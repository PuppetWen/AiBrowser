'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isSystemBrowserExecutable } = require('./isolation');
const execute = promisify(execFile);

async function privacyFirewall(browser, action = 'Check', options = {}) {
  if ((options.platform || process.platform) !== 'win32') throw new Error('严格隐私模式目前需要 Windows 出站防火墙保护，此平台尚未实现，请勿将其视为已保护。');
  if (!browser?.independent || !browser.path || isSystemBrowserExecutable(browser.path)) throw new Error('网络保护仅允许用于 AiBrowser 独立内核，不能修改系统浏览器的网络规则。');
  const binary = path.resolve(browser.path);
  if (!fs.existsSync(binary)) throw new Error('独立浏览器内核不存在');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'scripts', 'privacy-firewall.ps1'), '-Action', action, '-BrowserPath', binary];
  let result;
  try { result = await (options.execute || execute)(shell, args, { windowsHide: true, timeout: action === 'Install' ? 180000 : 20000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    let detail; try { detail = JSON.parse(String(error.stdout || '').trim()).error; } catch (_) {}
    throw new Error('网络保护校验失败，已阻止启动。请开启 Windows 防火墙，并在代理配置中点击“安装网络保护”。' + (detail ? '（' + detail + '）' : ''));
  }
  const status = JSON.parse(String(result.stdout).replace(/^\uFEFF/, '').trim());
  if (!status.ok) throw new Error(status.error || 'Windows 网络保护尚未就绪');
  return status;
}

module.exports = { privacyFirewall };
