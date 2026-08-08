'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const externalKernel = require('./automation/external-kernel');
const { killProcessTree } = require('./automation/protocol/cross-platform');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const userData = path.join(projectRoot, 'browser-data');
  const testRoot = path.join(projectRoot, '.cache', 'firefox-kernel-selftest');
  const profileDir = path.join(testRoot, 'profile');
  const found = externalKernel.detect({ appRoot: __dirname, userDataPath: userData });

  assert(found, 'project-local Firefox-Reverse kernel was not detected');
  assert.strictEqual(
    path.resolve(found.root),
    path.join(__dirname, 'kernels', 'firefox-reverse'),
    'Firefox must resolve from Browserapp/kernels/firefox-reverse'
  );
  assert(fs.existsSync(found.binary), `Firefox binary missing: ${found.binary}`);

  await fsp.mkdir(profileDir, { recursive: true });
  const temp = path.join(testRoot, 'temp');
  const appData = path.join(testRoot, 'appdata');
  const localAppData = path.join(testRoot, 'localappdata');
  for (const directory of [temp, appData, localAppData]) {
    await fsp.mkdir(directory, { recursive: true });
  }

  const launched = await externalKernel.launch({
    binary: found.binary,
    profileDir,
    url: 'about:blank',
    networkMode: 'direct',
    env: {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: temp,
      TMP: temp,
    },
  });

  let output = '';
  launched.child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  launched.child.stderr?.on('data', (chunk) => { output += chunk.toString(); });

  try {
    const ready = await externalKernel.waitForMarionette(launched.marionettePort, 60000);
    assert(ready, `Firefox Marionette did not become ready. ${output.slice(-2000)}`);
    assert.strictEqual(launched.child.exitCode, null, 'Firefox exited before readiness');
    console.log(JSON.stringify({
      success: true,
      pid: launched.pid,
      marionettePort: launched.marionettePort,
      binary: found.binary,
      profileDir,
    }, null, 2));
  } finally {
    const stopped = await killProcessTree(launched.pid, {
      force: true,
      expectedExecutable: found.binary,
    });
    if (!stopped && launched.child.exitCode === null) launched.child.kill();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
