#!/usr/bin/env node
'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');

function run(file, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(file)} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

async function main() {
  if (process.platform !== 'win32') return console.log('native-browser-text-selftest: skipped outside Windows');
  const root = path.join(__dirname, '.cache', 'native-browser-text-selftest');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = [
    { id: 'text-address-1', name: 'Text address 1', number: 1, browser: 'Google Chrome', proxy: 'Direct', advanced: { showInfoPage: false } },
    { id: 'text-address-2', name: 'Text address 2', number: 2, browser: 'Google Chrome', proxy: 'Direct', advanced: { showInfoPage: false } },
  ];
  try {
    await engine.init(null);
    engine.syncProfiles(profiles);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    await new Promise((resolve) => setTimeout(resolve, 900));
    const expected = '中文地址栏测试-2026';
    const encoded = Buffer.from(expected, 'utf8').toString('base64');
    const writer = await run(path.join(__dirname, 'native-browser-text.exe'), ['insert', encoded, ...sessions.map((item) => String(item.pid))]);
    const reader = await run(
      path.join(__dirname, 'native-omnibox-driver.exe'),
      [String(sessions[0].pid), expected, String(sessions[1].pid)],
      { ...process.env, OPENBROWSER_TEST_READ_ONLY: '1' },
    );
    const cleared = await run(path.join(__dirname, 'native-browser-text.exe'), ['clear', '', ...sessions.map((item) => String(item.pid))]);
    console.log(JSON.stringify({ success: true, expected, writer: writer.trim().split(/\r?\n/), reader: reader.trim().split(/\r?\n/), cleared: cleared.trim().split(/\r?\n/) }, null, 2));
  } finally {
    await engine.stopAll().catch(() => {});
    await engine.startPageServer?.stop?.().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
