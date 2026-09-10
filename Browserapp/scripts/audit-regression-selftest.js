'use strict';

// Offline regression suite. Desktop and browser integration tests are separate
// opt-in commands so this suite never operates the user's windows or profiles.
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const tests = [
  'environment-audit-selftest.js',
  'profile-isolation-regression-selftest.js',
  'firefox-retention-selftest.js',
  'settings-backup-regression-selftest.js',
  'renderer-settings-unit-selftest.js',
  'editor-system-defaults-selftest.js',
  'pet-display-geometry-selftest.js',
  'browser-network-regression-selftest.js',
  'automation/fingerprint-override-regression-selftest.js',
  'automation/fingerprint-native-selftest.js',
  'native-fingerprint-engine-selftest.js',
  'fingerprint-failure-lifecycle-selftest.js',
  'automation/automation-selftest.js',
  'automation/cloud-sync-security-selftest.js',
  'automation/local-api-ai-error-selftest.js',
  'automation/protocol/protocol-selftest.js',
  'automation/isolation-fingerprint-selftest.js',
  'automation/fingerprint-stability-selftest.js',
  'automation/kernel-policy-selftest.js',
  'network-mode-selftest.js',
  'proxy-forwarder-selftest.js',
  'proxy-feature-selftest.js',
  'proxy-format-selftest.js',
  'socks5-retry-selftest.js',
  'socks5-reset-selftest.js',
  'browser-startup-diagnostic-selftest.js',
  'fingerprint-inject-order-selftest.js',
  'profile-batch-unit-selftest.js',
  'extension-state-unit-selftest.js',
  'sync-settings-unit-selftest.js',
  'sync-backpressure-unit-selftest.js',
  'tab-mapping-unit-selftest.js',
  'ai/ai-selftest.js',
  'ai/agent-selftest.js',
  'i18n-selftest.js',
  'theme-nes-light-selftest.js',
  'theme-retro-desktop-selftest.js',
  'portable-paths-selftest.js',
];
let failures = 0;
for (const test of tests) {
  const result = spawnSync(process.execPath, [path.join(root, test)], {
    cwd: root, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const success = !result.error && result.status === 0;
  console.log(`${success ? 'PASS' : 'FAIL'} ${test}`);
  if (!success) {
    failures += 1;
    console.error((result.error?.message || '') + '\n' + result.stdout + result.stderr);
  }
}
console.log(`Audit regression: ${tests.length - failures}/${tests.length} passed`);
process.exitCode = failures ? 1 : 0;
