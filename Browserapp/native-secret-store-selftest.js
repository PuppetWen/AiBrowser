#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.platform !== 'win32') {
  console.log('native secret store selftest skipped outside Windows');
  process.exit(0);
}

const helper = path.join(__dirname, 'native-secret-store.exe');
const secret = '本机迁移密钥-selftest-123';

function run(action, input) {
  const result = spawnSync(helper, [action], { input, encoding: 'utf8', windowsHide: true, shell: false });
  assert.strictEqual(result.status, 0, String(result.stderr || result.error || 'native helper failed'));
  return String(result.stdout || '').trim();
}

const encrypted = run('encrypt', Buffer.from(secret, 'utf8').toString('base64'));
assert.ok(encrypted && !encrypted.includes(secret));
const plainBase64 = run('decrypt', encrypted);
assert.strictEqual(Buffer.from(plainBase64, 'base64').toString('utf8'), secret);

console.log('native secret store selftest passed');
