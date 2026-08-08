#!/usr/bin/env node
'use strict';

// Regression test for the exact app path used by Environment Management:
// BrowserEngine -> project bundled kernel -> isolated temporary profiles -> LiveSyncController.
// It intentionally does not fall back to Edge/Chrome installed on the machine.

const http = require('http');
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

function readDriverValue(stdout, key) {
  const match = new RegExp(`^${key}=([^\\r\\n]*)`, 'm').exec(String(stdout || ''));
  return match ? match[1] : '';
}

async function waitFor(check, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs; let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last?.pass) return last; } catch (_) {}
    await sleep(100);
  }
  throw new Error(`${label} timeout: ${JSON.stringify(last)}`);
}

async function main() {
  if (process.platform !== 'win32') return console.log('chromium-ime-sync-selftest: skipped outside Windows');
  const root = path.join(__dirname, '.cache', 'environment-managed-sync-selftest');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><meta charset="utf-8"><title>${request.url}</title><body data-path="${request.url}"><input id="message"><button id="action">action</button></body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = { getPath: (name) => name === 'userData' ? root : '' };
  const engine = new BrowserEngine(app);
  const profiles = [
    { id: 'managed-sync-master', name: 'Managed Sync Master', number: 1, browser: 'Google Chrome', proxy: 'Direct', advanced: { showInfoPage: false } },
    { id: 'managed-sync-slave', name: 'Managed Sync Slave', number: 2, browser: 'Google Chrome', proxy: 'Direct', advanced: { showInfoPage: false } },
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

    await Promise.all(sessions.map((session) => cdp.navigate(session.port, origin + '/start')));
    await sleep(900);
    sync = new LiveSyncController(engine, () => {});
    const started = await sync.start(profiles.map((profile) => profile.id));
    if (!started.nativeReady) await sync.waitForNativeReady(3000);

    const destination = origin + '/committed';
    const driverOutput = await run(
      path.join(__dirname, 'native-omnibox-driver.exe'),
      [String(sessions[0].pid), destination, String(sessions[1].pid)],
      { env: { ...process.env, OPENBROWSER_TEST_PRESS_ENTER: '1', OPENBROWSER_TEST_MASTER_ONLY: '1' } },
    );
    const copied = readDriverValue(driverOutput, 'COPIED');
    if (copied !== destination) {
      throw new Error(`Chromium 地址栏拷贝结果不匹配: copied=${copied} expected=${destination}`);
    }
    const focusMatch = driverOutput.match(/FOREGROUND_VIOLATIONS=(\d+)/);
    const foregroundViolations = Number(focusMatch?.[1] || 0);
    if (foregroundViolations !== 0) throw new Error(`同步期间从窗口抢占了前台焦点：${foregroundViolations}`);

    const converged = await waitFor(async () => {
      const urls = await Promise.all(sessions.map(async (session) => (await cdp.tabs(session.port)).map((tab) => tab.url)));
      return { pass: urls.every((items) => items.some((url) => url === destination)), urls };
    }, '地址栏提交后的环境导航同步');

    console.log(JSON.stringify({
      success: true,
      launchPath: 'BrowserEngine/environment-management',
      executables: sessions.map((session) => session.executable),
      destination,
      foregroundViolations,
      urls: converged.urls,
    }, null, 2));
  } finally {
    sync?.stop();
    await engine.stopAll().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
