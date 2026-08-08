'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function parseWindowsInternetSettings(output = '') {
  const values = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL)\s+REG_\w+\s*(.*?)\s*$/i);
    if (match) values[match[1].toLowerCase()] = match[2] || '';
  }
  return {
    enabled: /^(?:0x)?1$/i.test(String(values.proxyenable || '')),
    server: String(values.proxyserver || '').trim(),
    bypass: String(values.proxyoverride || '').trim(),
    pacUrl: String(values.autoconfigurl || '').trim(),
  };
}

function normalizeWindowsProxyServer(value = '') {
  const raw = String(value).trim();
  if (!raw) return '';
  if (!raw.includes('=')) return /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  const entries = new Map();
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    entries.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }
  for (const key of ['https', 'http', 'socks', 'socks5', 'socks4']) {
    const endpoint = entries.get(key);
    if (!endpoint) continue;
    const scheme = key.startsWith('socks') ? (key === 'socks4' ? 'socks4' : 'socks5') : 'http';
    return /^[a-z][a-z\d+.-]*:\/\//i.test(endpoint) ? endpoint : `${scheme}://${endpoint}`;
  }
  return '';
}

function parseMacSystemProxy(output = '') {
  const values = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9]+)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2] || '';
  }
  const candidates = [
    ['SOCKSEnable', 'SOCKSProxy', 'SOCKSPort', 'socks5'],
    ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', 'http'],
    ['HTTPEnable', 'HTTPProxy', 'HTTPPort', 'http'],
  ];
  for (const [enabledKey, hostKey, portKey, protocol] of candidates) {
    const host = String(values[hostKey] || '').trim();
    const port = Number(values[portKey]);
    if (String(values[enabledKey]) === '1' && host && Number.isInteger(port) && port > 0 && port <= 65535) {
      return {
        enabled: true,
        raw: `${protocol}://${host}:${port}`,
        bypass: '',
        pacUrl: '',
        source: 'macos-scutil',
      };
    }
  }
  const pacUrl = String(values.ProxyAutoConfigURLString || '').trim();
  return {
    enabled: String(values.ProxyAutoConfigEnable) === '1' && Boolean(pacUrl),
    raw: '',
    bypass: '',
    pacUrl,
    source: pacUrl ? 'macos-pac' : 'macos-direct',
  };
}

async function resolveSystemProxy(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const execute = options.execFile || execFileAsync;
    const result = await execute('reg.exe', ['query', INTERNET_SETTINGS], { windowsHide: true, encoding: 'utf8' });
    const settings = parseWindowsInternetSettings(result.stdout || result);
    const raw = settings.enabled ? normalizeWindowsProxyServer(settings.server) : '';
    return {
      enabled: Boolean(raw || settings.pacUrl),
      raw,
      bypass: settings.bypass,
      pacUrl: settings.pacUrl,
      source: raw ? 'windows-registry' : (settings.pacUrl ? 'windows-pac' : 'windows-direct'),
    };
  }

  if (platform === 'darwin') {
    const execute = options.execFile || execFileAsync;
    const result = await execute('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
    return parseMacSystemProxy(result.stdout || result);
  }

  const raw = String(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '').trim();
  return { enabled: Boolean(raw), raw, bypass: String(process.env.NO_PROXY || process.env.no_proxy || ''), pacUrl: '', source: raw ? 'environment' : 'system-direct' };
}

module.exports = {
  INTERNET_SETTINGS,
  normalizeWindowsProxyServer,
  parseMacSystemProxy,
  parseWindowsInternetSettings,
  resolveSystemProxy,
};
