'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { resolveHostDist, findHostWindowsExe } = require('./scripts/resolve-host-dist');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This desktop regression requires Windows');
  const appUnderTest = path.resolve(process.env.AIBROWSER_UI_TEST_APP_ROOT || __dirname);
  const runtimeUnderTest = process.env.AIBROWSER_UI_TEST_RUNTIME
    || findHostWindowsExe(resolveHostDist(__dirname));
  const parent = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(parent, { recursive: true });
  const root = await fsp.mkdtemp(path.join(parent, 'ui-audit-'));
  const userData = path.join(root, 'browser-data');
  await fsp.mkdir(userData);
  await fsp.writeFile(path.join(userData, 'openbrowser-local-settings.json'), JSON.stringify({ pet: { enabled: false } }));
  let child = null;
  let connection = null;
  let debugPort;
  let output = '';
  const errors = [];
  async function evaluate(expression) {
    const result = await connection.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { timeout: 20000 });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  async function stop() {
    connection?.close(); connection = null;
    if (!child) return;
    const owned = child; child = null;
    const exited = new Promise((resolve) => {
      if (owned.exitCode !== null) resolve(); else owned.once('exit', resolve);
    });
    try { await cdp.call(await cdp.browserSocket(debugPort), 'Browser.close', {}, 2000); } catch (_) {}
    await Promise.race([exited, delay(8000)]);
    if (owned.exitCode === null) { owned.kill(); await exited; }
  }
  async function start() {
    debugPort = await freePort();
    const apiPort = await freePort();
    const env = {
      ...process.env, OPENBROWSER_PROJECT_ROOT: root, OPENBROWSER_USER_DATA: userData,
      OPENBROWSER_START_MENU_PROGRAMS: path.join(root, 'shortcuts'), OPENBROWSER_API_PORT: String(apiPort),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(runtimeUnderTest, [`--remote-debugging-port=${debugPort}`, appUnderTest], {
      cwd: appUnderTest, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-6000); });
    child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-6000); });
    for (let i = 0; i < 150; i += 1) {
      if (child.exitCode !== null) throw new Error('Desktop exited before readiness: ' + output);
      try {
        const target = (await cdp.tabs(debugPort)).find((item) => item.url.endsWith('/index.html'));
        if (target) {
          if (!connection) {
            connection = await cdp.connect(target.webSocketDebuggerUrl, { onEvent(event) {
              if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.text);
            } });
            await connection.command('Runtime.enable');
          }
          if (await evaluate("(async () => { if (typeof uiInitialization === 'undefined' || !window.ops) return false; await uiInitialization; return (await window.ops.getInfo()).localApi !== null; })()")) return;
        }
      } catch (_) {}
      await delay(200);
    }
    throw new Error('Desktop did not become ready: ' + output);
  }
  try {
    await start();
    const created = await evaluate(`(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      openCreateProfileDialog();
      const form = document.querySelector('#profile-form');
      form.elements.number.value = '';
      form.querySelector('button[value="cancel"]').click();
      if (document.querySelector('#profile-dialog').open) throw new Error('Invalid form blocks cancellation');
      openCreateProfileDialog();
      form.elements.title.value = 'Live audit environment';
      form.elements.language.value = 'ja-JP';
      form.querySelector('button[value="default"]').click();
      let saved;
      for (let i = 0; i < 80; i++) {
        saved = (await window.ops.profileStatus()).find((p) => p.title === 'Live audit environment');
        if (saved && !document.querySelector('#profile-dialog').open) break;
        await wait(100);
      }
      if (!saved) throw new Error('Create profile did not persist');
      const full = { ...saved, platform: { ...saved.platform, password: 'synthetic-test-password' }, proxy: 'http://test-user:test-pass@127.0.0.1:65530', networkMode: 'proxy' };
      await persistUiProfiles(ui.profiles.map((p) => p.id === saved.id ? full : p));
      return { id: saved.id, language: saved.privacy.languageMode, canceledInvalidForm: true };
    })()`);
    assert.equal(created.language, 'ja-JP');
    console.log('PASS live desktop creation preserves selected language; invalid forms can be canceled');
    await stop();
    await start();
    const restored = await evaluate(`(async () => {
      for (let i = 0; i < 80 && !ui.profiles.some((p) => p.title === 'Live audit environment'); i++) await new Promise((r) => setTimeout(r, 100));
      const profile = ui.profiles.find((p) => p.title === 'Live audit environment');
      if (!profile) throw new Error('Profile missing after restart');
      const retainedSecrets = profile.platform.password === 'synthetic-test-password' && profile.proxy.includes('test-user:test-pass@');
      await persistUiProfiles(ui.profiles.map((p) => p.id === profile.id ? { ...p, cookies: '', platform: { ...p.platform, password: '', totpSecret: '' } } : p));
      const status = (await window.ops.profileStatus()).find((p) => p.id === profile.id);
      return { retainedSecrets, passwordRetained: profile.platform.password === 'synthetic-test-password', proxyRetained: profile.proxy.includes('test-user:test-pass@'), clearedPassword: status.platform.password === '', language: profile.privacy.languageMode };
    })()`);
    assert.equal(restored.retainedSecrets, true, JSON.stringify(restored));
    assert.equal(restored.clearedPassword, true);
    assert.equal(restored.language, 'ja-JP');
    assert.deepStrictEqual(errors, []);
    console.log('PASS live desktop restart restores settings and credentials; explicit password clearing reaches engine');
    const preset = await evaluate(`(async () => {
      openProfileEditor(${JSON.stringify(created.id)});
      const original = JSON.stringify(ui.profiles.find((p) => p.id === ${JSON.stringify(created.id)}));
      const first = document.getElementById('editor-system-defaults').getBoundingClientRect();
      const second = document.getElementById('editor-google-defaults').getBoundingClientRect();
      document.getElementById('editor-google-defaults').click();
      const untouchedBeforeSave = JSON.stringify(ui.profiles.find((p) => p.id === ${JSON.stringify(created.id)})) === original;
      const native = editorDraft(true);
      const controlsDisabled = document.getElementById('editor-fingerprint-controls').disabled;
      applyEditorNetworkResult({ countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35, longitude: 139 });
      if (editorDraft(true).privacy.languageMode !== 'system') throw new Error('Network lookup replaced native mode language');
      document.querySelector('#profile-editor-form button[type="submit"]').click();
      let stored;
      for (let i = 0; i < 80; i++) {
        stored = (await window.ops.profileStatus()).find((p) => p.id === ${JSON.stringify(created.id)});
        if (stored?.privacy.fingerprintMode === 'native') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { untouchedBeforeSave, controlsDisabled,
        adjacent: second.x >= first.right && Math.abs(second.top - first.top) < 2,
        mode: stored?.privacy.fingerprintMode, kernel: native.kernel,
        proxyRetained: stored?.proxy === native.proxy && native.proxy.includes('test-user:test-pass@'),
        realHardware: stored?.privacy.cores === 0 && stored?.privacy.memory === 0,
      };
    })()`);
    assert.equal(preset.untouchedBeforeSave, true);
    assert.equal(preset.controlsDisabled, true);
    assert.equal(preset.adjacent, true, 'Preset buttons remain side by side');
    assert.equal(preset.mode, 'native');
    assert.equal(preset.kernel, 'chromium');
    assert.equal(preset.proxyRetained, true);
    assert.equal(preset.realHardware, true);
    await stop();
    await start();
    const nativeRestored = await evaluate(`(() => {
      openProfileEditor(${JSON.stringify(created.id)});
      return { mode: editorDraft(true).privacy.fingerprintMode,
        disabled: document.getElementById('editor-fingerprint-controls').disabled,
        uaPreviewHidden: document.getElementById('editor-ua-meta').hidden };
    })()`);
    assert.equal(nativeRestored.mode, 'native');
    assert.equal(nativeRestored.disabled, true);
    assert.equal(nativeRestored.uaPreviewHidden, true);
    assert.deepStrictEqual(errors, []);
    console.log('PASS native preset button is adjacent, preserves proxy, saves only on submit and survives desktop restart');
  } finally {
    await stop();
    assert.equal(path.dirname(path.resolve(root)), parent);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 400 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
