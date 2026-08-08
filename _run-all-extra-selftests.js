const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const files = execSync('rg --files -g "*selftest.js" Browserapp')
  .toString()
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((file) => !file.includes('dist\\') && !file.includes('dist/'))
  .sort();

const packageScriptFiles = new Set([
  'Browserapp/automation/automation-selftest.js',
  'Browserapp/automation/cloud-sync-security-selftest.js',
  'Browserapp/automation/isolation-fingerprint-selftest.js',
  'Browserapp/automation/kernel-policy-selftest.js',
  'Browserapp/automation/kernel-init-sync-selftest.js',
  'Browserapp/automation/kernel-cdp-ready-selftest.js',
  'Browserapp/automation/ip-health-score-selftest.js',
  'Browserapp/automation/proxy-subscription-selftest.js',
  'Browserapp/automation/fingerprint-stability-selftest.js',
  'Browserapp/automation/env-icon-selftest.js',
  'Browserapp/automation/local-api-ai-error-selftest.js',
  'Browserapp/automation/wayfern-launch-selftest.js',
  'Browserapp/automation/protocol/protocol-selftest.js',
  'Browserapp/ai/ai-selftest.js',
  'Browserapp/ai/agent-selftest.js',
  'Browserapp/chromium-ime-sync-selftest.js',
  'Browserapp/desktop-packaging-ui-selftest.js',
  'Browserapp/extension-marker-cleanliness-selftest.js',
  'Browserapp/extension-storage-selftest.js',
  'Browserapp/firefox-kernel-selftest.js',
  'Browserapp/firefox-native-sync-selftest.js',
  'Browserapp/mixed-firefox-sync-selftest.js',
  'Browserapp/native-secret-store-selftest.js',
  'Browserapp/network-mode-selftest.js',
  'Browserapp/portable-paths-selftest.js',
  'Browserapp/rpa-marketplace-flow-selftest.js',
  'Browserapp/rpa-wayfern-compat-selftest.js',
  'Browserapp/browser-startup-diagnostic-selftest.js',
  'Browserapp/sync-console-selftest.js',
  'Browserapp/theme-nes-light-selftest.js',
  'Browserapp/theme-retro-desktop-selftest.js',
  'Browserapp/store-batch-four-selftest.js',
  'Browserapp/security-hardening-selftest.js',
  'Browserapp/selftest.js',
  'Browserapp/scripts/ensure-host-runtime-selftest.js',
  'Browserapp/scripts/proxy-live-subscription-selftest.js',
  'Browserapp/scripts/proxy-ui-selftest.js',
]);

const extraFiles = files.filter((file) => !packageScriptFiles.has(file));

const tests = extraFiles.map((file) => ({
  name: file,
  command: `node ${file}`,
  timeoutMs: 180000,
}));

const results = [];
for (const test of tests) {
  const start = Date.now();
  const proc = spawnSync(test.command, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: test.timeoutMs,
    cwd: process.cwd(),
  });
  const durationMs = Date.now() - start;
  const stdout = String(proc.stdout || '');
  const stderr = String(proc.stderr || '');
  const status = proc.error ? (proc.error.killed || /timed out/i.test(String(proc.error.message)) ? 'TIMEOUT' : 'FAIL')
    : (proc.status === 0 ? 'PASS' : 'FAIL');

  results.push({
    name: test.name,
    command: test.command,
    status,
    code: proc.status ?? null,
    durationMs,
    stdout: stdout.slice(0, 2500),
    stderr: stderr.slice(0, 2500),
  });
}

fs.writeFileSync('all-selftests-extra-results.json', JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2));
console.log(results.map((entry) => `${entry.name}: ${entry.status} (${entry.code ?? 'timeout'})`).join('\n'));
if (results.some((entry) => entry.status !== 'PASS')) process.exitCode = 1;
