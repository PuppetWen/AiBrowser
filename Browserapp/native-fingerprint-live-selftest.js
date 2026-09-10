'use strict';

// Real-browser regression for the native fingerprint primitives. This fixture
// only visits loopback and always creates a disposable browser profile.
const assert = require('assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const {
  buildFingerprint, chromeArgsForFingerprint, buildInjectionScript,
  buildWorkerInjectionScript, applyFingerprintToTab,
} = require('./automation/fingerprint');
const { killProcessTree } = require('./automation/protocol/cross-platform');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Serialized into both the document and a real dedicated worker.
async function navigatorSnapshot() {
  const hints = navigator.userAgentData;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: [...navigator.languages],
    cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    clientHints: hints ? {
      brands: hints.brands, mobile: hints.mobile, platform: hints.platform,
      highEntropy: await hints.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion',
        'uaFullVersion', 'fullVersionList', 'wow64',
      ]),
    } : null,
  };
}

function browserPath() {
  const index = process.argv.indexOf('--browser');
  if (index >= 0) {
    const binary = process.argv[index + 1];
    assert(binary && path.isAbsolute(binary), '--browser requires an absolute executable path');
    assert(fs.existsSync(binary), 'explicit browser executable must exist');
    return binary;
  }
  const candidates = process.platform === 'win32' ? [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  const binary = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  assert(binary, 'no locally installed Chrome found; use --browser with an installed executable');
  return binary;
}

async function main() {
  const binary = browserPath();
  // Deliberately leave conflicting custom fields in the profile. Native mode
  // must bypass them even when older settings still exist in persisted data.
  const profile = {
    id: 'native-live-fixture', userAgent: 'fixture-non-native-UA', language: 'zz-ZZ',
    width: 701, height: 403, webrtc: 'disabled',
    privacy: {
      fingerprintMode: 'native', canvas: 'blocked', webgl: 'blocked', audio: 'muted',
      cores: 1, memory: 1, timezoneMode: 'custom', timezone: 'Etc/GMT+11',
      geoMode: 'custom', latitude: 1, longitude: 1,
      fingerprint: { userAgent: 'fixture-custom-UA', language: 'zz-ZZ', canvas: 'noise', webgl: 'noise', cores: 1, memory: 1 },
    },
  };
  const fingerprint = buildFingerprint(profile);
  assert.equal(fingerprint.native, true);
  assert.deepEqual(chromeArgsForFingerprint(fingerprint, profile), []);
  assert.equal(buildInjectionScript(fingerprint), '');
  assert.equal(buildWorkerInjectionScript(fingerprint), '');

  const cacheRoot = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(cacheRoot, { recursive: true });
  const testRoot = await fsp.mkdtemp(path.join(cacheRoot, 'native-fingerprint-live-'));
  const userDataRoot = path.join(testRoot, 'profile');
  const environment = { ...process.env, APPDATA: path.join(testRoot, 'appdata'), LOCALAPPDATA: path.join(testRoot, 'localappdata'), TEMP: path.join(testRoot, 'temp'), TMP: path.join(testRoot, 'temp') };
  for (const directory of new Set([userDataRoot, environment.APPDATA, environment.LOCALAPPDATA, environment.TEMP])) await fsp.mkdir(directory, { recursive: true });
  const workerSource = '(' + navigatorSnapshot.toString() + ')().then(value => self.postMessage(value)).catch(error => self.postMessage({ error: String(error) }));';
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Accept-CH', 'Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Model');
    if (req.url === '/worker.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(workerSource);
    } else if (req.url === '/headers') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([key]) => key === 'user-agent' || key === 'accept-language' || key.startsWith('sec-ch-ua')))));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta charset="utf-8"><title>Native fingerprint fixture</title><canvas id="fixture" width="240" height="80"></canvas>');
    }
  });
  let child;
  let socket;
  let spawnError;
  let stderr = '';
  let tab;

  const documentExpression = '(' + async function documentSnapshot(navigatorSource) {
    const readNavigator = (0, eval)('(' + navigatorSource + ')');
    const nav = await readNavigator();
    const canvas = document.querySelector('#fixture');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#7831af';
    ctx.fillRect(3, 7, 71, 23);
    ctx.font = '17px Arial';
    ctx.fillStyle = '#152839';
    ctx.fillText('Native fixture 123', 11, 57);
    const gl = document.createElement('canvas').getContext('webgl');
    const debug = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const webgl = gl ? {
      vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION), shading: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      extensions: gl.getSupportedExtensions(),
    } : null;
    const worker = await new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js');
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('worker fixture timeout')); }, 5000);
      worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
      worker.onerror = (error) => { clearTimeout(timer); worker.terminate(); reject(new Error(error.message)); };
    });
    if (worker.error) throw new Error(worker.error);
    return {
      navigator: nav,
      screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth, devicePixelRatio },
      canvas: canvas.toDataURL(), webgl, worker,
      headers: await (await fetch('/headers')).json(),
      functions: { toString: Function.prototype.toString.toString(), getImageData: CanvasRenderingContext2D.prototype.getImageData.toString(), getParameter: WebGLRenderingContext.prototype.getParameter.toString() },
    };
  } + ')(' + JSON.stringify(navigatorSnapshot.toString()) + ')';

  async function snapshot() {
    const response = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: documentExpression, awaitPromise: true, returnByValue: true }, 15000);
    assert(!response.exceptionDetails, JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = 'http://127.0.0.1:' + server.address().port;
    child = spawn(binary, [
      '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-proxy-server',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
      '--user-data-dir=' + userDataRoot, ...chromeArgsForFingerprint(fingerprint, profile), origin,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(binary), env: environment });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
    child.on('error', (error) => { spawnError = error; });
    const startupDeadline = Date.now() + 30000;
    while (Date.now() < startupDeadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error('test browser exited: ' + stderr);
      try {
        const port = Number((await fsp.readFile(path.join(userDataRoot, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0]);
        socket = await cdp.browserSocket(port);
        tab = (await cdp.tabs(port)).find((candidate) => candidate.url.startsWith(origin));
        if (tab) {
          const ready = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'location.origin === ' + JSON.stringify(origin) + ' && document.readyState === "complete" && !!document.querySelector("#fixture")', returnByValue: true });
          if (ready.result?.value) break;
        }
      } catch (_) {}
      tab = null;
      await pause(100);
    }
    assert(tab, 'test browser startup must finish: ' + stderr);
    const baseline = await snapshot();
    const attemptedOverrides = [];
    await applyFingerprintToTab(async (...args) => {
      attemptedOverrides.push(args);
      return cdp.call(...args);
    }, tab.webSocketDebuggerUrl, fingerprint, profile);
    assert.deepEqual(attemptedOverrides, [], 'native mode must not issue fingerprint CDP overrides');
    assert.deepEqual(await snapshot(), baseline, 'native fingerprint primitives must leave the current document and new workers unchanged');
    console.log('PASS native fingerprint preserves Chrome UA/CH, request headers, platform, language, timezone, screen, CPU/RAM, Canvas, WebGL and worker values');
    await cdp.call(tab.webSocketDebuggerUrl, 'Page.navigate', { url: origin + '/after-native' });
    const navigationDeadline = Date.now() + 10000;
    let ready = false;
    while (Date.now() < navigationDeadline) {
      const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'location.pathname === "/after-native" && document.readyState === "complete"', returnByValue: true }).catch(() => null);
      if (result?.result?.value) { ready = true; break; }
      await pause(100);
    }
    assert(ready, 'new fixture document must finish loading');
    assert.deepEqual(await snapshot(), baseline, 'native fingerprint primitives must leave future documents unchanged');
    console.log('PASS new-document navigation retains the browser baseline without a fingerprint injection');
    console.log('Verified local browser: ' + binary);
    console.log('Scope: real headless Chrome with isolated temporary storage; fingerprint primitives only, no platform account login or risk-control claims.');
  } finally {
    if (child && child.pid && child.exitCode === null && child.signalCode === null) {
      if (socket) await cdp.call(socket, 'Browser.close', {}, 5000).catch(() => {});
      const deadline = Date.now() + 8000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(100);
      if (child.exitCode === null && child.signalCode === null) {
        assert(await killProcessTree(child.pid, { force: true, expectedExecutable: binary, expectedUserDataDir: userDataRoot }), 'only the owned test browser may be terminated');
        const killedDeadline = Date.now() + 5000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < killedDeadline) await pause(100);
      }
      assert(child.exitCode !== null || child.signalCode !== null, 'test browser must exit before deleting its profile');
    }
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    const resolved = path.resolve(testRoot);
    assert.equal(path.dirname(resolved), cacheRoot);
    assert(path.basename(resolved).startsWith('native-fingerprint-live-'));
    await fsp.rm(resolved, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
