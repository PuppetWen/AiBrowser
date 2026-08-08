const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
const outputPath = path.join(root, 'native-ui-retest-results.json');
const tests = [
  'Browserapp/firefox-native-sync-selftest.js',
  'Browserapp/mixed-firefox-sync-selftest.js',
  'Browserapp/chromium-ime-sync-selftest.js',
  'Browserapp/four-window-devtools-selftest.js',
  'Browserapp/four-window-extension-sidepanel-selftest.js',
  'Browserapp/four-window-upper-ui-jitter-selftest.js',
  'Browserapp/native-omnibox-selftest.js',
];

const results = tests.map((name) => {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const child = spawnSync(process.execPath, [name], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240000,
    windowsHide: true,
  });
  return {
    name,
    startedAt,
    durationMs: Date.now() - started,
    status: child.status === 0 ? 'PASS' : 'FAIL',
    code: child.status,
    signal: child.signal,
    error: child.error ? child.error.message : null,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
  };
});

const payload = { createdAt: new Date().toISOString(), results };
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`Wrote ${outputPath}\n`);
process.exitCode = results.every((item) => item.status === 'PASS') ? 0 : 1;
