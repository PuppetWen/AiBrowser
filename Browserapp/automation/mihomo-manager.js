'use strict';

const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const YAML = require('yaml');
const AdmZip = require('adm-zip');

const RELEASE_API = 'https://api.github.com/repos/MetaCubeX/mihomo/releases/latest';
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;

function safeJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getUrlBuffer(url, { timeout = 60000, redirects = 4, headers = {} } = {}) {
  const target = new URL(String(url));
  if (target.protocol !== 'https:') throw new Error('Mihomo 下载地址必须使用 HTTPS');
  const https = require('https');
  return new Promise((resolve, reject) => {
    const request = https.get(target, {
      timeout,
      headers: {
        Accept: 'application/vnd.github+json, application/octet-stream',
        'User-Agent': 'AiBrowser/1.0.2',
        ...headers,
      },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error('Mihomo 下载重定向次数过多'));
        // new URL() and the HTTPS check throw synchronously inside this callback,
        // which would escape the promise instead of rejecting it.
        try {
          const next = new URL(String(response.headers.location), target).toString();
          return getUrlBuffer(next, { timeout, redirects: redirects - 1, headers }).then(resolve, reject);
        } catch (error) {
          return reject(error);
        }
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return reject(new Error('Mihomo 下载返回 HTTP ' + status));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) {
          request.destroy(new Error('Mihomo 下载文件超过大小限制'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      // A peer reset mid-body emits 'aborted'/'error' on the response, not the
      // request, so without these the promise never settles.
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Mihomo 下载连接中断')));
    });
    request.on('timeout', () => request.destroy(new Error('Mihomo 下载超时')));
    request.on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = Number(address && address.port);
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForPort(port, timeout = 12000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(800);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() - started >= timeout) {
          reject(new Error('Mihomo 本地代理端口启动超时'));
          return;
        }
        setTimeout(tryConnect, 150);
      };
      socket.once('error', retry);
      socket.once('timeout', retry);
    };
    tryConnect();
  });
}

class MihomoManager {
  constructor(options = {}) {
    this.dataDir = path.resolve(String(options.dataDir || '.'));
    this.toolDir = options.toolDir
      ? path.resolve(String(options.toolDir))
      : path.join(this.dataDir, 'tools', 'mihomo');
    this.runtimeDir = options.runtimeDir
      ? path.resolve(String(options.runtimeDir))
      : path.join(this.dataDir, 'mihomo-runtime');
    this.executable = path.join(this.toolDir, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
    this.process = null;
    this.signature = '';
    this.ports = new Map();
    this.logs = [];
    this.startPromise = null;
  }

  status() {
    return {
      installed: fs.existsSync(this.executable),
      running: Boolean(this.process && this.process.exitCode === null),
      executable: this.executable,
      nodes: this.ports.size,
    };
  }

  async ensureInstalled() {
    if (fs.existsSync(this.executable)) return this.status();
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error(`当前平台暂不支持自动安装 Mihomo：${process.platform}/${process.arch}`);
    }
    await fsp.mkdir(this.toolDir, { recursive: true });
    const releaseBuffer = await getUrlBuffer(RELEASE_API, {
      timeout: 30000,
      headers: { Accept: 'application/vnd.github+json' },
    });
    const release = JSON.parse(releaseBuffer.toString('utf8'));
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((item) => /^mihomo-windows-amd64-compatible-.*\.zip$/i.test(String(item.name || '')))
      || assets.find((item) => /^mihomo-windows-amd64-v[\d.]+\.zip$/i.test(String(item.name || '')));
    if (!asset?.browser_download_url) throw new Error('官方发布页中未找到 Windows x64 Mihomo 安装包');
    const archive = await getUrlBuffer(asset.browser_download_url, { timeout: 120000 });
    const digest = crypto.createHash('sha256').update(archive).digest('hex');
    if (asset.digest && String(asset.digest).toLowerCase() !== `sha256:${digest}`) {
      throw new Error('Mihomo 安装包 SHA-256 校验失败');
    }
    const zip = new AdmZip(archive);
    const entry = zip.getEntries().find((item) => !item.isDirectory && /(^|\/)mihomo[^/]*\.exe$/i.test(item.entryName));
    if (!entry) throw new Error('Mihomo 安装包内未找到可执行文件');
    if (Number(entry.header?.size || 0) > 100 * 1024 * 1024) throw new Error('Mihomo 可执行文件大小异常');
    const temporary = this.executable + '.tmp';
    await fsp.writeFile(temporary, entry.getData());
    await fsp.rm(this.executable, { force: true });
    await fsp.rename(temporary, this.executable);
    await fsp.writeFile(path.join(this.toolDir, 'version.json'), JSON.stringify({
      version: String(release.tag_name || ''),
      asset: String(asset.name || ''),
      sha256: digest,
      downloadedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    return this.status();
  }

  recordSignature(records, frontProxy = {}) {
    return crypto.createHash('sha256').update(JSON.stringify({
      records: records.map((item) => ({
        id: item.id,
        update_time: item.update_time,
        node: item.clashProxy,
      })),
      frontProxy: frontProxy.enabled ? {
        protocol: frontProxy.protocol,
        host: frontProxy.host,
        port: frontProxy.port,
        username: frontProxy.username || '',
        password: frontProxy.password || '',
      } : null,
    })).digest('hex');
  }

  async buildConfig(records, preferredPorts = new Map(), frontProxy = {}) {
    const ports = new Map();
    const nameMap = new Map();
    const frontProxyEnabled = Boolean(frontProxy.enabled);
    const frontProxyName = 'ob-front-proxy';
    for (const item of records) nameMap.set(String(item.clashProxy?.name || ''), `ob-${item.id}`);
    const proxies = records.map((item) => {
      const node = safeJson(item.clashProxy || {});
      const originalName = String(node.name || '');
      node.name = `ob-${item.id}`;
      if (node['dialer-proxy'] && nameMap.has(String(node['dialer-proxy']))) {
        node['dialer-proxy'] = nameMap.get(String(node['dialer-proxy']));
      }
      if (frontProxyEnabled) node['dialer-proxy'] = frontProxyName;
      if (!node.type || !node.server || !node.port) throw new Error('订阅节点配置不完整：' + (item.name || item.id));
      if (!originalName) throw new Error('订阅节点缺少名称：' + item.id);
      return node;
    });
    if (frontProxyEnabled) {
      const frontNode = {
        name: frontProxyName,
        type: frontProxy.protocol,
        server: frontProxy.host === 'localhost' ? '127.0.0.1' : frontProxy.host,
        port: Number(frontProxy.port),
      };
      if (frontProxy.username) frontNode.username = frontProxy.username;
      if (frontProxy.password) frontNode.password = frontProxy.password;
      proxies.unshift(frontNode);
    }
    const listeners = [];
    const usedPorts = new Set(frontProxyEnabled ? [Number(frontProxy.port)] : []);
    for (const item of records) {
      let port = Number(preferredPorts.get(item.id) || 0);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || usedPorts.has(port)) port = await freePort();
      usedPorts.add(port);
      ports.set(item.id, port);
      listeners.push({
        name: `listener-${item.id}`,
        type: 'mixed',
        port,
        listen: '127.0.0.1',
        proxy: `ob-${item.id}`,
      });
    }
    return {
      ports,
      config: {
        'allow-lan': false,
        mode: 'rule',
        'log-level': 'warning',
        ipv6: true,
        'unified-delay': true,
        proxies,
        listeners,
        rules: ['MATCH,DIRECT'],
      },
    };
  }

  captureLog(chunk) {
    const text = String(chunk || '').trim();
    if (!text) return;
    this.logs.push(text.slice(0, 1000));
    if (this.logs.length > 30) this.logs.splice(0, this.logs.length - 30);
  }

  async start(records = [], frontProxy = {}) {
    const usable = records.filter((item) => item?.clashProxy);
    if (!usable.length) throw new Error('没有可由 Mihomo 转换的订阅节点');
    const signature = this.recordSignature(usable, frontProxy);
    if (this.process && this.process.exitCode === null && signature === this.signature) return this.status();
    if (this.startPromise) {
      await this.startPromise;
      if (this.process && this.process.exitCode === null && signature === this.signature) return this.status();
    }
    this.startPromise = (async () => {
      await this.ensureInstalled();
      const previousPorts = new Map(this.ports);
      await this.stop();
      await fsp.mkdir(this.runtimeDir, { recursive: true });
      const { ports, config } = await this.buildConfig(usable, previousPorts, frontProxy);
      const configPath = path.join(this.runtimeDir, 'config.yaml');
      await fsp.writeFile(configPath, YAML.stringify(config), 'utf8');
      this.logs = [];
      const child = spawn(this.executable, ['-d', this.runtimeDir, '-f', configPath], {
        cwd: this.runtimeDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.process = child;
      this.ports = ports;
      this.signature = signature;
      child.stdout?.on('data', (chunk) => this.captureLog(chunk));
      child.stderr?.on('data', (chunk) => this.captureLog(chunk));
      // A ChildProcess 'error' with no listener is an uncaught exception that kills
      // the app — spawn fails with ENOENT/EACCES if the binary is missing or locked.
      child.once('error', (error) => {
        this.captureLog('mihomo spawn failed: ' + (error?.message || error));
        if (this.process === child) {
          this.process = null;
          this.signature = '';
          this.ports = new Map();
        }
      });
      child.once('exit', () => {
        if (this.process === child) {
          this.process = null;
          this.signature = '';
          this.ports = new Map();
        }
      });
      const firstPort = ports.values().next().value;
      try {
        await waitForPort(firstPort);
      } catch (error) {
        const detail = this.logs.slice(-3).join(' | ');
        await this.stop();
        throw new Error(error.message + (detail ? '：' + detail : ''));
      }
      return this.status();
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async resolve(item, records, frontProxy = {}) {
    await this.start(records, frontProxy);
    const port = this.ports.get(item.id);
    if (!port) throw new Error('订阅节点的本地端口未就绪');
    return {
      id: item.id,
      raw: `socks5://127.0.0.1:${port}`,
      protocol: 'socks5',
      host: '127.0.0.1',
      port,
      via: 'mihomo',
      frontProxy: frontProxy.enabled ? {
        enabled: true,
        protocol: frontProxy.protocol,
        host: frontProxy.host,
        port: frontProxy.port,
      } : { enabled: false },
    };
  }

  async stop() {
    const child = this.process;
    this.process = null;
    this.signature = '';
    this.ports = new Map();
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try { child.kill(); } catch (_) {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

module.exports = { MihomoManager };
