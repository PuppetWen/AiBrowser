#!/usr/bin/env node
'use strict';

// Reproduces the Environment Management path from the UI report:
// two project-bundled Chromium environments, environment 1 as master, type an
// uncommitted omnibox draft, and verify environment 2 neither reloads nor steals
// focus. Draft IME keystrokes are intentionally not required to appear in slaves;
// committed navigation is synchronized through CDP after Enter.

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, ...options });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${path.basename(file)} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

async function pageTab(port) {
  const tabs = await cdp.tabs(port);
  return tabs.find((tab) => tab.type === 'page' && /^https?:\/\/127\.0\.0\.1:5032[6-9]\//i.test(tab.url)) || tabs.find((tab) => tab.type === 'page');
}

async function loadCount(tab) {
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: "Number(String(window.name||'').replace('__AIBROWSER_SYNC_LOADS__:', ''))||0",
    returnByValue: true,
  });
  return Number(result.result?.value || 0);
}

async function markerState(tab) {
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
    expression: "({master:Boolean(document.getElementById('aibrowser-master-marker')),environment:Boolean(document.getElementById('aibrowser-environment-marker')),profile:Boolean(document.getElementById('aibrowser-profile-marker')),active:document.documentElement.hasAttribute('data-aibrowser-sync-active')})",
    returnByValue: true,
  });
  return result.result?.value || {};
}

async function main() {
  if (process.platform !== 'win32') return console.log('chromium-live-omnibox-regression-selftest: skipped outside Windows');
  const root = path.join(__dirname, '.cache', 'chromium-live-omnibox-regression');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const app = { getPath: (name) => name === 'userData' ? root : '' };
  const engine = new BrowserEngine(app);
  const profiles = [
    { id: 'env-001-sync-regression', name: '主用浏览器', number: 1, browser: 'Google Chrome', proxy: 'Direct' },
    { id: 'env-002-sync-regression', name: '2', number: 2, browser: 'Google Chrome', proxy: 'Direct' },
  ];
  let sync;
  try {
    await engine.init(null);
    engine.syncProfiles(profiles);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    const projectKernelRoot = path.resolve(__dirname, 'kernels') + path.sep;
    for (const session of sessions) {
      const executable = path.resolve(String(session.executable || ''));
      if (!executable.startsWith(projectKernelRoot)) throw new Error(`环境没有使用项目内核：${executable}`);
    }
    await sleep(1200);

    let slaveTab = await pageTab(sessions[1].port);
    const loadMarker = "(() => { const p='__AIBROWSER_SYNC_LOADS__:'; const old=String(window.name||''); const n=old.startsWith(p)?Number(old.slice(p.length))||0:0; window.name=p+(n+1); })()";
    await cdp.call(slaveTab.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: loadMarker });
    await cdp.call(slaveTab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: loadMarker });

    sync = new LiveSyncController(engine, () => {});
    const started = await sync.start(profiles.map((profile) => profile.id));
    if (!started.nativeReady && !await sync.waitForNativeReady(3500)) throw new Error('原生输入同步桥未就绪');
    await sleep(1800);

    slaveTab = await pageTab(sessions[1].port);
    const beforeIdle = await loadCount(slaveTab);
    await sleep(1800);
    slaveTab = await pageTab(sessions[1].port);
    const afterIdle = await loadCount(slaveTab);
    if (afterIdle !== beforeIdle) throw new Error(`受控环境空闲时发生重复刷新：${beforeIdle} -> ${afterIdle}`);

    const expected = '1111';
    const driverOutput = await run(
      path.join(__dirname, 'native-omnibox-driver.exe'),
      [String(sessions[0].pid), expected, String(sessions[1].pid)],
      { env: { ...process.env, OPENBROWSER_TEST_PRESS_ENTER: '0', OPENBROWSER_TEST_MASTER_ONLY: '1', OPENBROWSER_TEST_UNICODE_INPUT: '1' } },
    );
    const foregroundViolations = Number(driverOutput.match(/FOREGROUND_VIOLATIONS=(\d+)/)?.[1] || 0);
    // Windows reports the accessibility activation before our foreground hook can
    // restore the master. At 2 ms sampling, <=2 means no persistent focus change
    // (at most one compositor frame); a larger value catches visible title-bar flashing.
    if (foregroundViolations > 2) throw new Error(`受控环境发生可见的前台焦点抢占：${foregroundViolations}`);

    await sleep(1000);
    slaveTab = await pageTab(sessions[1].port);
    const afterInput = await loadCount(slaveTab);
    if (afterInput !== afterIdle) throw new Error(`地址栏输入期间受控环境发生刷新：${afterIdle} -> ${afterInput}`);

    sync.stop(); await sync.waitForMarkerCleanup(); sync = null;
    await sleep(300);
    const afterStop = await Promise.all(sessions.map(async (session) => markerState(await pageTab(session.port))));
    if (afterStop.some((value) => value.master || value.environment || value.profile || value.active)) throw new Error(`停止同步后仍残留页面标识：${JSON.stringify(afterStop)}`);
    await Promise.all(sessions.map((session) => cdp.reload(session.port))); await sleep(700);
    const afterReload = await Promise.all(sessions.map(async (session) => markerState(await pageTab(session.port))));
    if (afterReload.some((value) => value.master || value.environment || value.profile || value.active)) throw new Error(`停止同步后刷新页面重新出现标识：${JSON.stringify(afterReload)}`);
    if (profiles.some((profile) => engine.running.get(profile.id)?.markerProcess)) throw new Error('未同步时不应启动原生环境编号标识');
    engine.setSyncProfileMarkers(profiles.map((profile) => profile.id), true); await sleep(250);
    const nativeMarkersStarted = profiles.every((profile) => {
      const child = engine.running.get(profile.id)?.markerProcess;
      return Boolean(child && !child.killed && child.exitCode === null);
    });
    if (!nativeMarkersStarted) throw new Error('同步时原生环境编号标识未启动');
    engine.setSyncProfileMarkers([], false); await sleep(100);
    const nativeMarkersStopped = profiles.every((profile) => !engine.running.get(profile.id)?.markerProcess);
    if (!nativeMarkersStopped) throw new Error('停止同步后原生环境编号标识未关闭');

    console.log(JSON.stringify({
      success: true,
      launchPath: 'Environment Management / project bundled Chromium',
      expected,
      reloadsWhileIdle: afterIdle - beforeIdle,
      reloadsWhileTyping: afterInput - afterIdle,
      markerCleanup: { afterStop, afterReload, nativeMarkersStarted, nativeMarkersStopped },
      foregroundViolations,
      startUrls: profiles.map((profile) => engine.running.get(profile.id)?.startUrl || null),
      visibleUrls: await Promise.all(sessions.map(async (session) => (await pageTab(session.port))?.url)),
      driver: driverOutput.trim().split(/\r?\n/),
    }, null, 2));
  } finally {
    sync?.stop();
    await engine.stopAll().catch(() => {});
    await engine.startPageServer?.stop?.().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
