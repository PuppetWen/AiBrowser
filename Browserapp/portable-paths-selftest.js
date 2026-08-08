'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const { rebasePortablePath, rebasePortableFileUrl } = require('./portable-paths');
const { BrowserEngine } = require('./engine');

async function main() {
  const appRoot = __dirname;
  const projectRoot = path.resolve(appRoot, '..');
  const cacheRoot = path.join(projectRoot, '.cache', 'portable-selftest');
  const userDataRoot = path.join(cacheRoot, 'moved copy', 'browser-data');
  await fsp.rm(cacheRoot, { recursive: true, force: true });
  await fsp.mkdir(path.join(userDataRoot, 'kernels'), { recursive: true });
  await fsp.writeFile(path.join(userDataRoot, 'kernels', 'kernel-meta.json'), '{}', 'utf8');

  const options = { appRoot, userDataRoot };
  const movedExtension = 'Z:\\Old Folder\\AiBrowser\\Browserapp\\bundled-extension';
  const movedKernelMeta = 'Z:\\Old Folder\\AiBrowser\\browser-data\\kernels\\kernel-meta.json';
  const legacyProfileRoot = 'C:\\Users\\someone\\AppData\\Roaming\\aibrowser\\browser-profiles-v2';
  const externalPath = 'D:\\Shared Extensions\\custom-extension';

  assert.strictEqual(
    rebasePortablePath(movedExtension, options),
    path.join(appRoot, 'bundled-extension'),
  );
  assert.strictEqual(
    rebasePortablePath(movedKernelMeta, options),
    path.join(userDataRoot, 'kernels', 'kernel-meta.json'),
  );
  assert.strictEqual(
    rebasePortablePath(legacyProfileRoot, { ...options, requireExisting: false }),
    path.join(userDataRoot, 'browser-profiles-v2'),
  );
  assert.strictEqual(rebasePortablePath(externalPath, options), externalPath);
  assert.strictEqual(
    rebasePortableFileUrl(pathToFileURL(movedExtension).toString(), options),
    pathToFileURL(path.join(appRoot, 'bundled-extension')).toString(),
  );
  console.log('  PASS  saved project paths rebase to the current folder');

  const stateFile = path.join(userDataRoot, 'openbrowser-engine.json');
  const oldBuiltInId = 'old-project-location-built-in-id';
  await fsp.writeFile(stateFile, JSON.stringify({
    extensions: [{
      id: oldBuiltInId,
      name: 'AiBrowser Marker',
      version: '1.0.2',
      path: movedExtension,
      iconUrl: pathToFileURL(path.join(path.dirname(movedExtension), 'icon.png')).toString(),
      builtIn: true,
    }],
    assignments: { 'env-portable': [oldBuiltInId] },
    profiles: [],
    kernelPolicyVersion: 4,
    preferIndependentKernel: true,
    allowSystemBrowserFallback: false,
    systemBrowserPath: null,
  }, null, 2), 'utf8');

  const fakeApp = {
    getPath(name) {
      if (name === 'userData') return userDataRoot;
      if (name === 'appData') return path.dirname(userDataRoot);
      return cacheRoot;
    },
  };
  const engine = new BrowserEngine(fakeApp, {
    profileDataRoot: path.join(userDataRoot, 'browser-profiles-v2'),
  });
  await engine.init(path.join(appRoot, 'bundled-extension'));
  const currentBuiltIn = [...engine.extensions.values()].find((extension) => extension.builtIn);
  assert.ok(currentBuiltIn, 'current built-in extension must load');
  assert.ok(engine.assignments.get('env-portable').has(currentBuiltIn.id));
  assert.ok(!engine.assignments.get('env-portable').has(oldBuiltInId));
  console.log('  PASS  environment extension assignments survive a project move');

  const launcher = await fsp.readFile(path.join(projectRoot, 'start-test.cmd'), 'utf8');
  assert.match(launcher, /OPENBROWSER_RUNTIME_ROOT=%~dp0\.runtime/i);
  assert.match(launcher, /NODE_EXE=%OPENBROWSER_RUNTIME_ROOT%\\node\\node\.exe/i);
  assert.match(launcher, /%~dp0Browserapp\\scripts\\run-app\.js/i);
  assert.doesNotMatch(launcher, /npm start/i);
  const localNode = path.join(projectRoot, '.runtime', 'node', 'node.exe');
  const localElectron = path.join(appRoot, 'node_modules', 'desktop-shell', 'dist', 'electron.exe');
  assert.ok(fs.existsSync(localNode), 'project-local Node runtime is missing');
  assert.ok(fs.existsSync(localElectron), 'project-local Electron runtime is missing');
  const version = spawnSync(localNode, ['--version'], { encoding: 'utf8' });
  assert.strictEqual(version.status, 0);
  assert.match(version.stdout, /^v\d+/);
  console.log(`  PASS  local Node ${version.stdout.trim()} and Electron runtime are available`);

  await fsp.rm(cacheRoot, { recursive: true, force: true });
  console.log('Portable path self-test passed.');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
