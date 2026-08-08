'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { extensionIdFromKey } = require('./store-extension');
const cdp = require('./cdp');

async function clearRoot(root, attempt = 0) {
  try {
    await fsp.rm(root, { recursive: true, force: true });
    return;
  } catch (error) {
    if ((error?.code === 'EBUSY' || error?.code === 'EPERM') && attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      return clearRoot(root, attempt + 1);
    }
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(error.trim() || `${command} failed: ${code}`)));
  });
}

async function createOfflineStorePackage(root) {
  const source = path.join(root, 'fixture-source');
  const zipFile = path.join(root, 'fixture.zip');
  await fsp.mkdir(source, { recursive: true });
  await fsp.writeFile(path.join(source, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'AiBrowser Multi Environment Fixture',
    version: '1.0.0',
    background: { service_worker: 'worker.js' },
  }), 'utf8');
  await fsp.writeFile(path.join(source, 'worker.js'), 'globalThis.aiBrowserMultiEnvironmentFixture = true;', 'utf8');
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-a', '-cf', zipFile, '-C', source, '.']);
  const zip = await fsp.readFile(zipFile);
  const key = Buffer.from('openbrowser-multi-environment-store-fixture-key', 'utf8');
  const signature = Buffer.from('fixture-signature', 'utf8');
  const storeId = extensionIdFromKey(key);
  const header = Buffer.alloc(16);
  header.write('Cr24', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(key.length, 8);
  header.writeUInt32LE(signature.length, 12);
  return { storeId, bytes: Buffer.concat([header, key, signature, zip]) };
}

async function installedExtensions(session) {
  const socket = await cdp.browserSocket(session.port);
  return (await cdp.call(socket, 'Extensions.getExtensions')).extensions || [];
}

function hasExtension(list, extensionPath) {
  const expected = path.resolve(extensionPath).toLowerCase();
  return list.some((item) => path.resolve(item.path || '').toLowerCase() === expected && item.enabled !== false);
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const root = path.join(projectRoot, '.cache', `store-batch-four-selftest-${Date.now()}-${process.pid}`);
  const userDataRoot = path.join(root, 'browser-data');
  const profileDataRoot = path.join(userDataRoot, 'browser-profiles-v2');
  // OPENBROWSER_KERNEL_ROOT is a resource root; BrowserKernelManager resolves
  // its nested kernels/wayfern directory.
  const integratedKernelRoot = path.join(projectRoot, 'browser-data');
  const previousKernelRoot = process.env.OPENBROWSER_KERNEL_ROOT;
  process.env.OPENBROWSER_KERNEL_ROOT = integratedKernelRoot;
  await clearRoot(root).catch(() => {});
  await fsp.mkdir(userDataRoot, { recursive: true });

  const app = { getPath: (name) => name === 'userData' ? userDataRoot : userDataRoot };
  const profileIds = Array.from({ length: 4 }, (_, index) => `store-env-${index + 1}`);
  const profiles = profileIds.map((id, index) => ({
    id,
    number: index + 1,
    name: `Store Environment ${index + 1}`,
    browser: 'Google Chrome',
    proxy: 'Direct',
    advanced: { showInfoPage: false },
  }));
  let engine = null;
  try {
    const rendererSource = await fsp.readFile(path.join(__dirname, 'renderer.js'), 'utf8');
    const preloadSource = await fsp.readFile(path.join(__dirname, 'preload.js'), 'utf8');
    const mainSource = await fsp.readFile(path.join(__dirname, 'main.js'), 'utf8');
    assert.match(rendererSource, /assign-profile-list input:checked/);
    assert.match(rendererSource, /assignExtension\(currentExtension\.id, ids, enabled\)/);
    assert.match(preloadSource, /extensions:assign/);
    assert.match(mainSource, /extensions:assign[\s\S]{0,300}assignExtension/);
    console.log('  PASS  batch dialog sends every checked environment through IPC');

    const fixture = await createOfflineStorePackage(root);
    const setup = new BrowserEngine(app, { profileDataRoot });
    await setup.init(null);
    setup.syncProfiles(profiles);
    const storeUrl = `https://chromewebstore.google.com/detail/fixture/${fixture.storeId}`;
    const extension = await setup.addStoreExtension(storeUrl, async () => fixture.bytes);

    const initiallySelected = [profileIds[0], profileIds[1], profileIds[3]];
    await setup.assignExtension(extension.id, initiallySelected, true);
    const initialCard = setup.listExtensions().find((item) => item.id === extension.id);
    assert.strictEqual(initialCard.enabledAll, false);
    assert.strictEqual(initialCard.assignedProfiles, 3);
    assert.deepStrictEqual([...initialCard.assignedProfileIds].sort(), [...initiallySelected].sort());

    const saved = JSON.parse(await fsp.readFile(path.join(userDataRoot, 'openbrowser-engine.json'), 'utf8'));
    for (const id of initiallySelected) assert.ok(saved.assignments[id].includes(extension.id));
    assert.ok(!saved.assignments[profileIds[2]]?.includes(extension.id));
    console.log('  PASS  three selected environment assignments persisted');

    // Reload from disk to prove the relation survives an app restart.
    engine = new BrowserEngine(app, { profileDataRoot });
    await engine.init(null);
    const reloadedCard = engine.listExtensions().find((item) => item.id === extension.id);
    assert.strictEqual(reloadedCard.assignedProfiles, 3);
    console.log('  PASS  multi-environment assignments survive engine restart');

    const sessions = new Map();
    for (const id of profileIds) sessions.set(id, await engine.start(engine.profiles.get(id)));
    const firstLoaded = {};
    for (const id of profileIds) firstLoaded[id] = hasExtension(await installedExtensions(sessions.get(id)), extension.path);
    assert.deepStrictEqual(firstLoaded, {
      [profileIds[0]]: true,
      [profileIds[1]]: true,
      [profileIds[2]]: false,
      [profileIds[3]]: true,
    });
    console.log('  PASS  plugin loaded in exactly the three selected browser processes');

    const addFourth = await engine.assignExtension(extension.id, [profileIds[2]], true);
    assert.deepStrictEqual(addFourth.restartRequired, [profileIds[2]]);
    await engine.stop(profileIds[2]);
    sessions.set(profileIds[2], await engine.start(engine.profiles.get(profileIds[2])));
    assert.strictEqual(hasExtension(await installedExtensions(sessions.get(profileIds[2])), extension.path), true);
    assert.strictEqual(engine.listExtensions().find((item) => item.id === extension.id).enabledAll, true);
    console.log('  PASS  adding a running environment takes effect after its targeted restart');

    const removeSelected = [profileIds[1], profileIds[3]];
    const removeResult = await engine.assignExtension(extension.id, removeSelected, false);
    assert.deepStrictEqual([...removeResult.restartRequired].sort(), [...removeSelected].sort());
    for (const id of removeSelected) {
      await engine.stop(id);
      sessions.set(id, await engine.start(engine.profiles.get(id)));
    }
    const finalLoaded = {};
    for (const id of profileIds) finalLoaded[id] = hasExtension(await installedExtensions(sessions.get(id)), extension.path);
    assert.deepStrictEqual(finalLoaded, {
      [profileIds[0]]: true,
      [profileIds[1]]: false,
      [profileIds[2]]: true,
      [profileIds[3]]: false,
    });
    const finalCard = engine.listExtensions().find((item) => item.id === extension.id);
    assert.strictEqual(finalCard.assignedProfiles, 2);
    assert.strictEqual(finalCard.enabledAll, false);
    console.log('  PASS  removing two selected environments leaves the other two enabled');

    console.log(JSON.stringify({
      success: true,
      extension: { id: extension.id, storeId: extension.storeId, path: extension.path },
      initialLoaded: firstLoaded,
      finalLoaded,
      finalAssignments: finalCard.assignedProfileIds,
      kernelResourceRoot: integratedKernelRoot,
    }, null, 2));
  } finally {
    await engine?.stopAll().catch(() => {});
    if (previousKernelRoot === undefined) delete process.env.OPENBROWSER_KERNEL_ROOT;
    else process.env.OPENBROWSER_KERNEL_ROOT = previousKernelRoot;
  await clearRoot(root).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
