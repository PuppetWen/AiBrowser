const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tests = Object.keys(pkg.scripts)
  .filter((name) => /^selftest:/.test(name))
  .sort()
  .map((name) => ({
    name,
    command: `npm run ${name}`,
    timeoutMs: 120000,
  }));

const extra = [
  { name: 'extension-startup-target-selftest', command: 'node extension-startup-target-selftest.js', timeoutMs: 120000 },
  { name: 'extension-pipe-selftest', command: 'node extension-pipe-selftest.js', timeoutMs: 120000 },
  { name: 'extension-pipe-port-selftest', command: 'node extension-pipe-port-selftest.js', timeoutMs: 120000 },
  { name: 'okx-crx-selftest', command: 'node okx-crx-selftest.js', timeoutMs: 120000 },
  { name: 'proxy-ui-selftest-direct', command: 'node scripts/proxy-ui-selftest.js', timeoutMs: 120000 },
  { name: 'proxy-live-subscription-selftest-direct', command: 'node scripts/proxy-live-subscription-selftest.js', timeoutMs: 120000 },
  { name: 'zoom-window-selftest', command: 'node zoom-window-selftest.js', timeoutMs: 120000 },
  { name: 'newtab-sync-selftest', command: 'node newtab-sync-selftest.js', timeoutMs: 120000 },
  { name: 'four-window-upper-ui-jitter-selftest', command: 'node four-window-upper-ui-jitter-selftest.js', timeoutMs: 120000 },
  { name: 'four-window-tab-click-convergence-selftest', command: 'node four-window-tab-click-convergence-selftest.js', timeoutMs: 120000 },
  { name: 'four-window-extension-sidepanel-selftest', command: 'node four-window-extension-sidepanel-selftest.js', timeoutMs: 120000 },
  { name: 'four-window-extension-popup-selftest', command: 'node four-window-extension-popup-selftest.js', timeoutMs: 120000 },
  { name: 'four-window-devtools-selftest', command: 'node four-window-devtools-selftest.js', timeoutMs: 120000 },
  { name: 'four-window-chrome-menu-selftest', command: 'node four-window-chrome-menu-selftest.js', timeoutMs: 120000 },
];

const queue = [...tests, ...extra];

function runOne(test) {
  const start = Date.now();
  const proc = spawnSync(test.command, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: test.timeoutMs,
    cwd: root,
    env: { ...process.env },
  });

  const durationMs = Date.now() - start;
  const stdout = String(proc.stdout || '');
  const stderr = String(proc.stderr || '');
  let status;
  if (proc.error) {
    if (proc.error.killed || /timed out/i.test(String(proc.error.message))) status = 'TIMEOUT';
    else status = 'FAIL';
  } else if (proc.status === 0) {
    status = /(^|\n)SKIP:/.test(`${stdout}\n${stderr}`) ? 'SKIP' : 'PASS';
  } else {
    status = 'FAIL';
  }

  const note = /(^|\n)SKIP:/.test(`${stdout}\n${stderr}`)
    ? ((stdout.match(/(^|\n)SKIP:[^\n]*/g) || []).map((line) => line.trim()).join(' | '))
    : '';

  return {
    name: test.name,
    command: test.command,
    status,
    code: proc.status ?? null,
    timeoutMs: test.timeoutMs,
    durationMs,
    note,
    stdout: stdout.slice(0, 2500),
    stderr: stderr.slice(0, 2500),
  };
}

const results = [];
for (const test of queue) {
  results.push(runOne(test));
}

fs.writeFileSync(path.join(root, 'full-selftest-run.json'), JSON.stringify({ createdAt: new Date().toISOString(), results }, null, 2));
console.log(results.map((entry) => `${entry.name}: ${entry.status}`).join('\n'));
