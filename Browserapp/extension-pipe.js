const { spawn } = require('child_process');
const path = require('path');
const cdp = require('./cdp');
const { ensureKernelReadyForLaunch } = require('./automation/browser-kernel');

class PipeConnection {
  constructor(child) {
    this.child = child; this.input = child.stdio[3]; this.output = child.stdio[4];
    this.nextId = 1; this.pending = new Map(); this.buffer = Buffer.alloc(0);
    this.output.on('data', (chunk) => this.onData(chunk));
    const fail = (error) => { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); };
    this.input.on('error', fail);
    this.output.on('error', fail);
    child.once('error', (error) => fail(error instanceof Error ? error : new Error(String(error))));
    child.once('exit', (code) => fail(new Error(`Chrome extension installer exited: ${code}`)));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(0); if (end < 0) break;
      const raw = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1);
      if (!raw) continue; let value; try { value = JSON.parse(raw); } catch (_) { continue; }
      const item = this.pending.get(value.id); if (!item) continue;
      this.pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(new Error(value.error.message || 'Chrome extension installer command failed'));
      else item.resolve(value.result || {});
    }
  }

  command(method, params = {}, timeout = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome extension installer timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.input.write(Buffer.concat([Buffer.from(JSON.stringify({ id, method, params }), 'utf8'), Buffer.from([0])]), (error) => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
}

async function launchPipeBrowser(browserPath, args, windowsHide = false, env = process.env) {
  const options = {
    windowsHide,
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    env,
  };
  // Detached process groups let non-Windows force-stop kill helper children cleanly.
  if (process.platform !== 'win32') options.detached = true;
  const child = spawn(browserPath, args, options);
  const connection = new PipeConnection(child);
  try {
    await connection.command('Browser.getVersion', {}, 20000);
  } catch (error) {
    try { child.kill(); } catch (_) {}
    throw error;
  }
  return { child, connection };
}

async function launchInstaller(browserPath, root, extraArgs = []) {
  await ensureKernelReadyForLaunch({ path: browserPath }, '', { userDataPath: root });
  const portableTemp = path.join(path.resolve(root), 'cache', 'temp');
  const portableAppData = process.platform === 'win32'
    ? path.join(portableTemp, 'AppData', 'Roaming')
    : path.join(path.resolve(root), 'wayfern-appdata');
  const env = { ...process.env, APPDATA: portableAppData, TEMP: portableTemp, TMP: portableTemp };
  const args = [`--user-data-dir=${root}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-mode', '--enable-unsafe-extension-debugging', '--remote-debugging-pipe', '--window-position=-32000,-32000', '--window-size=800,600', ...extraArgs, 'about:blank'];
  return launchPipeBrowser(browserPath, args, true, env);
}

async function closeInstaller(value) {
  if (!value) return;
  await value.connection.command('Browser.close').catch(() => {});
  if (value.child.exitCode === null) {
    await new Promise((resolve) => { const timer = setTimeout(resolve, 5000); value.child.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  if (value.child.exitCode === null) value.child.kill();
}

async function reconcileOnConnection(connection, desired, managedPaths = []) {
  // AiBrowser 148 kernels may lack Chrome Extensions.* CDP domain.
  // Probe first; if unavailable, keep browser alive and rely on --load-extension only.
  let current;
  try {
    current = await connection.command('Extensions.getExtensions');
  } catch (error) {
    const msg = String(error && error.message || error || '');
    if (/not available|unknown method|was not found|not found|unsupported/i.test(msg)) {
      return {
        installed: desired.map((item) => ({ ...item, chromeExtensionId: null })),
        extensions: [],
        skipped: true,
        reason: msg,
      };
    }
    throw error;
  }
  const wanted = new Map(desired.map((item) => [item.path.toLowerCase(), item]));
  const managed = managedPaths.map((item) => item.toLowerCase());
  for (const extension of current.extensions || []) {
    const currentPath = String(extension.path || '').toLowerCase();
    if (managed.includes(currentPath) && !wanted.has(currentPath)) await connection.command('Extensions.uninstall', { id: extension.id });
  }
  const refreshed = await connection.command('Extensions.getExtensions');
  const present = new Map((refreshed.extensions || []).map((item) => [String(item.path || '').toLowerCase(), item]));
  const installed = [];
  for (const extension of desired) {
    const existing = present.get(extension.path.toLowerCase());
    if (existing?.enabled) { installed.push({ ...extension, chromeExtensionId: existing.id }); continue; }
    if (existing) await connection.command('Extensions.uninstall', { id: existing.id });
    const result = await connection.command('Extensions.loadUnpacked', { path: extension.path, enableInIncognito: false }, 30000);
    installed.push({ ...extension, chromeExtensionId: result.id });
  }
  return { installed, extensions: (await connection.command('Extensions.getExtensions')).extensions || [] };
}

async function portConnection(port) {
  const socket = await cdp.browserSocket(port);
  return {
    command(method, params = {}, timeout = 15000) {
      return cdp.call(socket, method, params, timeout);
    },
  };
}

async function reconcileUnpackedExtensions(browserPath, root, desired, managedPaths = []) {
  const installer = await launchInstaller(browserPath, root);
  try { return await reconcileOnConnection(installer.connection, desired, managedPaths); }
  finally { await closeInstaller(installer); }
}

module.exports = { PipeConnection, launchPipeBrowser, launchInstaller, closeInstaller, reconcileOnConnection, reconcileUnpackedExtensions, portConnection };
