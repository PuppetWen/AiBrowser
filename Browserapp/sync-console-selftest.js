#!/usr/bin/env node
'use strict';

// Exercises the concrete primitives used by the Window Sync console with two
// isolated environments created by BrowserEngine and the bundled project kernel.

const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { BrowserEngine } = require('./engine');
const cdp = require('./cdp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function evaluate(tab, expression) {
  const result = await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'renderer evaluation failed');
  return result.result?.value;
}

async function main() {
  const root = path.join(__dirname, '.cache', 'sync-console-selftest');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${request.url}</title><input id="value"><main>${request.url}</main>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = [
    { id: 'console-one', number: 1, name: 'Console One', kernel: 'chromium', proxy: 'Direct', advanced: { showInfoPage: false } },
    { id: 'console-two', number: 2, name: 'Console Two', kernel: 'chromium', proxy: 'Direct', advanced: { showInfoPage: false } },
  ];
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const sessions = await Promise.all(profiles.map((profile) => engine.start(profile)));
    const projectKernelRoot = path.resolve(__dirname, 'kernels') + path.sep;
    for (const session of sessions) {
      if (!path.resolve(String(session.executable || '')).startsWith(projectKernelRoot)) throw new Error('测试环境没有使用项目内核：' + session.executable);
    }
    const inventory = await engine.sessions();
    if (inventory.length !== 2 || inventory.some((item) => !item.port)) throw new Error('刷新会话清单失败：' + JSON.stringify(inventory));
    await Promise.all(sessions.map((session) => cdp.navigate(session.port, origin + '/text')));
    await sleep(700);

    // Window management: tile-like bounds, cascade-like bounds and all states.
    await Promise.all(sessions.map((session, index) => cdp.setWindowBounds(session.port, { left: index * 620, top: 0, width: 610, height: 680 })));
    await Promise.all(sessions.map((session, index) => cdp.setWindowBounds(session.port, { left: index * 38, top: index * 34, width: 900, height: 700 })));
    for (const state of ['maximized', 'normal', 'minimized', 'normal']) await Promise.all(sessions.map((session) => cdp.setWindowState(session.port, state)));

    // Text management: focus, batch insert and clear in both environments.
    const textTabs = [];
    for (const session of sessions) {
      const tab = (await cdp.tabs(session.port)).find((item) => item.url === origin + '/text');
      if (!tab) throw new Error('文本测试标签页不存在');
      textTabs.push(tab);
      await evaluate(tab, `value.focus(); true`);
    }
    await Promise.all(sessions.map((session) => cdp.insertText(session.port, 'sync-console')));
    const inserted = await Promise.all(textTabs.map((tab) => evaluate(tab, 'value.value')));
    if (!inserted.every((value) => value === 'sync-console')) throw new Error('批量文本写入失败：' + JSON.stringify(inserted));
    await Promise.all(sessions.map((session) => cdp.clearFocused(session.port)));
    const cleared = await Promise.all(textTabs.map((tab) => evaluate(tab, 'value.value')));
    if (!cleared.every((value) => value === '')) throw new Error('批量文本清空失败：' + JSON.stringify(cleared));
    const assigned = ['specified-one', 'specified-two'];
    await Promise.all(sessions.map((session, index) => cdp.insertText(session.port, assigned[index])));
    const assignedResult = await Promise.all(textTabs.map((tab) => evaluate(tab, 'value.value')));
    if (assignedResult.some((value, index) => value !== assigned[index])) throw new Error('指定文本分配失败：' + JSON.stringify(assignedResult));

    // Tab management: new, navigate, reload and close on every environment.
    const created = await Promise.all(sessions.map((session) => cdp.newTab(session.port, origin + '/new')));
    await Promise.all(created.map((tab) => cdp.call(tab.webSocketDebuggerUrl, 'Page.navigate', { url: origin + '/navigated' })));
    await sleep(350);
    await Promise.all(created.map((tab) => cdp.call(tab.webSocketDebuggerUrl, 'Page.reload', { ignoreCache: false })));
    const navigated = await Promise.all(created.map((tab) => evaluate(tab, 'location.pathname')));
    if (!navigated.every((value) => value === '/navigated')) throw new Error('标签页导航/刷新失败：' + JSON.stringify(navigated));
    await Promise.all(sessions.map((session, index) => cdp.closeTab(session.port, created[index].id)));

    console.log(JSON.stringify({
      success: true,
      launchPath: 'BrowserEngine/environment-management',
      kernels: sessions.map((session) => session.executable),
      windowActions: ['tile', 'cascade', 'maximized', 'minimized', 'normal'],
      sessionRefresh: inventory.map((item) => item.id),
      textActions: { inserted, cleared, assigned: assignedResult },
      tabActions: ['new', 'navigate', 'reload', 'close'],
    }, null, 2));
  } finally {
    await engine.stopAll().catch(() => {});
    await engine.startPageServer?.stop?.().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
