'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const cdp = require('../cdp');
const {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findMacBinary,
} = require('./resolve-host-dist');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resolveHostBinary(appRoot) {
  const distRoot = resolveHostDist(appRoot);
  if (process.platform === 'win32') return findHostWindowsExe(distRoot);
  if (process.platform === 'darwin') return findMacBinary(path.join(findHostAppBundle(distRoot), 'Contents', 'MacOS'));
  throw new Error(`AiBrowser CDP fixture is unsupported on ${process.platform}`);
}

async function loadTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`);
  if (!response.ok) throw new Error(`CDP target request failed: ${response.status}`);
  const value = await response.json();
  return Array.isArray(value) ? value : [];
}

async function rendererReady(target) {
  if (!target?.webSocketDebuggerUrl) return false;
  try {
    const response = await cdp.call(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: "typeof switchView === 'function' && typeof refreshProxies === 'function' && Boolean(window.ops)",
      returnByValue: true,
    });
    return response.result?.value === true;
  } catch (_) {
    return false;
  }
}

async function closeOwnedBrowser(port, child) {
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

async function startAiBrowserCdp(port = 19333) {
  const appRoot = path.resolve(__dirname, '..');
  const host = resolveHostBinary(appRoot);
  if (!host || !fs.existsSync(host)) throw new Error(`AiBrowser host runtime missing: ${host || '(none)'}`);
  const child = spawn(host, [`--remote-debugging-port=${port}`, appRoot], {
    cwd: appRoot,
    env: process.env,
    stdio: 'ignore',
    windowsHide: true,
  });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`AiBrowser exited before CDP became ready: ${child.exitCode}`);
      try {
        const targets = await loadTargets(port);
        const appTarget = targets.find((target) => target.title === 'AiBrowser');
        if (appTarget && await rendererReady(appTarget)) {
          return { owned: true, child, targets, close: () => closeOwnedBrowser(port, child) };
        }
      } catch (_) {}
      await wait(200);
    }
    throw new Error(`AiBrowser did not expose CDP ${port} in time`);
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
}

module.exports = { loadTargets, startAiBrowserCdp };
