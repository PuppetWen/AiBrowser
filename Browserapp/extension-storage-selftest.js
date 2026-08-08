'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { extensionIdFromKey, pathInside } = require('./store-extension');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `${command} failed: ${code}`)));
  });
}

async function createCrx2(root) {
  const source = path.join(root, 'fixture-source');
  const zipFile = path.join(root, 'fixture.zip');
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'Portable Extension Fixture',
    version: '1.0.0',
  }), 'utf8');
  await fsp.writeFile(path.join(source, 'worker.js'), 'void 0;', 'utf8');
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-a', '-cf', zipFile, '-C', source, '.']);
  const zip = await fsp.readFile(zipFile);
  const key = Buffer.from('aibrowser-portable-extension-selftest-key', 'utf8');
  const signature = Buffer.from('fixture-signature', 'utf8');
  const header = Buffer.alloc(16);
  header.write('Cr24', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(key.length, 8);
  header.writeUInt32LE(signature.length, 12);
  return {
    bytes: Buffer.concat([header, key, signature, zip]),
    storeId: extensionIdFromKey(key),
  };
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const userDataRoot = path.join(projectRoot, 'browser-data');
  const profileDataRoot = path.join(userDataRoot, 'browser-profiles-v2');
  const app = { getPath: (name) => name === 'userData' ? userDataRoot : userDataRoot };
  const engine = new BrowserEngine(app, { profileDataRoot });
  const storage = engine.extensionStorage('env-001');

  assert.strictEqual(storage.applicationCenterRoot, path.join(userDataRoot, 'chrome-store-extensions'));
  assert.strictEqual(storage.applicationCenterCacheRoot, path.join(userDataRoot, 'app-center-icons'));
  assert.strictEqual(storage.browserExtensionRoot, path.join(profileDataRoot, 'env-001', 'Default', 'Extensions'));
  assert.strictEqual(storage.applicationCenterPortable, true);
  assert.strictEqual(storage.browserExtensionPortable, true);

  let directInstallCount = 0;
  if (fs.existsSync(profileDataRoot)) {
    for (const profile of await fsp.readdir(profileDataRoot, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue;
      const extensionRoot = path.join(profileDataRoot, profile.name, 'Default', 'Extensions');
      if (!fs.existsSync(extensionRoot)) continue;
      assert.ok(pathInside(extensionRoot, userDataRoot));
      directInstallCount += (await fsp.readdir(extensionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
    }
  }
  if (fs.existsSync(storage.storeSessionRoot)) assert.ok(pathInside(storage.storeSessionRoot, userDataRoot));
  console.log(`  PASS  browser-installed extensions are inside project profiles (${directInstallCount} found)`);

  const cacheRoot = path.join(projectRoot, '.cache', 'extension-storage-selftest');
  const fixtureUserData = path.join(cacheRoot, 'browser-data');
  await fsp.rm(cacheRoot, { recursive: true, force: true });
  await fsp.mkdir(fixtureUserData, { recursive: true });
  try {
    const crx = await createCrx2(cacheRoot);
    const fixtureEngine = new BrowserEngine(
      { getPath: (name) => name === 'userData' ? fixtureUserData : fixtureUserData },
      { profileDataRoot: path.join(fixtureUserData, 'browser-profiles-v2') },
    );
    const url = `https://chromewebstore.google.com/detail/fixture/${crx.storeId}`;
    const extension = await fixtureEngine.addStoreExtension(url, async () => crx.bytes);
    const expected = path.join(fixtureUserData, 'chrome-store-extensions', crx.storeId);
    assert.strictEqual(extension.path, expected);
    assert.ok(fs.existsSync(path.join(expected, 'manifest.json')));
    assert.ok(pathInside(extension.path, fixtureUserData));
    const leftovers = (await fsp.readdir(path.dirname(expected))).filter((name) => name.startsWith('.'));
    assert.deepStrictEqual(leftovers, []);
    console.log('  PASS  Application Center download, staging and final files stay in project userData');

    await fixtureEngine.removeExtension(extension.id);
    assert.ok(!fs.existsSync(expected));
    console.log('  PASS  removing an Application Center extension cleans its local files');
  } finally {
    await fsp.rm(cacheRoot, { recursive: true, force: true });
  }

  console.log('Extension storage self-test passed.');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
