'use strict';

// Synthetic profiles and mocked process/CDP boundaries only. No real accounts.
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const fingerprint = require('./automation/fingerprint');
const { writeAiBrowserKernelInit, loadInitObject } = require('./automation/kernel-init-sync');
const { StartPageServer } = require('./automation/start-page-server');

const filename = require.resolve('./engine');
const requireLocal = createRequire(filename);
const calls = [];
const launches = [];
const preparations = [];
const context = {
  process, Buffer, URL, __dirname, module: { exports: {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  require: (id) => {
    if (id === './automation/fingerprint') return {
      ...fingerprint,
      applyFingerprintToTab: async () => { throw new Error('native mode reached fingerprint injection'); },
      buildWorkerInjectionScript: () => { throw new Error('native mode reached worker generation'); },
    };
    if (id === './cdp') return {
      tabs: async () => [{ id: 'page', webSocketDebuggerUrl: 'ws://synthetic', url: 'about:blank' }],
      call: async (_url, method, params) => { calls.push({ method, params }); return {}; },
    };
    if (id === 'child_process') return {
      spawn: (binary, args, options) => {
        launches.push({ binary, args, options });
        throw new Error('STOP_AT_SYNTHETIC_SPAWN');
      },
      execFileSync: () => { throw new Error('Real process inspection forbidden'); },
    };
    if (id === './automation/env-icon') return { ...requireLocal(id), prepareMarkerExtension: async () => null };
    if (id === './automation/browser-kernel') return {
      ...requireLocal(id), ensureKernelReadyForLaunch: async (_browser, _output, options) => { preparations.push(options); },
    };
    if (id === './automation/fingerprint-debug-log') return { ...requireLocal(id), fpLog: async () => {} };
    return requireLocal(id);
  },
};
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
const { BrowserEngine } = context.module.exports;

async function main() {
  const cacheRoot = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(cacheRoot, { recursive: true });
  const testRoot = await fsp.mkdtemp(path.join(cacheRoot, 'native-fingerprint-engine-'));
  try {
    const engine = new BrowserEngine({ getPath: () => testRoot });
    engine.emit = () => {};
    const raw = {
      id: 'native-profile', name: 'Native fixture', networkMode: 'direct', language: 'fr-FR', userAgent: 'stale-user-agent',
      privacy: { fingerprintMode: 'native', webrtc: 'real', cores: 6, memory: 8, canvas: 'noise', media: 'blocked', geoMode: 'disabled', fontMode: 'custom', fontSize: 21, refreshFingerprintOnStart: true, stabilityMode: 'off' },
      advanced: { showInfoPage: false, blockUrls: 'https://blocked.invalid/*' },
    };
    const profile = engine.sanitizeProfile(raw);
    assert.equal(profile.privacy.fingerprintMode, 'native');
    assert.equal(engine.sanitizeProfile({ id: 'custom-default', name: 'Default' }).privacy.fingerprintMode, 'custom');
    assert.equal(engine.sanitizeProfile({ id: 'bad-mode', name: 'Invalid mode', privacy: { fingerprintMode: 'not-valid' } }).privacy.fingerprintMode, 'custom');
    engine.profiles.set(profile.id, profile);
    await engine.persist();
    assert.equal(JSON.parse(await fsp.readFile(engine.stateFile, 'utf8')).profiles[0].privacy.fingerprintMode, 'native');
    assert.equal(engine.needsExitNetworkForLocale(profile), false);
    assert.equal(engine.applyResolvedLocale(profile), profile);
    const patch = engine.fingerprintPatchFromNetwork({ countryCode: 'JP', timezone: 'Asia/Tokyo' }, profile);
    assert.equal(patch.language, undefined);
    assert.equal(patch.privacy, undefined);
    console.log('PASS native mode persists and never resolves identity from exit IP');

    const root = engine.profileRoot(profile.id);
    await fsp.mkdir(path.join(root, 'Default'), { recursive: true });
    const prefsFile = path.join(root, 'Default', 'Preferences');
    await fsp.writeFile(prefsFile, JSON.stringify({
      intl: { accept_languages: 'fr-FR,fr', selected_languages: 'fr-FR' },
      profile: {
        default_content_setting_values: { geolocation: 2, media_stream_mic: 2, media_stream_camera: 2 },
        content_settings: { exceptions: { geolocation: { 'https://fixture.invalid,*': { setting: 1 } } } },
      },
      webkit: { webprefs: { default_font_size: 21 } },
    }));
    await engine.applyProfilePreferences(root, profile);
    const prefs = JSON.parse(await fsp.readFile(prefsFile, 'utf8'));
    assert.equal(prefs.intl.accept_languages, undefined);
    assert.equal(prefs.intl.selected_languages, undefined);
    assert.equal(prefs.webkit.webprefs.default_font_size, undefined);
    assert.equal(prefs.profile.default_content_setting_values.geolocation, undefined);
    assert.equal(prefs.profile.default_content_setting_values.media_stream_mic, undefined);
    assert.equal(prefs.profile.content_settings.exceptions.geolocation['https://fixture.invalid,*'].setting, 1);
    console.log('PASS native preferences remove global overrides and preserve site permissions');

    const native = fingerprint.buildFingerprint(profile);
    const item = { profile, fingerprint: native };
    await engine.applyRuntimeSettings(123, profile, { userAgent: 'stale-custom-fp' }, { trackOn: item });
    assert.equal(item.fingerprint.native, true);
    assert.equal(item.fingerprint.userAgent, undefined);
    assert.deepEqual(calls.map((entry) => entry.method), ['Network.enable', 'Network.setBlockedURLs']);
    assert.equal(calls[1].params.urls[0], 'https://blocked.invalid/*');
    calls.length = 0;
    await engine.startWorkerFingerprintInjection(item, native);
    await engine.applyFingerprintToSession({}, 'session', item, native);
    await engine.ensureStartPageFingerprint(item, profile, native, 'about:blank');
    assert.equal(calls.length, 0);
    const protect = engine.sanitizeProfile({ ...raw, privacy: { ...raw.privacy, portScanProtect: true } });
    await engine.applyRuntimeSettings(123, protect, native);
    assert.ok(calls.some((entry) => entry.method === 'Network.setBlockedURLs'));
    assert.ok(calls.some((entry) => entry.method === 'Page.addScriptToEvaluateOnNewDocument' && entry.params.source.includes('Port scan blocked')));
    assert.ok(calls.every((entry) => !/setUserAgent|setDeviceMetrics|setTimezone|setGeolocation/.test(entry.method)));
    console.log('PASS runtime preserves explicit network protections without fingerprint/worker/reinject hooks');

    const custom = engine.sanitizeProfile({ ...raw, privacy: { ...raw.privacy, fingerprintMode: 'custom' } });
    await writeAiBrowserKernelInit(root, { profile: custom, fingerprint: fingerprint.buildFingerprint(custom) });
    const customInit = loadInitObject(await fsp.readFile(path.join(root, 'init.json')));
    assert.ok(customInit.user_agent_data);
    customInit.token = 'synthetic-token';
    customInit.unknown_old_identity_field = 'must-not-survive';
    await fsp.writeFile(path.join(root, 'init.json'), JSON.stringify(customInit));
    const written = await writeAiBrowserKernelInit(root, { profile, fingerprint: native });
    const init = written.init;
    for (const key of ['user_agent_data', 'platform', 'hardwareConcurrency', 'deviceMemory', 'webgl_vendor', 'webgl_renderer', 'webgpu_parameter', 'battery', 'accept_languages', 'unknown_old_identity_field']) assert.equal(init[key], undefined, key);
    assert.equal(init.cmd_line['user-agent'], undefined);
    assert.equal(init.cmd_line.lange, undefined);
    assert.equal(init.token, 'synthetic-token');
    assert.equal(init.allow_remote_debugging, true);
    assert.equal(init.canvas_fingerprint_keep_consistent_setting.enable, false);
    assert.equal(init.is_audio_finger_printing_enable, false);
    assert.equal(init.is_enumerate_devices_enable, false);
    assert.equal(init.webrtc_policy, 1);
    console.log('PASS custom-to-native kernel init retains management but clears previous identities');

    const welcome = new StartPageServer();
    welcome.port = 12345; // register only; never opens a listener.
    welcome.registerSession(profile, { expectedFingerprint: { userAgent: 'old-ua', hardwareConcurrency: 64 } });
    assert.deepEqual(welcome.sessions.get(profile.id).expectedFingerprint, { native: true });
    welcome.registerSession(custom, { expectedFingerprint: { userAgent: 'custom-ua', hardwareConcurrency: 64 } });
    assert.equal(welcome.sessions.get(custom.id).expectedFingerprint.userAgent, 'custom-ua');
    assert.equal(welcome.sessions.get(custom.id).expectedFingerprint.hardwareConcurrency, 64);
    console.log('PASS welcome page native mode never falls back to old identity or editor dimensions');

    engine.prepareProfileProxyForStart = async (value) => value;
    engine.ensureExitNetworkForLocale = async () => {};
    engine.assignedExtensions = () => [];
    engine.kernelStatus = () => ({ installed: true });
    engine.chooseBrowser = () => ({ name: 'Synthetic Chromium', path: path.join(testRoot, 'synthetic-browser.exe'), version: '149.0.0.0', source: 'test-kernel' });
    for (const candidate of [profile, { ...custom, id: 'custom-profile' }]) {
      await assert.rejects(engine.startProfile(candidate), /STOP_AT_SYNTHETIC_SPAWN/);
    }
    assert.equal(launches.length, 2);
    assert.ok(launches[0].args.includes('--proxy-server=direct://'));
    assert.ok(!launches[0].args.some((arg) => /^--(user-agent|lang|window-size|fingerprint|force-color-profile)=/.test(arg)));
    assert.ok(launches[1].args.some((arg) => arg.startsWith('--user-agent=')), 'custom mode still uses configured fingerprint');
    for (let index = 0; index < launches.length; index++) {
      const launch = launches[index];
      const profileRoot = launch.args.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
      assert.equal(typeof launch.options.env.then, 'undefined', 'spawn env must be resolved, not a Promise');
      for (const key of ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.ok(path.relative(profileRoot, launch.options.env[key]).startsWith('..') === false);
      assert.equal(preparations[index].userDataPath, profileRoot, 'kernel preparation and actual spawn must share the same isolated temp root');
    }
    assert.notEqual(launches[0].options.env.TEMP, launches[1].options.env.TEMP);
    console.log('PASS production launch builds native args and resolves per-profile process environment');
  } finally {
    // mkdtemp path is checked before recursive cleanup.
    assert.ok(path.relative(cacheRoot, testRoot).startsWith('native-fingerprint-engine-'));
    await fsp.rm(testRoot, { recursive: true, force: true });
  }
  console.log('NATIVE_FINGERPRINT_ENGINE_SELFTEST_OK groups=6');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
