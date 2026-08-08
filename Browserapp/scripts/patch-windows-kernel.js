#!/usr/bin/env node
'use strict';

/**
 * Prepare the bundled Wayfern 149 Windows kernel used by AiBrowser.
 *
 * Two patches enable CDP for the independent environment controller. The
 * portable-storage patches make Wayfern's terms marker use Chromium's temp
 * directory instead of Windows CSIDL_APPDATA. AiBrowser always points TEMP
 * at browser-data/cache/temp, keeping the marker inside the package data root.
 *
 * Patches are version-specific and fail closed when the expected bytes do not
 * match. Re-running the script is safe.
 */

const fs = require('fs');
const path = require('path');

const dll = path.resolve(__dirname, '..', 'kernels', 'windows-x64', 'chrome.dll');

const patches = [
  {
    name: 'CDP policy branch',
    offset: 0x37e6551,
    original: '0f84a8010000',
    patched: '909090909090',
  },
  {
    name: 'CDP policy return',
    offset: 0x41fddd0,
    original: '415741',
    patched: 'b001c3',
  },
  {
    name: 'portable terms path fallback',
    offset: 0x2b86d8,
    original: '0f88da000000',
    patched: 'e9db00000090',
  },
  {
    name: 'portable terms path uses DIR_TEMP',
    offset: 0x2b87c0,
    original: 'b907000000',
    patched: 'b906000000',
  },
];

function main() {
  if (!fs.existsSync(dll)) throw new Error(`Windows kernel DLL missing: ${dll}`);
  const data = fs.readFileSync(dll);
  let changed = false;

  for (const item of patches) {
    const original = Buffer.from(item.original, 'hex');
    const patched = Buffer.from(item.patched, 'hex');
    const actual = data.subarray(item.offset, item.offset + original.length);
    if (actual.equals(patched)) {
      console.log(`[kernel-patch] already applied: ${item.name}`);
      continue;
    }
    if (!actual.equals(original)) {
      throw new Error(
        `${item.name} byte mismatch at 0x${item.offset.toString(16)}: `
        + `expected ${item.original} or ${item.patched}, found ${actual.toString('hex')}`
      );
    }
    patched.copy(data, item.offset);
    changed = true;
    console.log(`[kernel-patch] applied: ${item.name}`);
  }

  if (changed) fs.writeFileSync(dll, data);
  console.log(`[kernel-patch] portable Windows kernel ready: ${dll}`);
}

try {
  main();
} catch (error) {
  console.error(`[kernel-patch] ${error.message}`);
  process.exitCode = 1;
}
