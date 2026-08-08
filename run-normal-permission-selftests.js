const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = __dirname;
const outputPath = path.join(root, 'normal-permission-selftest-results.json');
const tests = [
  'Browserapp/automation/wayfern-launch-selftest.js',
  'Browserapp/extension-pipe-port-selftest.js',
  'Browserapp/extension-pipe-selftest.js',
];

const results = tests.map((name) => {
  const started = Date.now();
  const child = spawnSync(process.execPath, [name], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  });
  const output = `${child.stdout || ''}\n${child.stderr || ''}`;
  return {
    name,
    command: `node ${name}`,
    status: child.status === 0 && !/(^|\n)\s*SKIP\b/i.test(output) ? 'PASS' : 'FAIL',
    code: child.status,
    durationMs: Date.now() - started,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    error: child.error ? child.error.message : null,
  };
});

fs.writeFileSync(outputPath, `${JSON.stringify({ createdAt: new Date().toISOString(), context: 'normal Windows user permission', results }, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ outputPath, results }, null, 2)}\n`);
process.exitCode = results.every((item) => item.status === 'PASS') ? 0 : 1;
