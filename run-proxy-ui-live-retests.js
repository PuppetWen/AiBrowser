const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  resolveHostDist,
  findHostWindowsExe,
} = require('./Browserapp/scripts/resolve-host-dist');

const root = __dirname;
const appRoot = path.join(root, 'Browserapp');
const outputPath = path.join(root, 'proxy-ui-live-retest-results.json');
const host = findHostWindowsExe(resolveHostDist(appRoot));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForApp(port, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`AiBrowser exited before CDP became ready: ${child.exitCode}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json());
      if (targets.some((target) => target.title === 'AiBrowser')) return targets;
    } catch (_) {}
    await wait(200);
  }
  throw new Error(`AiBrowser did not expose CDP ${port} in time`);
}

async function closeBrowser(port, child) {
  try {
    const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json());
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await wait(700);
    socket.close();
  } catch (_) {}
  if (child.exitCode === null) child.kill();
}

async function main() {
  if (!fs.existsSync(host)) throw new Error(`Electron runtime not found: ${host}`);
  const port = 19333;
  const child = spawn(host, [`--remote-debugging-port=${port}`, appRoot], {
    cwd: appRoot,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const results = [];
  try {
    await waitForApp(port, child);
    for (const name of [
      'Browserapp/scripts/proxy-ui-selftest.js',
      'Browserapp/scripts/proxy-live-subscription-selftest.js',
    ]) {
      const started = Date.now();
      const result = spawnSync(process.execPath, [name, String(port)], {
        cwd: root,
        encoding: 'utf8',
        timeout: 180000,
        windowsHide: true,
      });
      results.push({
        name,
        status: result.status === 0 && !/(^|\n)\s*SKIP\b/i.test(`${result.stdout || ''}\n${result.stderr || ''}`) ? 'PASS' : 'FAIL',
        code: result.status,
        durationMs: Date.now() - started,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        error: result.error ? result.error.message : null,
      });
    }
  } finally {
    await closeBrowser(port, child);
  }
  fs.writeFileSync(outputPath, `${JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ outputPath, results }, null, 2)}\n`);
  process.exitCode = results.every((item) => item.status === 'PASS') ? 0 : 1;
}

main().catch((error) => {
  fs.writeFileSync(outputPath, `${JSON.stringify({ createdAt: new Date().toISOString(), error: error.stack || error.message }, null, 2)}\n`, 'utf8');
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
});
