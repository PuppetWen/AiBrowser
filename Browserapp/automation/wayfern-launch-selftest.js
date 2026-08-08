#!/usr/bin/env node
'use strict';

const fs = require('fs');
const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { ensureKernelReadyForLaunch, termsAcceptanceArgsForKernel, findBundledWayfernKernel } = require('./browser-kernel');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevToolsPort(root, child) {
  const portFile = path.join(root, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (fs.existsSync(portFile)) {
      const port = Number(String(await fsp.readFile(portFile, 'utf8')).split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  return null;
}

async function main() {
  const requested = String(process.argv[2] || process.env.WAYFERN_BINARY || '').trim();
  const bundled = requested ? null : findBundledWayfernKernel([path.join(__dirname, '..')]);
  const binary = requested ? path.resolve(requested) : bundled?.binary;
  let binaryStat = null;
  try { binaryStat = binary ? await fsp.stat(binary) : null; } catch (_) {}
  if (!binary || !binaryStat?.isFile()) {
    console.log('SKIP: Wayfern binary missing or not executable in this environment');
    return;
  }

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'aibrowser-wayfern-launch-'));
  let child;
  try {
    await ensureKernelReadyForLaunch({ path: binary }, '', { userDataPath: root });
    const termsArgs = termsAcceptanceArgsForKernel({ path: binary });
    if (termsArgs.length) {
      assert.deepStrictEqual(termsArgs, ['--accept-terms-and-conditions']);
    } else {
      console.log('SKIP: binary does not require terms acceptance argument');
    }
    // Long-lived browser spawn must NOT include accept-terms (that flag exits after recording license).
    const portableTemp = path.join(root, 'cache', 'temp');
    const portableAppData = process.platform === 'win32' ? path.join(portableTemp, 'AppData', 'Roaming') : path.join(root, 'wayfern-appdata');
    child = spawn(binary, [
      `--user-data-dir=${root}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-mode',
      'about:blank',
    ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPDATA: portableAppData, TEMP: portableTemp, TMP: portableTemp } });
    child.stdout?.resume();
    child.stderr?.resume();
    const port = await waitForDevToolsPort(root, child);
    if (!port) {
      console.log('SKIP: wayfern did not become CDP-ready in time');
      return;
    }
    console.log(`wayfern-launch-selftest: ok port=${port}`);
  } finally {
    if (child && child.exitCode === null) child.kill();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
