'use strict';

// Firefox file names follow the bundled kernel and Mozilla's profile reference:
// https://support.mozilla.org/en-US/kb/profiles-where-firefox-stores-user-data
// Quota clients stay separate: https://searchfox.org/firefox-main/source/dom/quota/Client.h
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserEngine } = require('./engine');
const externalKernel = require('./automation/external-kernel');
const { decodeMozLz4, encodeMozLz4, stripSessionCookies, clearFirefoxSessionCookies } = require('./automation/firefox-sessionstore');

async function main() {
  const cacheRoot = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(cacheRoot, { recursive: true });
  const testRoot = await fsp.mkdtemp(path.join(cacheRoot, 'firefox-retention-'));
  const engine = new BrowserEngine({ getPath: () => path.join(testRoot, 'app') });
  const original = { detect: externalKernel.detect, launch: externalKernel.launch, wait: externalKernel.waitForMarionette };
  const allSaved = { saveCookies: true, savePasswords: true, saveLocalStorage: true, saveIndexedDB: true, saveHistory: true, saveBookmarks: true };
  const profile = (id, advanced = {}) => engine.sanitizeProfile({ id, name: id, kernel: 'firefox-reverse', advanced: { ...allSaved, ...advanced } });
  const rootOf = (id) => engine.profileRoot(id);
  const fileOf = (id, file) => path.join(rootOf(id), 'firefox-profile', file);
  const exists = (id, file) => fs.existsSync(fileOf(id, file));
  const write = async (id, file, data = 'synthetic-data') => {
    const target = fileOf(id, file); await fsp.mkdir(path.dirname(target), { recursive: true }); await fsp.writeFile(target, data);
  };
  const session = { windows: [{ tabs: [{ entries: [{ url: 'https://example.invalid/', title: 'keep tab', cookies: ['keep page payload'] }], formdata: { cookies: ['keep form field'], id: { cookies: ['checkbox-a', 'checkbox-b'] } }, storage: { cookies: ['keep page storage'] } }], cookies: [{ host: 'example.invalid', name: 'session', value: 'synthetic' }] }], cookies: [{ name: 'other', value: 'synthetic' }], _closedWindows: [{ cookies: [], state: { cookies: [], tabs: [] } }], selectedWindow: 1 };
  const expectedSession = JSON.parse(JSON.stringify(session));
  delete expectedSession.cookies; delete expectedSession.windows[0].cookies; delete expectedSession._closedWindows[0].cookies; delete expectedSession._closedWindows[0].state.cookies;
  const pass = (name) => console.log('PASS ' + name);
  try {
    for (const data of ['{}', 'x'.repeat(15), 'x'.repeat(300), JSON.stringify(session)]) assert.equal(decodeMozLz4(encodeMozLz4(data)).toString(), data);
    const compressed = Buffer.concat([Buffer.from('mozLz40\0', 'binary'), Buffer.from([13, 0, 0, 0, 0x35, 97, 98, 99, 3, 0, 0x10, 33])]);
    assert.equal(decodeMozLz4(compressed).toString(), 'abcabcabcabc!');
    const extendedMatch = Buffer.concat([Buffer.from('mozLz40\0', 'binary'), Buffer.from([48, 1, 0, 0, 0x1f, 97, 1, 0, 255, 25, 0x40, 100, 111, 110, 101])]);
    assert.equal(decodeMozLz4(extendedMatch).toString(), 'a'.repeat(300) + 'done');
    const result = stripSessionCookies(encodeMozLz4(JSON.stringify(session)));
    assert(result.changed);
    assert.deepEqual(JSON.parse(decodeMozLz4(result.data).toString()), expectedSession);
    assert.equal(stripSessionCookies(result.data).changed, false);
    pass('mozLz4 literal, overlapping/extended matches and cookie removal preserve tabs, history and form fields');

    const tooLarge = Buffer.from(compressed); tooLarge.writeUInt32LE(64 * 1024 * 1024 + 1, 8);
    const zeroOffset = Buffer.from(compressed); zeroOffset.writeUInt16LE(0, 16);
    const beforeStart = Buffer.from(compressed); beforeStart.writeUInt16LE(4, 16);
    const overflow = Buffer.from(compressed); overflow.writeUInt32LE(5, 8);
    for (const invalid of [Buffer.from('garbage'), tooLarge, zeroOffset, beforeStart, overflow, compressed.subarray(0, 17), compressed.subarray(0, -1)]) assert.throws(() => decodeMozLz4(invalid));
    assert.throws(() => stripSessionCookies(encodeMozLz4('{bad-json')));
    assert.throws(() => stripSessionCookies(encodeMozLz4(Buffer.from([0xff]))));
    pass('malformed headers, size declarations, offsets, truncated blocks, UTF-8 and JSON fail visibly');

    const id = 'clear'; engine.profiles.set(id, profile(id));
    const sessions = ['sessionstore.jsonlz4', 'sessionstore-backups/recovery.jsonlz4', 'sessionstore-backups/recovery.baklz4', 'sessionstore-backups/previous.jsonlz4', 'sessionstore-backups/upgrade.jsonlz4-20260908'];
    for (const file of sessions) await write(id, file, encodeMozLz4(JSON.stringify(session)));
    const removable = ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm', 'cache2/entry', 'startupCache/startupCache.8.little', 'storage/default/http+++example.invalid/cache/cache.sqlite'];
    const retained = ['storage/default/http+++example.invalid/ls/data.sqlite', 'storage/default/http+++example.invalid/idb/data.sqlite', 'storage/default/http+++example.invalid/.metadata-v2', 'places.sqlite', 'logins.json', 'key4.db', 'cert9.db'];
    for (const file of [...removable, ...retained]) await write(id, file);
    await engine.clearProfileCacheAndCookies(id);
    for (const file of removable) assert(!exists(id, file), file + ' should be removed');
    for (const file of retained) assert(exists(id, file), file + ' must be retained');
    for (const file of sessions) assert.deepEqual(JSON.parse(decodeMozLz4(await fsp.readFile(fileOf(id, file))).toString()), expectedSession);
    pass('clear-cache/Cookie clears Firefox files and every recovery cookie copy while preserving LS, IDB, passwords, bookmarks and tabs');

    await write(id, 'sessionstore-backups/recovery.baklz4', Buffer.from('corrupt'));
    await write(id, 'sessionstore.jsonlz4', encodeMozLz4(JSON.stringify(session)));
    await assert.rejects(clearFirefoxSessionCookies(rootOf(id)), /Cookie 清理失败/);
    assert.deepEqual(JSON.parse(decodeMozLz4(await fsp.readFile(fileOf(id, 'sessionstore.jsonlz4'))).toString()), session);
    await fsp.rm(fileOf(id, 'sessionstore-backups/recovery.baklz4'));
    const persist = engine.persist;
    engine.persist = async () => { throw new Error('synthetic persist failure'); };
    await assert.rejects(engine.clearProfileCacheAndCookies(id), /synthetic persist failure/);
    engine.persist = persist;
    pass('corrupt recovery data and failed configuration writes cannot report successful Cookie removal');

    for (const option of ['saveLocalStorage', 'saveIndexedDB']) {
      const testId = option.toLowerCase();
      for (const repo of ['default', 'temporary', 'permanent']) for (const client of ['ls', 'idb', 'cache']) await write(testId, `storage/${repo}/https+++example.invalid/${client}/data.sqlite`);
      await write(testId, 'webappsstore.sqlite'); await write(testId, 'storage/ls-archive.sqlite');
      await engine.enforceDataRetention(rootOf(testId), profile(testId, { [option]: false }));
      const removedClient = option === 'saveLocalStorage' ? 'ls' : 'idb';
      for (const repo of ['default', 'temporary', 'permanent']) for (const client of ['ls', 'idb', 'cache']) assert.equal(exists(testId, `storage/${repo}/https+++example.invalid/${client}/data.sqlite`), client !== removedClient);
      assert.equal(exists(testId, 'webappsstore.sqlite'), option !== 'saveLocalStorage');
    }
    const passwordId = 'passwords';
    for (const file of ['logins.json', 'logins-backup.json', 'key4.db', 'cert9.db']) await write(passwordId, file);
    await engine.enforceDataRetention(rootOf(passwordId), profile(passwordId, { savePasswords: false }));
    assert(!exists(passwordId, 'logins.json') && !exists(passwordId, 'logins-backup.json'));
    assert(exists(passwordId, 'key4.db') && exists(passwordId, 'cert9.db'));
    pass('localStorage/IndexedDB retention targets only its own client; password deletion preserves certificate keys');

    const placesId = 'places'; await write(placesId, 'places.sqlite'); await write(placesId, 'cookies.sqlite');
    for (const option of ['saveHistory', 'saveBookmarks']) await assert.rejects(engine.enforceDataRetention(rootOf(placesId), profile(placesId, { [option]: false, saveCookies: false })), /共用数据库/);
    assert(exists(placesId, 'places.sqlite') && exists(placesId, 'cookies.sqlite'));
    await engine.enforceDataRetention(rootOf(placesId), profile(placesId, { saveHistory: false, saveBookmarks: false }));
    assert(!exists(placesId, 'places.sqlite') && exists(placesId, 'cookies.sqlite'));
    pass('independent history/bookmark removal is rejected before any deletion; joint removal preserves cookies');

    engine.prepareProfileProxyForStart = async (value) => value;
    engine.ensureExitNetworkForLocale = async () => {};
    engine.applyResolvedLocale = (value) => value;
    let launches = 0;
    externalKernel.detect = () => ({ binary: path.join(testRoot, 'synthetic-firefox.exe') });
    externalKernel.launch = async () => { launches += 1; const child = new EventEmitter(); child.pid = 123456789; child.exitCode = null; child.signalCode = null; return { child, pid: child.pid, launcherPid: child.pid, marionettePort: 29299 }; };
    externalKernel.waitForMarionette = async () => true;
    await assert.rejects(engine.start(profile('unsupported', { saveHistory: false })), /共用数据库/);
    assert.equal(launches, 0);
    const lifecycle = profile('lifecycle', { saveCookies: false, clearCacheOnStart: true });
    await write(lifecycle.id, 'cookies.sqlite'); await write(lifecycle.id, 'cache2/old');
    await engine.start(lifecycle);
    assert(!exists(lifecycle.id, 'cookies.sqlite') && !exists(lifecycle.id, 'cache2/old'));
    await write(lifecycle.id, 'cookies.sqlite'); await write(lifecycle.id, 'sessionstore.jsonlz4', encodeMozLz4(JSON.stringify(session)));
    engine.running.get(lifecycle.id).child.exitCode = 0;
    await engine.stop(lifecycle.id);
    assert(!exists(lifecycle.id, 'cookies.sqlite'));
    assert.deepEqual(JSON.parse(decodeMozLz4(await fsp.readFile(fileOf(lifecycle.id, 'sessionstore.jsonlz4'))).toString()), expectedSession);
    await engine.start(profile('natural-close', { saveCookies: false }));
    await write('natural-close', 'cookies.sqlite');
    const naturallyClosed = engine.running.get('natural-close');
    naturallyClosed.child.exitCode = 0;
    naturallyClosed.child.emit('exit', 0, null);
    await naturallyClosed.cleanup();
    assert(!exists('natural-close', 'cookies.sqlite') && !engine.running.has('natural-close'));
    const errors = []; engine.on((event) => { if (event.type === 'sync-error') errors.push(event); });
    await engine.start(profile('failed-close'));
    engine.profiles.set('failed-close', profile('failed-close', { saveHistory: false }));
    engine.running.get('failed-close').child.exitCode = 0;
    await assert.rejects(engine.stop('failed-close'), /共用数据库/);
    assert(errors.some((event) => event.action === 'data-retention'));
    assert(!engine.running.has('failed-close'));
    pass('Firefox startup, explicit stop and natural exit run retention; unsupported settings and close failures remain visible');
    console.log('All Firefox retention selftests passed.');
  } finally {
    externalKernel.detect = original.detect; externalKernel.launch = original.launch; externalKernel.waitForMarionette = original.wait;
    for (const item of engine.running.values()) engine.clearRunningWatch(item);
    await engine.persistenceQueue;
    assert.equal(path.dirname(path.resolve(testRoot)), cacheRoot);
    assert(path.basename(testRoot).startsWith('firefox-retention-'));
    await fsp.rm(testRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
