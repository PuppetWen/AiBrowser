#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { safePublicErrorMessage } = require('./local-api-server');

assert.strictEqual(
  safePublicErrorMessage(new Error('API Key 来自旧目录，请重新填写')),
  'API Key 来自旧目录，请重新填写',
);
assert.strictEqual(
  safePublicErrorMessage(new Error('upstream Bearer sk-dangerous-secret-value failed')),
  'upstream Bearer *** failed',
);
assert.strictEqual(
  safePublicErrorMessage(new Error('https://example.test/?api_key=secret-value&x=1')),
  'https://example.test/?api_key=***&x=1',
);

console.log('local API AI error selftest passed');
