'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const cloudSync = require('./automation/cloud-sync');
const isolation = require('./automation/isolation');

// Execute the production main-process functions without launching Electron or
// reading the user's settings. All IO below belongs to this scratch directory.
const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first);
  return source.slice(first, last);
}

async function main() {
  const scratchParent = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(scratchParent, { recursive: true });
  const root = await fsp.mkdtemp(path.join(scratchParent, 'settings-backup-regression-'));
  try {
    const settingsFile = path.join(root, 'settings.json');
    let failWrite = false;
    const initial = {
      profileDataRoot: path.join(root, 'profiles'), cloud: { provider: 'local' },
      uiGroups: [], syncFloatingEnabled: true, pet: { enabled: false },
    };
    const context = vm.createContext({
      fsp: { ...fsp, writeFile: (...args) => {
        if (failWrite) return Promise.reject(new Error('simulated disk failure'));
        return fsp.writeFile(...args);
      } },
      path, localSettingsFile: settingsFile, localSettingsCache: initial,
      normalizeProfileDataRoot: (value) => path.resolve(value), cloudSync,
      normalizePetConfig: (value) => value, DEFAULT_PET_CONFIG: {}, BUNDLED_PET_IDS: [],
    });
    vm.runInContext(section('let localSettingsWriteChain', 'async function updateProfileDataRoot'), context);
    await context.saveLocalSettings({});
    await Promise.all([
      context.saveLocalSettings({ cloud: { provider: 'webdav' } }),
      context.saveLocalSettings({ pet: { enabled: true } }),
      context.saveLocalSettings({ uiGroups: [{ id: 'group-1' }] }),
    ]);
    const saved = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
    assert.equal(saved.cloud.provider, 'webdav');
    assert.equal(saved.pet.enabled, true);
    assert.equal(saved.uiGroups[0].id, 'group-1');
    assert.equal(saved.syncFloatingEnabled, true, 'unrelated saves preserve floating-window preference');
    failWrite = true;
    await assert.rejects(context.saveLocalSettings({ syncFloatingEnabled: false }), /disk failure/);
    assert.deepStrictEqual(JSON.parse(await fsp.readFile(settingsFile, 'utf8')), saved);
    assert.equal(context.localSettingsCache.syncFloatingEnabled, true, 'failed save must not change live settings');
    failWrite = false;
    await context.saveLocalSettings({ syncFloatingEnabled: false });
    assert.equal(JSON.parse(await fsp.readFile(settingsFile, 'utf8')).syncFloatingEnabled, false);
    assert.equal(fs.existsSync(settingsFile + '.tmp'), false);
    console.log('PASS serialized settings preserve independent updates and recover from failed writes');

    const rootEngine = {
      running: new Map(), profileRoot: initial.profileDataRoot,
      setProfileDataRoot(value) { this.profileRoot = value; },
    };
    Object.assign(context, {
      engine: rootEngine, emit: () => {}, defaultProfileDataRoot: initial.profileDataRoot,
      ensureDataRootIsolationSecure: async () => ({ ok: true }),
    });
    vm.runInContext(section('async function updateProfileDataRoot', 'function providerConfigFromCloud'), context);
    failWrite = true;
    const failedRootChange = context.updateProfileDataRoot(path.join(root, 'new-root'));
    await assert.rejects(context.updateProfileDataRoot(path.join(root, 'concurrent-root')), /等待/);
    await assert.rejects(failedRootChange, /disk failure/);
    assert.equal(rootEngine.profileRoot, context.localSettingsCache.profileDataRoot);
    assert.equal(rootEngine.changingProfileDataRoot, false);
    failWrite = false;
    await context.updateProfileDataRoot(path.join(root, 'accepted-root'));
    assert.equal(rootEngine.profileRoot, JSON.parse(await fsp.readFile(settingsFile, 'utf8')).profileDataRoot);
    rootEngine.restoringBackup = true;
    await assert.rejects(context.updateProfileDataRoot(initial.profileDataRoot), /等待/);
    console.log('PASS data-root changes reject concurrency and preserve engine/disk consistency after failure');

    const profilesRoot = path.join(root, 'profiles');
    const cookieFile = path.join(profilesRoot, 'env-1', 'Default', 'Network', 'Cookies');
    await fsp.mkdir(path.dirname(cookieFile), { recursive: true });
    await fsp.writeFile(cookieFile, 'local-cookie');
    const local = { id: 'env-1', name: 'Local', updatedAt: '2026-09-08T12:00:00Z' };
    const remote = {
      id: 'env-1', name: 'Remote', updatedAt: '2026-09-07T12:00:00Z',
      _dataFiles: { 'Network/Cookies': Buffer.from('remote-cookie').toString('base64') },
    };
    const engine = {
      running: new Map(), profiles: new Map([[local.id, local]]),
      getProfileDataRoot: () => profilesRoot,
      sanitizeProfile: (profile) => profile,
      assertProfileIdentity(id) {
        isolation.assertProfileId(id);
        for (const existing of this.profiles.keys()) {
          if (id !== existing && id.toLowerCase() === existing.toLowerCase()) throw new Error('ID collision');
        }
      },
      syncProfiles(profiles) { for (const profile of profiles) this.profiles.set(profile.id, profile); },
      async deleteProfiles(ids, deleteData) {
        assert.equal(deleteData, false);
        for (const id of ids) this.profiles.delete(id);
      },
    };
    Object.assign(context, { engine, automation: null, ...isolation });
    vm.runInContext(section('async function applyBackupBody', 'async function runCloudRestore'), context);
    for (const mode of ['local-wins', 'merge']) {
      const applied = await context.applyBackupBody({ profiles: [remote] }, { mode });
      assert.equal(applied.restoredFiles, 0);
      assert.equal(await fsp.readFile(cookieFile, 'utf8'), 'local-cookie', mode + ' must preserve the winning local session');
      assert.equal(engine.profiles.get(local.id).name, 'Local');
    }
    engine.profiles.set('local-only', { id: 'local-only' });
    await context.applyBackupBody({ profiles: [remote] }, { mode: 'overwrite', scopeProfileIds: [remote.id] });
    assert.equal(engine.profiles.has('local-only'), true, 'a selected profile pull must preserve unrelated configurations');
    const overwritten = await context.applyBackupBody({ profiles: [remote] }, { mode: 'overwrite' });
    assert.equal(engine.profiles.has('local-only'), false, 'overwrite must remove local-only configuration from the engine');
    assert.equal(overwritten.restoredFiles, 1);
    assert.equal(await fsp.readFile(cookieFile, 'utf8'), 'remote-cookie');
    engine.running.set(local.id, { starting: true });
    await assert.rejects(context.applyBackupBody({ profiles: [remote] }), /停止所有环境/);
    engine.running.clear();
    await assert.rejects(context.applyBackupBody({ profiles: [remote, { ...remote, id: 'ENV-1' }] }), /ID/);
    await assert.rejects(context.applyBackupBody({ profiles: [
      { ...remote, number: 2 }, { ...remote, id: 'env-2', number: 2 },
    ] }), /编号重复/);
    assert.equal(engine.restoringBackup, false, 'restore guard must release after validation errors');
    assert.equal(await fsp.readFile(cookieFile, 'utf8'), 'remote-cookie');
    const freshLocal = { ...local, cookies: '' };
    const oldRemote = { ...remote, cookies: '' };
    assert.deepStrictEqual(cloudSync.mergeProfiles([freshLocal], [oldRemote]).remoteDataProfileIds, []);
    assert.deepStrictEqual(cloudSync.mergeProfiles([], [remote], 'local-wins').remoteDataProfileIds, ['env-1']);
    console.log('PASS backup merge restores browser data only for remote winners; active and conflicting IDs rejected');

    const outside = path.join(root, 'other-account');
    await fsp.mkdir(path.join(outside, 'Network'), { recursive: true });
    await fsp.writeFile(path.join(outside, 'Network', 'Cookies'), 'other-account-cookie');
    const linkedRoot = path.join(profilesRoot, 'linked-env');
    await fsp.mkdir(linkedRoot);
    await fsp.symlink(outside, path.join(linkedRoot, 'Default'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(cloudSync.collectProfileDataFiles(linkedRoot, { advanced: { cloudBackup: true } }), /symlink|junction/);
    assert.deepStrictEqual(await cloudSync.collectProfileDataFiles(path.join(profilesRoot, 'env-1'), {
      advanced: { cloudBackup: true },
    }, { maxTotalBytes: 0 }), {});
    console.log('PASS backup collection rejects linked browser storage and respects a zero-byte budget');
  } finally {
    assert.equal(path.dirname(path.resolve(root)), scratchParent);
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
