function guardBrokenConsolePipe() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (error) => {
      if (error?.code === 'EPIPE') return;
    });
  }
  for (const method of ['log', 'info', 'warn', 'error']) {
    const original = console[method]?.bind(console);
    if (!original) continue;
    console[method] = (...args) => {
      try { original(...args); } catch (error) {
        if (error?.code !== 'EPIPE') throw error;
      }
    };
  }
}
guardBrokenConsolePipe();

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, session, shell } = require('./host-bridge');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');
const { spawn, execFile } = require('child_process');
const { randomUUID } = require('crypto');
const cdp = require('./cdp');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const { startAutomation } = require('./automation');
const { AiService } = require('./ai/ai-service');
const cloudSync = require('./automation/cloud-sync');
const { validateDataRootIsolationSecure, ensureDataRootIsolationSecure, assertProfileId } = require('./automation/isolation');
const { rebasePortablePath } = require('./portable-paths');
const { parseProxy } = require('./proxy-forwarder');
const { resolveSystemProxy } = require('./automation/system-proxy');
const hostRoamingAppData = String(process.env.APPDATA || '').trim();
const hostStartMenuPrograms = String(process.env.OPENBROWSER_START_MENU_PROGRAMS || '').trim()
  || (hostRoamingAppData
    ? path.join(hostRoamingAppData, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : '');

const sourceProjectRoot = path.resolve(__dirname, '..');
const packagedProjectRoot = (() => {
  if (process.platform !== 'win32') return null;
  const executableDir = path.dirname(process.execPath);
  const resourcesApp = path.join(executableDir, 'resources', 'app');
  if (!fs.existsSync(resourcesApp)) return null;
  // New packages put the real, branded Electron executable at the package
  // root. Keep the legacy runtime/ layout readable for existing users.
  return path.basename(executableDir).toLowerCase() === 'runtime'
    ? path.dirname(executableDir)
    : executableDir;
})();
const configuredUserDataRoot = String(process.env.OPENBROWSER_USER_DATA || '').trim();
const configuredProjectRoot = String(process.env.OPENBROWSER_PROJECT_ROOT || '').trim();
const sourceTreePortable = fs.existsSync(path.join(sourceProjectRoot, 'start-test.cmd'));
const portableProjectRoot = configuredProjectRoot
  ? path.resolve(configuredProjectRoot)
  : sourceTreePortable
    ? sourceProjectRoot
    : packagedProjectRoot;
const portableSourceMode = String(process.env.OPENBROWSER_PORTABLE || '').trim() === '1'
  || Boolean(portableProjectRoot);
const appDataRoot = app.getPath('appData');
const userDataRoot = configuredUserDataRoot
  ? path.resolve(configuredUserDataRoot)
  : portableSourceMode
    ? path.join(portableProjectRoot || sourceProjectRoot, 'browser-data')
    : path.join(appDataRoot, 'aibrowser');
if (portableSourceMode) {
  const projectRoot = portableProjectRoot || sourceProjectRoot;
  const portableCacheRoot = path.join(projectRoot, '.cache');
  const portableDirectories = {
    APPDATA: path.join(userDataRoot, 'appdata'),
    LOCALAPPDATA: path.join(userDataRoot, 'localappdata'),
    TEMP: path.join(portableCacheRoot, 'temp'),
    TMP: path.join(portableCacheRoot, 'temp'),
  };
  process.env.OPENBROWSER_PROJECT_ROOT = projectRoot;
  process.env.OPENBROWSER_USER_DATA = userDataRoot;
  for (const [name, directory] of Object.entries(portableDirectories)) {
    process.env[name] = directory;
    try { fs.mkdirSync(directory, { recursive: true }); } catch (_) {}
  }
}
app.setName('AiBrowser');
if (process.platform === 'win32') {
  // A stable explicit AppUserModelID keeps pinned shortcuts and running
  // windows in the same Windows taskbar group after upgrades/moves.
  try { app.setAppUserModelId('com.aibrowser.localworkspace'); } catch (_) { /* ignore */ }
}
try { process.title = 'AiBrowser'; } catch (_) { /* ignore */ }
// Guard: root/sudo would isolate configs under /var/root and break CPU/memory UI sync.
try {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (uid === 0 || euid === 0) {
    console.error('[AiBrowser] refuse to run as root/sudo — userData would split from normal user profiles.');
    app.exit(2);
  }
} catch (_) { /* ignore */ }
app.setPath('userData', userDataRoot);
// Persistent Electron partitions used for Chrome Web Store downloads must stay
// with the portable project as well (for example openbrowser-extension-store).
try { app.setPath('sessionData', userDataRoot); } catch (_) {}
if (portableSourceMode) {
  const projectRoot = portableProjectRoot || sourceProjectRoot;
  const pathOverrides = {
    appData: path.join(userDataRoot, 'appdata'),
    cache: path.join(projectRoot, '.cache', 'electron'),
    crashDumps: path.join(userDataRoot, 'crash-dumps'),
    downloads: path.join(userDataRoot, 'downloads'),
    temp: path.join(projectRoot, '.cache', 'temp'),
  };
  for (const [name, directory] of Object.entries(pathOverrides)) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      app.setPath(name, directory);
    } catch (error) {
      console.warn(`[AiBrowser] could not localize ${name}:`, error.message || error);
    }
  }
  const logRoot = path.join(userDataRoot, 'logs');
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    app.setAppLogsPath(logRoot);
  } catch (error) {
    console.warn('[AiBrowser] could not localize logs:', error.message || error);
  }
}

const defaultProfileDataRoot = path.join(app.getPath('userData'), 'browser-profiles-v2');
const localSettingsFile = path.join(app.getPath('userData'), 'openbrowser-local-settings.json');

const UPDATE_REPOSITORY = 'PuppetWen/AiBrowser';
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const UPDATE_LATEST_HTML = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`;
const UPDATE_RELEASES_ATOM = `https://github.com/${UPDATE_REPOSITORY}/releases.atom`;
const UPDATE_ASSETS = Object.freeze({
  'darwin:x64': 'AiBrowser-macOS-x86_64.dmg',
  'darwin:arm64': 'AiBrowser-macOS-arm64-with-kernel.dmg',
  'win32:x64': 'AiBrowser-Windows-x86_64-with-kernel-Setup.exe',
});
// Current integrated-kernel Windows packages are larger than 1 GiB. Keep a
// bounded ceiling while allowing the signed release installer to download.
const UPDATE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const UPDATE_TIMEOUT_MS = 20000;
const UPDATE_ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

function updatePlatformKey() {
  return `${process.platform}:${process.arch}`;
}

function updateAssetName() {
  return UPDATE_ASSETS[updatePlatformKey()] || null;
}

/**
 * Electron's default session follows the operating-system proxy configuration,
 * including a local HTTP/SOCKS proxy and PAC rules. Keep global fetch only as a
 * development-host fallback.
 */
function fetchAppUpdate(url, options = {}) {
  const sessionFetch = session?.defaultSession?.fetch;
  if (typeof sessionFetch === 'function') return sessionFetch.call(session.defaultSession, url, options);
  return fetch(url, options);
}

async function resolveAppUpdateNetwork() {
  const [configured, route] = await Promise.all([
    resolveSystemProxy().catch(() => ({ enabled: false, source: 'unavailable' })),
    session?.defaultSession?.resolveProxy?.(UPDATE_LATEST_HTML).catch(() => ''),
  ]);
  const resolvedRoute = String(route || '').trim() || 'DIRECT';
  const usesProxy = !/^DIRECT(?:;|$)/i.test(resolvedRoute) || Boolean(configured?.enabled);
  return {
    mode: usesProxy ? 'system-proxy' : 'direct',
    route: resolvedRoute,
    source: String(configured?.source || 'electron-session'),
  };
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/);
    if (!match) return null;
    return { numbers: [match[1], match[2], match[3]].map((part) => Number(part || 0)), pre: match[4] ? match[4].split('.') : [] };
  };
  const a = parse(left); const b = parse(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.pre.length && !b.pre.length) return 0;
  if (!a.pre.length) return 1;
  if (!b.pre.length) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < length; index += 1) {
    if (a.pre[index] == null) return -1;
    if (b.pre[index] == null) return 1;
    if (a.pre[index] === b.pre[index]) continue;
    const aNumber = /^\d+$/.test(a.pre[index]); const bNumber = /^\d+$/.test(b.pre[index]);
    if (aNumber && bNumber) return Number(a.pre[index]) > Number(b.pre[index]) ? 1 : -1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.pre[index] > b.pre[index] ? 1 : -1;
  }
  return 0;
}

function updateUrlIsAllowed(value, assetName) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    const pathName = decodeURIComponent(url.pathname);
    const endsWithAsset = pathName.endsWith('/' + assetName) || pathName.endsWith(assetName);
    if (!endsWithAsset) return false;
    return UPDATE_ALLOWED_HOSTS.has(url.hostname)
      || (url.hostname === 'github.com' && pathName.includes('/releases/download/'));
  } catch (_) {
    return false;
  }
}

function updateUserAgent() {
  return `AiBrowser/${app.getVersion()} (+https://github.com/${UPDATE_REPOSITORY})`;
}

function normalizeRemoteTag(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function metaFromTag(tag, source, releaseUrl) {
  const remoteVersion = normalizeRemoteTag(tag);
  if (!remoteVersion) return null;
  return {
    remoteVersion,
    releaseName: remoteVersion,
    releaseUrl: releaseUrl || `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${remoteVersion}`,
    source,
  };
}

/**
 * Resolve latest release tag without relying solely on GitHub API
 * (unauthenticated REST hits rate limits → false "unknown/yellow" light).
 * Priority: Atom feed → HTML follow/redirect → REST API.
 */
async function resolveLatestReleaseMeta() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  const htmlHeaders = { 'User-Agent': updateUserAgent(), Accept: 'text/html,application/xhtml+xml,*/*' };
  try {
    // 1) Atom feed — no API quota, works in Electron without redirect:manual quirks
    try {
      const response = await fetchAppUpdate(UPDATE_RELEASES_ATOM, {
        headers: { 'User-Agent': updateUserAgent(), Accept: 'application/atom+xml,application/xml,text/xml,*/*' },
        signal: controller.signal,
      });
      if (response.ok) {
        const atom = await response.text();
        // Prefer entry-level ids/links (first entry is newest)
        const entry = atom.match(/<entry\b[\s\S]*?<\/entry>/i)?.[0] || atom;
        const fromAtom = entry.match(/\/releases\/tag\/([^<"'\s]+)/i)
          || entry.match(/<id>tag:github\.com,\d+:Repository\/\d+\/([^<]+)<\/id>/i)
          || atom.match(/\/releases\/tag\/([^<"'\s]+)/i);
        const meta = fromAtom ? metaFromTag(decodeURIComponent(fromAtom[1]), 'atom') : null;
        if (meta) return meta;
      }
    } catch (_) { /* try next */ }

    // 2) /releases/latest — follow redirects; final URL or body contains /releases/tag/vX.Y.Z
    //    (prefer follow over manual: Electron Chromium often hides Location on opaqueredirect)
    try {
      const response = await fetchAppUpdate(UPDATE_LATEST_HTML, {
        method: 'GET',
        redirect: 'follow',
        headers: htmlHeaders,
        signal: controller.signal,
      });
      const finalUrl = String(response.url || '');
      const fromUrl = finalUrl.match(/\/releases\/tag\/([^/?#]+)/i);
      if (fromUrl) {
        const meta = metaFromTag(decodeURIComponent(fromUrl[1]), 'html-url', finalUrl);
        if (meta) return meta;
      }
      if (response.ok) {
        const html = await response.text();
        const fromHtml = html.match(/\/releases\/tag\/(v?[\w.-]+)/i);
        const meta = fromHtml ? metaFromTag(fromHtml[1], 'html') : null;
        if (meta) return meta;
      }
    } catch (_) { /* try next */ }

    // 2b) manual redirect Location (Node undici / some hosts)
    try {
      const response = await fetchAppUpdate(UPDATE_LATEST_HTML, {
        method: 'GET',
        redirect: 'manual',
        headers: htmlHeaders,
        signal: controller.signal,
      });
      const location = response.headers.get('location') || response.headers.get('Location') || '';
      const fromLoc = location.match(/\/releases\/tag\/([^/?#]+)/i);
      if (fromLoc) {
        const abs = location.startsWith('http') ? location : `https://github.com${location}`;
        const meta = metaFromTag(decodeURIComponent(fromLoc[1]), 'redirect', abs);
        if (meta) return meta;
      }
    } catch (_) { /* try next */ }

    // 3) REST API (last resort; unauthenticated often 403 rate-limit)
    const response = await fetchAppUpdate(UPDATE_API_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': updateUserAgent(),
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub Releases request failed (${response.status})`);
    const release = await response.json();
    const tag = normalizeRemoteTag(release.tag_name || release.name || '');
    if (!tag) throw new Error('GitHub Release has no version tag');
    return {
      remoteVersion: tag,
      releaseName: String(release.name || release.tag_name || tag),
      releaseUrl: String(release.html_url || `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${tag}`),
      source: 'api',
      apiRelease: release,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveReleaseAsset(remoteVersion, assetName) {
  if (!assetName || !remoteVersion) return null;
  const directUrl = `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${remoteVersion}/${assetName}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
    try {
      const response = await fetchAppUpdate(directUrl, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': updateUserAgent() },
        signal: controller.signal,
      });
      if (response.ok) {
        return {
          name: assetName,
          size: Number(response.headers.get('content-length')) || 0,
          browser_download_url: directUrl,
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (_) { /* optional */ }

  // HEAD can be blocked or redirected differently by GitHub's edge. Resolve
  // the exact tagged release through the API before declaring the asset absent.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
    try {
      const apiUrl = `${UPDATE_API_URL.replace(/\/latest$/, '')}/tags/v${encodeURIComponent(remoteVersion)}`;
      const response = await fetchAppUpdate(apiUrl, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': updateUserAgent() },
        signal: controller.signal,
      });
      if (response.ok) {
        const release = await response.json();
        const asset = Array.isArray(release.assets)
          ? release.assets.find((item) => item?.name === assetName)
          : null;
        if (asset?.browser_download_url && updateUrlIsAllowed(asset.browser_download_url, assetName)) {
          return {
            name: asset.name,
            size: Number(asset.size) || 0,
            browser_download_url: asset.browser_download_url,
          };
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (_) { /* unavailable release metadata */ }
  return null;
}

/** @deprecated use resolveLatestReleaseMeta — kept for download path compatibility */
async function fetchUpdateRelease() {
  const meta = await resolveLatestReleaseMeta();
  if (meta.apiRelease) return meta.apiRelease;
  return {
    tag_name: `v${meta.remoteVersion}`,
    name: meta.releaseName,
    html_url: meta.releaseUrl,
    assets: [],
  };
}

/**
 * Version traffic light only needs remote tag vs app.getVersion().
 * Download package availability is optional (canDownload).
 * green = up to date; red = remote is newer.
 */
async function checkAppUpdate() {
  const assetName = updateAssetName();
  const currentVersion = app.getVersion();
  const [meta, network] = await Promise.all([
    resolveLatestReleaseMeta(),
    resolveAppUpdateNetwork(),
  ]);
  const remoteVersion = meta.remoteVersion;
  if (!remoteVersion) throw new Error('GitHub Release has no version tag');
  const upToDate = compareVersions(remoteVersion, currentVersion) <= 0;
  let asset = null;
  if (assetName) {
    asset = await resolveReleaseAsset(remoteVersion, assetName);
    // Prefer API asset URL if present
    if (meta.apiRelease && Array.isArray(meta.apiRelease.assets)) {
      const fromApi = meta.apiRelease.assets.find((item) => item?.name === assetName);
      if (fromApi?.browser_download_url && updateUrlIsAllowed(fromApi.browser_download_url, assetName)) {
        asset = { name: fromApi.name, size: Number(fromApi.size) || 0, browser_download_url: fromApi.browser_download_url };
      }
    }
  }
  return {
    // supported = can show green/red for this build (always when we resolved a remote tag)
    supported: true,
    canDownload: Boolean(assetName && asset?.browser_download_url),
    repository: UPDATE_REPOSITORY,
    currentVersion,
    remoteVersion,
    upToDate,
    releaseName: meta.releaseName || remoteVersion,
    releaseUrl: meta.releaseUrl || `https://github.com/${UPDATE_REPOSITORY}/releases`,
    platform: process.platform,
    arch: process.arch,
    source: meta.source || 'unknown',
    network,
    asset: asset ? { name: asset.name, size: asset.size || 0, browser_download_url: asset.browser_download_url } : null,
  };
}

async function downloadAppUpdate() {
  const result = await checkAppUpdate();
  if (!result.canDownload || !result.asset?.name) throw new Error('This platform has no published AiBrowser installer package');
  if (result.upToDate) return { success: false, upToDate: true, version: result.currentVersion, assetName: result.asset.name };
  const downloadUrl = result.asset.browser_download_url
    || `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${result.remoteVersion}/${result.asset.name}`;
  if (!updateUrlIsAllowed(downloadUrl, result.asset.name)) throw new Error('The selected update package URL is not trusted');
  const controller = new AbortController();
  // Idle timeout (reset on every received chunk) — a fixed wall-clock cap would
  // abort large installer downloads on slow connections.
  const UPDATE_IDLE_TIMEOUT_MS = 120000;
  let timer = setTimeout(() => controller.abort(), UPDATE_IDLE_TIMEOUT_MS);
  const resetIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), UPDATE_IDLE_TIMEOUT_MS);
  };
  const extension = path.extname(result.asset.name).toLowerCase();
  const baseName = path.basename(result.asset.name, extension);
  const temporaryPath = path.join(app.getPath('downloads'), `${baseName}-${randomUUID()}${extension}`);
  let received = 0;
  try {
    const response = await fetchAppUpdate(downloadUrl, {
      headers: { Accept: 'application/octet-stream', 'User-Agent': `AiBrowser/${app.getVersion()}` },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Update download failed (${response.status})`);
    const contentLength = Number(response.headers.get('content-length')) || 0;
    if (contentLength > UPDATE_MAX_BYTES) throw new Error('Update package is too large');
    await fsp.mkdir(path.dirname(temporaryPath), { recursive: true });
    const file = await fsp.open(temporaryPath, 'w');
    try {
      const reader = response.body.getReader();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        resetIdleTimer();
        received += chunk.value.byteLength;
        if (received > UPDATE_MAX_BYTES) throw new Error('Update package is too large');
        await file.write(Buffer.from(chunk.value));
        emit({ type: 'app-update-progress', received, total: contentLength || result.asset.size || 0, percent: contentLength ? Math.min(100, Math.round(received / contentLength * 100)) : null, version: result.remoteVersion });
      }
    } finally {
      await file.close();
    }
    emit({ type: 'app-update-progress', received, total: contentLength || result.asset.size || received, percent: 100, version: result.remoteVersion });
    const openError = await shell.openPath(temporaryPath);
    if (openError) shell.showItemInFolder(temporaryPath);
    return { success: true, path: temporaryPath, version: result.remoteVersion, assetName: result.asset.name };
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}


/** Last GitHub Releases check; pushed to UI as traffic-light status. */
let lastAppUpdateStatus = null;
let appUpdateWatchTimer = null;
const APP_UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
const APP_UPDATE_STARTUP_DELAY_MS = 2500;
const APP_UPDATE_CACHE_FILE = path.join(app.getPath('userData'), 'openbrowser-update-status.json');

function appUpdateLightFromResult(result) {
  // Product rule: green = latest, red = update available.
  // Never use yellow for "I am latest". Failed checks without cache → gray "unknown".
  if (!result) return 'unknown';
  if (result.remoteVersion != null && result.currentVersion != null && result.upToDate != null) {
    return result.upToDate ? 'green' : 'red';
  }
  return 'unknown';
}

async function loadCachedAppUpdateStatus() {
  try {
    const raw = JSON.parse(await fsp.readFile(APP_UPDATE_CACHE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.remoteVersion == null || raw.upToDate == null) return null;
    // Cache only useful if it was for this same local version
    if (raw.currentVersion && String(raw.currentVersion) !== String(app.getVersion())) return null;
    lastAppUpdateStatus = {
      supported: true,
      canDownload: Boolean(raw.canDownload),
      repository: UPDATE_REPOSITORY,
      currentVersion: String(raw.currentVersion || app.getVersion()),
      remoteVersion: String(raw.remoteVersion),
      upToDate: Boolean(raw.upToDate),
      releaseName: raw.releaseName || raw.remoteVersion,
      releaseUrl: raw.releaseUrl || `https://github.com/${UPDATE_REPOSITORY}/releases`,
      platform: process.platform,
      arch: process.arch,
      source: raw.source || 'cache',
      asset: raw.asset || null,
      cachedAt: raw.checkedAt || null,
    };
    return lastAppUpdateStatus;
  } catch (_) {
    return null;
  }
}

async function saveCachedAppUpdateStatus(result) {
  if (!result || result.remoteVersion == null || result.upToDate == null) return;
  try {
    await fsp.mkdir(path.dirname(APP_UPDATE_CACHE_FILE), { recursive: true });
    const payload = {
      currentVersion: result.currentVersion,
      remoteVersion: result.remoteVersion,
      upToDate: result.upToDate,
      canDownload: result.canDownload,
      releaseName: result.releaseName,
      releaseUrl: result.releaseUrl,
      source: result.source,
      network: result.network || null,
      asset: result.asset || null,
      checkedAt: new Date().toISOString(),
    };
    const temporary = APP_UPDATE_CACHE_FILE + '.tmp';
    await fsp.writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rm(APP_UPDATE_CACHE_FILE, { force: true });
    await fsp.rename(temporary, APP_UPDATE_CACHE_FILE);
  } catch (_) { /* non-fatal */ }
}

/**
 * Check GitHub latest release and push status to all windows (traffic light).
 * green = up to date; red = newer release available; unknown = check failed (gray).
 */
async function pushAppUpdateStatus({ check = true } = {}) {
  try {
    const result = check ? await checkAppUpdate() : lastAppUpdateStatus;
    if (!result) {
      const cached = lastAppUpdateStatus;
      if (cached?.remoteVersion != null && cached.upToDate != null) {
        const payload = {
          type: 'app-update-status',
          light: cached.upToDate ? 'green' : 'red',
          checkedAt: new Date().toISOString(),
          ...cached,
          stale: true,
        };
        emit(payload);
        return payload;
      }
      const payload = {
        type: 'app-update-status',
        light: 'unknown',
        currentVersion: app.getVersion(),
        checkedAt: new Date().toISOString(),
      };
      emit(payload);
      return payload;
    }
    lastAppUpdateStatus = { ...result, error: null };
    await saveCachedAppUpdateStatus(lastAppUpdateStatus);
    const payload = {
      type: 'app-update-status',
      light: appUpdateLightFromResult(result),
      checkedAt: new Date().toISOString(),
      ...result,
    };
    emit(payload);
    return payload;
  } catch (error) {
    // Prefer last successful green/red over a confusing amber "error" light
    if (lastAppUpdateStatus?.remoteVersion != null && lastAppUpdateStatus.upToDate != null) {
      const payload = {
        type: 'app-update-status',
        light: lastAppUpdateStatus.upToDate ? 'green' : 'red',
        checkedAt: new Date().toISOString(),
        ...lastAppUpdateStatus,
        stale: true,
        warning: String(error && error.message || error),
      };
      emit(payload);
      return payload;
    }
    const payload = {
      type: 'app-update-status',
      light: 'unknown',
      currentVersion: app.getVersion(),
      error: String(error && error.message || error),
      checkedAt: new Date().toISOString(),
    };
    emit(payload);
    return payload;
  }
}

function startAppUpdateWatcher() {
  // Paint cached green/red immediately so UI never sticks on yellow/checking
  loadCachedAppUpdateStatus().then((cached) => {
    if (cached) {
      emit({
        type: 'app-update-status',
        light: appUpdateLightFromResult(cached),
        checkedAt: new Date().toISOString(),
        ...cached,
        stale: true,
      });
    }
  }).catch(() => {});

  const run = () => {
    pushAppUpdateStatus({ check: true }).catch((error) => {
      console.warn('AiBrowser update check failed:', error.message || error);
    });
  };
  setTimeout(run, APP_UPDATE_STARTUP_DELAY_MS);
  if (appUpdateWatchTimer) clearInterval(appUpdateWatchTimer);
  appUpdateWatchTimer = setInterval(run, APP_UPDATE_POLL_MS);
  if (typeof appUpdateWatchTimer.unref === 'function') appUpdateWatchTimer.unref();
}

// rebase: only for paths restored from settings (a portable tree may have moved).
// A path the user just picked in the dialog must be honored as typed.
function normalizeProfileDataRoot(value, options = {}) {
  const raw = String(value || '').trim();
  const rebased = raw
    ? (options.rebase === false ? raw : rebasePortablePath(raw, {
      appRoot: __dirname,
      userDataRoot: app.getPath('userData'),
      requireExisting: false,
    }))
    : defaultProfileDataRoot;
  const candidate = path.resolve(rebased);
  const check = validateDataRootIsolationSecure(candidate);
  if (!check.ok) throw new Error(check.message);
  return check.root;
}

let localSettingsCache = {
  profileDataRoot: defaultProfileDataRoot,
  cloud: cloudSync.defaultCloudConfig(),
  uiGroups: [],
  syncFloatingEnabled: false,
};

async function loadLocalSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(localSettingsFile, 'utf8'));
    localSettingsCache = {
      profileDataRoot: normalizeProfileDataRoot(saved.profileDataRoot),
      cloud: { ...cloudSync.defaultCloudConfig(), ...(saved.cloud || {}) },
      uiGroups: Array.isArray(saved.uiGroups) ? saved.uiGroups : [],
      syncFloatingEnabled: saved.syncFloatingEnabled === true,
    };
    return localSettingsCache;
  } catch (_) {
    localSettingsCache = {
      profileDataRoot: defaultProfileDataRoot,
      cloud: cloudSync.defaultCloudConfig(),
      uiGroups: [],
      syncFloatingEnabled: false,
    };
    return localSettingsCache;
  }
}

async function saveLocalSettings(value, options = {}) {
  localSettingsCache = {
    profileDataRoot: normalizeProfileDataRoot(value.profileDataRoot || localSettingsCache.profileDataRoot, options),
    cloud: value.cloud || localSettingsCache.cloud || cloudSync.defaultCloudConfig(),
    uiGroups: Array.isArray(value.uiGroups) ? value.uiGroups : (localSettingsCache.uiGroups || []),
    syncFloatingEnabled: value.syncFloatingEnabled === true,
  };
  await fsp.mkdir(path.dirname(localSettingsFile), { recursive: true });
  const temporary = localSettingsFile + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify({ version: 3, ...localSettingsCache }, null, 2), 'utf8');
  await fsp.rm(localSettingsFile, { force: true });
  await fsp.rename(temporary, localSettingsFile);
}

async function updateProfileDataRoot(value, options = {}) {
  if (!engine) throw new Error('Browser engine is not ready');
  if (engine.running.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
  const profileDataRoot = normalizeProfileDataRoot(value, options);
  const secureCheck = await ensureDataRootIsolationSecure(profileDataRoot);
  if (!secureCheck.ok) throw new Error(secureCheck.message);
  engine.setProfileDataRoot(profileDataRoot);
  await saveLocalSettings({ ...localSettingsCache, profileDataRoot }, options);
  emit({ type: 'storage-settings', profileRoot: profileDataRoot });
  return { success: true, profileRoot: profileDataRoot, defaultProfileRoot: defaultProfileDataRoot };
}

function providerConfigFromCloud(cloud) {
  const provider = String(cloud.provider || 'local').toLowerCase();
  if (provider === 'webdav') return cloud.webdav || {};
  if (provider === 'github') return cloud.github || {};
  if (provider === 'gdrive' || provider === 'google' || provider === 'gcs') return cloud.gdrive || {};
  if (provider === 'onedrive' || provider === 'microsoft' || provider === 'mscloud') return cloud.onedrive || cloud.webdav || {};
  if (provider === 'quark' || provider === 'kuake') return cloud.quark || cloud.webdav || {};
  if (provider === 'baidu' || provider === 'baiduyun' || provider === 'pan') return cloud.baidu || cloud.webdav || {};
  if (cloudSync.isWebDavBridgeProvider?.(provider)) {
    return cloud[provider] || cloud.webdav || {};
  }
  return cloud.local || {};
}

async function runCloudBackup(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const allProfiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : [...(engine?.profiles?.values?.() || [])];
  const profileIds = Array.isArray(payload.profileIds) ? payload.profileIds.map(String) : null;
  const groups = Array.isArray(payload.groups) ? payload.groups : (localSettingsCache.uiGroups || []);
  let proxies = [];
  try { proxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
  const { buffer, meta } = await cloudSync.buildBackupPackage({
    profiles: allProfiles,
    groups,
    proxies,
    settings: { cloud: { ...cloud, passphrase: cloud.passphrase ? '***' : '' } },
    profileDataRoot: engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot,
    includeBrowserData: cloud.includeBrowserData !== false,
    passphrase: cloud.passphrase || '',
    profileIds,
  });
  const remoteName = payload.remoteName || cloudSync.REMOTE_NAME;
  const result = await cloudSync.upload(cloud.provider, providerConfigFromCloud(cloud), buffer, remoteName);
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ ...localSettingsCache, cloud });
  emit({ type: 'cloud-sync', action: 'backup', ...meta, ...result });
  return { success: true, meta, result, cloud };
}

async function applyBackupBody(body, { mode = 'merge', localProfiles = null, localGroups = null } = {}) {
  const profileRoot = engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot;
  const remoteProfiles = (body.profiles || []).map((p) => {
    const copy = { ...p };
    return copy;
  });
  let restoredFiles = 0;
  const dataById = new Map();
  for (const profile of remoteProfiles) {
    assertProfileId(profile?.id);
    if (profile._dataFiles && profile.id) {
      dataById.set(profile.id, profile._dataFiles);
      delete profile._dataFiles;
    }
  }

  const localList = Array.isArray(localProfiles)
    ? localProfiles
    : [...(engine?.profiles?.values?.() || [])];
  const localGroupList = Array.isArray(localGroups) ? localGroups : (localSettingsCache.uiGroups || []);

  const merged = cloudSync.mergeProfiles(localList, remoteProfiles, mode);
  const groups = cloudSync.mergeGroups(localGroupList, body.groups || [], mode);

  // restore browser data files for profiles that came from remote package
  for (const profile of merged.profiles) {
    const files = dataById.get(profile.id);
    if (files) {
      restoredFiles += await cloudSync.restoreProfileDataFiles(path.join(profileRoot, profile.id), files);
    }
  }

  let proxies = body.proxies || [];
  if (Array.isArray(proxies) && proxies.length) {
    let localProxies = [];
    try { localProxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
    proxies = cloudSync.mergeProxies(localProxies, proxies, mode);
    if (automation?.proxyStore?.replaceAll) {
      await automation.proxyStore.replaceAll(proxies).catch(() => {});
    } else if (automation?.proxyStore) {
      for (const item of proxies) {
        try { await automation.proxyStore.create(item); } catch (_) {}
      }
    }
  }

  await saveLocalSettings({ ...localSettingsCache, uiGroups: groups });
  if (engine) engine.syncProfiles(merged.profiles);

  return {
    profiles: merged.profiles,
    groups,
    proxies,
    restoredFiles,
    mergeStats: merged.stats,
    createdAt: body.createdAt,
  };
}

async function runCloudRestore(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const mode = String(payload.mode || cloud.restoreMode || 'merge');
  const remoteName = payload.remoteName || cloudSync.REMOTE_NAME;
  const buffer = await cloudSync.download(cloud.provider, providerConfigFromCloud(cloud), remoteName);
  const body = await cloudSync.parseBackupPackage(buffer, cloud.passphrase || payload.passphrase || '');

  // optional: only restore subset of profile ids from the pack
  if (Array.isArray(payload.profileIds) && payload.profileIds.length) {
    const allow = new Set(payload.profileIds.map(String));
    body.profiles = (body.profiles || []).filter((p) => allow.has(String(p.id)));
  }

  const applied = await applyBackupBody(body, {
    mode,
    localProfiles: payload.localProfiles,
    localGroups: payload.localGroups,
  });

  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  cloud.restoreMode = mode;
  await saveLocalSettings({ ...localSettingsCache, cloud, uiGroups: applied.groups });
  emit({
    type: 'cloud-sync',
    action: 'restore',
    mode,
    profileCount: applied.profiles.length,
    restoredFiles: applied.restoredFiles,
    mergeStats: applied.mergeStats,
  });
  return { success: true, mode, ...applied, cloud };
}

/** Push one or more environments as individual remote packs + refresh full pack optional */
async function runCloudProfilePush(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const ids = sanitizeIds(payload.profileIds || (payload.profileId ? [payload.profileId] : []));
  if (!ids.length) throw new Error('请指定要同步的环境');
  const allProfiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : [...(engine?.profiles?.values?.() || [])];
  const results = [];
  for (const id of ids) {
    const profile = allProfiles.find((p) => p.id === id);
    if (!profile) throw new Error('环境不存在：' + id);
    const { buffer, meta } = await cloudSync.buildBackupPackage({
      profiles: [{ ...profile, updatedAt: profile.updatedAt || new Date().toISOString() }],
      groups: Array.isArray(payload.groups) ? payload.groups : (localSettingsCache.uiGroups || []),
      proxies: [],
      settings: { kind: 'profile', profileId: id },
      profileDataRoot: engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot,
      includeBrowserData: cloud.includeBrowserData !== false,
      passphrase: cloud.passphrase || '',
      profileIds: [id],
    });
    const remoteName = cloudSync.profileRemoteName(id);
    const result = await cloudSync.upload(cloud.provider, providerConfigFromCloud(cloud), buffer, remoteName);
    results.push({ id, meta, result, remoteName });
  }
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ ...localSettingsCache, cloud });
  emit({ type: 'cloud-sync', action: 'profile-push', count: results.length, ids });
  return { success: true, results, cloud };
}

async function runCloudProfilePull(payload = {}) {
  const cloud = { ...localSettingsCache.cloud, ...(payload.cloud || {}) };
  const mode = String(payload.mode || cloud.restoreMode || 'merge');
  const ids = sanitizeIds(payload.profileIds || (payload.profileId ? [payload.profileId] : []));
  if (!ids.length) throw new Error('请指定要拉取的环境');
  const localProfiles = Array.isArray(payload.localProfiles)
    ? payload.localProfiles
    : [...(engine?.profiles?.values?.() || [])];
  let combinedRemote = [];
  let restoredFiles = 0;
  const per = [];
  for (const id of ids) {
    const remoteName = cloudSync.profileRemoteName(id);
    const buffer = await cloudSync.download(cloud.provider, providerConfigFromCloud(cloud), remoteName);
    const body = await cloudSync.parseBackupPackage(buffer, cloud.passphrase || payload.passphrase || '');
    combinedRemote = combinedRemote.concat(body.profiles || []);
    per.push({ id, remoteName, count: (body.profiles || []).length, createdAt: body.createdAt });
  }
  const applied = await applyBackupBody(
    { profiles: combinedRemote, groups: payload.groups || localSettingsCache.uiGroups || [], proxies: [] },
    { mode, localProfiles, localGroups: payload.localGroups }
  );
  restoredFiles = applied.restoredFiles;
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ ...localSettingsCache, cloud, uiGroups: applied.groups });
  emit({ type: 'cloud-sync', action: 'profile-pull', count: ids.length, mode, mergeStats: applied.mergeStats });
  return { success: true, mode, ...applied, per, restoredFiles, cloud };
}

let engine;
let liveSync;
let automation = null;
let aiService = null;
let quitting = false;
let syncSelection = [];
let syncState = { active: false, master: null, selected: [] };
const windows = new Set();
let mainWindow = null;
let syncFloatingWindow = null;
let currentUiTheme = { themeId: 'pixel-workstation', colorMode: 'dark' };

function trustedAppIndexUrl() {
  // Canonical UI document: only this exact file:// path may call registerTrustedIpc.
  // Reject other file:///…/index.html (e.g. /tmp/malicious/index.html) even if loaded in mainWindow.
  return pathToFileURL(path.join(__dirname, 'index.html')).href;
}

function assertTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) {
    throw new Error('untrusted IPC sender');
  }
  const senderUrl = String(event.sender.getURL?.() || '');
  const expected = trustedAppIndexUrl();
  // Exact match, or same path with query/hash (Electron may append ? or # after loadFile).
  if (senderUrl !== expected && !senderUrl.startsWith(expected + '?') && !senderUrl.startsWith(expected + '#')) {
    throw new Error('untrusted IPC document');
  }
}

function trustedSyncFloatingUrl() {
  return pathToFileURL(path.join(__dirname, 'sync-floating.html')).href;
}

function assertSyncFloatingSender(event) {
  if (!syncFloatingWindow || syncFloatingWindow.isDestroyed() || event?.sender !== syncFloatingWindow.webContents) {
    throw new Error('untrusted floating sync IPC sender');
  }
  const senderUrl = String(event.sender.getURL?.() || '');
  const expected = trustedSyncFloatingUrl();
  if (senderUrl !== expected && !senderUrl.startsWith(expected + '?') && !senderUrl.startsWith(expected + '#')) {
    throw new Error('untrusted floating sync document');
  }
}

function registerTrustedIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    return handler(event, ...args);
  });
}
let shortcutBridge = null;
let shortcutFallbackRegistered = false;
let shortcutActionInFlight = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeIds(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid profile selection');
  return [...new Set(value.map(assertProfileId))];
}

function emit(value) {
  for (const win of windows) if (!win.isDestroyed()) win.webContents.send('engine:event', value);
  if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) {
    syncFloatingWindow.webContents.send('sync-floating:event', value);
  }
}

async function tile(ids, cascade = false, customLayout = null) {
  const entries = engine.runningSyncable(sanitizeIds(ids));
  if (!entries.length) throw new Error('没有可排列的运行中浏览器环境');
  const work = screen.getPrimaryDisplay().workArea;
  const setBounds = ({ item }, bounds) => {
    // Do not mix CDP and Win32 positioning on Windows. CDP window bounds and
    // SetWindowPos use different DPI coordinate spaces at non-100% scaling,
    // which makes Chromium and Firefox tiles visibly different sizes.
    if (process.platform === 'win32' && Number.isInteger(item.pid) && item.pid > 0) {
      const helper = path.join(__dirname, 'native-window-bounds.exe');
      if (!fs.existsSync(helper)) return Promise.reject(new Error('缺少 Windows 浏览器窗口排列组件：native-window-bounds.exe'));
      return new Promise((resolve, reject) => {
        execFile(helper, [String(item.pid), String(bounds.left), String(bounds.top), String(bounds.width), String(bounds.height)], { windowsHide: true, timeout: 6000 }, (error) => error ? reject(error) : resolve());
      });
    }
    if (item.port) return cdp.setWindowBounds(item.port, bounds);
    return Promise.resolve();
  };
  let appliedLayout = null;
  if (cascade) {
    // Cascade layout: left + vs * index
    const { computeCascadeBounds } = require('./automation/protocol/window-sync-protocol');
    const width = Math.max(760, work.width - 220);
    const height = Math.max(560, work.height - 180);
    const layout = computeCascadeBounds(entries.map((e) => e.id), {
      left: work.x, top: work.y, width, height, vs: 38,
    });
    const applyCascade = () => Promise.all(entries.map(({ item }, index) => {
      const bounds = layout[index]?.bounds || { left: work.x + index * 38, top: work.y + index * 34, width, height };
      return setBounds(entries[index], bounds);
    }));
    await applyCascade();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await applyCascade();
  } else {
    const requestedColumns = Number.parseInt(customLayout?.columns, 10);
    const requestedRows = Number.parseInt(customLayout?.rows, 10);
    const hasCustomLayout = customLayout !== null && customLayout !== undefined;
    if (hasCustomLayout && (
      !Number.isInteger(requestedColumns) || requestedColumns < 1 || requestedColumns > entries.length
      || !Number.isInteger(requestedRows) || requestedRows < 1 || requestedRows > entries.length
      || requestedColumns * requestedRows < entries.length
    )) throw new Error('自定义布局与当前浏览器数量不匹配，请重新选择布局');
    const cols = hasCustomLayout ? requestedColumns : Math.ceil(Math.sqrt(entries.length));
    const rows = hasCustomLayout ? requestedRows : Math.ceil(entries.length / cols);
    appliedLayout = { columns: cols, rows };
    const height = Math.floor(work.height / rows);
    const rowCounts = [];
    let remaining = entries.length;
    for (let row = 0; row < rows; row += 1) {
      const rowsAfter = rows - row - 1;
      const rowItemCount = Math.min(cols, remaining - rowsAfter);
      rowCounts.push(rowItemCount);
      remaining -= rowItemCount;
    }
    const bounds = [];
    for (let row = 0; row < rows; row += 1) {
      const rowItemCount = rowCounts[row];
      const width = Math.floor(work.width / rowItemCount);
      for (let column = 0; column < rowItemCount; column += 1) {
        const left = work.x + column * width;
        const top = work.y + row * height;
        bounds.push({
          left,
          top,
          width: column === rowItemCount - 1 ? work.x + work.width - left : width,
          height: row === rows - 1 ? work.y + work.height - top : height,
        });
      }
    }
    const applyTile = () => Promise.all(entries.map((entry, index) => setBounds(entry, bounds[index])));
    await applyTile();
    // Browser.setWindowBounds resolves before every browser frame has necessarily
    // committed its restored size. Reapply once after the native frames settle so
    // Chromium and Firefox cannot retain two different grid generations.
    await new Promise((resolve) => setTimeout(resolve, 180));
    await applyTile();
  }
  return {
    success: true,
    count: entries.length,
    mode: cascade ? 'cascade' : (customLayout ? 'custom-tile' : 'tile'),
    layout: appliedLayout,
    platform: process.platform,
  };
}

function runNativeWindowHelper(args, missingMessage) {
  if (process.platform !== 'win32') return Promise.reject(new Error('当前平台不支持原生浏览器窗口控制'));
  const helper = path.join(__dirname, 'native-window-bounds.exe');
  if (!fs.existsSync(helper)) return Promise.reject(new Error(missingMessage || '缺少原生浏览器窗口控制组件：native-window-bounds.exe'));
  return new Promise((resolve, reject) => {
    execFile(helper, args.map(String), { windowsHide: true, timeout: 6000 }, (error) => error ? reject(error) : resolve());
  });
}

function runNativeBrowserText(item, action, text = '') {
  if (process.platform !== 'win32') return Promise.reject(new Error('浏览器地址栏文本操作目前仅支持 Windows'));
  const helper = path.join(__dirname, 'native-browser-text.exe');
  if (!fs.existsSync(helper)) return Promise.reject(new Error('缺少浏览器地址栏文本组件：native-browser-text.exe'));
  if (!Number.isInteger(item?.pid) || item.pid <= 0) return Promise.reject(new Error('浏览器进程尚未就绪'));
  const encoded = Buffer.from(String(text), 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(helper, [String(action), encoded, String(item.pid)], { windowsHide: true, timeout: 8000, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(new Error('当前环境没有可写入的网页文本框或浏览器地址栏'));
      resolve({ success: true, targetId: 'browser-address-bar', surface: 'browser-ui', detail: String(stdout || '').trim() });
    });
  });
}

async function performWindowAction(rawIds, rawAction, rawLayout = null) {
  const ids = sanitizeIds(rawIds);
  const action = String(rawAction || '');
  if (action === 'tile') return tile(ids, false);
  if (action === 'custom-tile') return tile(ids, false, rawLayout);
  if (action === 'cascade') return tile(ids, true);
  if (!['minimized', 'normal', 'maximized'].includes(action)) throw new Error('Unknown window action');
  const entries = engine.runningSyncable(ids);
  if (!entries.length) throw new Error('没有可控制的运行中浏览器环境');
  await Promise.all(entries.map(({ item }) => item.port
    ? cdp.setWindowState(item.port, action)
    : runNativeWindowHelper([item.pid, action], '缺少 Firefox 窗口控制组件：native-window-bounds.exe')));
  return { success: true, count: entries.length, action };
}

function isEnvironmentStartUrl(value) {
  const s = String(value || '');
  if (/aibrowser-start\.html/i.test(s)) return true;
  if (/aibrowser-start|aibrowser-native/i.test(s)) return true;
  if (/https?:\/\/127\.0\.0\.1:5032[6-9]\/?/i.test(s)) return true;
  return Boolean(engine?.isStartPageUrl?.(s));
}

function environmentStartUrl(entry) {
  // Prefer live start URL from running session (http://127.0.0.1:PORT/?id=...)
  if (entry?.item?.startUrl) return entry.item.startUrl;
  if (entry?.id && engine?.running?.get?.(entry.id)?.startUrl) {
    return engine.running.get(entry.id).startUrl;
  }
  try {
    const profile = entry?.item?.profile || engine?.profiles?.get?.(entry?.id);
    if (profile && engine?.startPageServer) {
      return engine.startPageServer.buildUrl(profile);
    }
  } catch (_) {}
  const root = entry?.item?.root || entry?.root;
  return root ? 'file:///' + path.join(root, 'aibrowser-start.html').replace(/\\/g, '/') : null;
}

async function syncTabsFromMaster(ids) {
  const selected = engine.runningSyncable(sanitizeIds(ids));
  if (selected.length < 2) throw new Error('Select at least two running browser environments');
  if (!selected[0].item.port) return { success: true, skipped: true, reason: 'native-master', master: selected[0].id, slaves: selected.length - 1, tabCount: 0 };
  const entries = [selected[0], ...selected.slice(1).filter((entry) => entry.item.port)];
  if (entries.length < 2) return { success: true, skipped: true, reason: 'no-semantic-slave', master: selected[0].id, slaves: selected.length - 1, tabCount: 0 };
  const masterTabs = (await cdp.tabs(entries[0].item.port)).filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://'));
  const urls = masterTabs.map((tab) => tab.url).filter(Boolean).slice(0, 20);
  for (const slave of entries.slice(1)) {
    const existing = (await cdp.tabs(slave.item.port)).filter((tab) => !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://'));
    for (let index = 0; index < urls.length; index += 1) {
      const targetUrl = isEnvironmentStartUrl(urls[index]) ? (environmentStartUrl(slave) || urls[index]) : urls[index];
      if (existing[index]) await cdp.call(existing[index].webSocketDebuggerUrl, 'Page.navigate', { url: targetUrl }).catch(() => cdp.navigate(slave.item.port, targetUrl));
      else await cdp.newTab(slave.item.port, targetUrl);
    }
  }
  return { success: true, master: entries[0].id, slaves: entries.length - 1, tabCount: urls.length };
}

function syncSnapshot() { return { ...syncState, selected: [...syncState.selected] }; }

function updateSyncSelection(rawIds) {
  if (syncState.active) return syncSnapshot();
  syncSelection = sanitizeIds(rawIds);
  syncState = { ...syncState, master: null, selected: [...syncSelection] };
  emit({ type: 'sync-state', ...syncSnapshot(), reason: 'selection' });
  return syncSnapshot();
}

function handleLiveSyncEvent(value) {
  emit(value);
  if ((value.type === 'sync-disconnected' || (value.type === 'live-sync' && value.active === false)) && syncState.active) {
    engine?.setSyncProfileMarkers?.([], false);
    syncState = { active: false, master: null, selected: [...syncSelection] };
    emit({ type: 'sync-state', ...syncSnapshot(), reason: value.type });
  }
}

async function beginSync(ids = syncSelection) {
  let selected = engine.runningSyncable(sanitizeIds(ids)).map((entry) => entry.id);
  if (selected.length < 2) selected = engine.runningSyncable([...engine.running.keys()]).map((entry) => entry.id);
  if (selected.length < 2) throw new Error('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e24\u4e2a\u8fd0\u884c\u4e2d\u7684\u6d4f\u89c8\u5668\u73af\u5883');
  syncSelection = selected;
  // Starting synchronization must never move or resize user-arranged windows.
  // Layout changes are explicit and only run from the Window > Tile/Cascade actions.
  const tabs = await syncTabsFromMaster(selected);
  const live = await liveSync.start(selected, { preserveWindowLayout: true });
  engine.setSyncProfileMarkers?.(selected, true);
  syncState = { active: true, master: selected[0], selected, mode: live.mode, nativeReady: live.nativeReady };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, ...tabs, live, state: syncSnapshot() };
}

async function endSync() {
  liveSync?.stop();
  await liveSync?.waitForMarkerCleanup?.();
  engine?.setSyncProfileMarkers?.([], false);
  syncState = { active: false, master: null, selected: [...syncSelection] };
  emit({ type: 'sync-state', ...syncSnapshot() });
  return { success: true, state: syncSnapshot() };
}

async function restartSync() {
  await endSync();
  return beginSync(syncSelection);
}

async function performTextAction(payload = {}) {
  const ids = sanitizeIds(payload.ids);
  const action = String(payload.action);
  const text = String(payload.text || '').slice(0, 100000);
  const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
  const min = Math.max(0, Math.min(5, Number(payload.delayMin) || 0));
  const max = Math.max(min, Math.min(5, Number(payload.delayMax) || min));
  const profiles = []; const failures = [];
  for (const id of ids) {
    const entry = entries.get(id);
    try {
      let result;
      if (!entry) {
        const running = engine.running.get(id);
        if (!running) throw new Error('该浏览器环境没有运行');
        const delay = action === 'insert' ? min + Math.random() * (max - min) : 0; if (delay) await sleep(delay * 1000);
        try {
          if (!running.marionettePort) throw new Error('NO_MARIONETTE_PAGE');
          result = await liveSync.performTextAction(id, action, text);
        } catch (_) {
          result = await runNativeBrowserText(running, action, text);
        }
      } else if (await cdp.focusedEditableTab(entry.item.port)) {
        if (action === 'clear') result = await cdp.clearFocused(entry.item.port);
        else if (action === 'insert') {
          const delay = min + Math.random() * (max - min); if (delay) await sleep(delay * 1000);
          result = await cdp.insertText(entry.item.port, text);
        } else throw new Error('Unknown text action');
      } else if (action === 'clear' || action === 'insert') {
        const delay = action === 'insert' ? min + Math.random() * (max - min) : 0; if (delay) await sleep(delay * 1000);
        result = await runNativeBrowserText(entry.item, action, text);
      } else throw new Error('Unknown text action');
      profiles.push({ id, targetId: result.targetId, textLength: text.length });
    } catch (error) { failures.push({ id, message: error.message }); }
  }
  return { success: failures.length === 0 && profiles.length === ids.length, profiles, failures };
}

async function performBatchTextAction(payload = {}) {
  const ids = sanitizeIds(payload.ids);
  const texts = Array.isArray(payload.texts) ? payload.texts.map((value) => String(value || '').slice(0, 100000)) : [];
  if (!ids.length || texts.length !== ids.length) throw new Error('Text assignments must match the selected environments');
  const assignments = new Map(ids.map((id, index) => [id, texts[index]]));
  const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
  const min = Math.max(0, Math.min(5, Number(payload.delayMin) || 0));
  const max = Math.max(min, Math.min(5, Number(payload.delayMax) || min));
  const profiles = []; const failures = [];
  for (const id of ids) {
    const entry = entries.get(id); const assignedText = assignments.get(id) || '';
    try {
      const delay = min + Math.random() * (max - min); if (delay) await sleep(delay * 1000);
      let result;
      if (entry) {
        if (await cdp.focusedEditableTab(entry.item.port)) result = await cdp.insertText(entry.item.port, assignedText);
        else result = await runNativeBrowserText(entry.item, 'insert', assignedText);
      }
      else {
        const running = engine.running.get(id);
        if (!running) throw new Error('该浏览器环境没有运行');
        try {
          if (!running.marionettePort) throw new Error('NO_MARIONETTE_PAGE');
          result = await liveSync.performTextAction(id, 'insert', assignedText);
        } catch (_) {
          result = await runNativeBrowserText(running, 'insert', assignedText);
        }
      }
      profiles.push({ id, targetId: result.targetId, textLength: assignedText.length });
    } catch (error) { failures.push({ id, message: error.message }); }
  }
  return { success: failures.length === 0 && profiles.length === ids.length, profiles, failures };
}

async function performTabAction(payload = {}) {
  const ids = sanitizeIds(payload.ids);
  const action = String(payload.action);
  const value = payload.payload || {};
  if (action === 'list') return { success: true, sessions: await engine.sessions() };
  const entries = new Map(engine.runningWithCdp(ids).map((entry) => [entry.id, entry]));
  const profiles = []; const failures = [];
  if (action === 'sync') {
    const result = await syncTabsFromMaster(ids);
    for (const id of ids) {
      if (entries.has(id)) profiles.push({ id });
      else failures.push({ id, message: 'Firefox 不提供 CDP 标签页清单；操作同步仍可同步当前网页' });
    }
    return { ...result, success: failures.length === 0 && !result.skipped, profiles, failures };
  }
  for (const id of ids) {
    const entry = entries.get(id);
    if (!entry) { failures.push({ id, message: '该环境不是运行中的 Chromium/CDP 环境' }); continue; }
    try {
      const { item } = entry;
      if (action === 'new') await cdp.newTab(item.port, String(value.url || 'about:blank'));
      else if (action === 'navigate') await cdp.navigate(item.port, String(value.url || 'about:blank'));
      else if (action === 'reload') await cdp.reload(item.port);
      else if (action === 'close') { const tab = await cdp.firstTab(item.port); if (tab) await cdp.closeTab(item.port, tab.id); }
      else throw new Error('Unknown tab action');
      profiles.push({ id });
    } catch (error) { failures.push({ id, message: error.message }); }
  }
  return { success: failures.length === 0 && profiles.length === ids.length, count: profiles.length, profiles, failures };
}

async function runShortcut(action) {
  if (shortcutActionInFlight) return;
  shortcutActionInFlight = true;
  emit({ type: 'shortcut-triggered', action });
  try {
    if (action === 'start') await beginSync(syncSelection);
    else if (action === 'stop') await endSync();
    else await restartSync();
  } catch (error) {
    emit({ type: 'sync-error', action, message: error.message });
  } finally { shortcutActionInFlight = false; }
}

function registerShortcutFallback() {
  if (shortcutFallbackRegistered) return;
  shortcutFallbackRegistered = true;
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  const shortcuts = [
    [`${mod}+Alt+A`, 'start'],
    [`${mod}+Alt+S`, 'start'],
    [`${mod}+Alt+D`, 'stop'],
    [`${mod}+Alt+R`, 'restart'],
  ];
  // Keep Windows-style Control+Alt bindings available on macOS too.
  if (process.platform === 'darwin') {
    shortcuts.push(
      ['Control+Alt+A', 'start'],
      ['Control+Alt+S', 'start'],
      ['Control+Alt+D', 'stop'],
      ['Control+Alt+R', 'restart'],
    );
  }
  const registered = shortcuts.map(([accelerator, action]) => ({
    accelerator,
    registered: globalShortcut.register(accelerator, () => runShortcut(action)),
  }));
  emit({ type: 'shortcut-status', mode: process.platform === 'darwin' ? 'macos-global' : 'host-fallback', registered });
}

function registerTextShortcuts() {
  const mod = process.platform === 'darwin' ? 'Command' : 'Control';
  const shortcuts = [
    [`${mod}+Alt+F`, 'random-number'],
    [process.platform === 'darwin' ? 'Command+Option+Q' : 'Control+Q', 'same-text'],
    ['Shift+F1', 'specified-text'],
  ];
  if (process.platform === 'darwin') {
    shortcuts.push(
      ['Control+Alt+F', 'random-number'],
      ['Control+Q', 'same-text'],
    );
  }
  const registered = shortcuts.map(([accelerator, action]) => ({ accelerator, registered: globalShortcut.register(accelerator, () => emit({ type: 'text-shortcut', action })) }));
  emit({ type: 'text-shortcut-status', registered });
}

function startShortcutBridge() {
  const executable = path.join(__dirname, 'native-sync-hotkeys.exe');
  if (process.platform !== 'win32' || !fs.existsSync(executable)) {
    registerShortcutFallback();
    return;
  }
  const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  shortcutBridge = child;
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const lines = output.split(/\r?\n/); output = lines.pop() || '';
    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      if (line === 'READY') emit({ type: 'shortcut-status', mode: 'windows-hook', active: true, accelerators: ['Ctrl+Alt+A', 'Ctrl+Alt+S', 'Ctrl+Alt+D', 'Ctrl+Alt+R'] });
      else if (line === 'start' || line === 'stop' || line === 'restart') runShortcut(line);
    }
  });
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-1000); });
  child.once('error', (error) => {
    if (shortcutBridge !== child) return;
    shortcutBridge = null;
    emit({ type: 'sync-error', action: 'shortcut-bridge', message: error.message });
    if (!quitting) registerShortcutFallback();
  });
  child.once('exit', (code) => {
    if (shortcutBridge !== child) return;
    shortcutBridge = null;
    if (!quitting) {
      emit({ type: 'sync-error', action: 'shortcut-bridge', message: errorOutput.trim() || ('Windows shortcut bridge exited: ' + code) });
      registerShortcutFallback();
    }
  });
}

function stopShortcutBridge() {
  const child = shortcutBridge;
  shortcutBridge = null;
  if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  globalShortcut.unregisterAll();
  shortcutFallbackRegistered = false;
}
async function fetchStorePackage(url, proxyValue = null) {
  const initial = new URL(url);
  if (initial.protocol !== 'https:' || initial.hostname !== 'clients2.google.com') throw new Error('Chrome 商店下载地址无效');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const storeSession = session.fromPartition('persist:openbrowser-extension-store');
    if (proxyValue === 'system') await storeSession.setProxy({ mode: 'system' });
    else if (proxyValue) await storeSession.setProxy({ mode: 'fixed_servers', proxyRules: proxyValue });
    else await storeSession.setProxy({ mode: 'direct' });
    const response = await storeSession.fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'user-agent': 'Mozilla/5.0 AiBrowserLocal/3.0' } });
    const finalUrl = new URL(String(response.url || url));
    if (finalUrl.protocol !== 'https:' || !['clients2.google.com', 'clients2.googleusercontent.com'].includes(finalUrl.hostname)) throw new Error('Chrome 商店返回了不受信任的下载地址');
    if (!response.ok) throw new Error('Chrome 商店下载失败（HTTP ' + response.status + '）');
    const declared = Number(response.headers.get('content-length') || 0); if (declared > 120 * 1024 * 1024) throw new Error('扩展包超过 120 MB 限制');
    const buffer = Buffer.from(await response.arrayBuffer()); if (buffer.length > 120 * 1024 * 1024) throw new Error('扩展包超过 120 MB 限制');
    return buffer;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接 Chrome 应用商店超时，请检查系统代理/VPN，或先给任一目标环境配置可访问 Google 的代理');
    throw error;
  } finally { clearTimeout(timer); }
}

const chromeStoreIconRequests = new Map();

function validChromeStoreId(value) {
  return /^[a-p]{32}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
}

function chromeStoreImageUrl(html) {
  const text = String(html || '');
  const match = text.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i)
    || text.match(/https:\/\/[a-z0-9.-]+\.googleusercontent\.com\/[^"'\\s>]+\.(?:png|jpe?g|webp)/i)
    || text.match(/https:\/\/lh3\.googleusercontent\.com\/[^"'\\s>]+/i);
  if (!match) return null;
  return String(match[1] || match[0]).replace(/&amp;/g, '&');
}

function isChromeStoreIconHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'chromewebstore.google.com' || host.endsWith('.googleusercontent.com') || host.endsWith('.gstatic.com') || host.endsWith('.ggpht.com');
}

function bufferToDataUrl(buffer, contentType = '') {
  const type = String(contentType || '').toLowerCase().split(';')[0].trim();
  let mime = type.startsWith('image/') ? type : '';
  if (!mime && buffer?.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) mime = 'image/png';
    else if (buffer[0] === 0xff && buffer[1] === 0xd8) mime = 'image/jpeg';
    else if (buffer[0] === 0x52 && buffer[1] === 0x49) mime = 'image/webp';
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) mime = 'image/gif';
    else mime = 'image/png';
  }
  return `data:${mime || 'image/png'};base64,${Buffer.from(buffer).toString('base64')}`;
}

async function cachedIconDataUrl(cacheFile) {
  try {
    const data = await fsp.readFile(cacheFile);
    if (!data.length) return null;
    return bufferToDataUrl(data);
  } catch (_) {
    return null;
  }
}

function extensionIconSource(manifest) {
  const sets = [manifest?.icons, manifest?.action?.default_icon, manifest?.browser_action?.default_icon, manifest?.page_action?.default_icon];
  for (const set of sets) {
    if (typeof set === 'string') return set;
    if (!set || typeof set !== 'object') continue;
    const entry = Object.entries(set).filter(([, value]) => typeof value === 'string')
      .sort(([left], [right]) => Number(right) - Number(left))[0];
    if (entry) return entry[1];
  }
  return null;
}

function runArchiveCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: null, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function fetchChromeStoreMetadata(storeId) {
  const safeId = validChromeStoreId(storeId);
  if (!safeId) return null;
  const cacheDir = path.join(app.getPath('userData'), 'app-center-icons');
  const metadataFile = path.join(cacheDir, `${safeId}.json`);
  const cacheFile = path.join(cacheDir, `${safeId}.img`);
  try {
    const cached = JSON.parse(await fsp.readFile(metadataFile, 'utf8'));
    if (cached) {
      // Prefer live data URL from cached image bytes (sandbox-safe in renderer)
      const dataUrl = await cachedIconDataUrl(cacheFile);
      if (dataUrl) return { ...cached, icon_url: dataUrl };
      if (cached.icon_url && String(cached.icon_url).startsWith('data:')) return cached;
      if (cached.description) {
        // Try page icon scrape if only description was cached
        const icon = await fetchChromeStoreIcon(safeId);
        if (icon) {
          const next = { ...cached, icon_url: icon };
          await fsp.writeFile(metadataFile, JSON.stringify({ ...next, icon_url: 'file-cache' }), 'utf8').catch(() => {});
          return next;
        }
      }
      if (cached.icon_url || cached.description) return cached;
    }
  } catch (_) {}

  let metadata = { name: '', description: '', icon_url: null };
  try {
    const query = new URLSearchParams({ response: 'redirect', prodversion: '150.0.0.0', acceptformat: 'crx2,crx3', x: `id=${safeId}&installsource=ondemand&uc` });
    const buffer = await fetchStorePackage(`https://clients2.google.com/service/update2/crx?${query}`);
    const { crxDetails } = require('./store-extension');
    const zip = crxDetails(buffer).zip;
    const tempDir = path.join(cacheDir, `.metadata-${safeId}-${process.pid}-${Date.now()}`);
    const zipFile = `${tempDir}.zip`;
    try {
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(zipFile, zip);
      const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
      const manifest = JSON.parse((await runArchiveCommand(tar, ['-xOf', zipFile, 'manifest.json'])).toString('utf8'));
      metadata = {
        name: typeof manifest.name === 'string' ? manifest.name : '',
        description: typeof manifest.description === 'string' ? manifest.description : '',
        icon_url: null,
      };
      const iconPath = extensionIconSource(manifest)?.replace(/^[/\\]+/, '');
      if (iconPath && !iconPath.split('/').includes('..')) {
        const image = await runArchiveCommand(tar, ['-xOf', zipFile, iconPath]);
        if (image.length && image.length <= 2 * 1024 * 1024) {
          await fsp.writeFile(cacheFile, image);
          metadata.icon_url = bufferToDataUrl(image);
        }
      }
    } finally {
      await fsp.rm(zipFile, { force: true }).catch(() => {});
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (_) {
    // CRX download often blocked; fall through to store page scrape
  }

  if (!metadata.icon_url) {
    const icon = await fetchChromeStoreIcon(safeId);
    if (icon) metadata.icon_url = icon;
  }
  if (metadata.icon_url || metadata.description) {
    await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {});
    // Don't store huge data URLs in JSON — image is in .img cache
    await fsp.writeFile(metadataFile, JSON.stringify({
      name: metadata.name,
      description: metadata.description,
      icon_url: metadata.icon_url ? 'file-cache' : null,
    }), 'utf8').catch(() => {});
  }
  return (metadata.icon_url || metadata.description) ? metadata : null;
}

async function fetchChromeStoreIcon(storeId) {
  const safeId = validChromeStoreId(storeId);
  if (!safeId) return null;
  const cacheDir = path.join(app.getPath('userData'), 'app-center-icons');
  const cacheFile = path.join(cacheDir, `${safeId}.img`);
  const cached = await cachedIconDataUrl(cacheFile);
  if (cached) return cached;
  if (chromeStoreIconRequests.has(safeId)) return chromeStoreIconRequests.get(safeId);
  const request = (async () => {
    const storeSession = session.fromPartition('persist:openbrowser-extension-store');
    const pageUrl = `https://chromewebstore.google.com/detail/${safeId}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let response;
    try {
      response = await storeSession.fetch(pageUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'accept-language': 'en-US,en;q=0.9',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) return null;
    const imageUrl = chromeStoreImageUrl(await response.text());
    if (!imageUrl) return null;
    const parsed = new URL(imageUrl);
    if (parsed.protocol !== 'https:' || !isChromeStoreIconHost(parsed.hostname)) return null;
    const imageController = new AbortController();
    const imageTimeout = setTimeout(() => imageController.abort(), 20000);
    let imageResponse;
    try {
      imageResponse = await storeSession.fetch(parsed.toString(), {
        redirect: 'follow',
        signal: imageController.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
      });
    } finally {
      clearTimeout(imageTimeout);
    }
    const finalUrl = new URL(imageResponse.url || parsed.toString());
    const contentType = String(imageResponse.headers.get('content-type') || '').toLowerCase();
    if (!imageResponse.ok || !isChromeStoreIconHost(finalUrl.hostname)) return null;
    // Some CDNs omit content-type; accept by magic bytes later
    if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) return null;
    const data = Buffer.from(await imageResponse.arrayBuffer());
    if (!data.length || data.length > 2 * 1024 * 1024) return null;
    await fsp.mkdir(cacheDir, { recursive: true });
    await fsp.writeFile(cacheFile, data);
    return bufferToDataUrl(data, contentType);
  })().catch(() => null).finally(() => chromeStoreIconRequests.delete(safeId));
  chromeStoreIconRequests.set(safeId, request);
  return request;
}

/** Theme chrome colors for fused title bar (shipping-app look). */
const THEME_CHROME = {
  'pixel-workstation': { bg: '#0c0f13', overlay: '#161c20', symbol: '#d1e5d4' },
  'nes-light': { bg: '#c2b59c', overlay: '#d0c4aa', symbol: '#27231b' },
  'element-admin': { bg: '#e8e8ed', overlay: '#f5f5f7', symbol: '#1d1d1f' },
  'element-admin-dark': { bg: '#1c1c1e', overlay: '#2c2c2e', symbol: '#f5f5f7' },
  'retro-desktop': { bg: '#d8d8d8', overlay: '#ececec', symbol: '#1c1c1c' },
  'aurora-glass': { bg: '#07111a', overlay: '#0a1b27', symbol: '#eaf7f6' },
  'paper-studio': { bg: '#e9dfcc', overlay: '#fffaf1', symbol: '#2f342f' },
  default: { bg: '#0b1117', overlay: '#151f27', symbol: '#eef8f0' },
};

function chromeForTheme(themeId, colorMode) {
  if (themeId === 'element-admin' && colorMode === 'dark') return THEME_CHROME['element-admin-dark'];
  return THEME_CHROME[themeId] || THEME_CHROME.default;
}

function applyWindowChrome(win, themeId, colorMode) {
  if (!win || win.isDestroyed()) return;
  const chrome = chromeForTheme(themeId, colorMode);
  try { win.setBackgroundColor(chrome.bg); } catch (_) {}
  // Keep Windows caption overlay in sync with theme (light/dark native skin too)
  if (process.platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay({
        color: chrome.overlay,
        symbolColor: chrome.symbol,
        height: 32,
      });
    } catch (_) {}
  }
}

function syncFloatingSnapshot() {
  const profiles = Array.isArray(engine?.status?.()) ? engine.status() : [];
  return {
    enabled: localSettingsCache.syncFloatingEnabled === true,
    theme: { ...currentUiTheme },
    sync: { ...syncSnapshot(), runtime: liveSync?.runtimeStatus?.() || null, settings: liveSync?.getSettings?.() || null },
    sessions: profiles.filter((profile) => profile.running).map((profile) => ({
      id: String(profile.id || ''),
      number: profile.number ?? profile.id,
      name: String(profile.title || profile.name || `环境 ${profile.number ?? profile.id}`),
      browser: String(profile.browser || profile.kernel || 'Browser'),
      syncable: Boolean(profile.port || (process.platform === 'win32' && Number.isInteger(profile.pid) && profile.pid > 0)),
      canMaster: Boolean(profile.port),
      syncMode: profile.port ? 'semantic-native' : (profile.marionettePort ? 'marionette-native' : 'native-coordinate'),
    })),
  };
}

async function setSyncFloatingEnabled(enabled) {
  const next = Boolean(enabled);
  await saveLocalSettings({ ...localSettingsCache, syncFloatingEnabled: next });
  if (next) {
    const win = await createSyncFloatingWindow();
    if (!win.isVisible()) win.show();
  } else if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) {
    syncFloatingWindow.hide();
  }
  emit({ type: 'sync-floating-setting', enabled: next });
  return { success: true, enabled: next };
}

async function createSyncFloatingWindow() {
  if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) return syncFloatingWindow;
  const chrome = chromeForTheme(currentUiTheme.themeId, currentUiTheme.colorMode);
  const work = screen.getPrimaryDisplay().workArea;
  const width = 460;
  const height = 50;
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 420,
    minHeight: 50,
    maxWidth: 640,
    maxHeight: 420,
    x: Math.max(work.x, work.x + work.width - width - 18),
    y: Math.max(work.y, work.y + 48),
    title: 'AiBrowser 工具条',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'logo.ico' : 'logo.png'),
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: chrome.bg,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'sync-floating-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  syncFloatingWindow = win;
  try { win.setAlwaysOnTop(true, 'floating'); } catch (_) {}
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (event) => {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    event.preventDefault();
    win.hide();
    if (localSettingsCache.syncFloatingEnabled) {
      saveLocalSettings({ ...localSettingsCache, syncFloatingEnabled: false })
        .then(() => emit({ type: 'sync-floating-setting', enabled: false }))
        .catch((error) => console.warn('Could not save floating sync visibility:', error.message));
    }
  });
  win.on('closed', () => {
    if (syncFloatingWindow === win) syncFloatingWindow = null;
  });
  await win.loadFile(path.join(__dirname, 'sync-floating.html'));
  applyWindowChrome(win, currentUiTheme.themeId, currentUiTheme.colorMode);
  return win;
}

function registerSyncFloatingIpc() {
  ipcMain.handle('sync-floating:snapshot', (event) => {
    assertSyncFloatingSender(event);
    return syncFloatingSnapshot();
  });
  ipcMain.handle('sync-floating:apply', async (event, payload) => {
    assertSyncFloatingSender(event);
    const requested = sanitizeIds(payload?.ids || []);
    const running = new Set(engine.runningSyncable([...engine.running.keys()]).map((entry) => entry.id));
    const selected = requested.filter((id) => running.has(id));
    const requestedMaster = selected.includes(String(payload?.master || '')) ? String(payload.master) : null;
    const master = requestedMaster && engine.running.get(requestedMaster)?.port
      ? requestedMaster
      : selected.find((id) => engine.running.get(id)?.port);
    if (!master) throw new Error('请至少选择一个 Chromium 环境作为主控；Firefox 可作为受控环境参与同步');
    const ordered = master ? [master, ...selected.filter((id) => id !== master)] : selected;
    if (ordered.length < 2) throw new Error('请至少选择两个支持同步的运行中浏览器环境');
    if (syncState.active) await endSync();
    return beginSync(ordered);
  });
  ipcMain.handle('sync-floating:selection', (event, payload) => {
    assertSyncFloatingSender(event);
    const requested = sanitizeIds(payload?.ids || []);
    const running = new Set(engine.runningSyncable([...engine.running.keys()]).map((entry) => entry.id));
    const selected = requested.filter((id) => running.has(id));
    const requestedMaster = selected.includes(String(payload?.master || '')) ? String(payload.master) : null;
    const master = requestedMaster && engine.running.get(requestedMaster)?.port
      ? requestedMaster
      : selected.find((id) => engine.running.get(id)?.port);
    const ordered = master ? [master, ...selected.filter((id) => id !== master)] : selected;
    return updateSyncSelection(ordered);
  });
  ipcMain.handle('sync-floating:stop', (event) => {
    assertSyncFloatingSender(event);
    return endSync();
  });
  ipcMain.handle('sync-floating:restart', (event) => {
    assertSyncFloatingSender(event);
    return restartSync();
  });
  ipcMain.handle('sync-floating:window', (event, payload) => {
    assertSyncFloatingSender(event);
    return performWindowAction(payload?.ids || [], payload?.action, payload?.layout);
  });
  ipcMain.handle('sync-floating:text', (event, payload) => {
    assertSyncFloatingSender(event);
    return performTextAction(payload || {});
  });
  ipcMain.handle('sync-floating:text-batch', (event, payload) => {
    assertSyncFloatingSender(event);
    return performBatchTextAction(payload || {});
  });
  ipcMain.handle('sync-floating:settings', (event, payload) => {
    assertSyncFloatingSender(event);
    return liveSync.updateSettings(payload || {});
  });
  ipcMain.handle('sync-floating:tabs', (event, payload) => {
    assertSyncFloatingSender(event);
    return performTabAction(payload || {});
  });
  ipcMain.handle('sync-floating:open-manager', (event, payload) => {
    assertSyncFloatingSender(event);
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.focus();
    mainWindow.webContents.send('engine:event', { type: 'navigate-sync', openSettings: Boolean(payload?.openSettings) });
    return { success: true };
  });
  ipcMain.handle('sync-floating:hide', async (event) => {
    assertSyncFloatingSender(event);
    return setSyncFloatingEnabled(false);
  });
  ipcMain.handle('sync-floating:set-expanded', (event, expanded) => {
    assertSyncFloatingSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { success: false };
    const [width] = win.getContentSize();
    win.setContentSize(width, expanded ? 360 : 50, true);
    return { success: true, expanded: Boolean(expanded) };
  });
}

async function createWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const chrome = chromeForTheme('pixel-workstation');

  /** @type {Record<string, any>} */
  const options = {
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: 'AiBrowser',
    icon: (() => {
      // Windows must use the same multi-resolution ICO as the packaged EXE;
      // otherwise a pinned taskbar item can switch icons after the window opens.
      const pixelPng = path.join(__dirname, 'assets', 'logo-pixel.png');
      const icns = path.join(__dirname, 'assets', 'logo.icns');
      const png = path.join(__dirname, 'assets', 'logo.png');
      const ico = path.join(__dirname, 'assets', 'logo.ico');
      if (isMac && fs.existsSync(icns)) return icns;
      if (isWin && fs.existsSync(ico)) return ico;
      if (fs.existsSync(pixelPng)) return pixelPng;
      if (fs.existsSync(png)) return png;
      return ico;
    })(),
    backgroundColor: chrome.bg,
    show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  };

  // Fuse system title bar with in-app chrome (shipping-app style)
  if (isMac) {
    options.titleBarStyle = 'hiddenInset';
    // Sit in the empty strip above brand (brand is pushed down in CSS)
    options.trafficLightPosition = { x: 12, y: 14 };
    options.transparent = false;
  } else if (isWin) {
    // Same shipping-app fusion as macOS: custom chrome + native caption buttons
    options.titleBarStyle = 'hidden';
    options.frame = true;
    options.titleBarOverlay = {
      color: chrome.overlay,
      symbolColor: chrome.symbol,
      height: 32,
    };
  }

  const win = new BrowserWindow(options);
  let taskbarShortcutReady = false;
  const applyWindowsTaskbarDetails = () => {
    if (!isWin || win.isDestroyed()) return;
    try {
      const requestedRelaunch = String(process.env.OPENBROWSER_TASKBAR_RELAUNCH || '').trim();
      const relaunchExecutable = requestedRelaunch && fs.existsSync(requestedRelaunch)
        ? path.resolve(requestedRelaunch)
        : process.execPath;
      const relaunchIcon = path.join(__dirname, 'assets', 'logo.ico');
      if (typeof win.setAppDetails === 'function') {
        try {
          win.setAppDetails({
            appId: 'com.aibrowser.localworkspace',
            appIconPath: fs.existsSync(relaunchIcon) ? relaunchIcon : relaunchExecutable,
            appIconIndex: 0,
            relaunchCommand: `"${relaunchExecutable}"`,
            relaunchDisplayName: 'AiBrowser',
          });
        } catch (error) {
          console.warn('[taskbar] Electron app details unavailable:', error.message);
        }
      }
      if (!taskbarShortcutReady && hostStartMenuPrograms && typeof shell.writeShortcutLink === 'function') {
        const shortcutPath = path.join(hostStartMenuPrograms, 'AiBrowser', 'AiBrowser.lnk');
        fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
        const operation = fs.existsSync(shortcutPath) ? 'update' : 'create';
        taskbarShortcutReady = shell.writeShortcutLink(shortcutPath, operation, {
          target: relaunchExecutable,
          cwd: path.dirname(relaunchExecutable),
          description: 'AiBrowser',
          icon: fs.existsSync(relaunchIcon) ? relaunchIcon : relaunchExecutable,
          iconIndex: 0,
          appUserModelId: 'com.aibrowser.localworkspace',
        });
        if (!taskbarShortcutReady) console.warn('[taskbar] unable to create the AiBrowser Start Menu shortcut');
      }
    } catch (error) {
      console.warn('[taskbar] unable to set Windows relaunch metadata:', error.message);
    }
  };
  applyWindowsTaskbarDetails();
  mainWindow = win;
  windows.add(win);
  win.on('closed', () => {
    windows.delete(win);
    if (mainWindow === win) mainWindow = null;
    if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) syncFloatingWindow.destroy();
  });
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.show();
    applyWindowsTaskbarDetails();
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // The packaged EXE boots through resources/app.asar and requires this file
  // from resources/app. A relative path resolves against the launch working
  // directory and produced a blank window when users started the root EXE.
  await win.loadFile(path.join(__dirname, 'index.html'));
  if (!win.isVisible()) win.show();
  applyWindowsTaskbarDetails();
  if (win.isMinimized()) win.restore();
  win.focus();
}

app.whenReady().then(async () => {
  try { app.setName('AiBrowser'); } catch (_) { /* ignore */ }
  try { process.title = 'AiBrowser'; } catch (_) { /* ignore */ }
  if (process.platform === 'darwin' && app.dock) {
    // Software Dock / shortcut icon = logo-pixel (not browser logo-native)
    try {
      const { rebuildAppShortcutIcons } = require('./automation/env-icon');
      rebuildAppShortcutIcons();
    } catch (error) {
      console.warn('AiBrowser app icons rebuild skipped:', error.message);
    }
    const dockCandidates = [
      path.join(__dirname, 'assets', 'logo-pixel.png'),
      path.join(__dirname, 'assets', 'logo.png'),
      path.join(__dirname, 'assets', 'logo.icns'),
    ];
    for (const dockIcon of dockCandidates) {
      try {
        if (fs.existsSync(dockIcon)) {
          app.dock.setIcon(dockIcon);
          break;
        }
      } catch (error) {
        console.warn('AiBrowser Dock icon could not be applied:', error.message);
      }
    }
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = String(details.url || '');
    const allowed = url.startsWith('file:') || url.startsWith('data:') || url.startsWith('devtools:')
      || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url);
    callback({ cancel: !allowed });
  });
  const localSettings = await loadLocalSettings();
  const initialRootCheck = await ensureDataRootIsolationSecure(localSettings.profileDataRoot);
  if (!initialRootCheck.ok) throw new Error(initialRootCheck.message);
  engine = new BrowserEngine(app, { profileDataRoot: localSettings.profileDataRoot });
  liveSync = new LiveSyncController(engine, handleLiveSyncEvent);
  await engine.init(path.join(__dirname, 'bundled-extension'));
  try {
    const startPage = await engine.ensureStartPage();
    startPage.setEngine?.(engine);
    console.log('AiBrowser start page:', startPage.info?.() || startPage.port);
  } catch (error) {
    console.error('AiBrowser start page server failed:', error.message);
  }
  engine.on((value) => {
    emit(value);
    if (value?.id && (
      value.type === 'profile-stopped'
      || value.type === 'profile-closed'
      || (value.type === 'status' && value.running === false)
    )) {
      automation?.proxyStore?.releaseScope?.(value.id).catch(() => {});
    }
    // Hub/ix style: when an opted-in profile closes, auto-push that env to cloud
    if (value?.type === 'profile-closed' && value.cloudBackup && value.profile?.id) {
      const cloud = localSettingsCache?.cloud || {};
      if (cloud.enabled) {
        runCloudProfilePush({
          profileIds: [value.profile.id],
          profiles: [value.profile],
          groups: localSettingsCache.uiGroups || [],
          cloud,
        }).catch((error) => {
          console.warn('AiBrowser auto cloud push failed:', error.message);
          emit({ type: 'cloud-sync', action: 'profile-push-error', id: value.profile.id, message: error.message });
        });
      }
    }
  });
  engine.ensureKernelBootstrap().catch((error) => console.error('AiBrowser kernel bootstrap failed:', error.message));
  startShortcutBridge();
  registerTextShortcuts();
  registerSyncFloatingIpc();

  try {
    automation = await startAutomation({
      app,
      engine,
      liveSync,
      beginSync,
      endSync,
      restartSync,
      getSyncState: syncSnapshot,
      setSelection: (ids) => {
        syncSelection = sanitizeIds(ids);
        syncState.selected = [...syncSelection];
        emit({ type: 'sync-state', ...syncSnapshot() });
      },
      tile,
      emit,
      port: Number(process.env.OPENBROWSER_API_PORT || 50325),
      apiKey: process.env.OPENBROWSER_API_KEY || undefined,
      // Lazy: aiService is constructed further down, after this stack.
      getAiService: () => aiService,
    });
    // Hand the launched-browser sidebar a reachable endpoint + credential.
    // Browsers started before this point simply get no sidebar, which is why
    // it is set immediately after the API server reports its port.
    engine.agentApi = {
      base: `http://127.0.0.1:${automation.info?.port || process.env.OPENBROWSER_API_PORT || 50325}`,
      key: automation.apiKey,
    };
  } catch (error) {
    emit({ type: 'local-api-error', message: error.message });
    console.error('Local API failed to start:', error.message);
  }

  aiService = new AiService({
    userDataPath: app.getPath('userData'),
    getContext: () => {
      const status = Array.isArray(engine?.status?.()) ? engine.status() : [];
      const profiles = [...(engine?.profiles?.values?.() || [])].map((profile) => ({
        id: String(profile.id || ''),
        name: String(profile.name || profile.id || ''),
        number: profile.number || null,
        running: Boolean(status.find((item) => item.id === profile.id)?.running),
        groupId: String(profile.groupId || ''),
        proxyMode: String(profile.networkMode || profile.proxyMode || ''),
      })).slice(0, 200);
      let proxies = [];
      try {
        proxies = (automation?.proxyStore?.list?.({}) || []).map((proxy) => ({
          id: String(proxy.id || ''),
          name: String(proxy.name || ''),
          protocol: String(proxy.protocol || ''),
          host: String(proxy.host || ''),
          port: proxy.port || null,
          groupId: String(proxy.groupId || ''),
          latency: proxy.latency ?? null,
          available: proxy.available ?? null,
        })).slice(0, 300);
      } catch (_) {}
      const plans = (automation?.rpaStore?.listPlans?.() || []).map((plan) => ({
        id: String(plan.id || ''),
        name: String(plan.plan_name || plan.name || ''),
        stepCount: Array.isArray(plan.steps) ? plan.steps.length : 0,
        profileIds: Array.isArray(plan.profile_ids) ? plan.profile_ids.map(String) : [],
        updatedAt: plan.updated_at || plan.updatedAt || null,
      })).slice(0, 100);
      return { profiles, proxies, plans };
    },
  });
  try {
    await aiService.init();
  } catch (error) {
    console.error('AiBrowser AI service failed to initialize:', error.message);
  }

  registerTrustedIpc('system:info', () => ({
    appVersion: app.getVersion(),
    chrome: process.versions.chrome,
    browsers: engine.candidates(),
    profileRoot: engine.getProfileDataRoot(),
    defaultProfileRoot: defaultProfileDataRoot,
    localApi: automation?.info || null,
    startPage: engine.startPageServer?.info?.() || null,
    kernel: engine.kernelStatus(),
    kernelSelection: engine.browserSelection(),
    systemBrowsers: engine.systemBrowserCandidates().filter((item) => fs.existsSync(item.path)),
    preferIndependentKernel: engine.preferIndependentKernel,
    allowSystemBrowserFallback: engine.allowSystemBrowserFallback,
    systemBrowserPath: engine.systemBrowserPath,
    titleBarIntegrated: process.platform === 'darwin' || process.platform === 'win32',
    platform: process.platform,
    syncFloatingEnabled: localSettingsCache.syncFloatingEnabled === true,
  }));
  registerTrustedIpc('app:update-check', () => pushAppUpdateStatus({ check: true }));
  registerTrustedIpc('app:update-download', () => downloadAppUpdate());
  registerTrustedIpc('system:set-ui-chrome', (_event, payload) => {
    const win = BrowserWindow.fromWebContents(_event.sender) || mainWindow;
    const themeId = typeof payload === 'string' ? payload : String(payload?.themeId || '');
    const colorMode = typeof payload === 'object' && payload ? String(payload.colorMode || 'light') : 'light';
    currentUiTheme = { themeId: themeId || 'pixel-workstation', colorMode };
    applyWindowChrome(win, themeId, colorMode);
    if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) {
      applyWindowChrome(syncFloatingWindow, currentUiTheme.themeId, currentUiTheme.colorMode);
      syncFloatingWindow.webContents.send('sync-floating:theme', currentUiTheme);
    }
    return { success: true, theme: themeId, colorMode };
  });
  registerTrustedIpc('system:set-sync-floating', (_event, enabled) => setSyncFloatingEnabled(enabled));
  registerTrustedIpc('kernel:status', () => engine.kernelStatus());
  registerTrustedIpc('kernel:download', async (_event, force) => engine.ensureIndependentKernel(Boolean(force)));
  registerTrustedIpc('kernel:check-update', async () => engine.checkKernelUpdate());
  registerTrustedIpc('kernel:set-custom', async (_event, binaryPath) => engine.setCustomKernel(String(binaryPath || '')));
  registerTrustedIpc('kernel:policy', async (_event, policy) => engine.setKernelPolicy(policy || {}));
  registerTrustedIpc('kernel:choose-custom', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择独立 Chromium / Chrome 可执行文件',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Executable', extensions: ['exe'] }]
        : [{ name: 'All', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const kernel = await engine.setCustomKernel(result.filePaths[0]);
    return { canceled: false, kernel };
  });
  registerTrustedIpc('system:get-storage', () => ({ profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot, running: engine.running.size }));
  registerTrustedIpc('system:choose-storage', async () => {
    if (engine.running.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
    const options = { title: '\u9009\u62e9\u73af\u5883\u6570\u636e\u4fdd\u5b58\u76ee\u5f55', defaultPath: engine.getProfileDataRoot(), properties: ['openDirectory', 'createDirectory', 'promptToCreate'] };
    const result = mainWindow && !mainWindow.isDestroyed() ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return { canceled: true, profileRoot: engine.getProfileDataRoot(), defaultProfileRoot: defaultProfileDataRoot };
    return { canceled: false, ...(await updateProfileDataRoot(result.filePaths[0], { rebase: false })) };
  });
  registerTrustedIpc('system:reset-storage', () => updateProfileDataRoot(defaultProfileDataRoot));
  registerTrustedIpc('system:open-storage', async () => {
    const profileRoot = engine.getProfileDataRoot(); await fsp.mkdir(profileRoot, { recursive: true });
    const message = await shell.openPath(profileRoot); if (message) throw new Error(message);
    return { success: true, profileRoot };
  });
  registerTrustedIpc('cloud:get-config', async () => {
    await loadLocalSettings();
    return localSettingsCache.cloud || cloudSync.defaultCloudConfig();
  });
  registerTrustedIpc('cloud:set-config', async (_event, cloud) => {
    await loadLocalSettings();
    const next = { ...cloudSync.defaultCloudConfig(), ...(localSettingsCache.cloud || {}), ...(cloud || {}) };
    await saveLocalSettings({ ...localSettingsCache, cloud: next });
    return next;
  });
  registerTrustedIpc('cloud:choose-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择云备份本地目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return { canceled: false, dir: result.filePaths[0] };
  });
  registerTrustedIpc('cloud:backup', async (_event, payload) => runCloudBackup(payload || {}));
  registerTrustedIpc('cloud:restore', async (_event, payload) => runCloudRestore(payload || {}));
  registerTrustedIpc('cloud:profile-push', async (_event, payload) => runCloudProfilePush(payload || {}));
  registerTrustedIpc('cloud:profile-pull', async (_event, payload) => runCloudProfilePull(payload || {}));
  registerTrustedIpc('cloud:export-file', async (_event, payload) => {
    const cloud = { ...localSettingsCache.cloud, ...(payload?.cloud || {}) };
    const profiles = Array.isArray(payload?.profiles) ? payload.profiles : [...(engine?.profiles?.values?.() || [])];
    const groups = Array.isArray(payload?.groups) ? payload.groups : (localSettingsCache.uiGroups || []);
    let proxies = [];
    try { proxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
    const { buffer, meta } = await cloudSync.buildBackupPackage({
      profiles,
      groups,
      proxies,
      settings: {},
      profileDataRoot: engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot,
      includeBrowserData: cloud.includeBrowserData !== false,
      passphrase: cloud.passphrase || '',
      profileIds: payload?.profileIds || null,
    });
    const result = await dialog.showSaveDialog({
      title: '导出 AiBrowser 备份',
      defaultPath: `aibrowser-backup-${Date.now()}.obpack`,
      filters: [{ name: 'AiBrowser Backup', extensions: ['obpack'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, buffer);
    return { success: true, path: result.filePath, meta };
  });
  registerTrustedIpc('cloud:import-file', async (_event, payload) => {
    const result = await dialog.showOpenDialog({
      title: '导入 AiBrowser 备份',
      properties: ['openFile'],
      filters: [{ name: 'AiBrowser Backup', extensions: ['obpack', 'json', 'gz'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const buffer = await fsp.readFile(result.filePaths[0]);
    const body = await cloudSync.parseBackupPackage(buffer, payload?.passphrase || localSettingsCache.cloud?.passphrase || '');
    const mode = String(payload?.mode || localSettingsCache.cloud?.restoreMode || 'merge');
    const applied = await applyBackupBody(body, {
      mode,
      localProfiles: payload?.localProfiles,
      localGroups: payload?.localGroups,
    });
    return { success: true, mode, ...applied };
  });
  registerTrustedIpc('profiles:sync', (_event, profiles) => engine.syncProfiles(profiles));
  registerTrustedIpc('profiles:delete', async (_event, payload) => {
    const ids = sanitizeIds(payload?.ids || []);
    if (syncState.active && syncState.selected.some((id) => ids.includes(id))) await endSync();
    syncSelection = syncSelection.filter((id) => !ids.includes(id));
    syncState = { ...syncState, selected: syncState.selected.filter((id) => !ids.includes(id)) };
    emit({ type: 'sync-state', ...syncSnapshot() });
    return engine.deleteProfiles(ids, payload?.deleteData !== false);
  });
  const prepareLibraryProxy = async (profile) => {
    const libraryProxyId = String(profile?.proxyMeta?.libraryProxyId || '').trim();
    if (!libraryProxyId) return profile;
    if (!automation?.proxyStore) throw new Error('代理库未就绪');
    let frontProxy = null;
    if (profile?.networkMode === 'proxy' && profile?.proxyMeta?.frontProxyMode === 'system') {
      const system = await resolveSystemProxy();
      if (!system.raw) {
        const detail = system.pacUrl
          ? '当前系统使用 PAC 自动配置，无法解析成固定前置代理地址'
          : '操作系统当前没有启用可用的 HTTP/SOCKS5 代理';
        throw new Error('系统前置代理不可用：' + detail);
      }
      const parsed = parseProxy(system.raw);
      if (!parsed || !['http', 'socks5'].includes(parsed.protocol)) {
        throw new Error('系统前置代理仅支持 HTTP 或 SOCKS5 固定端点');
      }
      frontProxy = {
        enabled: true,
        raw: parsed.raw,
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        source: system.source,
      };
    }
    const resolved = await automation.proxyStore.resolveForUse(libraryProxyId, {
      frontProxy,
      scopeKey: profile.id,
    });
    return {
      ...profile,
      networkMode: 'proxy',
      proxy: resolved.raw,
      proxyMeta: {
        ...(profile.proxyMeta || {}),
        libraryProxyId,
        frontProxyHandledByLibrary: Boolean(frontProxy),
      },
    };
  };
  registerTrustedIpc('profiles:start', async (_event, profile) => engine.start(await prepareLibraryProxy(profile)));
  registerTrustedIpc('profiles:stop', async (_event, id) => {
    const result = await engine.stop(id);
    await automation?.proxyStore?.releaseScope?.(String(id || '')).catch(() => {});
    return result;
  });
  registerTrustedIpc('profiles:clear-cache-cookies', (_event, id) => engine.clearProfileCacheAndCookies(id));
  registerTrustedIpc('profiles:status', () => engine.status());
  registerTrustedIpc('profiles:test-proxy', async (_event, profile) => {
    const prepared = await prepareLibraryProxy(profile);
    try {
      return await engine.testProxy(prepared);
    } finally {
      if (!engine.running.has(prepared.id)) await automation?.proxyStore?.releaseScope?.(prepared.id).catch(() => {});
    }
  });
  registerTrustedIpc('profiles:check-proxy', async (_event, profile) => {
    const prepared = await prepareLibraryProxy(profile);
    try {
      return await engine.checkProxy(prepared);
    } finally {
      if (!engine.running.has(prepared.id)) await automation?.proxyStore?.releaseScope?.(prepared.id).catch(() => {});
    }
  });

  registerTrustedIpc('extensions:list', () => engine.listExtensions());
  registerTrustedIpc('extensions:add-folder', async () => {
    const result = await dialog.showOpenDialog({ title: '选择已解压的 Chrome 扩展目录', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const extension = await engine.addExtension(result.filePaths[0]);
    const ids = [...engine.profiles.keys()]; const running = ids.filter((id) => engine.running.has(id));
    if (ids.length) await engine.assignExtension(extension.id, ids, true);
    for (const id of running) await engine.stop(id);
    for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    return { canceled: false, extension, assigned: ids.length, restarted: running.length };
  });
  registerTrustedIpc('extensions:add-store', async (_event, payload) => {
    const ids = sanitizeIds(payload.profileIds || []);
    const storeUrl = String(payload.url || ''); let extension;
    try { extension = await engine.addStoreExtension(storeUrl); }
    catch (directError) {
      try { extension = await engine.addStoreExtension(storeUrl, (url) => fetchStorePackage(url, 'system')); }
      catch (systemError) { throw new Error(`Chrome 应用商店下载失败。直连：${directError.message}；系统代理：${systemError.message}`); }
    }
    const running = new Set(engine.status().filter((item) => item.running && ids.includes(item.id)).map((item) => item.id));
    if (ids.length) await engine.assignExtension(extension.id, ids, true);
    if (payload.restart) {
      for (const id of running) await engine.stop(id);
      for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    }
    return { extension, assigned: ids.length, restarted: payload.restart ? running.size : 0 };
  });
  registerTrustedIpc('extensions:assign', (_event, payload) => engine.assignExtension(String(payload.extensionId), sanitizeIds(payload.profileIds), Boolean(payload.enabled)));
  registerTrustedIpc('extensions:toggle-all', async (_event, payload) => {
    const extensionId = String(payload.extensionId || ''); const enabled = Boolean(payload.enabled);
    const ids = [...engine.profiles.keys()]; const running = ids.filter((id) => engine.running.has(id));
    await engine.assignExtension(extensionId, ids, enabled);
    for (const id of running) await engine.stop(id);
    for (const id of running) { const profile = engine.profiles.get(id); if (profile) await engine.start(profile); }
    return { success: true, enabled, affected: ids.length, restarted: running.length };
  });
  registerTrustedIpc('extensions:remove', (_event, id) => engine.removeExtension(String(id)));

  registerTrustedIpc('sync:sessions', () => engine.sessions());
  registerTrustedIpc('sync:selection', (_event, ids) => updateSyncSelection(ids));
  registerTrustedIpc('sync:state', () => syncSnapshot());
  registerTrustedIpc('sync:settings:get', () => liveSync.getSettings());
  registerTrustedIpc('sync:settings:set', (_event, value) => liveSync.updateSettings(value));
  registerTrustedIpc('sync:start', (_event, ids) => beginSync(ids));
  registerTrustedIpc('sync:stop', () => endSync());
  registerTrustedIpc('sync:restart', () => restartSync());
  registerTrustedIpc('sync:window', (_event, payload) => performWindowAction(payload?.ids || [], payload?.action, payload?.layout));
  registerTrustedIpc('sync:text', (_event, payload) => performTextAction(payload));
  registerTrustedIpc('sync:text-batch', (_event, payload) => performBatchTextAction(payload));
  registerTrustedIpc('sync:tabs', (_event, payload) => performTabAction(payload));

  registerTrustedIpc('automation:local-api', () => automation?.info || null);
  registerTrustedIpc('automation:fingerprint', (_event, id) => engine.fingerprintFor(String(id || '')));
  registerTrustedIpc('automation:isolation-audit', () => engine.isolationAudit());
  registerTrustedIpc('automation:build-ua', (_event, payload = {}) => {
    const { buildUaProfile, randomUaForSeed, parseOsFromUa } = require('./automation/user-agent');
    const crypto = require('crypto');
    if (payload?.random) {
      const seed = crypto.randomBytes(4).readUInt32BE(0);
      return randomUaForSeed(seed, {
        majors: payload.chromeMajor ? [Number(payload.chromeMajor)] : undefined,
        osList: payload.os ? [payload.os] : undefined,
      });
    }
    const osMap = { Windows: 'windows', windows: 'windows', macOS: 'macos', macos: 'macos', Mac: 'macos', Linux: 'linux', linux: 'linux' };
    const os = osMap[payload.os] || payload.os || parseOsFromUa(payload.userAgent || '') || undefined;
    return buildUaProfile({
      userAgent: payload.userAgent || '',
      os,
      chromeMajor: Number(payload.chromeMajor) || undefined,
      chromeFull: payload.chromeFull || payload.fullVersion,
      reduced: payload.reduced !== false,
    });
  });

  const proxyStore = () => {
    if (!automation?.proxyStore) throw new Error('代理库未就绪');
    return automation.proxyStore;
  };
  registerTrustedIpc('proxy:list', (_event, filter) => proxyStore().list(filter || {}));
  registerTrustedIpc('proxy:state', (_event, filter) => proxyStore().state(filter || {}));
  registerTrustedIpc('proxy:parse-input', (_event, value) => proxyStore().parseInput(String(value || '')));
  registerTrustedIpc('proxy:get', (_event, id) => proxyStore().get(String(id || '')));
  registerTrustedIpc('proxy:create', (_event, payload) => proxyStore().create(payload || {}));
  registerTrustedIpc('proxy:update', (_event, payload) => {
    const id = String(payload?.id || payload?.proxy_id || '');
    if (!id) throw new Error('id required');
    return proxyStore().update(id, payload || {});
  });
  registerTrustedIpc('proxy:delete', (_event, ids) => proxyStore().remove(ids));
  registerTrustedIpc('proxy:subscription-save', (_event, payload) => proxyStore().upsertSubscription(payload || {}));
  registerTrustedIpc('proxy:subscription-sync', (_event, id) => proxyStore().syncSubscription(String(id || '')));
  registerTrustedIpc('proxy:group-update', (_event, payload) => proxyStore().updateGroup(payload || {}));
  registerTrustedIpc('proxy:resolve', (_event, id) => proxyStore().resolveForUse(String(id || '')));
  registerTrustedIpc('proxy:check', async (_event, payload) => {
    const store = proxyStore();
    const id = String(payload?.id || payload?.proxy_id || '');
    const item = id ? store.get(id) : null;
    let draftRaw = String(payload?.raw || payload?.proxy || '').trim();
    if (!item && !draftRaw && payload?.host && payload?.port) {
      const protocol = String(payload?.protocol || payload?.type || 'socks5').toLowerCase();
      if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) {
        throw new Error('该协议需要提供完整的原始代理链接');
      }
      const username = String(payload?.username || payload?.user || '');
      const password = String(payload?.password || '');
      const auth = username
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
        : '';
      draftRaw = `${protocol}://${auth}${String(payload.host).trim()}:${Number(payload.port)}`;
    }
    const needsDraftMihomo = /^(?:vless|hysteria2|hy2):\/\//i.test(draftRaw);
    const resolved = item
      ? await store.resolveForUse(item.id)
      : (needsDraftMihomo ? await store.resolveDraft({ ...(payload || {}), raw: draftRaw }) : null);
    const raw = resolved?.raw || draftRaw;
    if (!raw) throw new Error('proxy required');
    try {
      const result = await engine.testProxy({
        id: 'proxy-check',
        name: 'proxy-check',
        proxy: raw,
        proxyMeta: {
          ipChannel: item?.ipChannel || payload?.ipChannel || 'ip-api',
          apiExtractUrl: item?.refreshUrl || payload?.apiExtractUrl || '',
          refreshUrl: item?.refreshUrl || payload?.refreshUrl || '',
        },
      });
      if (item) await store.markCheck(item.id, result);
      return { ...result, proxy: item ? store.get(item.id) : null };
    } catch (error) {
      if (item) {
        await store.markCheckError(item.id, {
          errorClass: error.errorClass || 'unknown',
          latencyMs: error.latencyMs,
        });
      }
      throw error;
    }
  });
  registerTrustedIpc('proxy:check-many', async (_event, payload) => {
    const store = proxyStore();
    const ids = [...new Set(Array.isArray(payload?.ids) ? payload.ids.map(String).filter(Boolean) : [])].slice(0, 5000);
    if (!ids.length) throw new Error('ids required');
    const concurrency = Math.max(1, Math.min(12, Number(payload?.concurrency) || 6));
    const batchId = String(payload?.batchId || '').slice(0, 100);
    const startedAt = Date.now();
    const results = new Array(ids.length);
    let cursor = 0;
    let completed = 0;
    let succeeded = 0;
    let failed = 0;
    emit({ type: 'proxy-check-progress', batchId, state: 'running', total: ids.length, completed, ok: succeeded, fail: failed });
    const checkOne = async (id) => {
      const item = store.get(id);
      if (!item) {
        return { id, ok: false, error: 'not found', errorClass: 'not_found' };
      }
      try {
        const resolved = await store.resolveForUse(item.id);
        const result = await engine.testProxy({
          id: 'proxy-check',
          name: item.name || 'proxy-check',
          proxy: resolved.raw,
          proxyMeta: { ipChannel: item.ipChannel || 'ip-api', refreshUrl: item.refreshUrl || '', apiExtractUrl: item.refreshUrl || '' },
        });
        return { id, ok: true, ...result };
      } catch (error) {
        return {
          id,
          ok: false,
          error: error.message || String(error),
          errorClass: error.errorClass || 'unknown',
          latencyMs: error.latencyMs || null,
        };
      }
    };
    const worker = async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await checkOne(ids[index]);
        completed += 1;
        if (results[index].ok) succeeded += 1;
        else failed += 1;
        emit({ type: 'proxy-check-progress', batchId, state: 'running', total: ids.length, completed, ok: succeeded, fail: failed });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));
    await store.markCheckMany(results.map((result) => result.ok
      ? { id: result.id, ok: true, result }
      : { id: result.id, ok: false, error: result }));
    for (const result of results) result.proxy = store.get(result.id);
    const successfulLatencies = results
      .filter((result) => result.ok && Number.isFinite(Number(result.latencyMs)))
      .map((result) => Number(result.latencyMs));
    const summary = {
      results,
      total: results.length,
      ok: succeeded,
      fail: failed,
      concurrency: Math.min(concurrency, ids.length),
      elapsedMs: Date.now() - startedAt,
      averageLatencyMs: successfulLatencies.length
        ? Math.round(successfulLatencies.reduce((sum, latency) => sum + latency, 0) / successfulLatencies.length)
        : null,
      fastestLatencyMs: successfulLatencies.length ? Math.min(...successfulLatencies) : null,
    };
    emit({
      type: 'proxy-check-progress',
      batchId,
      state: 'complete',
      total: summary.total,
      completed: summary.total,
      ok: summary.ok,
      fail: summary.fail,
      averageLatencyMs: summary.averageLatencyMs,
      elapsedMs: summary.elapsedMs,
    });
    return summary;
  });
  registerTrustedIpc('profiles:refresh-proxy', async (_event, profile) => {
    const prepared = await prepareLibraryProxy(profile);
    try {
      return await engine.refreshProfileProxy(prepared);
    } finally {
      if (!engine.running.has(prepared.id)) await automation?.proxyStore?.releaseScope?.(prepared.id).catch(() => {});
    }
  });
  registerTrustedIpc('profiles:apply-proxy-fingerprint', async (_event, profile) => {
    const prepared = await prepareLibraryProxy(profile);
    try {
      return await engine.checkProxy(prepared, { persist: true });
    } finally {
      if (!engine.running.has(prepared.id)) await automation?.proxyStore?.releaseScope?.(prepared.id).catch(() => {});
    }
  });
  registerTrustedIpc('automation:app-center', (_event, filter) => {
    if (!automation?.appCenter) return { list: { builtin: [], recommended: [], local: [] }, counts: { builtin: 0, recommended: 0, local: 0, installed: 0 } };
    return automation.appCenter.list(filter || {});
  });
  registerTrustedIpc('automation:app-center-icons', async (_event, storeIds) => {
    const ids = [...new Set((Array.isArray(storeIds) ? storeIds : []).map(validChromeStoreId).filter(Boolean))].slice(0, 50);
    const entries = await Promise.all(ids.map(async (id) => [id, await fetchChromeStoreIcon(id)]));
    return Object.fromEntries(entries.filter(([, iconUrl]) => iconUrl));
  });
  registerTrustedIpc('automation:app-center-metadata', async (_event, storeIds) => {
    const ids = [...new Set((Array.isArray(storeIds) ? storeIds : []).map(validChromeStoreId).filter(Boolean))].slice(0, 50);
    const entries = await Promise.all(ids.map(async (id) => [id, await fetchChromeStoreMetadata(id).catch(() => null)]));
    return Object.fromEntries(entries.filter(([, metadata]) => metadata));
  });
  registerTrustedIpc('ai:state', () => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.getState();
  });
  registerTrustedIpc('ai:provider-save', (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.saveProvider(payload || {});
  });
  registerTrustedIpc('ai:provider-delete', (_event, id) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.deleteProvider(String(id || ''));
  });
  registerTrustedIpc('ai:provider-active', (_event, id) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.setActiveProvider(String(id || ''));
  });
  registerTrustedIpc('ai:models', (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.listModels(payload || {});
  });
  registerTrustedIpc('ai:test', (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.testProvider(payload || {});
  });
  registerTrustedIpc('ai:sessions', () => aiService?.listSessions?.() || []);
  registerTrustedIpc('ai:session-create', (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.createSession(payload || {});
  });
  registerTrustedIpc('ai:session-get', (_event, id) => aiService?.getSession?.(String(id || '')) || null);
  registerTrustedIpc('ai:session-delete', (_event, id) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.deleteSession(String(id || ''));
  });
  registerTrustedIpc('ai:chat', (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.chat(payload || {});
  });
  registerTrustedIpc('ai:generate-rpa', (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    return aiService.generateRpa(payload || {});
  });
  registerTrustedIpc('automation:rpa-status', () => automation?.rpaEngine?.getStatus?.() || { running: [], count: 0 });
  registerTrustedIpc('automation:rpa-plans', () => automation?.rpaStore?.listPlans?.() || []);
  registerTrustedIpc('automation:rpa-tasks', (_event, filter) => automation?.rpaStore?.listTasks?.(filter || {}) || []);
  registerTrustedIpc('automation:rpa-delete-tasks', async (_event, ids) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const protectedIds = automation.rpaEngine?.getStatus?.().running || [];
    return automation.rpaStore.deleteTasks(ids, { protectedIds });
  });
  registerTrustedIpc('automation:rpa-get-plan', (_event, id) => automation?.rpaStore?.getPlan?.(String(id || '')) || null);
  registerTrustedIpc('automation:rpa-choose-data-file', async () => {
    const options = {
      title: '选择流程数据文件',
      properties: ['openFile'],
      filters: [
        { name: '流程数据', extensions: ['xlsx', 'csv', 'json'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    };
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    return { canceled: false, path: result.filePaths[0] };
  });
  registerTrustedIpc('automation:rpa-save-plan', (_event, plan) => {
    if (!automation) throw new Error('Automation stack is not ready');
    return automation.rpaStore.upsertPlan(plan);
  });
  registerTrustedIpc('automation:rpa-delete-plan', (_event, id) => {
    if (!automation) throw new Error('Automation stack is not ready');
    return automation.rpaStore.deletePlan(String(id || ''));
  });
  registerTrustedIpc('automation:rpa-run', async (_event, payload) => {
    if (!automation) throw new Error('Automation stack is not ready');
    if (payload?.plan_id) return automation.rpaEngine.runPlan(String(payload.plan_id), payload);
    if (payload?.task_id) return automation.rpaEngine.runTask(String(payload.task_id), payload);
    if (Array.isArray(payload?.steps)) {
      const task = await automation.rpaStore.createTask({
        profile_id: String(payload.profile_id || ''),
        process_name: String(payload.name || 'ipc-rpa'),
        steps: payload.steps,
      });
      return automation.rpaEngine.runTask(task.id, payload);
    }
    throw new Error('plan_id, task_id or steps required');
  });
  registerTrustedIpc('automation:rpa-stop', (_event, taskId) => automation?.rpaEngine?.stop?.(taskId || null));
  registerTrustedIpc('automation:rpa-templates', (_event, filter) => {
    if (!automation?.rpaStore) return { list: [], categories: ['全部'], config: {} };
    return {
      list: automation.rpaStore.listTemplates(filter || {}),
      categories: automation.rpaStore.listTemplateCategories(),
      config: automation.rpaStore.getConfig?.() || {},
    };
  });
  registerTrustedIpc('automation:rpa-template-get', (_event, id) => automation?.rpaStore?.getTemplate?.(String(id || '')) || null);
  registerTrustedIpc('automation:rpa-template-save', (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.upsertTemplate(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-save-as', (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.saveAsTemplate(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-delete', (_event, id) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.deleteTemplate(String(id || ''));
  });
  registerTrustedIpc('automation:rpa-template-install', (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const id = String(payload?.id || payload?.template_id || '');
    if (!id) throw new Error('template id required');
    return automation.rpaStore.installTemplate(id, payload || {});
  });
  registerTrustedIpc('automation:rpa-template-sync-remote', async (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    // Remote sync is opt-in only: caller must pass base explicitly (no hard-coded host).
    if (payload?.token || payload?.cookie || payload?.apiKey || payload?.base) {
      await automation.rpaStore.setConfig({
        remoteToken: payload.token || undefined,
        remoteCookie: payload.cookie || undefined,
        remoteApiKey: payload.apiKey || undefined,
        remoteApiBase: payload.base || undefined,
        remoteApiOrigin: payload.origin || undefined,
        remoteLang: payload.lang || 'zh-CN',
      });
    }
    return automation.rpaStore.syncRemoteTemplates(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-config', async (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    if (payload && typeof payload === 'object' && Object.keys(payload).length) {
      return automation.rpaStore.setConfig(payload);
    }
    return automation.rpaStore.getConfig();
  });
  registerTrustedIpc('automation:rpa-template-import-remote', async (_event, payload) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    return automation.rpaStore.importRemoteTemplatePayload(payload || {});
  });
  registerTrustedIpc('automation:rpa-template-export', async (_event, id) => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const bundle = id
      ? automation.rpaStore.exportTemplate(String(id))
      : automation.rpaStore.exportAllCustomTemplates();
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showSaveDialog(mainWindow, {
          title: '导出自动脚本模版',
          defaultPath: `aibrowser-rpa-template-${Date.now()}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showSaveDialog({
          title: '导出自动脚本模版',
          defaultPath: `aibrowser-rpa-template-${Date.now()}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.writeFile(result.filePath, JSON.stringify(bundle, null, 2), 'utf8');
    return { success: true, path: result.filePath, count: bundle.templates?.length || 0 };
  });
  registerTrustedIpc('automation:rpa-template-import', async () => {
    if (!automation?.rpaStore) throw new Error('Automation stack is not ready');
    const result = mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showOpenDialog(mainWindow, {
          title: '导入自动脚本模版 JSON',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })
      : await dialog.showOpenDialog({
          title: '导入自动脚本模版 JSON',
          properties: ['openFile'],
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
    if (result.canceled || !result.filePaths?.[0]) return { canceled: true };
    const raw = await fsp.readFile(result.filePaths[0], 'utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      throw new Error('JSON 解析失败：' + error.message);
    }
    return automation.rpaStore.importTemplates(parsed);
  });
  registerTrustedIpc('automation:mcp-paths', () => ({
    mcpScript: path.join(__dirname, 'automation', 'mcp-server.js'),
    appRoot: __dirname,
    port: automation?.info?.port || Number(process.env.OPENBROWSER_API_PORT || 50325),
    apiKey: automation?.apiKey || process.env.OPENBROWSER_API_KEY || '',
    localApi: automation?.info || null,
  }));

  await createWindow();
  if (localSettingsCache.syncFloatingEnabled) {
    const floating = await createSyncFloatingWindow();
    floating.show();
  }
  startAppUpdateWatcher();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const cloud = localSettingsCache?.cloud || {};
  Promise.resolve()
    .then(async () => {
      if (cloud.enabled && cloud.autoSyncOnQuit) {
        try {
          await runCloudBackup({
            profiles: [...(engine?.profiles?.values?.() || [])],
            groups: localSettingsCache.uiGroups || [],
            cloud,
          });
        } catch (error) {
          console.warn('AiBrowser quit auto-backup failed:', error.message);
          try {
            localSettingsCache.cloud = { ...cloud, lastError: error.message };
            await saveLocalSettings(localSettingsCache);
          } catch (_) {}
        }
      }
    })
    .then(() => Promise.resolve(automation?.stop?.()).catch((error) => {
      console.warn('AiBrowser quit automation stop failed:', error?.message || error);
    }))
    .then(() => (engine ? engine.stopAll() : null))
    .catch((error) => {
      console.warn('AiBrowser quit cleanup failed:', error?.message || error);
    })
    .finally(() => app.quit());
});
app.on('will-quit', () => {
  stopShortcutBridge();
  automation?.stop?.().catch(() => {});
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
