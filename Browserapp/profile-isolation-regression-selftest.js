'use strict';

// Uses synthetic accounts, temporary directories and a mocked external kernel.
// Never opens a browser or reads the user's persisted environments.
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserEngine } = require('./engine');
const externalKernel = require('./automation/external-kernel');
const {
  acquireProfileLock, releaseProfileLock, assertProfileId,
  assertSafeProfileChild, validateDataRootIsolationSecure, validateProfileRootSecure,
  auditIsolation, systemBrowserDataRoots,
} = require('./automation/isolation');

async function main() {
  const cacheRoot = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(cacheRoot, { recursive: true });
  const testRoot = await fsp.mkdtemp(path.join(cacheRoot, 'profile-isolation-regression-'));
  const engines = [];
  const original = { detect: externalKernel.detect, launch: externalKernel.launch, wait: externalKernel.waitForMarionette };
  function engineAt(name) {
    const root = path.join(testRoot, name);
    const engine = new BrowserEngine({ getPath: () => root });
    engine.prepareProfileProxyForStart = async (profile) => profile;
    engine.ensureExitNetworkForLocale = async () => {};
    engine.applyResolvedLocale = (profile) => profile;
    engines.push(engine);
    return engine;
  }
  function profile(id, extra = {}) { return { id, name: id, ...extra }; }
  function pass(name) { console.log('PASS ' + name); }
  try {
    const engine = engineAt('profiles');
    engine.syncProfiles([profile('AccountA', { cookies: 'synthetic-cookie' })]);
    assert.throws(() => engine.syncProfiles([profile('accounta')]), /conflicts/);
    assert.throws(() => engine.profileRoot('accounta'), /conflicts/);
    await assert.rejects(engine.start(profile('accounta')), /conflicts/);
    const before = engine.status();
    assert.throws(() => engine.syncProfiles([profile('fresh'), profile('fresh')]), /Duplicate/);
    assert.throws(() => engine.syncProfiles([profile('Fresh'), profile('fresh')]), /Duplicate/);
    assert.deepEqual(engine.status(), before, 'invalid batches must not partially update profiles');
    for (const id of ['CON', 'nul', 'COM1', 'Lpt9']) assert.throws(() => assertProfileId(id));
    pass('case collisions, duplicate IDs and Windows device names are rejected before mutation');

    const secret = profile('secret', {
      cookies: 'synthetic-cookie', proxy: 'http://fixture-user:fixture-pass@127.0.0.1:18080',
      platform: { password: 'synthetic-password', totpSecret: 'synthetic-totp' },
      proxyMeta: { backupProxies: ['http://backup:pass@127.0.0.1:18081'], refreshUrl: 'https://example.invalid/rotate?token=synthetic' },
    });
    engine.syncProfiles([secret]);
    engine.syncProfiles([profile('secret', { _secretsRedacted: true, proxy: 'http://127.0.0.1:18080' })]);
    assert.equal(engine.profiles.get('secret').cookies, secret.cookies);
    assert.equal(engine.profiles.get('secret').platform.password, secret.platform.password);
    assert.equal(engine.profiles.get('secret').proxy, secret.proxy);
    assert.equal(engine.profiles.get('secret').proxyMeta.refreshUrl, secret.proxyMeta.refreshUrl);
    engine.syncProfiles([profile('secret', { proxy: 'http://127.0.0.1:18080' })]);
    assert.equal(engine.profiles.get('secret').cookies, '');
    assert.equal(engine.profiles.get('secret').platform.password, '');
    assert.equal(engine.profiles.get('secret').platform.totpSecret, '');
    assert.equal(engine.profiles.get('secret').proxy, 'http://127.0.0.1:18080');
    pass('explicitly redacted cache restores credentials; intentional field clearing persists');

    const writes = [];
    for (let index = 0; index < 40; index += 1) {
      engine.profiles.set('persist', engine.sanitizeProfile(profile('persist', { note: 'x'.repeat(index * 31) })));
      writes.push(engine.persist());
    }
    await Promise.all(writes);
    const saved = JSON.parse(await fsp.readFile(engine.stateFile, 'utf8'));
    assert.equal(saved.profiles.find((entry) => entry.id === 'persist').note.length, 39 * 31);
    assert.equal((await fsp.readdir(path.dirname(engine.stateFile))).filter((name) => name.endsWith('.tmp')).length, 0);
    pass('concurrent persistence remains valid JSON and preserves the latest state');

    const root = engine.profileRoot('linked');
    const outside = path.join(testRoot, 'other-account');
    const victimCache = path.join(outside, 'Default', 'Cache');
    await fsp.mkdir(victimCache, { recursive: true });
    await fsp.writeFile(path.join(victimCache, 'keep.txt'), 'other account cache');
    await fsp.mkdir(path.dirname(root), { recursive: true });
    await fsp.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertSafeProfileChild(root, path.join(root, 'Default', 'Cache')), /Isolation/);
    await assert.rejects(engine.clearProfileCacheAndCookies('linked'), /Isolation/);
    assert.equal(await fsp.readFile(path.join(victimCache, 'keep.txt'), 'utf8'), 'other account cache');
    assert.equal((await validateProfileRootSecure(engine.getProfileDataRoot(), root, 'linked', { create: true })).ok, false);
    assert.equal(auditIsolation([{ id: 'original', root: outside }, { id: 'alias', root }]).ok, false);
    assert.equal(auditIsolation([{ id: 'missing' }]).ok, false);
    pass('junction profile roots cannot read/delete another account, and audits flag aliases/missing roots');

    const preferenceRoot = engine.profileRoot('preferences');
    await fsp.mkdir(preferenceRoot, { recursive: true });
    const outsideDefault = path.join(outside, 'Default');
    await fsp.writeFile(path.join(outsideDefault, 'Preferences'), '{"sentinel":true}');
    await fsp.writeFile(path.join(outsideDefault, 'Login Data'), 'other-password-database');
    await fsp.symlink(outsideDefault, path.join(preferenceRoot, 'Default'), process.platform === 'win32' ? 'junction' : 'dir');
    const preferences = engine.sanitizeProfile(profile('preferences'));
    await assert.rejects(engine.applyProfilePreferences(preferenceRoot, preferences), /Isolation/);
    await assert.rejects(engine.enforceDataRetention(preferenceRoot, preferences), /Isolation/);
    await assert.rejects(engine.resetZoom(preferenceRoot), /Isolation/);
    assert.equal(await fsp.readFile(path.join(outsideDefault, 'Preferences'), 'utf8'), '{"sentinel":true}');
    assert.equal(await fsp.readFile(path.join(outsideDefault, 'Login Data'), 'utf8'), 'other-password-database');
    pass('nested profile junctions cannot redirect preferences or data-retention deletion');

    const systemAlias = path.join(testRoot, 'browser-alias');
    await fsp.symlink(outside, systemAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const nonexistent = path.join(systemAlias, 'not-created', 'profiles');
    assert.equal(validateDataRootIsolationSecure(nonexistent, { browserRoots: [outside] }).ok, false);
    assert.equal(fs.existsSync(path.join(outside, 'not-created')), false);
    const fakeHome = path.join(testRoot, 'home');
    const roots = systemBrowserDataRoots({ LOCALAPPDATA: path.join(testRoot, 'portable-local') }, fakeHome, 'win32');
    assert(roots.includes(path.join(fakeHome, 'AppData', 'Local', 'Google', 'Chrome', 'User Data')));
    pass('nonexistent paths under junctions and portable APPDATA do not bypass system-browser protection');

    const firefox = engineAt('external');
    const launches = [];
    externalKernel.detect = () => ({ binary: path.join(testRoot, 'synthetic-firefox.exe') });
    externalKernel.launch = async (options) => {
      const child = new EventEmitter();
      child.pid = 123456789; child.exitCode = null; child.signalCode = null;
      launches.push({ options, child });
      return { child, pid: child.pid, launcherPid: child.pid, marionettePort: 28123 + launches.length };
    };
    externalKernel.waitForMarionette = async () => true;
    const externalProfile = profile('firefox-a', { kernel: 'firefox-reverse' });
    const [first, duplicate] = await Promise.all([firefox.start(externalProfile), firefox.start(externalProfile)]);
    assert(first.running && duplicate.running);
    assert.equal(launches.length, 1);
    await assert.rejects(acquireProfileLock(firefox.profileRoot(externalProfile.id)), (error) => error.code === 'PROFILE_LOCKED');
    await firefox.start(profile('firefox-b', { kernel: 'firefox-reverse' }));
    assert.notEqual(launches[0].options.env.APPDATA, launches[1].options.env.APPDATA);
    assert.notEqual(launches[0].options.env.TEMP, launches[1].options.env.TEMP);
    assert(launches[0].options.env.APPDATA.startsWith(firefox.profileRoot(externalProfile.id) + path.sep));
    for (const entry of launches) entry.child.exitCode = 0;
    await firefox.stopAll();
    const unlocked = await acquireProfileLock(firefox.profileRoot(externalProfile.id));
    await releaseProfileLock(firefox.profileRoot(externalProfile.id), unlocked);
    pass('Firefox concurrent starts share one launch, hold a profile lock and use separate APPDATA/TEMP');

    externalKernel.waitForMarionette = async () => { launches.at(-1).child.exitCode = 1; return false; };
    await assert.rejects(firefox.start(profile('failed', { kernel: 'firefox-reverse' })), /启动失败/);
    assert.equal(firefox.running.has('failed'), false);
    assert.equal(firefox.starting.has('failed'), false);
    const failedLock = await acquireProfileLock(firefox.profileRoot('failed'));
    await releaseProfileLock(firefox.profileRoot('failed'), failedLock);
    firefox.restoringBackup = true;
    await assert.rejects(firefox.start(externalProfile), /备份恢复/);
    firefox.restoringBackup = false;
    pass('failed Firefox startup releases locks and cannot appear running; restore blocks launches');

    const durable = engineAt('durable-save');
    let completeWrite;
    durable.persist = () => new Promise((resolve) => { completeWrite = resolve; });
    let acknowledged = false;
    const durableSave = durable.syncProfiles([profile('saved')], { waitForPersistence: true })
      .then((status) => { acknowledged = true; return status; });
    await Promise.resolve();
    assert.equal(acknowledged, false, 'IPC save cannot succeed before disk persistence');
    completeWrite();
    assert.equal((await durableSave)[0].id, 'saved');
    durable.persist = async () => { throw new Error('synthetic disk write failure'); };
    await assert.rejects(durable.syncProfiles([profile('saved')], { waitForPersistence: true }), /disk write failure/);
    pass('durable profile saves wait for disk completion and report write failures');

    console.log('All profile isolation regression selftests passed.');
  } finally {
    externalKernel.detect = original.detect;
    externalKernel.launch = original.launch;
    externalKernel.waitForMarionette = original.wait;
    for (const engine of engines) {
      for (const item of engine.running.values()) engine.clearRunningWatch(item);
      await engine.persistenceQueue;
    }
    const resolved = path.resolve(testRoot);
    assert.equal(path.dirname(resolved), cacheRoot);
    assert(path.basename(resolved).startsWith('profile-isolation-regression-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
