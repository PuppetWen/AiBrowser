'use strict';

const assert = require('assert');
const vm = require('vm');
const {
  isNativeFingerprintProfile,
  buildFingerprint,
  buildInjectionScript,
  buildWorkerInjectionScript,
  chromeArgsForFingerprint,
  applyFingerprintToTab,
  fingerprintConsistencyIssues,
} = require('./fingerprint');

async function main() {
  const configured = {
    id: 'native-regression',
    userAgent: 'Custom browser identity',
    width: 900, height: 600, language: 'ja-JP', exitTimezone: 'Asia/Tokyo',
    privacy: {
      timezoneMode: 'custom', timezone: 'Asia/Tokyo',
      geoMode: 'custom', latitude: 10, longitude: 20,
      webrtc: 'disabled', canvas: 'noise', webgl: 'blocked', audio: 'muted', dnt: true,
      fingerprint: { userAgent: 'Nested custom identity', cores: 32, memory: 64, canvasId: 123 },
    },
  };
  const nativeProfile = { ...configured, privacy: { ...configured.privacy, fingerprintMode: 'native' } };
  const before = JSON.stringify(nativeProfile);
  const native = buildFingerprint(nativeProfile);
  assert.deepStrictEqual(native, { native: true, mode: 'native' }, 'native mode cannot advertise synthetic expected values');
  assert.strictEqual(JSON.stringify(nativeProfile), before, 'selecting native behavior must not mutate persisted settings');
  assert.deepStrictEqual(fingerprintConsistencyIssues(native), { ok: true, issues: [] });

  const guardedProfile = new Proxy({ privacy: { fingerprintMode: 'native' } }, {
    get(target, key) {
      assert.strictEqual(key, 'privacy', 'native mode must not read seed or custom identity inputs');
      return target[key];
    },
  });
  assert.deepStrictEqual(buildFingerprint(guardedProfile), native);
  assert.strictEqual(isNativeFingerprintProfile(nativeProfile), true);
  for (const value of [undefined, null, false, 'custom', 'NATIVE', 'random']) {
    assert.strictEqual(isNativeFingerprintProfile({ privacy: { fingerprintMode: value } }), false);
  }

  const custom = buildFingerprint(configured);
  assert.deepStrictEqual(
    buildFingerprint({ ...configured, privacy: { ...configured.privacy, fingerprintMode: 'custom' } }),
    custom,
    'existing profiles and explicitly custom profiles must retain the same generated identity'
  );
  assert.strictEqual(typeof custom.userAgent, 'string');
  assert.ok(custom.screen && custom.uaProfile && custom.seed);

  for (const makeScript of [buildInjectionScript, buildWorkerInjectionScript]) {
    const script = makeScript(native);
    assert.strictEqual(script, '');
    const context = vm.createContext({});
    vm.runInContext(`globalThis.originalDefineProperty = Object.defineProperty;
      globalThis.navigator = Object.freeze({ userAgent: 'Browser supplied UA', hardwareConcurrency: 7 });`, context);
    vm.runInContext(script, context);
    assert.strictEqual(vm.runInContext('Object.defineProperty === originalDefineProperty', context), true);
    assert.strictEqual(vm.runInContext('navigator.userAgent', context), 'Browser supplied UA');
    assert.ok(makeScript(custom).length > 0, 'custom mode should retain its document and worker injection');
  }

  assert.deepStrictEqual(chromeArgsForFingerprint(native, configured), []);
  assert.deepStrictEqual(chromeArgsForFingerprint(custom, nativeProfile), [], 'native profile must suppress stale custom fingerprint arguments');
  assert.ok(chromeArgsForFingerprint(custom, configured).some((arg) => arg.startsWith('--user-agent=')));
  let calls = 0;
  const neverCall = async () => { calls += 1; throw new Error('native mode must not contact CDP to change browser identity'); };
  await applyFingerprintToTab(neverCall, null, native, configured);
  await applyFingerprintToTab(neverCall, 'ws://unused', native, configured);
  await applyFingerprintToTab(neverCall, null, custom, nativeProfile);
  assert.strictEqual(calls, 0);

  const customCalls = [];
  await applyFingerprintToTab(async (method) => { customCalls.push(method); return {}; }, null, custom, configured);
  assert.ok(customCalls.includes('Emulation.setUserAgentOverride'));
  assert.ok(customCalls.includes('Page.addScriptToEvaluateOnNewDocument'));
  console.log('FINGERPRINT_NATIVE_SELFTEST_OK native_values=1 no_identity_reads=1 no_scripts=1 no_args=1 no_cdp=1 custom_unchanged=1');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
