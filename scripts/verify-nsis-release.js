'use strict';
// Read-only NSIS non-solid zlib verification. Never executes an installer.
// Container layout is documented in the upstream NSIS fileform implementation:
// https://github.com/NSIS-Dev/nsis/blob/master/Source/exehead/fileform.h
// https://github.com/NSIS-Dev/nsis/blob/master/Source/exehead/fileform.c
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Writable } = require('stream');
const { pipeline } = require('stream/promises');
const assert = require('assert');

const [sourceRootArg, packageRootArg, version, ...artifacts] = process.argv.slice(2);
if (!sourceRootArg || !packageRootArg || !version || !artifacts.length) {
  throw new Error('Usage: node verify-nsis-release.js SOURCE_BROWSERAPP STAGED_PACKAGE_ROOT VERSION EXE...');
}
const sourceRoot = path.resolve(sourceRootArg);
const packageRoot = path.resolve(packageRootArg);
const projectRoot = path.dirname(sourceRoot);
const relativeFiles = ['package.json', 'main.js', 'engine.js', 'cdp.js', 'renderer.js', 'preload.js', 'index.html',
  'automation/privacy-policy.js', 'automation/privacy-gateway.js', 'automation/privacy-firewall.js',
  'automation/fingerprint.js', 'automation/start-page-server.js', 'automation/external-kernel.js',
  'automation/mihomo-manager.js', 'scripts/privacy-firewall.ps1'];
const expectedFiles = relativeFiles.map(relative => ({ name: path.basename(relative), source: path.join(sourceRoot, relative), relative }));
for (const relative of ['README.md', 'README.zh-CN.md']) expectedFiles.push({ name: relative, source: path.join(projectRoot, relative), relative });
expectedFiles.push({ name: 'RELEASE-NOTES.md', source: path.join(projectRoot, 'docs', 'releases', `v${version}.md`), relative: 'RELEASE-NOTES.md' });
expectedFiles.push({ name: 'AiBrowser.exe', source: path.join(packageRoot, 'AiBrowser.exe'), relative: 'AiBrowser.exe' });

async function hashFile(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function readAt(fd, position, length) {
  const buffer = Buffer.alloc(length);
  assert.equal(fs.readSync(fd, buffer, 0, length, position), length, 'Unexpected archive EOF');
  return buffer;
}
function findContainer(fd, fileSize) {
  const prefix = readAt(fd, 0, Math.min(fileSize, 16 * 1024 * 1024));
  for (let offset = 512; offset + 28 <= prefix.length; offset += 512) {
    if (prefix.readUInt32LE(offset + 4) !== 0xdeadbeef || prefix.subarray(offset + 8, offset + 20).toString('ascii') !== 'NullsoftInst') continue;
    const flags = prefix.readUInt32LE(offset), headerSize = prefix.readUInt32LE(offset + 20), totalSize = prefix.readUInt32LE(offset + 24);
    assert(!(flags & ~15) && headerSize > 0 && headerSize < 64 * 1024 * 1024, 'Invalid NSIS first header');
    assert(totalSize >= 32 && offset + totalSize <= fileSize, 'Invalid NSIS bounds');
    const end = offset + totalSize - ((flags & 4) ? 0 : 4);
    const marker = readAt(fd, offset + 28, 4).readUInt32LE();
    const compressed = Boolean(marker & 0x80000000), storedSize = marker & 0x7fffffff;
    assert(storedSize > 0 && storedSize <= 32 * 1024 * 1024 && offset + 32 + storedSize <= end, 'Unsupported or invalid NSIS header block');
    const stored = readAt(fd, offset + 32, storedSize);
    const header = compressed ? zlib.inflateRawSync(stored, { maxOutputLength: 64 * 1024 * 1024 }) : stored;
    assert.equal(header.length, headerSize, 'NSIS header length mismatch (solid compression unsupported)');
    return { header, dataStart: offset + 32 + storedSize, end };
  }
  throw new Error('No valid aligned NSIS container found');
}
function filenamesAndBlocks(container) {
  const header = container.header;
  // The installed NSIS Unicode stub is 32-bit; block table entries are 8 bytes.
  const entriesOffset = header.readUInt32LE(20), entriesCount = header.readUInt32LE(24), stringsOffset = header.readUInt32LE(28);
  assert(entriesCount > 0 && entriesCount < 1000000 && entriesOffset + entriesCount * 28 <= header.length, 'Invalid NSIS instruction table');
  assert(stringsOffset > 0 && stringsOffset < header.length, 'Invalid NSIS string table');
  const stringAt = index => {
    let at = stringsOffset + index * 2;
    assert(at >= stringsOffset && at < header.length, 'Invalid filename pointer');
    const start = at;
    while (at + 2 <= header.length && header.readUInt16LE(at) && at - start <= 8192) at += 2;
    assert(at + 2 <= header.length && at - start <= 8192, 'Unterminated NSIS filename');
    return header.subarray(start, at).toString('utf16le');
  };
  const files = [], privateDirectories = [];
  for (let index = 0; index < entriesCount; index++) {
    const at = entriesOffset + index * 28, opcode = header.readUInt32LE(at);
    if (opcode === 20) {
      const name = stringAt(header.readInt32LE(at + 8)), block = header.readUInt32LE(at + 12);
      assert(container.dataStart + block + 4 <= container.end, 'Invalid NSIS file block pointer');
      assert(!/^(Cookies|Login Data|History|Local State|user\.js|prefs\.js|sessionstore\.jsonlz4|\.env(?:\..*)?)$/i.test(path.win32.basename(name)), 'NSIS contains browser state or environment secrets');
      files.push({ name, basename: path.win32.basename(name), block });
    }
    if (opcode === 11) {
      const name = stringAt(header.readInt32LE(at + 4));
      if (/(^|[\\/])(browser-data|rpa-output|\.cache)([\\/]|$)/i.test(name)) privateDirectories.push(name);
    }
  }
  assert(!privateDirectories.length, 'NSIS contains a private data directory');
  assert(files.length > 0, 'No NSIS file extraction instructions found');
  return files;
}
async function hashBlock(artifact, fd, container, block, maxOutput) {
  const at = container.dataStart + block, marker = readAt(fd, at, 4).readUInt32LE();
  const size = marker & 0x7fffffff, compressed = Boolean(marker & 0x80000000);
  assert(at + 4 + size <= container.end, 'NSIS file extends beyond container');
  const digest = crypto.createHash('sha256');
  let bytes = 0;
  const sink = new Writable({ write(chunk, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxOutput) { callback(new Error('NSIS output exceeds expected source size')); return; }
    digest.update(chunk); callback();
  } });
  if (size) {
    const input = fs.createReadStream(artifact, { start: at + 4, end: at + 3 + size });
    if (compressed) await pipeline(input, zlib.createInflateRaw(), sink);
    else await pipeline(input, sink);
  }
  return { digest: digest.digest('hex'), bytes };
}
(async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version, version, 'Source version mismatch');
  for (const expected of expectedFiles) {
    expected.size = fs.statSync(expected.source).size;
    expected.digest = await hashFile(expected.source);
  }
  for (const artifactArg of artifacts) {
    const artifact = path.resolve(artifactArg), fd = fs.openSync(artifact, 'r');
    try {
      const container = findContainer(fd, fs.fstatSync(fd).size), files = filenamesAndBlocks(container), verified = [];
      for (const expected of expectedFiles) {
        const candidates = files.filter(file => file.basename.toLowerCase() === expected.name.toLowerCase());
        let matching = null;
        for (const file of candidates) {
          try {
            const value = await hashBlock(artifact, fd, container, file.block, expected.size);
            if (value.bytes === expected.size && value.digest === expected.digest) { matching = file; break; }
          } catch (error) { if (!/exceeds expected source size/.test(error.message)) throw error; }
        }
        assert(matching, `Missing or outdated embedded content: ${expected.relative}`);
        verified.push({ file: expected.relative, sha256: expected.digest });
      }
      console.log(JSON.stringify({ artifact: path.basename(artifact), version, fileInstructions: files.length,
        verified, privateDataDirectories: 0, mode: 'read-only NSIS payload hashes; no executable run' }));
    } finally { fs.closeSync(fd); }
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
