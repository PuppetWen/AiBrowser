'use strict';

// Exercise the actual renderer functions with an in-memory DOM/IPC boundary.
// No Electron process, browser profile, account data, or network access is used.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert(start >= 0, `Missing renderer function ${name}`);
  const end = source.indexOf('\n}', start);
  assert(end > start, `Missing end of renderer function ${name}`);
  return source.slice(start, end + 2);
}

const writes = [];
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, { value: '', checked: false });
  return nodes.get(selector);
};
const context = vm.createContext({
  URL, Intl, console,
  UNGROUPED_ID: '',
  ui: { profiles: [{ id: 'existing', number: 1, proxy: 'Direct' }], nextProfileNumber: 2 },
  engineProfiles: [],
  selectedProfiles: new Set(),
  editingProfileId: 'existing',
  editorNetworkResult: null,
  syncSettings: { keyboard: true },
  SYNC_SETTINGS_KEY: 'test-sync',
  localStorage: { setItem: (...args) => writes.push(args) },
  save: () => writes.push(['profiles']),
  findGroup: (id) => id === 'local-group' ? { id } : null,
  normalizeSyncSettings: (value) => ({ ...value }),
  fillSyncSettingsForm() {},
  refreshStatus: async () => {},
  refreshSessions: async () => {},
  renderProfiles() {},
  log() {}, toast() {}, tx: (value) => value,
  $: node,
  document: { querySelector: (selector) => ({ value: selector.includes('editor-network') ? 'direct' : 'fixed' }) },
  window: { ops: {} },
});
for (const name of [
  'positiveProfileNumber', 'normalizeProfileSettings', 'redactProxyForStorage', 'redactProfileForStorage',
  'persistUiProfiles', 'applySyncSettings', 'restoreProfilesFromEngine', 'availableProfileNumbers',
  'createInternalProfileId', 'parseCsvRows', 'parseImportedProfiles', 'prepareImportedProfiles',
  'applySelectedNetworkMode', 'editorSelectedNetwork', 'serializeEditorProxy', 'editorDraft',
]) vm.runInContext(declaration(name), context, { filename: `renderer.js:${name}` });

const plain = (value) => JSON.parse(JSON.stringify(value));

async function run() {
  const original = {
    id: 'existing', number: 1, title: 'saved remotely', kernel: 'firefox-reverse',
    proxy: 'socks5://alice:secret@127.0.0.1:1080', networkMode: 'proxy',
    cookies: '[{"name":"login","value":"synthetic"}]',
    platform: { username: 'alice', password: 'secret', totpSecret: 'test-totp' },
    proxyMeta: { libraryProxyId: 'old-library', backupProxies: ['http://bob:secret@127.0.0.1:8080'], refreshUrl: 'https://example.invalid/refresh?token=test', apiExtractUrl: 'https://example.invalid/proxy?token=test' },
    privacy: { languageMode: 'ja-JP', cores: 0, memory: 0, fingerprint: { seed: 37 } },
    advanced: { saveLocalStorage: false, blockImages: true },
  };
  const cached = context.redactProfileForStorage(original);
  assert.equal(cached._secretsRedacted, true);
  assert.equal(cached.proxy, 'socks5://127.0.0.1:1080');
  assert.equal(cached.cookies, '');
  assert.equal(cached.platform.password, '');
  assert.deepEqual(plain(cached.proxyMeta.backupProxies), []);
  assert.equal(cached.proxyMeta.refreshUrl, '');
  assert.equal(cached.proxyMeta.apiExtractUrl, '');
  const restored = context.restoreProfilesFromEngine([{ ...cached, title: 'stale', kernel: 'chromium' }], [original]);
  assert.equal(restored[0].title, original.title);
  assert.equal(restored[0].kernel, original.kernel);
  assert.equal(restored[0].proxy, original.proxy);
  assert.equal(restored[0].platform.password, original.platform.password);
  assert(!Object.hasOwn(restored[0], '_secretsRedacted'));
  assert.throws(() => context.restoreProfilesFromEngine([cached], null), /读取失败/);
  const cleared = context.normalizeProfileSettings({ ...original, cookies: '', platform: { password: '', totpSecret: '' }, _secretsRedacted: true });
  assert(!Object.hasOwn(cleared, '_secretsRedacted'));
  assert.equal(cleared.platform.password, '');

  const imported = context.prepareImportedProfiles(context.parseImportedProfiles(JSON.stringify([original]), 'json'))[0];
  assert.notEqual(imported.id, original.id);
  assert.match(imported.id, /^env-002-r/);
  assert.equal(imported.kernel, original.kernel);
  assert.equal(imported.cookies, original.cookies);
  assert.equal(imported.platform.totpSecret, original.platform.totpSecret);
  assert.equal(imported.privacy.fingerprint.seed, 37);
  assert.equal(imported.privacy.cores, 0);
  assert.equal(imported.advanced.saveLocalStorage, false);
  assert.equal(imported.proxyMeta.libraryProxyId, '');
  const aliasImport = context.prepareImportedProfiles(context.parseImportedProfiles(JSON.stringify([{
    password: 'alias-password', platformPassword: 'alias-platform-password',
    totpSecret: 'alias-totp', totp_secret: 'alias-totp-snake', otp: 'alias-otp',
    proxyPassword: 'alias-proxy-password', proxy_password: 'alias-proxy-snake',
  }]), 'json'))[0];
  assert.equal(aliasImport.platform.password, 'alias-password');
  assert.equal(aliasImport.platform.totpSecret, 'alias-totp');
  for (const key of ['password', 'platformPassword', 'totpSecret', 'totp_secret', 'otp', 'proxyPassword', 'proxy_password']) {
    assert(!Object.hasOwn(aliasImport, key), `Sensitive import alias ${key} must not survive normalization`);
  }
  assert(!JSON.stringify(context.redactProfileForStorage(aliasImport)).includes('alias-'));
  const aliasesInCache = context.redactProfileForStorage({ ...original, password: 'alias-password', proxyPassword: 'alias-proxy-password' });
  assert(!JSON.stringify(aliasesInCache).includes('alias-'), 'Existing aliases must also be removed from cached profiles');
  assert.throws(() => context.parseImportedProfiles('[null]', 'json'), /对象数组/);
  const csv = '\uFEFFname,username,password,note,language\r\n"Account, A",alice," secret ","line 1\nline ""2""",ja-JP\r\nB,bob,,"",en-US';
  const csvProfiles = context.prepareImportedProfiles(context.parseImportedProfiles(csv, 'csv'));
  assert.equal(csvProfiles.length, 2);
  assert.equal(csvProfiles[0].title, 'Account, A');
  assert.equal(csvProfiles[0].platform.password, ' secret ');
  assert.equal(csvProfiles[0].note, 'line 1\nline "2"');
  assert.equal(csvProfiles[0].privacy.languageMode, 'ja-JP');
  assert.equal(csvProfiles[1].note, '');
  assert.throws(() => context.parseCsvRows('name\n"unclosed'), /未闭合/);

  const oldProfiles = context.ui.profiles;
  context.window.ops.syncProfiles = async () => { throw new Error('rejected save'); };
  await assert.rejects(context.persistUiProfiles([original], 44), /rejected save/);
  assert.strictEqual(context.ui.profiles, oldProfiles);
  assert.equal(context.ui.nextProfileNumber, 2);
  assert.equal(writes.length, 0);
  context.window.ops.syncProfiles = async (profiles) => profiles;
  await context.persistUiProfiles([original], 44);
  assert.equal(context.ui.nextProfileNumber, 44);
  assert.equal(writes.length, 1);

  context.window.ops.setSyncSettings = async () => { throw new Error('sync refused'); };
  await assert.rejects(context.applySyncSettings({ keyboard: false }), /sync refused/);
  assert.equal(context.syncSettings.keyboard, true);
  assert.equal(writes.length, 1);
  context.window.ops.setSyncSettings = async () => {};
  await context.applySyncSettings({ keyboard: false });
  assert.equal(context.syncSettings.keyboard, false);
  assert.equal(writes.length, 2);

  const untouched = { id: 'untouched', number: 3, networkMode: 'direct', proxy: 'Direct' };
  context.ui.profiles = [original, untouched];
  context.selectedProfiles = new Set(['existing']);
  context.window.ops.profileStatus = async () => [{ id: 'existing', running: false }];
  context.verifyProxyAssignments = async () => [{ ip: '192.0.2.4', countryCode: 'JP' }];
  await context.applySelectedNetworkMode('proxy', { proxies: ['http://127.0.0.1:9000'], restart: false });
  assert.equal(context.ui.profiles[0].proxy, 'http://127.0.0.1:9000');
  assert.equal(context.ui.profiles[0].proxyMeta.libraryProxyId, '');
  assert.equal(context.ui.profiles[0].proxyMeta.apiExtractUrl, '');
  assert.deepEqual(plain(context.ui.profiles[0].proxyMeta.backupProxies), []);
  assert.strictEqual(context.ui.profiles[1], untouched);
  assert.equal(original.proxyMeta.libraryProxyId, 'old-library', 'Draft must not mutate saved profile');
  const committed = context.ui.profiles;
  context.window.ops.syncProfiles = async () => { throw new Error('network save refused'); };
  await assert.rejects(context.applySelectedNetworkMode('direct', { restart: false }), /network save refused/);
  assert.strictEqual(context.ui.profiles, committed);
  assert.equal(context.ui.profiles[0].networkMode, 'proxy');

  node('#editor-dnt-mode').value = 'off';
  node('#editor-dnt').checked = true;
  const draft = context.editorDraft(false);
  assert.equal(draft.privacy.dnt, false, 'Turning DNT off must override the stale hidden legacy checkbox');
  assert.equal(draft.privacy.dntMode, 'off');
  const cancelButtons = html.match(/<button\b[^>]*\bvalue="cancel"[^>]*>/g) || [];
  assert(cancelButtons.length > 10);
  assert(cancelButtons.every((button) => /\bformnovalidate\b/.test(button)), 'Invalid required fields must not prevent cancel');
  console.log('RENDERER_SETTINGS_UNIT_SELFTEST_OK: redaction, restore, JSON/CSV import, transactional saves, proxy reassignment, DNT and cancel controls');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
