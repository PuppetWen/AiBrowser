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

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, nativeTheme, screen, session, shell } = require('./host-bridge');
const path = require('path');
const os = require('os');
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
const { validateDataRootIsolationSecure, ensureDataRootIsolationSecure, validateProfileRootSecure, assertProfileId } = require('./automation/isolation');
const { rebasePortablePath } = require('./portable-paths');
const { parseProxy } = require('./proxy-forwarder');
const { resolveSystemProxy } = require('./automation/system-proxy');
const {
  PET_PHASES,
  PET_MOTION_MODES,
  PET_MOTIONS,
  DEFAULT_PET_CONFIG,
  normalizePetConfig,
  petWindowSize,
} = require('./pet-config');
const { desktopBoundsForDisplays, recoverPetDisplayPosition } = require('./pet-display-geometry');
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
const petAssetRoot = path.join(__dirname, 'assets', 'pets');
const petRuntimeRoot = path.join(__dirname, 'pet-runtime');
const BUNDLED_PET_IDS = Object.freeze([
  'mmd-bianca',
  'mmd-bianca-saint',
  'mmd-emden',
  'mmd-lilith',
  'mmd-odette',
  'mmd-qingxiao',
  'mmd-robin',
  'mmd-thoth-black',
  'mmd-thoth-white',
]);

const UPDATE_REPOSITORY = 'PuppetWen/AiBrowser';
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const UPDATE_HISTORY_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=30`;
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
const BUNDLED_RELEASE_HISTORY = Object.freeze([
  {
    version: '1.0.8',
    name: 'AiBrowser v1.0.8',
    publishedAt: '2026-09-11T04:00:00Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.8',
    notes: [
      '- 全部 6 套主题、7 种深浅外观统一液态玻璃材质。',
      '- 工具栏、文件路径框、下拉菜单、弹窗及同步浮条增加通透染色与边缘高光。',
      '- Windows 11 22H2 及以上启用原生亚克力背景，macOS 使用系统 vibrancy。',
      '- 改善正文、提示、选中标签、代码与状态文字对比度，保留键盘焦点。',
      '- 适配减少透明度、高对比度与减少动态效果，旧平台保留清晰回退。',
    ].join('\n'),
  },
  {
    version: '1.0.7',
    name: 'AiBrowser v1.0.7',
    publishedAt: '2026-09-10T00:00:00Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.7',
    notes: [
      '- 新增 Google 默认指纹环境预设，使用当前 Chromium 内核的原生参数。',
      '- 修复环境隔离、并发启动、代理、指纹注入失败和备份恢复问题。',
      '- 修复保存后立即退出、凭据恢复、导入、语言和表单问题。',
      '- 修复宠物桌面边缘滚动条，并响应显示器、分辨率和 DPI 变化。',
      '- 澄清本机参数与启动日志，统一 Windows 文件版本并排除打包诊断数据。',
    ].join('\n'),
  },
  {
    version: '1.0.6',
    name: 'AiBrowser v1.0.6',
    publishedAt: '2026-08-31T10:32:33Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.6',
    notes: [
      '- 新增 9 个本地 3D 桌面宠物与 12 个动作。',
      '- 支持左键拖动、右键旋转、滚轮缩放及三种动作播放模式。',
      '- 扩大动作绘制范围，修复闪烁、尺寸跳变和模型部位消失。',
      '- 模型、动作、贴图及运行时随程序本地提供。',
    ].join('\n'),
  },
  {
    version: '1.0.5',
    name: 'AiBrowser v1.0.5',
    publishedAt: '2026-08-13T16:03:00Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.5',
    notes: [
      '- 内置离线中文版本历史，并与 GitHub 在线 Releases 合并。',
      '- 历史版本支持独立折叠、辅助标签与滚动。',
      '- 保留 GitHub 项目按钮、代理下载、续传及原路径覆盖更新。',
    ].join('\n'),
  },
  {
    version: '1.0.4',
    name: 'AiBrowser v1.0.4',
    publishedAt: '2026-08-13T14:59:58Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.4',
    notes: [
      '- 更新页面始终显示「GitHub 项目地址」按钮。',
      '- 最新版时显示「当前已是最新版」；仅检测到新版本时替换为「更新安装」按钮。',
      '- 「更新安装」恢复应用内代理下载、断线重连、HTTP Range 续传与原路径覆盖。',
      '- 下载连接和进度区域仅在实际下载时显示。',
      '- 保留历史版本折叠列表及独立滚动条。',
    ].join('\n'),
  },
  {
    version: '1.0.3',
    name: 'AiBrowser v1.0.3',
    publishedAt: '2026-08-13T13:28:02Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.3',
    notes: [
      '- 版本更新页面支持读取 GitHub 历史 Releases。',
      '- 每个历史版本可独立展开或收起，最新版本默认展开。',
      '- 每条记录显示版本号、发布日期、更新内容和 GitHub Release 入口。',
      '- 历史更新区域增加独立纵向滚动条。',
    ].join('\n'),
  },
  {
    version: '1.0.2',
    name: 'AiBrowser v1.0.2',
    publishedAt: '2026-08-13T12:12:04Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.2',
    notes: [
      '- 新增侧边栏一级「版本更新」页面。',
      '- 显示当前版本、GitHub 最新版本、代理路由、检测时间和 Release 更新内容。',
      '- 更新流量使用独立 Electron 网络会话，支持 Windows 系统代理、本地代理和 PAC。',
      '- 大文件使用 .part 文件、HTTP Range 续传和自动重连。',
      '- 安装器识别现有安装路径并原位覆盖，桌面快捷方式改为可选组件。',
      '- 左下角版本号改为从程序清单动态读取。',
    ].join('\n'),
  },
  {
    version: '1.0.1',
    name: 'AiBrowser v1.0.1',
    publishedAt: '2026-08-12T07:55:04Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.1',
    notes: [
      '- 修复删除分组后再次新建时，分组名称和备注无法输入的问题。',
      '- 左下角新增当前版本和 GitHub 最新版状态点。',
      '- 悬停状态点可查看版本、检测时间和更新网络详情。',
      '- 更新检查与安装包下载支持 Windows 本地/系统代理及 PAC。',
    ].join('\n'),
  },
  {
    version: '1.0.0',
    name: 'AiBrowser v1.0.0',
    publishedAt: '2026-08-08T03:53:08Z',
    url: 'https://github.com/PuppetWen/AiBrowser/releases/tag/v1.0.0',
    notes: [
      '- AiBrowser 首个公开 Windows x86-64 版本。',
      '- 支持 Chromium 与 Firefox 隔离浏览器环境。',
      '- 支持多窗口鼠标、键盘、文本、标签页及浏览器界面同步。',
      '- 支持中文输入法组合状态，避免拼音输入被提前打断。',
      '- 支持等大小平铺、层叠和 Excel 风格自定义网格布局。',
      '- 包含代理配置、自动化、本地 API/MCP 和可选 AI 集成。',
      '- 安装包和便携包内置所需运行时，不需要额外安装浏览器或依赖。',
    ].join('\n'),
  },
]);

function mergeReleaseHistory(onlineHistory = []) {
  const merged = new Map();
  for (const release of [...onlineHistory, ...BUNDLED_RELEASE_HISTORY]) {
    const version = normalizeRemoteTag(release?.version || '');
    if (!version) continue;
    const previous = merged.get(version);
    const bundled = BUNDLED_RELEASE_HISTORY.find((item) => item.version === version);
    merged.set(version, {
      version,
      name: String(release?.name || previous?.name || bundled?.name || `AiBrowser v${version}`),
      notes: String(release?.notes || previous?.notes || bundled?.notes || '').trim(),
      publishedAt: String(release?.publishedAt || previous?.publishedAt || bundled?.publishedAt || ''),
      url: String(release?.url || previous?.url || bundled?.url || `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${version}`),
      prerelease: Boolean(release?.prerelease || previous?.prerelease),
    });
  }
  return [...merged.values()].sort((left, right) => compareVersions(right.version, left.version));
}

function updatePlatformKey() {
  return `${process.platform}:${process.arch}`;
}

function updateAssetName() {
  return UPDATE_ASSETS[updatePlatformKey()] || null;
}

let appUpdateProxySignature = '';

async function prepareAppUpdateNetwork({ force = false } = {}) {
  const configured = await resolveSystemProxy().catch(() => ({ enabled: false, source: 'unavailable' }));
  const updateSession = session.fromPartition('persist:aibrowser-updater', { cache: true });
  let proxyConfig = { mode: 'system' };
  if (configured?.pacUrl) {
    proxyConfig = { mode: 'pac_script', pacScript: String(configured.pacUrl) };
  } else if (configured?.enabled && configured?.raw) {
    proxyConfig = {
      mode: 'fixed_servers',
      proxyRules: String(configured.raw),
      proxyBypassRules: String(configured.bypass || ''),
    };
  }
  const signature = JSON.stringify(proxyConfig);
  if (force || signature !== appUpdateProxySignature) {
    await updateSession.setProxy(proxyConfig);
    appUpdateProxySignature = signature;
    if (force) await updateSession.closeAllConnections().catch(() => {});
  }
  const route = await updateSession.resolveProxy(UPDATE_LATEST_HTML).catch(() => '');
  const resolvedRoute = String(route || '').trim() || 'DIRECT';
  return {
    updateSession,
    network: {
      mode: /^DIRECT(?:;|$)/i.test(resolvedRoute) && !configured?.enabled ? 'direct' : 'system-proxy',
      route: resolvedRoute,
      source: String(configured?.source || 'electron-session'),
      configured: Boolean(configured?.enabled || configured?.pacUrl),
    },
  };
}

async function fetchAppUpdate(url, options = {}) {
  let prepared = await prepareAppUpdateNetwork();
  try {
    return await prepared.updateSession.fetch(url, options);
  } catch (_) {
    prepared = await prepareAppUpdateNetwork({ force: true });
    return prepared.updateSession.fetch(url, options);
  }
}

async function resolveAppUpdateNetwork() {
  return (await prepareAppUpdateNetwork()).network;
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

async function resolveTaggedRelease(remoteVersion) {
  if (!remoteVersion) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const apiUrl = `${UPDATE_API_URL.replace(/\/latest$/, '')}/tags/v${encodeURIComponent(remoteVersion)}`;
    const response = await fetchAppUpdate(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': updateUserAgent() },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return response.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveReleaseHistory() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const response = await fetchAppUpdate(UPDATE_HISTORY_API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': updateUserAgent() },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const releases = await response.json();
    if (!Array.isArray(releases)) return [];
    return releases
      .filter((release) => release && !release.draft)
      .map((release) => ({
        version: normalizeRemoteTag(release.tag_name || release.name || ''),
        name: String(release.name || release.tag_name || ''),
        notes: String(release.body || '').trim(),
        publishedAt: String(release.published_at || release.created_at || ''),
        url: String(release.html_url || ''),
        prerelease: Boolean(release.prerelease),
      }))
      .filter((release) => release.version && updateUrlIsAllowed(release.url || `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${release.version}`));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
  const [taggedReleaseFallback, releaseHistory] = await Promise.all([
    meta.apiRelease ? Promise.resolve(meta.apiRelease) : resolveTaggedRelease(remoteVersion),
    resolveReleaseHistory(),
  ]);
  const taggedRelease = taggedReleaseFallback;
  let asset = null;
  if (assetName) {
    if (taggedRelease && Array.isArray(taggedRelease.assets)) {
      const fromApi = taggedRelease.assets.find((item) => item?.name === assetName);
      if (fromApi?.browser_download_url && updateUrlIsAllowed(fromApi.browser_download_url, assetName)) {
        asset = { name: fromApi.name, size: Number(fromApi.size) || 0, browser_download_url: fromApi.browser_download_url };
      }
    }
    asset ||= await resolveReleaseAsset(remoteVersion, assetName);
    asset ||= {
      name: assetName,
      size: 0,
      browser_download_url: `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${remoteVersion}/${assetName}`,
    };
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
    releaseNotes: String(taggedRelease?.body || '').trim(),
    publishedAt: String(taggedRelease?.published_at || taggedRelease?.created_at || ''),
    history: mergeReleaseHistory(releaseHistory.length ? releaseHistory : [{
      version: remoteVersion,
      name: meta.releaseName || remoteVersion,
      notes: String(taggedRelease?.body || '').trim(),
      publishedAt: String(taggedRelease?.published_at || taggedRelease?.created_at || ''),
      url: meta.releaseUrl || `https://github.com/${UPDATE_REPOSITORY}/releases/tag/v${remoteVersion}`,
      prerelease: Boolean(taggedRelease?.prerelease),
    }]),
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
  const UPDATE_IDLE_TIMEOUT_MS = 120000;
  const UPDATE_RETRY_LIMIT = 8;
  const extension = path.extname(result.asset.name).toLowerCase();
  const baseName = path.basename(result.asset.name, extension);
  const finalPath = path.join(app.getPath('downloads'), `${baseName}-v${result.remoteVersion}${extension}`);
  const partialPath = finalPath + '.part';
  await fsp.mkdir(path.dirname(partialPath), { recursive: true });
  let received = Number((await fsp.stat(partialPath).catch(() => null))?.size || 0);
  let total = Number(result.asset.size) || 0;
  if (received > UPDATE_MAX_BYTES || (total && received > total)) {
    await fsp.rm(partialPath, { force: true });
    received = 0;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= UPDATE_RETRY_LIMIT && (!total || received < total); attempt += 1) {
    const controller = new AbortController();
    let idleTimer = setTimeout(() => controller.abort(), UPDATE_IDLE_TIMEOUT_MS);
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), UPDATE_IDLE_TIMEOUT_MS);
    };
    try {
      const headers = { Accept: 'application/octet-stream', 'User-Agent': `AiBrowser/${app.getVersion()}` };
      if (received > 0) headers.Range = `bytes=${received}-`;
      const response = await fetchAppUpdate(downloadUrl, { headers, signal: controller.signal });
      if (response.status === 416 && total && received >= total) break;
      if (![200, 206].includes(response.status) || !response.body) throw new Error(`Update download failed (${response.status})`);
      const resumed = received > 0 && response.status === 206;
      if (received > 0 && !resumed) {
        received = 0;
        await fsp.rm(partialPath, { force: true });
      }
      const contentRange = String(response.headers.get('content-range') || '');
      const rangeTotal = Number(contentRange.match(/\/(\d+)$/)?.[1] || 0);
      const contentLength = Number(response.headers.get('content-length')) || 0;
      total = rangeTotal || (contentLength ? received + contentLength : total);
      if (total > UPDATE_MAX_BYTES) throw new Error('Update package is too large');
      const file = await fsp.open(partialPath, resumed ? 'a' : 'w');
      try {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          resetIdleTimer();
          received += chunk.value.byteLength;
          if (received > UPDATE_MAX_BYTES) throw new Error('Update package is too large');
          await file.write(Buffer.from(chunk.value));
          emit({
            type: 'app-update-progress',
            phase: 'downloading',
            received,
            total: total || result.asset.size || 0,
            percent: total ? Math.min(100, Math.round(received / total * 100)) : null,
            version: result.remoteVersion,
            attempt,
          });
        }
      } finally {
        await file.close();
      }
      if (total && received < total) throw new Error(`Download interrupted at ${received}/${total} bytes`);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (/too large|not trusted/i.test(String(error?.message || error))) throw error;
      if (attempt >= UPDATE_RETRY_LIMIT) break;
      const retryIn = Math.min(30, 2 ** attempt);
      emit({
        type: 'app-update-retry',
        attempt,
        maxAttempts: UPDATE_RETRY_LIMIT,
        retryIn,
        received,
        total,
        version: result.remoteVersion,
        message: String(error?.message || error),
      });
      await prepareAppUpdateNetwork({ force: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, retryIn * 1000));
    } finally {
      clearTimeout(idleTimer);
    }
  }
  if (lastError || (total && received < total)) {
    throw new Error(`更新下载中断，已保留 ${received} 字节供下次续传：${lastError?.message || '文件不完整'}`);
  }
  await fsp.rm(finalPath, { force: true }).catch(() => {});
  await fsp.rename(partialPath, finalPath);
  emit({ type: 'app-update-progress', phase: 'installing', received, total: total || received, percent: 100, version: result.remoteVersion });
  if (process.platform === 'win32' && app.isPackaged) {
    const installRoot = path.dirname(process.execPath);
    const child = spawn(finalPath, ['/S', `/UPDATEPATH=${installRoot}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    setTimeout(() => app.quit(), 1200);
  } else {
    const openError = await shell.openPath(finalPath);
    if (openError) shell.showItemInFolder(finalPath);
  }
  return { success: true, path: finalPath, version: result.remoteVersion, assetName: result.asset.name };
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
      releaseNotes: String(raw.releaseNotes || ''),
      publishedAt: String(raw.publishedAt || ''),
      history: mergeReleaseHistory(Array.isArray(raw.history) ? raw.history : []),
      platform: process.platform,
      arch: process.arch,
      source: raw.source || 'cache',
      network: raw.network || null,
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
      releaseNotes: result.releaseNotes || '',
      publishedAt: result.publishedAt || '',
      history: Array.isArray(result.history) ? result.history : [],
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
  pet: normalizePetConfig(DEFAULT_PET_CONFIG, BUNDLED_PET_IDS),
};

async function loadLocalSettings() {
  try {
    const saved = JSON.parse(await fsp.readFile(localSettingsFile, 'utf8'));
    const savedPet = { ...(saved.pet || DEFAULT_PET_CONFIG) };
    localSettingsCache = {
      profileDataRoot: normalizeProfileDataRoot(saved.profileDataRoot),
      cloud: { ...cloudSync.defaultCloudConfig(), ...(saved.cloud || {}) },
      uiGroups: Array.isArray(saved.uiGroups) ? saved.uiGroups : [],
      syncFloatingEnabled: saved.syncFloatingEnabled === true,
      pet: normalizePetConfig(savedPet, BUNDLED_PET_IDS),
    };
    return localSettingsCache;
  } catch (_) {
    localSettingsCache = {
      profileDataRoot: defaultProfileDataRoot,
      cloud: cloudSync.defaultCloudConfig(),
      uiGroups: [],
      syncFloatingEnabled: false,
      pet: normalizePetConfig(DEFAULT_PET_CONFIG, BUNDLED_PET_IDS),
    };
    return localSettingsCache;
  }
}

let localSettingsWriteChain = Promise.resolve();

function saveLocalSettings(value, options = {}) {
  const persist = async () => {
    const next = {
      profileDataRoot: value.profileDataRoot ? normalizeProfileDataRoot(value.profileDataRoot, options) : localSettingsCache.profileDataRoot,
      cloud: value.cloud || localSettingsCache.cloud || cloudSync.defaultCloudConfig(),
      uiGroups: Array.isArray(value.uiGroups) ? value.uiGroups : (localSettingsCache.uiGroups || []),
      syncFloatingEnabled: typeof value.syncFloatingEnabled === 'boolean' ? value.syncFloatingEnabled : localSettingsCache.syncFloatingEnabled,
      pet: normalizePetConfig(value.pet || localSettingsCache.pet || DEFAULT_PET_CONFIG, BUNDLED_PET_IDS),
    };
    await fsp.mkdir(path.dirname(localSettingsFile), { recursive: true });
    const temporary = localSettingsFile + '.tmp';
    try {
      await fsp.writeFile(temporary, JSON.stringify({ version: 6, ...next }, null, 2), 'utf8');
      await fsp.rename(temporary, localSettingsFile);
      localSettingsCache = next;
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => {});
    }
  };
  const result = localSettingsWriteChain.then(persist);
  localSettingsWriteChain = result.catch(() => {});
  return result;
}

async function updateProfileDataRoot(value, options = {}) {
  if (!engine) throw new Error('Browser engine is not ready');
  if (engine.changingProfileDataRoot || engine.restoringBackup) throw new Error('请等待数据目录变更或备份恢复完成');
  engine.changingProfileDataRoot = true;
  try {
    if (engine.running.size || engine.starting?.size) throw new Error('\u8bf7\u5148\u505c\u6b62\u6240\u6709\u73af\u5883\uff0c\u518d\u4fee\u6539\u6570\u636e\u4fdd\u5b58\u4f4d\u7f6e');
    const profileDataRoot = normalizeProfileDataRoot(value, options);
    const secureCheck = await ensureDataRootIsolationSecure(profileDataRoot);
    if (!secureCheck.ok) throw new Error(secureCheck.message);
    engine.setProfileDataRoot(profileDataRoot);
    try {
      await saveLocalSettings({ profileDataRoot }, options);
    } catch (error) {
      engine.setProfileDataRoot(localSettingsCache.profileDataRoot);
      throw error;
    }
    emit({ type: 'storage-settings', profileRoot: profileDataRoot });
    return { success: true, profileRoot: profileDataRoot, defaultProfileRoot: defaultProfileDataRoot };
  } finally {
    engine.changingProfileDataRoot = false;
  }
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
  await saveLocalSettings({ cloud });
  emit({ type: 'cloud-sync', action: 'backup', ...meta, ...result });
  return { success: true, meta, result, cloud };
}

async function applyBackupBody(body, { mode = 'merge', localProfiles = null, localGroups = null, scopeProfileIds = null } = {}) {
  if (engine?.running?.size || engine?.starting?.size) throw new Error('请先停止所有环境，再恢复浏览器备份');
  if (engine?.restoringBackup) throw new Error('正在恢复浏览器备份，请等待完成');
  if (engine?.changingProfileDataRoot) throw new Error('请等待数据目录变更完成');
  if (engine) engine.restoringBackup = true;
  try {
    return await applyStoppedBackupBody(body, { mode, localProfiles, localGroups, scopeProfileIds });
  } finally {
    if (engine) engine.restoringBackup = false;
  }
}

async function applyStoppedBackupBody(body, { mode = 'merge', localProfiles = null, localGroups = null, scopeProfileIds = null } = {}) {
  const profileRoot = engine?.getProfileDataRoot?.() || localSettingsCache.profileDataRoot;
  const remoteProfiles = (body.profiles || []).map((p) => {
    const copy = { ...p };
    return copy;
  });
  let restoredFiles = 0;
  const dataById = new Map();
  const remoteIds = new Set();
  for (const profile of remoteProfiles) {
    assertProfileId(profile?.id);
    const key = profile.id.toLowerCase();
    if (remoteIds.has(key)) throw new Error('备份包含重复或大小写冲突的环境 ID：' + profile.id);
    remoteIds.add(key);
    if (profile._dataFiles && profile.id) {
      dataById.set(profile.id, profile._dataFiles);
      delete profile._dataFiles;
    }
  }

  const localList = Array.isArray(localProfiles)
    ? localProfiles
    : [...(engine?.profiles?.values?.() || [])];
  const localGroupList = Array.isArray(localGroups) ? localGroups : (localSettingsCache.uiGroups || []);

  const scope = Array.isArray(scopeProfileIds) ? new Set(scopeProfileIds.map(assertProfileId)) : null;
  const merged = cloudSync.mergeProfiles(
    scope ? localList.filter((profile) => scope.has(profile.id)) : localList,
    scope ? remoteProfiles.filter((profile) => scope.has(profile.id)) : remoteProfiles,
    mode,
  );
  if (scope) merged.profiles = [...localList.filter((profile) => !scope.has(profile.id)), ...merged.profiles];
  const metadataMode = scope && (mode === 'overwrite' || mode === 'remote-wins') ? 'merge' : mode;
  const groups = cloudSync.mergeGroups(localGroupList, body.groups || [], metadataMode);
  if (merged.profiles.length > 1000) throw new Error('Invalid profile list');
  if (engine) merged.profiles = merged.profiles.map((profile) => engine.sanitizeProfile(profile));
  const mergedIds = new Set();
  const mergedNumbers = new Set();
  for (const profile of merged.profiles) {
    assertProfileId(profile?.id);
    const key = profile.id.toLowerCase();
    if (mergedIds.has(key)) throw new Error('环境 ID 大小写冲突：' + profile.id);
    mergedIds.add(key);
    if (profile.number) {
      if (mergedNumbers.has(profile.number)) throw new Error('环境编号重复：' + profile.number);
      mergedNumbers.add(profile.number);
    }
    engine?.assertProfileIdentity(profile.id);
    const check = await validateProfileRootSecure(profileRoot, path.join(profileRoot, profile.id), profile.id);
    if (!check.ok) throw new Error(check.message);
  }
  if (engine?.running?.size || engine?.starting?.size) throw new Error('请先停止所有环境，再恢复浏览器备份');

  // restore browser data files for profiles that came from remote package
  const restoreIds = new Set(merged.remoteDataProfileIds);
  for (const profile of merged.profiles) {
    const files = restoreIds.has(profile.id) ? dataById.get(profile.id) : null;
    if (files) {
      restoredFiles += await cloudSync.restoreProfileDataFiles(path.join(profileRoot, profile.id), files);
    }
  }

  let proxies = body.proxies || [];
  if (Array.isArray(proxies) && proxies.length) {
    let localProxies = [];
    try { localProxies = automation?.proxyStore?.list?.({}) || []; } catch (_) {}
    proxies = cloudSync.mergeProxies(localProxies, proxies, metadataMode);
    if (automation?.proxyStore?.replaceAll) {
      await automation.proxyStore.replaceAll(proxies).catch(() => {});
    } else if (automation?.proxyStore) {
      for (const item of proxies) {
        try { await automation.proxyStore.create(item); } catch (_) {}
      }
    }
  }

  await saveLocalSettings({ uiGroups: groups });
  if (engine && (mode === 'overwrite' || mode === 'remote-wins')) {
    const keptIds = new Set(merged.profiles.map((profile) => profile.id));
    const removedIds = [...engine.profiles.keys()].filter((id) => !keptIds.has(id));
    // Overwrite replaces configuration only; data folders stay available for
    // recovery unless the user explicitly deletes those environments' data.
    for (let index = 0; index < removedIds.length; index += 200) {
      await engine.deleteProfiles(removedIds.slice(index, index + 200), false);
    }
  }
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
    scopeProfileIds: Array.isArray(payload.profileIds) && payload.profileIds.length ? payload.profileIds : null,
  });

  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  cloud.restoreMode = mode;
  await saveLocalSettings({ cloud, uiGroups: applied.groups });
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
  await saveLocalSettings({ cloud });
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
    { mode, localProfiles, localGroups: payload.localGroups, scopeProfileIds: ids }
  );
  restoredFiles = applied.restoredFiles;
  cloud.lastSyncAt = new Date().toISOString();
  cloud.lastError = '';
  await saveLocalSettings({ cloud, uiGroups: applied.groups });
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
let petWindow = null;
let petDragSession = null;
let petPhase = 'waiting';
let petPhaseTimer = null;
let petStartupLoading = true;
let petRendererState = {};
let petScalePersistTimer = null;
let petScaleCenterAnchor = null;
let petInputPassthroughTimer = null;
let petInputIgnored = null;
let petSessionHardened = false;
const activeAgentStates = new Map();
const activeRpaTasks = new Set();
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

function trustedPetUrl() {
  return pathToFileURL(path.join(__dirname, 'pet.html')).href;
}

function assertPetSender(event) {
  if (!petWindow || petWindow.isDestroyed() || event?.sender !== petWindow.webContents) {
    throw new Error('untrusted pet IPC sender');
  }
  const senderUrl = String(event.sender.getURL?.() || '');
  const expected = trustedPetUrl();
  if (senderUrl !== expected && !senderUrl.startsWith(expected + '?') && !senderUrl.startsWith(expected + '#')) {
    throw new Error('untrusted pet document');
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
  handlePetObservableEvent(value);
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

const windowGlassMaterials = new WeakMap();

function nativeGlassMaterial(win) {
  if (nativeTheme?.prefersReducedTransparency || nativeTheme?.shouldUseHighContrastColors || nativeTheme?.inForcedColorsMode) return 'none';
  // Electron's DWM materials need Windows 11 22H2. Keep normal windows so
  // resizing, native caption buttons, snapping and accessibility still work.
  if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') {
    const [major, , build] = os.release().split('.').map(Number);
    if (major >= 10 && build >= 22621) return 'acrylic';
  }
  if (process.platform === 'darwin' && typeof win.setVibrancy === 'function') return 'vibrancy';
  return 'none';
}

function applyWindowChrome(win, themeId, colorMode) {
  if (!win || win.isDestroyed()) return 'none';
  const chrome = chromeForTheme(themeId, colorMode);
  const dark = themeId === 'pixel-workstation' || themeId === 'aurora-glass' || (themeId === 'element-admin' && colorMode === 'dark');
  try {
    const source = dark ? 'dark' : 'light';
    if (nativeTheme && nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
  } catch (_) {}
  let material = nativeGlassMaterial(win);
  try {
    if (process.platform === 'win32' && typeof win.setBackgroundMaterial === 'function') {
      win.setBackgroundMaterial(material === 'acrylic' ? 'acrylic' : 'none');
    } else if (process.platform === 'darwin' && typeof win.setVibrancy === 'function') {
      win.setVibrancy(material === 'vibrancy' ? 'under-window' : null);
    }
    win.setBackgroundColor(material === 'none' ? chrome.bg : '#00000000');
  } catch (_) {
    material = 'none';
    try { win.setBackgroundColor(chrome.bg); } catch (_) {}
  }
  windowGlassMaterials.set(win, material);
  // Keep Windows caption overlay in sync with theme (light/dark native skin too)
  if (process.platform === 'win32' && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay({
        color: material === 'none' ? chrome.overlay : '#00000000',
        symbolColor: chrome.symbol,
        height: 32,
      });
    } catch (_) {}
  }
  return material;
}

let bundledPetCatalogCache = null;

function bundledPetCatalog() {
  if (bundledPetCatalogCache) return bundledPetCatalogCache;
  bundledPetCatalogCache = BUNDLED_PET_IDS.map((id) => {
    const root = path.join(petAssetRoot, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'pet.json'), 'utf8'));
    const source = manifest.mmd3d || {};
    const modelKind = String(source.model || '').toLowerCase().endsWith('.glb') ? 'humanoid' : 'pmx';
    const motionClips = Object.fromEntries(PET_PHASES.map(({ id: phase }) => {
      const clips = PET_MOTIONS.filter((motion) => motion.phase === phase).map((motion) => {
        const authored = source.motionSets?.[phase]?.[motion.index];
        if (!authored || !Array.isArray(authored.files) || !authored.files.length) {
          throw new Error(`Pet ${id} is missing motion ${motion.id}`);
        }
        return {
          id: motion.id,
          label: motion.label,
          urls: authored.files.map((file) => pathToFileURL(path.join(root, String(file))).href),
          endFrame: motion.maxEndFrame
            ? Math.min(Number(authored.endFrame) || motion.maxEndFrame, motion.maxEndFrame)
            : authored.endFrame,
        };
      });
      return [phase, clips];
    }));
    return {
      id,
      displayName: String(manifest.displayName || id).replace(/（3D）$/, ''),
      description: String(manifest.description || ''),
      vendorScript: pathToFileURL(path.join(
        petRuntimeRoot,
        modelKind === 'humanoid' ? 'mmd-humanoid-vendor.js' : 'mmd-pmx-vendor.js'
      )).href,
      runtime: {
        modelUrl: pathToFileURL(path.join(root, String(source.model || 'model.pmx'))).href,
        modelKind,
        scale: source.scale,
        translate: source.translate,
        cameraYaw: source.cameraYaw,
        motionScale: source.motionScale,
        physics: source.physics === true,
        motionClips,
        renderFps: Number(source.renderFps) || 30,
        motionCacheSize: Number(source.motionCacheSize) || 2,
        viewportOverscan: PET_VIEWPORT_OVERSCAN,
        boneMap: source.boneMap,
        secondaryMotion: source.secondaryMotion,
      },
    };
  });
  return bundledPetCatalogCache;
}

function sendPetEvent(value) {
  if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('pet:event', value);
}

function derivePetPhase() {
  if (petStartupLoading) return 'waiting';
  if ([...activeAgentStates.values()].includes('tool') || activeRpaTasks.size) return 'tool';
  if (activeAgentStates.size) return 'thinking';
  if (syncState.active || (engine?.running?.size || 0) > 0) return 'review';
  return 'idle';
}

function setPetPhase(next, transientMs = 0) {
  if (!PET_PHASES.some((phase) => phase.id === next)) return;
  if (petPhaseTimer) {
    clearTimeout(petPhaseTimer);
    petPhaseTimer = null;
  }
  petPhase = next;
  sendPetEvent({ type: 'phase', phase: next });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine:event', { type: 'pet-phase', phase: next });
  }
  if (transientMs > 0) {
    petPhaseTimer = setTimeout(() => {
      petPhaseTimer = null;
      setPetPhase(derivePetPhase());
    }, transientMs);
  }
}

function handlePetObservableEvent(value) {
  if (!value || typeof value !== 'object') return;
  if (value.type === 'agent-state') {
    const runId = String(value.runId || value.sessionId || 'agent');
    if (value.state === 'tool' || value.state === 'thinking') {
      activeAgentStates.set(runId, value.state);
      setPetPhase(value.state);
    } else {
      activeAgentStates.delete(runId);
      setPetPhase(value.state === 'failed' ? 'failed' : 'done', 2800);
    }
    return;
  }
  if (value.type === 'rpa-task') {
    const taskId = String(value.taskId || 'rpa');
    if (value.status === 'running') {
      activeRpaTasks.add(taskId);
      setPetPhase('tool');
    } else {
      activeRpaTasks.delete(taskId);
      setPetPhase(value.status === 'success' ? 'done' : 'failed', 2800);
    }
    return;
  }
  if (value.type === 'profile-start-progress' || value.type === 'kernel-progress' || value.type === 'app-update-progress') {
    setPetPhase('waiting');
    return;
  }
  if (value.type === 'status') {
    setPetPhase(value.running ? 'done' : 'failed', 2200);
    return;
  }
  if (value.type === 'profile-stopped' || value.type === 'profile-closed') {
    setPetPhase('failed', 2200);
    return;
  }
  if (value.type === 'sync-state') {
    setPetPhase(derivePetPhase());
    return;
  }
  if (String(value.type || '').endsWith('-error') || value.type === 'browser-startup-failure') {
    setPetPhase('failed', 3000);
  }
}

function defaultPetPosition(size) {
  const work = screen.getPrimaryDisplay().workArea;
  const renderMarginX = size.width * (PET_VIEWPORT_OVERSCAN - 1) / 2;
  const renderMarginY = size.height * (PET_VIEWPORT_OVERSCAN - 1) / 2;
  return {
    x: Math.round(work.x + work.width - size.width - renderMarginX - 24),
    y: Math.round(work.y + work.height - size.height - renderMarginY - 24),
  };
}

function visiblePetPosition(position, size) {
  if (!position) return defaultPetPosition(size);
  const visible = screen.getAllDisplays().some(({ bounds }) => {
    const overlapWidth = Math.min(position.x + size.width, bounds.x + bounds.width) - Math.max(position.x, bounds.x);
    const overlapHeight = Math.min(position.y + size.height, bounds.y + bounds.height) - Math.max(position.y, bounds.y);
    return overlapWidth >= 48 && overlapHeight >= 48;
  });
  return visible ? position : defaultPetPosition(size);
}

const PET_HOST_SCALE = 1.6;
const PET_VIEWPORT_OVERSCAN = 1.75;
const PET_HOST_SIZE = petWindowSize(PET_HOST_SCALE);

function petVisualOffset(scale) {
  const size = petWindowSize(scale);
  return {
    x: Math.round((PET_HOST_SIZE.width - size.width) / 2),
    y: Math.round((PET_HOST_SIZE.height - size.height) / 2),
    ...size,
  };
}

function petDesktopBounds() {
  return desktopBoundsForDisplays(screen.getAllDisplays())
    || { ...screen.getPrimaryDisplay().bounds };
}

function refreshPetDesktopGeometry(win) {
  if (petWindow !== win || win.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const desktopBounds = desktopBoundsForDisplays(displays);
  if (!desktopBounds) return;
  stopPetDragTracking();
  if (petScalePersistTimer) clearTimeout(petScalePersistTimer);
  petScalePersistTimer = null;
  petScaleCenterAnchor = null;
  const currentBounds = win.getBounds();
  if (['x', 'y', 'width', 'height'].some((key) => currentBounds[key] !== desktopBounds[key])) {
    win.setBounds(desktopBounds, false);
  }
  const scale = localSettingsCache.pet.scale;
  const position = recoverPetDisplayPosition(localSettingsCache.pet.position, petWindowSize(scale), displays, PET_VIEWPORT_OVERSCAN);
  localSettingsCache.pet = { ...localSettingsCache.pet, position };
  sendPetEvent({ type: 'desktop-bounds', desktopBounds: win.getBounds(), position, scale });
  updatePetInputPassthrough();
}

function watchPetDisplayChanges(win) {
  const refresh = () => {
    try { refreshPetDesktopGeometry(win); }
    catch (error) { console.warn('[desktop-pet] display update failed:', error); }
  };
  const metricsChanged = (_event, _display, metrics) => {
    if (!Array.isArray(metrics) || metrics.some((metric) => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(metric))) refresh();
  };
  screen.on('display-added', refresh);
  screen.on('display-removed', refresh);
  screen.on('display-metrics-changed', metricsChanged);
  win.once('closed', () => {
    screen.removeListener('display-added', refresh);
    screen.removeListener('display-removed', refresh);
    screen.removeListener('display-metrics-changed', metricsChanged);
  });
}

function updatePetInputPassthrough() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const visualSize = petWindowSize(localSettingsCache.pet.scale);
  const position = visiblePetPosition(localSettingsCache.pet.position, visualSize);
  const cursor = screen.getCursorScreenPoint();
  const inside = cursor.x >= position.x
    && cursor.x < position.x + visualSize.width
    && cursor.y >= position.y
    && cursor.y < position.y + visualSize.height;
  const ignored = !inside && !petDragSession;
  if (ignored === petInputIgnored) return;
  petInputIgnored = ignored;
  petWindow.setIgnoreMouseEvents(ignored, { forward: false });
}

function startPetInputPassthrough() {
  if (petInputPassthroughTimer) clearInterval(petInputPassthroughTimer);
  petInputIgnored = null;
  updatePetInputPassthrough();
  petInputPassthroughTimer = setInterval(updatePetInputPassthrough, 32);
}

function stopPetInputPassthrough() {
  if (petInputPassthroughTimer) clearInterval(petInputPassthroughTimer);
  petInputPassthroughTimer = null;
  petInputIgnored = null;
}

function applyPetWindowGeometry(win, scale, visualPosition) {
  const visualSize = petWindowSize(scale);
  const visiblePosition = visiblePetPosition(visualPosition, visualSize);
  sendPetEvent({ type: 'position', position: visiblePosition, scale });
  updatePetInputPassthrough();
  return visiblePosition;
}

function freezePetScaleAtCurrentBounds() {
  if (!petWindow || petWindow.isDestroyed()) return;
  petScaleCenterAnchor = null;
  updatePetInputPassthrough();
}

async function persistInteractivePetScale() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const pet = {
    ...localSettingsCache.pet,
  };
  await saveLocalSettings({ pet });
  notifyPetConfig();
}

function scheduleInteractivePetScale(deltaY) {
  if (!petWindow || petWindow.isDestroyed()) return { success: false };
  if (petDragSession) return { success: true, scale: localSettingsCache.pet.scale, ignoredWhileDragging: true };
  const direction = Number(deltaY) > 0 ? -1 : 1;
  const currentTarget = localSettingsCache.pet.scale;
  const wheelStrength = Math.min(2, Math.max(0.45, Math.abs(Number(deltaY) || 100) / 100));
  const targetScale = normalizePetConfig({
    ...localSettingsCache.pet,
    scale: currentTarget + direction * 0.04 * wheelStrength,
  }, BUNDLED_PET_IDS).scale;
  if (targetScale === currentTarget) return { success: true, scale: targetScale };

  const currentSize = petWindowSize(currentTarget);
  const targetSize = petWindowSize(targetScale);
  const currentPosition = visiblePetPosition(localSettingsCache.pet.position, currentSize);
  if (!petScaleCenterAnchor) {
    petScaleCenterAnchor = {
      x: currentPosition.x + currentSize.width / 2,
      y: currentPosition.y + currentSize.height / 2,
    };
  }
  localSettingsCache.pet = {
    ...localSettingsCache.pet,
    scale: targetScale,
    position: {
      x: Math.round(petScaleCenterAnchor.x - targetSize.width / 2),
      y: Math.round(petScaleCenterAnchor.y - targetSize.height / 2),
    },
  };
  updatePetInputPassthrough();
  sendPetEvent({
    type: 'scale',
    scale: targetScale,
    position: localSettingsCache.pet.position,
  });
  if (petScalePersistTimer) clearTimeout(petScalePersistTimer);
  petScalePersistTimer = setTimeout(() => {
    petScalePersistTimer = null;
    void persistInteractivePetScale().catch((error) => console.warn('[desktop-pet] scale persistence failed:', error));
  }, 260);
  return { success: true, scale: targetScale };
}

async function createPetWindow() {
  if (petWindow && !petWindow.isDestroyed()) return petWindow;
  if (!petSessionHardened) {
    const isolatedPetSession = session.fromPartition('aibrowser-pet');
    isolatedPetSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      callback({ cancel: true });
    });
    petSessionHardened = true;
  }
  const config = localSettingsCache.pet;
  const size = petWindowSize(config.scale);
  const position = visiblePetPosition(config.position, size);
  const desktopBounds = petDesktopBounds();
  localSettingsCache.pet = { ...config, position };
  const win = new BrowserWindow({
    ...desktopBounds,
    title: 'AiBrowser 3D 宠物',
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'pet-preload.js'),
      partition: 'aibrowser-pet',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  petWindow = win;
  watchPetDisplayChanges(win);
  try { win.setAlwaysOnTop(true, 'screen-saver', 1); } catch (_) {}
  try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (event) => {
    const severity = event?.level;
    const text = event?.message;
    if (Number(severity) < 2) return;
    console.warn('[desktop-pet]', text || `renderer console level ${severity}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.warn('[desktop-pet] load failed:', code, description, url);
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== trustedPetUrl()) event.preventDefault();
  });
  win.on('closed', () => {
    if (petWindow === win) petWindow = null;
    stopPetDragTracking();
    stopPetInputPassthrough();
    if (petScalePersistTimer) clearTimeout(petScalePersistTimer);
    petScalePersistTimer = null;
    petScaleCenterAnchor = null;
  });
  await win.loadFile(path.join(__dirname, 'pet.html'));
  startPetInputPassthrough();
  if (config.enabled && !win.isDestroyed()) win.showInactive();
  return win;
}

function notifyPetConfig() {
  const config = localSettingsCache.pet;
  sendPetEvent({ type: 'config', config });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('engine:event', { type: 'pet-settings', config });
  }
}

async function setPetConfig(partial = {}) {
  if (petScalePersistTimer) clearTimeout(petScalePersistTimer);
  petScalePersistTimer = null;
  const current = localSettingsCache.pet || normalizePetConfig(DEFAULT_PET_CONFIG, BUNDLED_PET_IDS);
  const merged = {
    ...current,
    ...(partial && typeof partial === 'object' ? partial : {}),
    assignments: partial?.assignments
      ? { ...current.assignments, ...partial.assignments }
      : current.assignments,
  };
  let next = normalizePetConfig(merged, BUNDLED_PET_IDS);
  if (partial?.position != null) petScaleCenterAnchor = null;
  if (next.scale !== current.scale && partial?.position == null) {
    const currentSize = petWindowSize(current.scale);
    const nextSize = petWindowSize(next.scale);
    const currentPosition = visiblePetPosition(current.position, currentSize);
    if (!petScaleCenterAnchor) {
      petScaleCenterAnchor = {
        x: currentPosition.x + currentSize.width / 2,
        y: currentPosition.y + currentSize.height / 2,
      };
    }
    next = {
      ...next,
      position: {
        x: Math.round(petScaleCenterAnchor.x - nextSize.width / 2),
        y: Math.round(petScaleCenterAnchor.y - nextSize.height / 2),
      },
    };
  }
  next = {
    ...next,
    position: visiblePetPosition(next.position, petWindowSize(next.scale)),
  };
  await saveLocalSettings({ pet: next });
  if (next.enabled) {
    const win = await createPetWindow();
    applyPetWindowGeometry(win, next.scale, next.position);
    try { win.setAlwaysOnTop(true, 'screen-saver', 1); } catch (_) {}
    if (!win.isVisible()) win.showInactive();
  } else if (petWindow && !petWindow.isDestroyed()) {
    petWindow.hide();
  }
  notifyPetConfig();
  return { success: true, config: localSettingsCache.pet };
}

async function runPetIntegrationSelftest(resultFile) {
  const waitUntil = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const petCaptureBounds = () => {
    const desktop = petDesktopBounds();
    const size = petWindowSize(localSettingsCache.pet.scale);
    const position = visiblePetPosition(localSettingsCache.pet.position, size);
    const renderWidth = Math.round(size.width * PET_VIEWPORT_OVERSCAN);
    const renderHeight = Math.round(size.height * PET_VIEWPORT_OVERSCAN);
    const unclippedX = Math.round(position.x - desktop.x - (renderWidth - size.width) / 2);
    const unclippedY = Math.round(position.y - desktop.y - (renderHeight - size.height) / 2);
    const x = Math.max(0, unclippedX);
    const y = Math.max(0, unclippedY);
    const width = Math.max(1, Math.min(renderWidth - Math.max(0, -unclippedX), desktop.width - x));
    const height = Math.max(1, Math.min(renderHeight - Math.max(0, -unclippedY), desktop.height - y));
    return {
      x,
      y,
      width,
      height,
      inputX: Math.round(position.x - desktop.x) - x,
      inputY: Math.round(position.y - desktop.y) - y,
      inputWidth: size.width,
      inputHeight: size.height,
    };
  };
  const capturePetFrame = (win) => {
    const { x, y, width, height } = petCaptureBounds();
    return win.webContents.capturePage({ x, y, width, height });
  };
  const captureVisiblePixels = async (win) => {
    const frame = await capturePetFrame(win);
    const bitmap = frame.toBitmap();
    let visiblePixels = 0;
    for (let offset = 3; offset < bitmap.length; offset += 4) {
      if (bitmap[offset] >= 16) visiblePixels += 1;
    }
    return visiblePixels;
  };
  const result = { startedAt: new Date().toISOString(), checks: {}, snapshots: {} };
  try {
    const win = await createPetWindow();
    const testDesktop = petDesktopBounds();
    const testPetSize = petWindowSize(1);
    await setPetConfig({
      petId: 'mmd-bianca',
      mode: 'by-state',
      scale: 1,
      position: {
        x: Math.round(testDesktop.x + (testDesktop.width - testPetSize.width) / 2),
        y: Math.round(testDesktop.y + (testDesktop.height - testPetSize.height) / 2),
      },
      assignments: { idle: ['idle:iris-out'] },
    });
    setPetPhase('idle');
    await waitUntil(() => (petRendererState.petId === 'mmd-bianca' && petRendererState.phase === 'idle'
      && petRendererState.modelReady) || petRendererState.modelError, 60000, 'initial pet model');
    await sleep(750);
    // Keep physical desktop input from contaminating synthetic drag/wheel
    // measurements. This is a dedicated self-test process and exits on finish.
    stopPetInputPassthrough();
    win.setIgnoreMouseEvents(true, { forward: false });
    await sleep(120);
    result.snapshots.initialRenderer = { ...petRendererState };
    result.snapshots.initialDom = await win.webContents.executeJavaScript(`(() => {
      const status = document.getElementById('pet-status');
      const canvas = document.querySelector('#pet-stage canvas');
      return {
        debug: window.__petDebugSnapshot(),
        statusHidden: status.hidden,
        statusOpacity: getComputedStyle(status).opacity,
        bodyCursor: getComputedStyle(document.body).cursor,
        hitboxCursor: getComputedStyle(document.getElementById('pet-hitbox')).cursor,
        stagePointerEvents: getComputedStyle(document.getElementById('pet-stage')).pointerEvents,
        canvasCount: document.querySelectorAll('#pet-stage canvas').length,
        canvasSize: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null,
      };
    })()`);
    const initialBounds = win.getBounds();
    const mainBounds = mainWindow.getBounds();
    result.checks.modelReady = petRendererState.modelReady === true && !petRendererState.modelError;
    result.checks.alwaysOnTop = win.isAlwaysOnTop();
    result.checks.independentWindow = typeof win.getParentWindow !== 'function' || win.getParentWindow() == null;
    result.checks.inputHitboxExact = result.snapshots.initialDom.debug.inputBounds.x
      === result.snapshots.initialDom.debug.visualPosition.x - testDesktop.x
      && result.snapshots.initialDom.debug.inputBounds.y
        === result.snapshots.initialDom.debug.visualPosition.y - testDesktop.y
      && result.snapshots.initialDom.debug.inputBounds.width === testPetSize.width
      && result.snapshots.initialDom.debug.inputBounds.height === testPetSize.height;
    result.checks.desktopCursorIsolated = result.snapshots.initialDom.bodyCursor === 'default'
      && result.snapshots.initialDom.hitboxCursor === 'grab'
      && result.snapshots.initialDom.stagePointerEvents === 'none';
    result.snapshots.settingsUi = await mainWindow.webContents.executeJavaScript(`(() => ({
      foldable: document.querySelector('#desktop-pet-card > details.pet-settings-disclosure') instanceof HTMLDetailsElement,
      modeValues: [...document.querySelectorAll('#pet-motion-mode option')].map(option => option.value),
      multiselectCount: document.querySelectorAll('#pet-phase-config .pet-motion-multiselect').length,
    }))()`);
    result.checks.settingsFoldable = result.snapshots.settingsUi.foldable === true;
    result.checks.threeMotionModes = result.snapshots.settingsUi.modeValues.join(',') === 'by-state,all-shuffle,all-random-once';
    result.checks.compactStateMultiselects = result.snapshots.settingsUi.multiselectCount === PET_PHASES.length;

    const screenshotFile = path.join(path.dirname(resultFile), 'pet-renderer.png');
    const image = await win.webContents.capturePage();
    const screenshotBitmap = image.toBitmap();
    result.checks.transparentBackground = screenshotBitmap.length >= 4 && screenshotBitmap[3] === 0;
    await fsp.mkdir(path.dirname(screenshotFile), { recursive: true });
    await fsp.writeFile(screenshotFile, image.toPNG());
    result.screenshot = screenshotFile;
    const irisFrames = [];
    for (let index = 0; index < 15; index += 1) {
      const frame = await capturePetFrame(win);
      const { width, height } = frame.getSize();
      const bitmap = frame.toBitmap();
      let visiblePixels = 0;
      let visibleTopPixels = 0;
      let whiteTopPixels = 0;
      const topRows = Math.floor(height * 0.45);
      for (let y = 0; y < topRows; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          if (bitmap[offset + 3] < 16) continue;
          visiblePixels += 1;
          visibleTopPixels += 1;
          if (bitmap[offset] > 238 && bitmap[offset + 1] > 238 && bitmap[offset + 2] > 238) whiteTopPixels += 1;
        }
      }
      const frameFile = path.join(path.dirname(resultFile), `iris-out-${String(index + 1).padStart(2, '0')}.png`);
      await fsp.writeFile(frameFile, frame.toPNG());
      for (let y = topRows; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          if (bitmap[(y * width + x) * 4 + 3] >= 16) visiblePixels += 1;
        }
      }
      irisFrames.push({
        second: index,
        visiblePixels,
        visibleTopPixels,
        whiteRatio: visibleTopPixels ? Number((whiteTopPixels / visibleTopPixels).toFixed(4)) : 1,
        file: frameFile,
      });
      if (index < 14) await sleep(1000);
    }
    result.snapshots.irisOut = irisFrames;
    const baselineWhite = irisFrames[0]?.whiteRatio || 0;
    result.checks.irisOutPartsVisible = irisFrames.every((frame) => frame.visiblePixels > 1000);
    result.checks.irisOutNoWhiteFlash = irisFrames.every((frame) => frame.whiteRatio <= Math.max(0.55, baselineWhite + 0.3));

    const motionSamples = [];
    for (const motion of PET_MOTIONS) {
      await setPetConfig({
        mode: 'by-state',
        assignments: { [motion.phase]: [motion.id] },
      });
      setPetPhase(motion.phase);
      await sleep(1400);
      const captureBounds = petCaptureBounds();
      const sample = await capturePetFrame(win);
      const { width, height } = sample.getSize();
      const bitmap = sample.toBitmap();
      let visiblePixels = 0;
      let outsideInputPixels = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4 + 3;
          if (bitmap[offset] < 16) continue;
          visiblePixels += 1;
          if (x < captureBounds.inputX || x >= captureBounds.inputX + captureBounds.inputWidth
            || y < captureBounds.inputY || y >= captureBounds.inputY + captureBounds.inputHeight) {
            outsideInputPixels += 1;
          }
        }
      }
      const sampleFile = path.join(path.dirname(resultFile), `motion-${motion.id.replace(':', '-')}.png`);
      await fsp.writeFile(sampleFile, sample.toPNG());
      motionSamples.push({ id: motion.id, visiblePixels, outsideInputPixels, file: sampleFile });
    }
    result.snapshots.motionSamples = motionSamples;
    result.checks.allMotionsVisible = motionSamples.length === PET_MOTIONS.length
      && motionSamples.every((sample) => sample.visiblePixels > 1000);
    result.checks.expandedActionViewport = motionSamples.some((sample) => sample.outsideInputPixels > 1000);
    const beforeDragDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    await win.webContents.executeJavaScript('window.desktopPet.beginDrag({ screenX: 200, screenY: 200, manual: true })');
    const dragVisibleFrames = [];
    for (let step = 1; step <= 6; step += 1) {
      await win.webContents.executeJavaScript(`window.desktopPet.drag({ screenX: ${200 + step * 25}, screenY: ${200 + step * 10} })`);
      await sleep(24);
      dragVisibleFrames.push(await captureVisiblePixels(win));
    }
    await win.webContents.executeJavaScript('window.desktopPet.endDrag()');
    const draggedBounds = win.getBounds();
    const draggedDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    result.snapshots.dragVisibleFrames = dragVisibleFrames;
    result.checks.leftDrag = draggedDebug.visualPosition.x === beforeDragDebug.visualPosition.x + 150
      && draggedDebug.visualPosition.y === beforeDragDebug.visualPosition.y + 60;
    result.checks.dragSizeStable = draggedBounds.width === initialBounds.width && draggedBounds.height === initialBounds.height;
    result.checks.dragAlwaysVisible = dragVisibleFrames.every((visiblePixels) => visiblePixels > 1000);

    const crossingSize = petWindowSize(draggedDebug.visualScale);
    const crossingX = mainBounds.x + mainBounds.width - Math.min(90, crossingSize.width - 48);
    await setPetConfig({ position: { x: crossingX, y: draggedDebug.visualPosition.y } });
    const crossingBounds = win.getBounds();
    const crossingContentBounds = win.getContentBounds();
    const crossingDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    result.checks.crossesMainWindow = crossingDebug.visualPosition.x < mainBounds.x + mainBounds.width
      && crossingDebug.visualPosition.x + crossingSize.width > mainBounds.x + mainBounds.width;

    const beforeScaleDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    await win.webContents.executeJavaScript(`(() => {
      const hitbox = document.getElementById('pet-hitbox');
      hitbox.dispatchEvent(new PointerEvent('pointerdown', { button: 2, buttons: 2, pointerId: 77, clientX: 100, clientY: 120, bubbles: true }));
      hitbox.dispatchEvent(new PointerEvent('pointermove', { button: 2, buttons: 2, pointerId: 77, clientX: 145, clientY: 150, bubbles: true }));
      hitbox.dispatchEvent(new PointerEvent('pointerup', { button: 2, buttons: 0, pointerId: 77, clientX: 145, clientY: 150, bubbles: true }));
      hitbox.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    })()`);
    const scaleUpVisibleFrames = [];
    for (let frame = 0; frame < 12; frame += 1) {
      scaleUpVisibleFrames.push(await captureVisiblePixels(win));
      await sleep(20);
    }
    await waitUntil(() => petRendererState.orbitEvents > 0 && petRendererState.wheelEvents > 0, 5000, 'orbit and wheel events');
    await sleep(350);
    const scaledBounds = win.getBounds();
    const scaledContentBounds = win.getContentBounds();
    const scaledDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    result.checks.rightDragOrbit = petRendererState.orbitEvents > 0;
    result.checks.wheelScale = petRendererState.wheelEvents > 0
      && scaledDebug.visualScale > beforeScaleDebug.visualScale
      && scaledDebug.canvasTransform !== beforeScaleDebug.canvasTransform;
    const beforeScaleSize = petWindowSize(beforeScaleDebug.visualScale);
    const scaledVisualSize = petWindowSize(scaledDebug.visualScale);
    result.checks.scaleAnchor = Math.abs(
      scaledDebug.visualPosition.x + scaledVisualSize.width / 2
      - beforeScaleDebug.visualPosition.x - beforeScaleSize.width / 2,
    ) <= 1
      && Math.abs(
        scaledDebug.visualPosition.y + scaledVisualSize.height / 2
        - beforeScaleDebug.visualPosition.y - beforeScaleSize.height / 2,
      ) <= 1
      && scaledBounds.x === crossingBounds.x
      && scaledBounds.y === crossingBounds.y
      && scaledBounds.width === crossingBounds.width
      && scaledBounds.height === crossingBounds.height;

    await win.webContents.executeJavaScript(`document.getElementById('pet-hitbox')
      .dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }))`);
    const scaleDownVisibleFrames = [];
    for (let frame = 0; frame < 12; frame += 1) {
      scaleDownVisibleFrames.push(await captureVisiblePixels(win));
      await sleep(20);
    }
    await sleep(350);
    const restoredBounds = win.getBounds();
    const restoredContentBounds = win.getContentBounds();
    const restoredDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    result.snapshots.scaleVisibleFrames = { up: scaleUpVisibleFrames, down: scaleDownVisibleFrames };
    result.snapshots.scaleBounds = { before: crossingBounds, enlarged: scaledBounds, restored: restoredBounds };
    result.snapshots.scaleContentBounds = {
      before: crossingContentBounds,
      enlarged: scaledContentBounds,
      restored: restoredContentBounds,
    };
    result.checks.scaleAlwaysVisible = [...scaleUpVisibleFrames, ...scaleDownVisibleFrames]
      .every((visiblePixels) => visiblePixels > 1000);
    result.checks.scaleRoundTrip = restoredBounds.x === crossingBounds.x
      && restoredBounds.y === crossingBounds.y
      && restoredBounds.width === crossingBounds.width
      && restoredBounds.height === crossingBounds.height
      && Math.abs(restoredDebug.visualScale - beforeScaleDebug.visualScale) < 1e-6
      && restoredDebug.visualPosition.x === beforeScaleDebug.visualPosition.x
      && restoredDebug.visualPosition.y === beforeScaleDebug.visualPosition.y;

    petStartupLoading = true;
    await setPetConfig({
      petId: 'mmd-bianca-saint',
      mode: 'all-shuffle',
      assignments: { tool: ['tool:produce-101', 'tool:shinjuku', 'review:duck-dance'] },
    });
    await waitUntil(() => petRendererState.petId === 'mmd-bianca-saint'
      && petRendererState.motionMode === 'all-shuffle'
      && petRendererState.modelReady, 60000, 'switched pet model');
    setPetPhase('tool');
    await waitUntil(() => petRendererState.phase === 'tool', 5000, 'tool phase');
    const rendererDebug = await win.webContents.executeJavaScript('window.__petDebugSnapshot()');
    result.snapshots.finalRenderer = rendererDebug;
    result.checks.petSwitch = rendererDebug.currentPetId === 'mmd-bianca-saint' && rendererDebug.modelReady;
    result.checks.actionSwitch = rendererDebug.motionMode === 'all-shuffle'
      && rendererDebug.phase === 'tool' && rendererDebug.configEvents > 0;

    const persisted = JSON.parse(await fsp.readFile(localSettingsFile, 'utf8'));
    result.checks.persistence = persisted.pet?.petId === 'mmd-bianca-saint'
      && persisted.pet?.mode === 'all-shuffle'
      && persisted.pet?.assignments?.tool?.includes('review:duck-dance')
      && Math.abs(Number(persisted.pet?.scale) - 1) < 0.001;
    result.persisted = persisted.pet;
    result.passed = Object.values(result.checks).every(Boolean);
  } catch (error) {
    result.snapshots.errorRenderer = { ...petRendererState };
    result.error = String(error?.stack || error?.message || error);
    result.passed = false;
  }
  result.finishedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(resultFile), { recursive: true });
  await fsp.writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');
  setTimeout(() => app.quit(), 100);
}

function stopPetDragTracking() {
  if (petDragSession?.timer) clearInterval(petDragSession.timer);
  petDragSession = null;
}

function movePetFromDragPointer(screenX, screenY) {
  if (!petDragSession || !petWindow || petWindow.isDestroyed()) return;
  const x = Math.round(petDragSession.positionX + (Number(screenX) - petDragSession.pointerX));
  const y = Math.round(petDragSession.positionY + (Number(screenY) - petDragSession.pointerY));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (x === localSettingsCache.pet.position?.x && y === localSettingsCache.pet.position?.y) return;
  localSettingsCache.pet = { ...localSettingsCache.pet, position: { x, y } };
  sendPetEvent({ type: 'position', position: { x, y }, scale: localSettingsCache.pet.scale });
  updatePetInputPassthrough();
}

function registerPetIpc() {
  ipcMain.handle('pet:snapshot', (event) => {
    assertPetSender(event);
    return {
      config: localSettingsCache.pet,
      phase: petPhase,
      phases: PET_PHASES,
      motions: PET_MOTIONS,
      pets: bundledPetCatalog(),
      desktopBounds: petWindow && !petWindow.isDestroyed() ? petWindow.getBounds() : petDesktopBounds(),
      selftest: Boolean(String(process.env.AIBROWSER_PET_SELFTEST_RESULT || '').trim()),
    };
  });
  ipcMain.handle('pet:drag-start', (event, point) => {
    assertPetSender(event);
    freezePetScaleAtCurrentBounds();
    if (petScalePersistTimer) clearTimeout(petScalePersistTimer);
    petScalePersistTimer = null;
    stopPetDragTracking();
    const position = visiblePetPosition(localSettingsCache.pet.position, petWindowSize(localSettingsCache.pet.scale));
    petDragSession = {
      pointerX: Number(point?.screenX) || 0,
      pointerY: Number(point?.screenY) || 0,
      positionX: position.x,
      positionY: position.y,
      timer: null,
    };
    if (point?.manual !== true) {
      petDragSession.timer = setInterval(() => {
        const cursor = screen.getCursorScreenPoint();
        movePetFromDragPointer(cursor.x, cursor.y);
      }, 16);
    }
    return { success: true };
  });
  ipcMain.on('pet:drag', (event, point) => {
    try { assertPetSender(event); } catch (_) { return; }
    movePetFromDragPointer(point?.screenX, point?.screenY);
  });
  ipcMain.handle('pet:drag-end', async (event) => {
    assertPetSender(event);
    stopPetDragTracking();
    if (!petWindow || petWindow.isDestroyed()) return { success: false };
    return setPetConfig({ position: localSettingsCache.pet.position });
  });
  ipcMain.handle('pet:scale', (event, deltaY) => {
    assertPetSender(event);
    return scheduleInteractivePetScale(deltaY);
  });
  ipcMain.on('pet:renderer-state', (event, state) => {
    try { assertPetSender(event); } catch (_) { return; }
    petRendererState = state && typeof state === 'object' ? {
      modelReady: state.modelReady === true,
      modelError: String(state.modelError || '').slice(0, 500),
      phase: String(state.phase || ''),
      petId: String(state.petId || ''),
      motionMode: PET_MOTION_MODES.some(({ id }) => id === state.motionMode)
        ? state.motionMode
        : DEFAULT_PET_CONFIG.mode,
      orbitEvents: Number(state.orbitEvents) || 0,
      wheelEvents: Number(state.wheelEvents) || 0,
      configEvents: Number(state.configEvents) || 0,
      visualScale: Number(state.visualScale) || 1,
    } : {};
    if (petRendererState.modelReady && petStartupLoading) {
      petStartupLoading = false;
      setPetPhase(derivePetPhase());
    } else if (petRendererState.modelError) {
      petStartupLoading = false;
      setPetPhase('failed', 3000);
    }
  });
  registerTrustedIpc('pet:settings:get', () => ({
    config: localSettingsCache.pet,
    phase: petPhase,
    phases: PET_PHASES,
    motions: PET_MOTIONS,
    pets: bundledPetCatalog().map(({ id, displayName, description }) => ({ id, displayName, description })),
    renderer: petRendererState,
  }));
  registerTrustedIpc('pet:settings:set', (_event, partial) => setPetConfig(partial || {}));
}

function syncFloatingSnapshot() {
  const profiles = Array.isArray(engine?.status?.()) ? engine.status() : [];
  return {
    enabled: localSettingsCache.syncFloatingEnabled === true,
    theme: { ...currentUiTheme, nativeGlass: windowGlassMaterials.get(syncFloatingWindow) || 'none' },
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
  await saveLocalSettings({ syncFloatingEnabled: next });
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
  applyWindowChrome(win, currentUiTheme.themeId, currentUiTheme.colorMode);
  try { win.setAlwaysOnTop(true, 'floating'); } catch (_) {}
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', (event) => {
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    event.preventDefault();
    win.hide();
    if (localSettingsCache.syncFloatingEnabled) {
      saveLocalSettings({ syncFloatingEnabled: false })
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
  applyWindowChrome(win, currentUiTheme.themeId, currentUiTheme.colorMode);
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
    if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
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
  nativeTheme?.on('updated', () => {
    const nativeGlass = applyWindowChrome(mainWindow, currentUiTheme.themeId, currentUiTheme.colorMode);
    emit({ type: 'ui-glass-material', nativeGlass });
    if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) {
      const floatingGlass = applyWindowChrome(syncFloatingWindow, currentUiTheme.themeId, currentUiTheme.colorMode);
      syncFloatingWindow.webContents.send('sync-floating:theme', { ...currentUiTheme, nativeGlass: floatingGlass });
    }
  });
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
  registerPetIpc();

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
  registerTrustedIpc('app:update-open-release', async (_event, releaseUrl) => {
    const target = String(releaseUrl || lastAppUpdateStatus?.releaseUrl || '').trim();
    if (!target || !updateUrlIsAllowed(target)) throw new Error('The selected release URL is not trusted');
    await shell.openExternal(target);
    return { success: true, url: target };
  });
  registerTrustedIpc('system:set-ui-chrome', (_event, payload) => {
    const win = BrowserWindow.fromWebContents(_event.sender) || mainWindow;
    const themeId = typeof payload === 'string' ? payload : String(payload?.themeId || '');
    const colorMode = typeof payload === 'object' && payload ? String(payload.colorMode || 'light') : 'light';
    currentUiTheme = { themeId: themeId || 'pixel-workstation', colorMode };
    const nativeGlass = applyWindowChrome(win, themeId, colorMode);
    if (syncFloatingWindow && !syncFloatingWindow.isDestroyed()) {
      const floatingGlass = applyWindowChrome(syncFloatingWindow, currentUiTheme.themeId, currentUiTheme.colorMode);
      syncFloatingWindow.webContents.send('sync-floating:theme', { ...currentUiTheme, nativeGlass: floatingGlass });
    }
    return { success: true, theme: themeId, colorMode, nativeGlass };
  });
  registerTrustedIpc('system:set-sync-floating', (_event, enabled) => setSyncFloatingEnabled(enabled));
  registerTrustedIpc('kernel:status', () => engine.kernelStatus());
  registerTrustedIpc('privacy:install-firewall', () => engine.installPrivacyFirewall());
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
    return localSettingsCache.cloud || cloudSync.defaultCloudConfig();
  });
  registerTrustedIpc('cloud:set-config', async (_event, cloud) => {
    const next = { ...cloudSync.defaultCloudConfig(), ...(localSettingsCache.cloud || {}), ...(cloud || {}) };
    await saveLocalSettings({ cloud: next });
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
  registerTrustedIpc('profiles:sync', (_event, profiles) => engine.syncProfiles(profiles, { waitForPersistence: true }));
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
  registerTrustedIpc('ai:chat', async (_event, payload) => {
    if (!aiService) throw new Error('AI 服务未就绪');
    const runId = `chat-${randomUUID()}`;
    activeAgentStates.set(runId, 'thinking');
    setPetPhase('thinking');
    try {
      const result = await aiService.chat(payload || {});
      activeAgentStates.delete(runId);
      setPetPhase('done', 2800);
      return result;
    } catch (error) {
      activeAgentStates.delete(runId);
      setPetPhase('failed', 3000);
      throw error;
    }
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
  if (localSettingsCache.pet.enabled) {
    await createPetWindow();
  } else {
    petStartupLoading = false;
    setPetPhase(derivePetPhase());
  }
  const petSelftestResult = String(process.env.AIBROWSER_PET_SELFTEST_RESULT || '').trim();
  if (petSelftestResult) {
    await runPetIntegrationSelftest(path.resolve(petSelftestResult));
    return;
  }
  startAppUpdateWatcher();
});

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  setPetPhase('failed');
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
    .then(() => engine?.persistenceQueue)
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
