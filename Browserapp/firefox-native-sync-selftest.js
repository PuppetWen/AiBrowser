#!/usr/bin/env node
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const externalKernel = require('./automation/external-kernel');

function waitForReady(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => reject(new Error(`native mirror READY timeout\n${stdout}\n${stderr}`)), timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (/(^|\r?\n)READY(\r?\n|$)/.test(stdout)) { clearTimeout(timer); resolve(stdout); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`native mirror exited ${code}\n${stdout}\n${stderr}`)); });
  });
}

function run(file, args, env = process.env, attempt = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve(stdout);
      if (code === 4 && attempt < 1) return setTimeout(() => run(file, args, env, attempt + 1).then(resolve, reject), 400);
      reject(new Error(`driver exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function readDriverValue(stdout, key) {
  const match = new RegExp(`^${key}=([^\\r\\n]*)`, 'm').exec(String(stdout || ''));
  return match ? match[1] : '';
}

async function stopLaunched(value) {
  if (!value?.child || value.child.killed) return;
  try { value.child.kill(); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function main() {
  if (process.platform !== 'win32') return console.log('firefox-native-sync-selftest: skipped outside Windows');
  const binary = path.join(__dirname, 'kernels', 'firefox-reverse', 'firefox.exe');
  if (!fs.existsSync(binary)) throw new Error('bundled Firefox-Reverse kernel missing');
  const root = path.join(__dirname, '.cache', 'firefox-native-sync-selftest');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  let master; let slave; let mirror;
  try {
    master = await externalKernel.launch({ binary, profileDir: path.join(root, 'master'), url: 'about:blank', networkMode: 'direct' });
    slave = await externalKernel.launch({ binary, profileDir: path.join(root, 'slave'), url: 'about:blank', networkMode: 'system' });
    const ready = await Promise.all([
      externalKernel.waitForMarionette(master.marionettePort, 30000),
      externalKernel.waitForMarionette(slave.marionettePort, 30000),
    ]);
    if (!ready.every(Boolean)) throw new Error('Firefox Marionette did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const env = {
      ...process.env,
      OPENBROWSER_FULL_WINDOW_MASTER: '1',
      OPENBROWSER_FULL_WINDOW_SLAVE_PIDS: String(slave.pid),
      OPENBROWSER_SYNC_KEYBOARD: '1', OPENBROWSER_SYNC_CLICK: '1', OPENBROWSER_SYNC_SCROLL: '1', OPENBROWSER_SYNC_TRACK: '1',
    };
    mirror = spawn(path.join(__dirname, 'native-input-mirror.exe'), [String(master.pid), String(slave.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    await waitForReady(mirror);
    const expected = 'firefox-native-sync-2026';
    const output = await run(path.join(__dirname, 'native-omnibox-driver.exe'), [String(master.pid), expected, String(slave.pid)]);
    const copied = readDriverValue(output, 'COPIED');
    const masterValue = readDriverValue(output, 'MASTER');
    if (copied !== expected) {
      throw new Error(`Firefox 地址栏拷贝结果不匹配: copied=${copied} expected=${expected}`);
    }
    if (masterValue !== expected && masterValue) {
      throw new Error(`Firefox 地址栏读回不匹配: master=${masterValue} expected=${expected}`);
    }
    const focusMatch = output.match(/FOREGROUND_VIOLATIONS=(\d+)/);
    if (Number(focusMatch?.[1] || 0) !== 0) throw new Error('Firefox 从窗口抢占前台焦点：' + focusMatch?.[1]);
    console.log(JSON.stringify({ success: true, masterPid: master.pid, slavePid: slave.pid, expected, driver: output.trim().split(/\r?\n/) }, null, 2));
  } finally {
    if (mirror && !mirror.killed) { try { mirror.kill(); } catch (_) {} }
    await Promise.all([stopLaunched(master), stopLaunched(slave)]);
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
