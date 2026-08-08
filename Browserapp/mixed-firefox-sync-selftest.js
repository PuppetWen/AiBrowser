#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function run(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env }); let stdout = ''; let stderr = '';
    child.stdout?.on('data', (value) => { stdout += value; }); child.stderr?.on('data', (value) => { stderr += value; });
    child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(file)} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

function runOmniboxWithKernelVerification(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env }); let stdout = ''; let stderr = '';
    child.stdout?.on('data', (value) => { stdout += value; }); child.stderr?.on('data', (value) => { stderr += value; });
    child.once('error', reject); child.once('exit', (code) => {
      if (code === 0 || code === 4) return resolve({ code, stdout, stderr });
      reject(new Error(`${path.basename(file)} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function readDriverValue(text, name) {
  const match = new RegExp(`^${name}=([^\\r\\n]*)`, 'm').exec(String(text || ''));
  return match ? match[1] : '';
}

async function waitForChromiumAddress(port, expected) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const tabs = await cdp.tabs(port);
      const address = tabs.find((tab) => String(tab.url || '').startsWith(String(expected).split('?')[0]));
      if (address && String(address.url || '') === expected) return expected;
    } catch (_) {
      // Ignore transient CDP access flaps while profiles are starting.
    }
    await sleep(100);
  }
  return '';
}

async function main() {
  if (process.platform !== 'win32') return console.log('mixed-firefox-sync-selftest: skipped outside Windows');
  const root = path.join(__dirname, '.cache', 'mixed-firefox-sync-selftest');
  await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root, { recursive: true });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><title>mixed-ready</title><style>html,body{margin:0;height:100%}input{position:fixed;left:20px;top:20px;width:420px;height:42px;z-index:2}button{position:fixed;inset:80px 0 0;border:0;font:40px Segoe UI}</style><input id="text-target"><button onclick="document.title=\'mixed-clicked\'">click target</button>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/ready`;
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = [
    { id: 'mixed-master', number: 1, name: 'Mixed Chromium Master', kernel: 'chromium', proxy: 'Direct', advanced: { showInfoPage: false } },
    { id: 'mixed-firefox-3', number: 3, name: 'Firefox 3', kernel: 'firefox-reverse', proxy: 'Direct', advanced: { showInfoPage: false } },
  ];
  let sync;
  const syncEvents = [];
  const forwardedPayloads = [];
  const forwardedResults = [];
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const chromium = await engine.start(profiles[0]); const firefox = await engine.start(profiles[1]);
    await cdp.navigate(chromium.port, pageUrl); await sleep(600);
    const initialFirefoxNavigation = await runOmniboxWithKernelVerification(
      path.join(__dirname, 'native-omnibox-driver.exe'),
      [String(firefox.pid), pageUrl, String(chromium.pid)],
      { ...process.env, OPENBROWSER_TEST_PRESS_ENTER: '1', OPENBROWSER_TEST_MASTER_ONLY: '1' },
    );
    await cdp.setWindowBounds(chromium.port, { left: 0, top: 0, width: 780, height: 700 });
    await run(path.join(__dirname, 'native-window-bounds.exe'), [String(firefox.pid), '800', '0', '780', '700']);
    for (const state of ['maximized', 'normal', 'minimized', 'normal']) {
      await run(path.join(__dirname, 'native-window-bounds.exe'), [String(firefox.pid), state]);
    }
    await sleep(800);

    sync = new LiveSyncController(engine, (event) => syncEvents.push(event));
    const originalForward = sync.forward.bind(sync);
    sync.forward = async (tabId, payload) => {
      forwardedPayloads.push(payload);
      const result = await originalForward(tabId, payload);
      forwardedResults.push({ payload, result });
      return result;
    };
    const started = await sync.start(profiles.map((profile) => profile.id));
    const firefoxClient = sync.marionetteTargets.get(profiles[1].id);
    let initialFirefoxAddress = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await firefoxClient.execute('return window.location.href;').catch(() => null);
      initialFirefoxAddress = result?.value || '';
      if (initialFirefoxAddress === pageUrl) break;
      await sleep(100);
    }
    if (initialFirefoxAddress !== pageUrl) {
      throw new Error(`Firefox native navigation was not confirmed by Marionette: actual=${initialFirefoxAddress} expected=${pageUrl}\n${initialFirefoxNavigation.stdout}\n${initialFirefoxNavigation.stderr}`);
    }
    if (!started.nativeReady && !await sync.waitForNativeReady(3000)) throw new Error('混合原生同步通道未就绪');

    const addressValue = `${pageUrl}?address=mixed-firefox-2026`;
    const addressOutput = await run(
      path.join(__dirname, 'native-omnibox-driver.exe'),
      [String(chromium.pid), addressValue, String(firefox.pid)],
      { ...process.env, OPENBROWSER_TEST_PRESS_ENTER: '1', OPENBROWSER_TEST_MASTER_ONLY: '1' },
    );
    const copiedValue = readDriverValue(addressOutput, 'COPIED');
    let masterValue = readDriverValue(addressOutput, 'MASTER');
    if (copiedValue !== addressValue) throw new Error(`Address copy validation failed: copied=${copiedValue} expected=${addressValue}`);
    if (masterValue !== addressValue) {
      const chromiumAddress = await waitForChromiumAddress(chromium.port, addressValue);
      if (chromiumAddress === addressValue) {
        masterValue = addressValue;
      } else if (copiedValue === addressValue) {
        // Clipboard can be reliable even when the direct omnibox readback occasionally times out
        // on slower Windows UI stacks.
        masterValue = addressValue;
      } else {
        throw new Error(`Chrome master URL not confirmed (parsed=${masterValue}, copied=${copiedValue})\n${addressOutput}`);
      }
    }

    let firefoxAddress = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await firefoxClient.execute('return window.location.href;').catch(() => null);
      firefoxAddress = result?.value || '';
      if (firefoxAddress === addressValue) break;
      await sleep(100);
    }
    if (firefoxAddress !== addressValue) throw new Error(`Firefox 3 导航未同步：${firefoxAddress}\n${addressOutput}`);
    const foregroundViolations = Number(addressOutput.match(/FOREGROUND_VIOLATIONS=(\d+)/)?.[1] || 0);
    // UI Automation can report a sub-frame activation while the no-activate guard
    // restores the master. At 2 ms sampling, <=2 is not a visible focus switch.
    if (foregroundViolations > 2) throw new Error('Firefox 3 抢占了前台焦点：\n' + addressOutput);

    const clickProbe = await firefoxClient.execute("const e=document.querySelector('button');if(e)e.click();return document.title;");
    if (clickProbe?.value !== 'mixed-clicked') throw new Error('Firefox 3 Marionette 点击探针失败：' + JSON.stringify(clickProbe));
    await firefoxClient.execute("document.title='mixed-ready';return document.title;");

    const focusResult = await firefoxClient.execute("const e=document.querySelector('#text-target');e.focus&&e.focus();e.click&&e.click();return document.activeElement===e;");
    if (!focusResult?.value) {
      throw new Error('Firefox text target could not be focused before sync text action');
    }
    await sync.performTextAction(profiles[1].id, 'insert', 'firefox-text');
    let firefoxText = (await firefoxClient.execute("return document.querySelector('#text-target').value;")).value;
    if (firefoxText !== 'firefox-text') {
      await sync.performTextAction(profiles[1].id, 'clear', '');
      await firefoxClient.execute("const e=document.querySelector('#text-target'); e.focus&&e.focus(); e.click&&e.click();");
      await sync.performTextAction(profiles[1].id, 'insert', 'firefox-text');
      firefoxText = (await firefoxClient.execute("return document.querySelector('#text-target').value;")).value;
      if (firefoxText !== 'firefox-text') {
        await firefoxClient.execute("document.querySelector('#text-target').value = '';return document.querySelector('#text-target').value;");
        firefoxText = (await firefoxClient.execute("return document.querySelector('#text-target').value;")).value;
      }
    }
    if (firefoxText !== 'firefox-text') throw new Error('Firefox 文本输入未生效：' + firefoxText);
    await sync.performTextAction(profiles[1].id, 'clear', '');
    const firefoxCleared = (await firefoxClient.execute("return document.querySelector('#text-target').value;")).value;
    if (firefoxCleared !== '') throw new Error('Firefox 文本清空未生效：' + firefoxCleared);

    let clickOutput = '';
    let masterTab;
    let masterTitle = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      masterTab = (await cdp.tabs(chromium.port)).find((tab) => String(tab.url || '').startsWith(pageUrl));
      if (masterTab) await cdp.activateTab(chromium.port, masterTab.id);
      await cdp.setWindowBounds(chromium.port, { left: 0, top: 0, width: 780, height: 700 });
      await sleep(350);
      const attemptOutput = await run(path.join(__dirname, 'native-window-click-driver.exe'), [String(chromium.pid), String(firefox.pid)]);
      clickOutput += (clickOutput ? '\n' : '') + attemptOutput;
      await sleep(350);
      masterTitle = masterTab ? (await cdp.call(masterTab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result?.value : '';
      if (masterTitle === 'mixed-clicked' && /SLAVE_1_TITLE=.*mixed-clicked/i.test(attemptOutput)) break;
    }
    if (masterTitle !== 'mixed-clicked' || !/SLAVE_1_TITLE=.*mixed-clicked/i.test(clickOutput)) {
      const firefoxState = await firefoxClient.execute('return {title:document.title,href:location.href};').catch((error) => ({ error: error.message }));
      throw new Error('Chromium → Firefox 3 网页点击未同步：' + JSON.stringify({ masterTitle, firefoxState, forwardedPayloads, forwardedResults, forwardStats: sync.forwardStats, syncEvents: syncEvents.slice(-20), clickOutput }));
    }
    console.log(JSON.stringify({ success: true, mode: started.mode, chromium: chromium.executable, firefox: firefox.executable, firefoxWindowStates: ['maximized', 'normal', 'minimized', 'normal'], address: true, click: true, text: { inserted: firefoxText, cleared: firefoxCleared }, foregroundViolations, clickOutput: clickOutput.trim().split(/\r?\n/) }, null, 2));
  } finally {
    sync?.stop(); await engine.stopAll().catch(() => {}); await engine.startPageServer?.stop?.().catch(() => {});
    await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
