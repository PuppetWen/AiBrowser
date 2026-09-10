'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, 'scripts', 'package-portable.js'), 'utf8');
const start = source.indexOf('function isGeneratedPackageEntry(entry)');
const end = source.indexOf('\n}', start) + 2;
assert(start >= 0 && end > start);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context);
for (const name of ['all-selftest-report.json', 'all-selftests-extra-results-pass2-b1.json',
  'all-selftests-extra-results-pass2.json', 'all-selftests-extra-results.json',
  'remaining-selftest-report.json', 'script-selftest-report.json',
  'tmp-run-all-selftests.js', 'tmp-run-remaining.js', 'startup.log', 'notes.orig']) {
  assert.equal(context.isGeneratedPackageEntry(name), true, name);
}
for (const name of ['package.json', 'package-lock.json', 'main.js', 'pet-display-geometry.js',
  'profile-isolation-regression-selftest.js', 'assets', 'automation', 'pet-runtime']) {
  assert.equal(context.isGeneratedPackageEntry(name), false, name);
}
console.log('PASS packaging excludes local diagnostic files and temporary drivers while retaining app sources');
