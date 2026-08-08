#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const bundled = fs.readFileSync(path.join(__dirname, 'bundled-extension', 'marker.js'), 'utf8');
const environment = fs.readFileSync(path.join(__dirname, 'automation', 'env-icon.js'), 'utf8');

assert.ok(!/textContent\s*=\s*['"]OB['"]/.test(bundled), 'ordinary browsing must not inject the OB badge');
assert.ok(
  bundled.includes("document.getElementById('aibrowser-profile-marker')?.remove()"),
  'bundled extension must clean up the legacy badge',
);
assert.ok(
  environment.includes("document.getElementById('aibrowser-profile-marker')?.remove()"),
  'per-environment extension must clean up the legacy badge',
);

console.log('extension marker cleanliness selftest passed');
