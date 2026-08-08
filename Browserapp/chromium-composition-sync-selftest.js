#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function inputValue(port) {
  const tab = (await cdp.tabs(port)).find((item) => /^http:\/\/127\.0\.0\.1:/i.test(item.url));
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: "document.querySelector('#message').value", returnByValue: true });
  return String(result.result?.value || '');
}

async function main() {
  const root = path.join(__dirname, '.cache', 'composition-sync-selftest');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><meta charset="utf-8"><input id="message">');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = [
    { id: 'composition-master', name: 'Composition master', number: 1, browser: 'Google Chrome', proxy: 'Direct', advanced: { showInfoPage: false } },
    { id: 'composition-slave', name: 'Composition slave', number: 2, browser: 'Google Chrome', proxy: 'Direct', advanced: { showInfoPage: false } },
  ];
  let sync;
  try {
    await engine.init(null);
    engine.syncProfiles(profiles);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    await Promise.all(sessions.map((item) => cdp.navigate(item.port, url)));
    await sleep(700);
    sync = new LiveSyncController(engine, () => {});
    await sync.start(profiles.map((item) => item.id));
    await sleep(500);
    const masterTab = (await cdp.tabs(sessions[0].port)).find((item) => item.url === url);
    await cdp.call(masterTab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: `(() => {
      const input=document.querySelector('#message');input.focus();
      input.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
      input.value='nih';
      input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:'h',inputType:'insertCompositionText',isComposing:true}));
    })()` });
    await sleep(350);
    const duringComposition = await inputValue(sessions[1].port);
    if (duringComposition === 'nih') throw new Error('拼音组合中间态被同步到了从环境');
    await cdp.call(masterTab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: `(() => {
      const input=document.querySelector('#message');input.value='你好';
      input.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你好'}));
      input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:'你好',inputType:'insertFromComposition',isComposing:false}));
    })()` });
    await sleep(500);
    const committed = await inputValue(sessions[1].port);
    if (committed !== '你好') throw new Error(`中文提交结果没有同步：${JSON.stringify(committed)}`);
    console.log(JSON.stringify({ success: true, duringComposition, committed }, null, 2));
  } finally {
    sync?.stop();
    await engine.stopAll().catch(() => {});
    await engine.startPageServer?.stop?.().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
