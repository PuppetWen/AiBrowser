'use strict';

const assert = require('assert');
const { buildFingerprint, applyFingerprintToTab } = require('./fingerprint');

async function main() {
  const apply = async (profile) => {
    const calls = [];
    const fp = buildFingerprint({ id: 'fingerprint-override-regression', ...profile });
    await applyFingerprintToTab(async (method, params) => { calls.push({ method, params }); return {}; }, null, fp, profile);
    return { fp, calls, geo: calls.find((call) => call.method === 'Emulation.setGeolocationOverride')?.params };
  };
  for (const profile of [
    { privacy: { geoMode: 'ip' }, exitLatitude: null, exitLongitude: null },
    { privacy: { geoMode: 'ip' }, exitLatitude: '', exitLongitude: ' ' },
    { privacy: { geoMode: 'custom', latitude: null, longitude: null } },
    { privacy: { geoMode: 'custom', latitude: ' ', longitude: '' }, exitLatitude: 35, exitLongitude: 120 },
    { privacy: { geoMode: 'custom', latitude: 91, longitude: 181 } },
    { privacy: { geoMode: 'custom', latitude: false, longitude: true } },
    { privacy: { geoMode: 'disabled' }, exitLatitude: 35, exitLongitude: 120 },
    { privacy: { geoMode: 'prompt' }, exitLatitude: 35, exitLongitude: 120 },
  ]) {
    const { fp, geo } = await apply(profile);
    assert.strictEqual(fp.dynamicConfig.geoposition, null);
    assert.strictEqual(geo, undefined, 'missing/invalid coordinates must never become a (0, 0) override');
  }
  for (const profile of [
    { privacy: { geoMode: 'custom', latitude: 0, longitude: 0 } },
    { privacy: { geoMode: 'custom', latitude: '35.5', longitude: '120', accuracy: 50 } },
    { privacy: { geoMode: 'ip' }, exitLatitude: 0, exitLongitude: -180 },
    { privacy: { geoMode: 'ip' }, exitLatitude: 90, exitLongitude: 180 },
  ]) {
    const { fp, geo } = await apply(profile);
    assert.deepStrictEqual(geo, fp.dynamicConfig.geoposition, 'CDP and native fingerprint location must agree');
  }

  const fp = buildFingerprint({ id: 'registration-regression' });
  let registrations = 0;
  let evaluated = false;
  await assert.rejects(() => applyFingerprintToTab(async (method) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      registrations += 1;
      throw new Error('Target does not support document scripts');
    }
    if (method === 'Runtime.evaluate') evaluated = true;
    return {};
  }, null, fp), (error) => error.documentStartOk === false && /document-start registration failed/.test(error.message));
  assert.strictEqual(registrations, 2, 'transient registration errors should receive one retry');
  assert.strictEqual(evaluated, false, 'current-document evaluation cannot substitute for future document protection');

  registrations = 0;
  await applyFingerprintToTab(async (method) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && ++registrations === 1) throw new Error('temporary target error');
    return {};
  }, null, fp);
  assert.strictEqual(registrations, 2);
  console.log('FINGERPRINT_OVERRIDE_REGRESSION_SELFTEST_OK missing_coordinates=1 valid_zero=1 valid_bounds=1 geo_consistency=1 registration_failure=1 registration_retry=1');
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
