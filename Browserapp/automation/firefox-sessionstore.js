'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { assertSafeProfileChild } = require('./isolation');

const MAGIC = Buffer.from('mozLz40\0', 'binary');
const MAX_BYTES = 64 * 1024 * 1024;

function decodeMozLz4(input) {
  if (!Buffer.isBuffer(input) || input.length < 12 || !input.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid Firefox SessionStore mozLz4 header');
  const size = input.readUInt32LE(8);
  if (size > MAX_BYTES || input.length > MAX_BYTES + Math.ceil(MAX_BYTES / 255) + 32) throw new Error('Firefox SessionStore exceeds the size limit');
  const output = Buffer.alloc(size);
  let source = 12; let target = 0;
  const length = (base) => {
    let result = base;
    if (base === 15) {
      let next;
      do {
        if (source >= input.length) throw new Error('Truncated Firefox SessionStore LZ4 length');
        next = input[source++]; result += next;
        if (result > size) throw new Error('Invalid Firefox SessionStore LZ4 length');
      } while (next === 255);
    }
    return result;
  };
  while (source < input.length) {
    const token = input[source++];
    const literals = length(token >>> 4);
    if (source + literals > input.length || target + literals > size) throw new Error('Firefox SessionStore LZ4 literal exceeds its bounds');
    input.copy(output, target, source, source + literals);
    source += literals; target += literals;
    if (source === input.length) break;
    if (source + 2 > input.length) throw new Error('Truncated Firefox SessionStore LZ4 offset');
    const offset = input.readUInt16LE(source); source += 2;
    if (!offset || offset > target) throw new Error('Invalid Firefox SessionStore LZ4 offset');
    const matched = length(token & 15) + 4;
    if (target + matched > size) throw new Error('Firefox SessionStore LZ4 match exceeds its bounds');
    for (let index = 0; index < matched; index += 1) { output[target] = output[target - offset]; target += 1; }
  }
  if (target !== size) throw new Error('Firefox SessionStore decoded size does not match its header');
  return output;
}

function encodeMozLz4(data) {
  const source = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  if (source.length > MAX_BYTES) throw new Error('Firefox SessionStore exceeds the size limit');
  const lengths = [];
  if (source.length >= 15) {
    let remaining = source.length - 15;
    while (remaining >= 255) { lengths.push(255); remaining -= 255; }
    lengths.push(remaining);
  }
  const header = Buffer.alloc(13 + lengths.length);
  MAGIC.copy(header); header.writeUInt32LE(source.length, 8);
  header[12] = Math.min(source.length, 15) << 4;
  Buffer.from(lengths).copy(header, 13);
  return Buffer.concat([header, source]);
}

function stripSessionCookies(input) {
  const text = new TextDecoder('utf8', { fatal: true }).decode(decodeMozLz4(input));
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Firefox SessionStore JSON object');
  const pending = [value]; let changed = false;
  while (pending.length) {
    const current = pending.pop();
    if (Array.isArray(current.cookies)) { delete current.cookies; changed = true; }
    // Cookies belong to the session/window records. Tab entries, formdata and
    // page storage can contain unrelated user fields also named "cookies".
    for (const key of ['windows', '_closedWindows']) {
      if (Array.isArray(current[key])) {
        for (const window of current[key]) if (window && typeof window === 'object' && !Array.isArray(window)) pending.push(window);
      }
    }
    if (current.state && typeof current.state === 'object' && !Array.isArray(current.state)) pending.push(current.state);
  }
  return { changed, data: changed ? encodeMozLz4(JSON.stringify(value)) : input };
}

async function clearFirefoxSessionCookies(profileRoot) {
  const base = path.join(profileRoot, 'firefox-profile');
  const files = [path.join(base, 'sessionstore.jsonlz4')];
  const backups = await assertSafeProfileChild(profileRoot, path.join(base, 'sessionstore-backups'));
  try {
    for (const entry of await fsp.readdir(backups, { withFileTypes: true })) {
      if (/^(?:recovery\.(?:jsonlz4|baklz4)|previous\.jsonlz4|upgrade\.jsonlz4-[A-Za-z0-9_-]+)$/.test(entry.name)) files.push(path.join(backups, entry.name));
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const updates = [];
  // Validate every recovery file before rewriting any of them.
  for (const file of files) {
    await assertSafeProfileChild(profileRoot, file);
    let stat;
    try { stat = await fsp.stat(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.size > MAX_BYTES + Math.ceil(MAX_BYTES / 255) + 32) throw new Error('Invalid Firefox SessionStore file');
    try {
      const result = stripSessionCookies(await fsp.readFile(file));
      if (result.changed) updates.push({ file, data: result.data });
    } catch (error) { throw new Error('Firefox SessionStore Cookie 清理失败 (' + path.basename(file) + ')：' + error.message); }
  }
  for (const { file, data } of updates) {
    const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    await assertSafeProfileChild(profileRoot, file);
    await assertSafeProfileChild(profileRoot, temporary);
    try {
      await fsp.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await fsp.rename(temporary, file);
    } finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
  }
  return updates.length;
}

module.exports = { decodeMozLz4, encodeMozLz4, stripSessionCookies, clearFirefoxSessionCookies };
