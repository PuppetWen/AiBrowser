#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'sync-floating.html'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, 'sync-floating-renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, 'sync-floating-preload.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

for (const id of [
  'floating-delay-input', 'floating-sync-text', 'floating-clear-text',
  'floating-random-min', 'floating-random-max', 'floating-send-random',
  'floating-add-text-group', 'floating-specified-groups',
]) {
  if (!html.includes(`id="${id}"`)) throw new Error(`悬浮文本管理缺少控件：${id}`);
}
for (const token of ['batchTextAction', 'sendSpecifiedGroup', 'distributeTexts', 'TEXT_GROUPS_KEY']) {
  if (!renderer.includes(token)) throw new Error(`悬浮文本管理缺少实现：${token}`);
}
for (const token of ['compositionstart', 'compositionend', 'event.isComposing', 'focusedText && target.contains(focusedText)']) {
  if (!renderer.includes(token)) throw new Error(`floating text IME protection is missing: ${token}`);
}
if (!preload.includes('sync-floating:text-batch') || !main.includes("ipcMain.handle('sync-floating:text-batch'")) {
  throw new Error('悬浮文本管理批处理 IPC 未完整连接');
}
if (!preload.includes('sync-floating:settings') || !main.includes("ipcMain.handle('sync-floating:settings'")) {
  throw new Error('悬浮文本管理延迟设置 IPC 未完整连接');
}

console.log(JSON.stringify({
  success: true,
  textParity: ['same', 'clear', 'random-number', 'delay-input', 'specified-sequence', 'specified-random', 'multiple-groups'],
}, null, 2));
