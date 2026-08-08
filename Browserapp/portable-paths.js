'use strict';

const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

const DATA_CHILDREN = new Set([
  'appdata',
  'blob_storage',
  'browser-profiles-v2',
  'cache',
  'code cache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'env-markers',
  'extensions',
  'gpucache',
  'kernels',
  'local storage',
  'localappdata',
  'mihomo-runtime',
  'network',
  'partitions',
  'proxy-runtime',
  'session storage',
  'shared dictionary',
  'tools',
  'wayfern-appdata',
]);

function decodePath(value) {
  const raw = String(value || '').trim();
  if (!/^file:/i.test(raw)) return raw;
  try { return fileURLToPath(raw); } catch (_) { return raw; }
}

function safeSuffix(parts) {
  if (!parts.length) return [];
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  return parts;
}

function splitPath(value) {
  return decodePath(value).replace(/\\/g, '/').split('/').filter(Boolean);
}

function candidateAfterSegment(value, segment, root) {
  if (!root) return null;
  const parts = splitPath(value);
  const lower = parts.map((part) => part.toLowerCase());
  const index = lower.lastIndexOf(String(segment).toLowerCase());
  if (index < 0) return null;
  const suffix = safeSuffix(parts.slice(index + 1));
  return suffix ? path.join(path.resolve(root), ...suffix) : null;
}

function candidateFromLegacyAiBrowserData(value, userDataRoot) {
  if (!userDataRoot) return null;
  const parts = splitPath(value);
  const lower = parts.map((part) => part.toLowerCase());
  for (let index = lower.length - 2; index >= 0; index -= 1) {
    if (lower[index] !== 'aibrowser' || !DATA_CHILDREN.has(lower[index + 1])) continue;
    const suffix = safeSuffix(parts.slice(index + 1));
    return suffix ? path.join(path.resolve(userDataRoot), ...suffix) : null;
  }
  return null;
}

/**
 * Rebase a path saved by another copy of the source tree.
 *
 * Only well-known project anchors are rewritten. Custom storage locations and
 * user-selected files outside AiBrowser remain untouched.
 */
function rebasePortablePath(value, options = {}) {
  const original = decodePath(value);
  if (!original) return original;

  const appRoot = options.appRoot ? path.resolve(options.appRoot) : null;
  const userDataRoot = options.userDataRoot ? path.resolve(options.userDataRoot) : null;
  const candidates = [
    candidateAfterSegment(original, 'Browserapp', appRoot),
    candidateAfterSegment(original, 'browser-data', userDataRoot),
    candidateFromLegacyAiBrowserData(original, userDataRoot),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (options.requireExisting === false || fs.existsSync(candidate)) return path.normalize(candidate);
  }
  return original;
}

function rebasePortableFileUrl(value, options = {}) {
  const raw = String(value || '').trim();
  if (!/^file:/i.test(raw)) return raw;
  const rebased = rebasePortablePath(raw, options);
  try { return pathToFileURL(rebased).toString(); } catch (_) { return raw; }
}

/**
 * Project-local user-data root, or null when this is not a portable tree.
 *
 * Mirrors the detection in main.js so code that runs *outside* the desktop host
 * (self-tests, log readers, CLI scripts) resolves to the same place instead of
 * falling through to %APPDATA% / ~/Library and writing outside the project.
 */
function portableUserDataRoot() {
  const configured = String(process.env.OPENBROWSER_USER_DATA || '').trim();
  if (configured) return path.resolve(configured);
  const projectRoot = path.resolve(__dirname, '..');
  const portable = String(process.env.OPENBROWSER_PORTABLE || '').trim() === '1'
    || fs.existsSync(path.join(projectRoot, 'start-test.cmd'));
  return portable ? path.join(projectRoot, 'browser-data') : null;
}

module.exports = {
  rebasePortablePath,
  rebasePortableFileUrl,
  portableUserDataRoot,
};
