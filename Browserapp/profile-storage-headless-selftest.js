'use strict';

// Opt-in integration test: uses the bundled kernel by default, or an explicit
// --browser absolute executable path. Every launch uses a disposable profile.
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { BrowserEngine } = require('./engine');
const { acquireProfileLock, releaseProfileLock, validateProfileRootSecure, auditIsolation } = require('./automation/isolation');
const { killProcessTree } = require('./automation/protocol/cross-platform');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const browserIndex = process.argv.indexOf('--browser');
  const configuredBinary = browserIndex >= 0 ? process.argv[browserIndex + 1] : null;
  if (browserIndex >= 0 && (!configuredBinary || !path.isAbsolute(configuredBinary))) throw new Error('--browser requires an absolute executable path');
  const binary = configuredBinary || path.resolve(__dirname, 'kernels', 'windows-x64', 'chrome.exe');
  if (!fs.existsSync(binary)) throw new Error('Chromium executable does not exist: ' + binary);
  console.log('Testing ' + (configuredBinary ? 'explicit non-bundled browser: ' : 'bundled kernel: ') + binary);
  const cacheRoot = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(cacheRoot, { recursive: true });
  const testRoot = await fsp.mkdtemp(path.join(cacheRoot, 'profile-storage-headless-'));
  const appRoot = path.join(testRoot, 'app');
  const engine = new BrowserEngine({ getPath: () => appRoot });
  const children = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>Local isolation fixture</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;

  async function launch(id) {
    const profile = engine.sanitizeProfile({ id, name: id, networkMode: 'direct', advanced: { saveCookies: true, saveLocalStorage: true, saveIndexedDB: true } });
    engine.profiles.set(id, profile);
    const root = engine.profileRoot(id);
    assert((await validateProfileRootSecure(engine.getProfileDataRoot(), root, id, { create: true })).ok);
    const lock = await acquireProfileLock(root, { profileId: id, test: true });
    await engine.applyProfilePreferences(root, profile);
    await fsp.rm(path.join(root, 'DevToolsActivePort'), { force: true });
    const environment = { ...process.env, APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'), TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp') };
    for (const directory of new Set([environment.APPDATA, environment.LOCALAPPDATA, environment.TEMP])) await fsp.mkdir(directory, { recursive: true });
    const child = spawn(binary, [
      '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--user-data-dir=' + root, origin,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(binary), env: environment });
    const item = { id, child, root, lock, stderr: '' };
    children.push(item);
    child.stdout.on('data', () => {});
    child.stderr.on('data', (data) => { item.stderr = (item.stderr + data).slice(-2000); });
    child.on('error', (error) => { item.spawnError = error; });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (item.spawnError) throw item.spawnError;
      if (child.exitCode !== null) {
        const error = new Error('Headless child exited: ' + item.stderr);
        if (/Terms and Conditions[\s\S]*accept-terms-and-conditions/.test(item.stderr)) error.code = 'TERMS_NOT_ACCEPTED';
        throw error;
      }
      try {
        item.port = Number((await fsp.readFile(path.join(root, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
        item.socket = await cdp.browserSocket(item.port);
        const tabs = await cdp.tabs(item.port);
        item.tab = tabs.find((tab) => tab.url.startsWith(origin));
        if (item.tab) {
          const ready = await cdp.call(item.tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: 'location.origin === ' + JSON.stringify(origin) + ' && document.readyState === "complete"', returnByValue: true,
          });
          if (ready.result?.value) {
            item.connection = await cdp.connect(item.socket);
            return item;
          }
        }
      } catch (_) {}
      await pause(100);
    }
    throw new Error('Headless startup timed out: ' + item.stderr);
  }

  async function stop(item) {
    if (!item || item.closed) return;
    if (item.child.exitCode === null && item.socket) await cdp.call(item.socket, 'Browser.close', {}, 5000).catch(() => {});
    const deadline = Date.now() + 8000;
    while (item.child.exitCode === null && Date.now() < deadline) await pause(100);
    if (item.child.exitCode === null) {
      assert(await killProcessTree(item.child.pid, { force: true, expectedExecutable: binary, expectedUserDataDir: item.root }), 'only the owned test child may be terminated');
      const killedDeadline = Date.now() + 5000;
      while (item.child.exitCode === null && Date.now() < killedDeadline) await pause(100);
    }
    assert(item.child.exitCode !== null || item.child.signalCode !== null, 'headless child must exit before its profile is removed');
    item.connection?.close();
    await releaseProfileLock(item.root, item.lock);
    item.closed = true;
  }

  async function state(item, marker = null) {
    const expression = `(${async function syntheticStorage(marker) {
      if (marker !== null) {
        document.cookie = 'account_marker=' + encodeURIComponent(marker) + '; Path=/; Max-Age=3600';
        localStorage.setItem('account_marker', marker);
      }
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('isolation-fixture', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('accounts');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (marker !== null) await new Promise((resolve, reject) => {
        const tx = db.transaction('accounts', 'readwrite');
        tx.objectStore('accounts').put(marker, 'marker');
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      const indexed = await new Promise((resolve, reject) => {
        const request = db.transaction('accounts').objectStore('accounts').get('marker');
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return { cookie: document.cookie, local: localStorage.getItem('account_marker'), indexed };
    }})(${JSON.stringify(marker)})`;
    const result = await cdp.call(item.tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 10000);
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async function setHttpOnly(item, value) {
    await engine.importProfileCookies(item.connection, JSON.stringify([{
      name: 'session_marker', value, url: origin, httpOnly: true,
      expires: Math.floor(Date.now() / 1000) + 3600,
    }]));
  }
  async function httpOnly(item) {
    const exported = JSON.parse(await engine.exportProfileCookies(item.connection));
    return exported.find((cookie) => cookie.name === 'session_marker')?.value || null;
  }

  try {
    const [a, b] = await Promise.all([launch('account-a'), launch('account-b')]);
    assert(a.child.pid !== b.child.pid && a.port !== b.port);
    assert(auditIsolation([a, b]).ok);
    assert.deepEqual(await state(a), { cookie: '', local: null, indexed: null });
    assert.deepEqual(await state(b), { cookie: '', local: null, indexed: null });
    await state(a, 'account-A');
    await setHttpOnly(a, 'login-A');
    assert.deepEqual(await state(b), { cookie: '', local: null, indexed: null });
    assert.equal(await httpOnly(b), null);
    await state(b, 'account-B');
    await setHttpOnly(b, 'login-B');
    assert.deepEqual(await state(a), { cookie: 'account_marker=account-A', local: 'account-A', indexed: 'account-A' });
    assert.deepEqual(await state(b), { cookie: 'account_marker=account-B', local: 'account-B', indexed: 'account-B' });
    assert.equal(await httpOnly(a), 'login-A');
    assert.equal(await httpOnly(b), 'login-B');
    console.log('PASS two headless Chromium processes isolate same-origin cookies, HttpOnly login cookies, localStorage and IndexedDB');
    await Promise.all([stop(a), stop(b)]);
    const [a2, b2] = await Promise.all([launch('account-a'), launch('account-b')]);
    assert.deepEqual(await state(a2), { cookie: 'account_marker=account-A', local: 'account-A', indexed: 'account-A' });
    assert.deepEqual(await state(b2), { cookie: 'account_marker=account-B', local: 'account-B', indexed: 'account-B' });
    assert.equal(await httpOnly(a2), 'login-A');
    assert.equal(await httpOnly(b2), 'login-B');
    console.log('PASS both accounts retain their own storage after clean browser shutdown and restart');
    console.log('All headless profile storage selftests passed.');
  } finally {
    const stopped = await Promise.allSettled(children.map(stop));
    await new Promise((resolve) => server.close(resolve));
    for (const result of stopped) if (result.status === 'rejected') throw result.reason;
    const resolved = path.resolve(testRoot);
    assert.equal(path.dirname(resolved), cacheRoot);
    assert(path.basename(resolved).startsWith('profile-storage-headless-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (error.code === 'TERMS_NOT_ACCEPTED') {
    console.log('SKIP bundled-kernel storage validation: kernel requires its terms to be accepted by the user. No terms were accepted.');
    console.log(error.message);
  } else {
    console.error(error); process.exitCode = 1;
  }
});
