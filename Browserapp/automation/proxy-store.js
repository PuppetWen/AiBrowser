'use strict';

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const YAML = require('yaml');
const {
  parseProxy,
  displayProxy,
  fetchUrlText,
  startChainedProxy,
} = require('../proxy-forwarder');
const { MihomoManager } = require('./mihomo-manager');

const MAX_PROXIES = 5000;
const MAX_SUBSCRIPTION_PROXIES = 2000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function friendlySubscriptionError(error) {
  const message = text(error?.message || error, 500);
  const status = message.match(/^HTTP\s+(\d{3})/i)?.[1];
  if (status) return `订阅服务器返回 HTTP ${status}`;
  return text(message.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), 300) || '订阅更新失败';
}

function normalizeFrontProxy(input = {}, existing = null) {
  const enabledValue = input.enabled ?? existing?.enabled ?? false;
  const enabled = enabledValue === true || enabledValue === 1 || enabledValue === '1' || enabledValue === 'true';
  const protocol = text(input.protocol ?? existing?.protocol ?? 'socks5', 20).toLowerCase();
  const host = text(input.host ?? existing?.host ?? '127.0.0.1', 255).toLowerCase();
  const port = Number(input.port ?? existing?.port ?? 7890);
  if (!['http', 'socks5'].includes(protocol)) throw new Error('本机前置代理只支持 HTTP 或 SOCKS5');
  if (!LOOPBACK_HOSTS.has(host)) throw new Error('本机前置代理地址只允许 127.0.0.1、localhost 或 ::1');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本机前置代理端口必须是 1-65535');
  return { enabled, protocol, host, port };
}

function testTcpEndpoint(host, port, timeout = 3000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve({ host, port, latencyMs: Math.max(1, Date.now() - startedAt) });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish());
    socket.once('timeout', () => finish(new Error(`连接本机代理超时：${host}:${port}`)));
    socket.once('error', (error) => {
      const message = error?.code === 'ECONNREFUSED'
        ? `本机代理未监听：${host}:${port}`
        : `无法连接本机代理：${host}:${port}（${error?.code || error?.message || 'unknown'}）`;
      finish(new Error(message));
    });
  });
}

function decodeUriPart(value) {
  try { return decodeURIComponent(String(value || '')); } catch (_) { return String(value || ''); }
}

function booleanParam(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeCertificateFingerprint(value) {
  const raw = text(value, 500);
  if (!raw) return '';
  try {
    const compact = raw.replace(/\s+/g, '');
    if (/^[A-Za-z0-9+/]{43}=$/.test(compact)) {
      const bytes = Buffer.from(compact, 'base64');
      if (bytes.length === 32) {
        return bytes.toString('hex').toUpperCase().match(/../g).join(':');
      }
    }
  } catch (_) { /* keep the original value */ }
  return raw;
}

function parseProxyShareLink(value) {
  const raw = String(value || '').trim();
  let parsed;
  try { parsed = new URL(raw); } catch (_) { throw new Error('代理链接格式无效'); }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!['vless', 'hysteria2', 'hy2'].includes(protocol)) {
    throw new Error('当前链接不是 VLESS 或 Hysteria2');
  }
  const host = parsed.hostname;
  const port = Number(parsed.port || 443);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('代理链接缺少有效的主机或端口');
  }
  const params = parsed.searchParams;
  const fragment = decodeUriPart(parsed.hash.replace(/^#/, '')).trim();
  const type = protocol === 'vless' ? 'vless' : 'hysteria2';
  const name = fragment || `${type.toUpperCase()} ${host}:${port}`;

  if (type === 'vless') {
    const uuid = decodeUriPart(parsed.username);
    if (!uuid) throw new Error('VLESS 链接缺少 UUID');
    const security = String(params.get('security') || '').toLowerCase();
    const network = String(params.get('type') || params.get('network') || 'tcp').toLowerCase();
    const encryption = String(params.get('encryption') || '');
    const node = {
      name,
      type: 'vless',
      server: host,
      port,
      uuid,
      udp: true,
      network,
      encryption: encryption === 'none' ? '' : encryption,
    };
    const flow = params.get('flow');
    const servername = params.get('sni') || params.get('servername');
    const fingerprint = params.get('fp') || params.get('client-fingerprint');
    const publicKey = params.get('pbk') || params.get('public-key');
    const shortId = params.get('sid') || params.get('short-id');
    const packetEncoding = params.get('packetEncoding') || params.get('packet-encoding');
    const alpn = String(params.get('alpn') || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (flow) node.flow = flow;
    if (security === 'tls' || security === 'reality' || publicKey) node.tls = true;
    if (servername) node.servername = servername;
    if (fingerprint) node['client-fingerprint'] = fingerprint;
    if (publicKey) {
      node['reality-opts'] = { 'public-key': publicKey };
      if (shortId) node['reality-opts']['short-id'] = shortId;
    }
    if (packetEncoding) node['packet-encoding'] = packetEncoding;
    if (alpn.length) node.alpn = alpn;
    if (booleanParam(params.get('allowInsecure') || params.get('insecure'))) node['skip-cert-verify'] = true;
    if (network === 'ws') {
      const wsPath = params.get('path');
      const wsHost = params.get('host');
      node['ws-opts'] = {};
      if (wsPath) node['ws-opts'].path = wsPath;
      if (wsHost) node['ws-opts'].headers = { Host: wsHost };
    } else if (network === 'grpc') {
      const serviceName = params.get('serviceName') || params.get('service-name');
      if (serviceName) node['grpc-opts'] = { 'grpc-service-name': serviceName };
    }
    return {
      kind: 'mihomo',
      raw,
      name,
      protocol: 'vless',
      host,
      port,
      username: uuid,
      password: '',
      clashProxy: node,
      requiresMihomo: true,
    };
  }

  const username = decodeUriPart(parsed.username);
  const uriPassword = decodeUriPart(parsed.password);
  const auth = uriPassword ? `${username}:${uriPassword}` : username;
  if (!auth) throw new Error('Hysteria2 链接缺少认证密码');
  const node = {
    name,
    type: 'hysteria2',
    server: host,
    port,
    password: auth,
  };
  const sni = params.get('sni');
  const obfs = params.get('obfs');
  const obfsPassword = params.get('obfs-password');
  const fingerprint = normalizeCertificateFingerprint(params.get('pinSHA256') || params.get('fingerprint'));
  if (sni) node.sni = sni;
  if (booleanParam(params.get('insecure'))) node['skip-cert-verify'] = true;
  if (fingerprint) node.fingerprint = fingerprint;
  if (obfs) node.obfs = obfs;
  if (obfsPassword) node['obfs-password'] = obfsPassword;
  if (booleanParam(params.get('fastopen'))) node.tfo = true;
  return {
    kind: 'mihomo',
    raw,
    name,
    protocol: 'hysteria2',
    host,
    port,
    username: '',
    password: auth,
    clashProxy: node,
    requiresMihomo: true,
  };
}

function parseProxyInput(value) {
  const raw = String(value || '').trim();
  if (/^(?:vless|hysteria2|hy2):\/\//i.test(raw)) return parseProxyShareLink(raw);
  const parsed = parseProxy(raw);
  if (!parsed) throw new Error('请填写代理地址');
  return {
    kind: 'native',
    raw,
    name: `${parsed.protocol.toUpperCase()} ${parsed.host}:${parsed.port}`,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username || '',
    password: parsed.password || '',
    clashProxy: null,
    requiresMihomo: false,
  };
}

function sourceKey(subscriptionId, node, occurrence = 0) {
  const parts = [
    subscriptionId,
    text(node?.name, 300),
    text(node?.type, 80).toLowerCase(),
  ];
  if (occurrence > 0) parts.push(`duplicate-${occurrence}`);
  const identity = parts.join('\n');
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

function normalizeGroup(input = {}, existing = null) {
  const now = new Date().toISOString();
  const name = text(input.name || existing?.name || '未命名分组', 80);
  if (!name) throw new Error('分组名称不能为空');
  return {
    id: existing?.id || text(input.id, 80) || `proxy-group-${uid()}`,
    name,
    collapsed: input.collapsed == null ? Boolean(existing?.collapsed) : Boolean(input.collapsed),
    subscriptionId: text(input.subscriptionId || existing?.subscriptionId, 80),
    create_time: existing?.create_time || now,
    update_time: now,
  };
}

function normalizeProxyRecord(input = {}, existing = null) {
  const name = text(input.name || existing?.name, 120);
  const remark = text(input.remark ?? existing?.remark, 500);
  const protocol = text(input.protocol || input.type || existing?.protocol || 'socks5', 40).toLowerCase();
  const host = text(input.host || existing?.host, 300);
  const port = Number(input.port ?? existing?.port);
  const username = String(input.username ?? input.user ?? existing?.username ?? '');
  const password = String(input.password ?? existing?.password ?? '');
  const refreshUrl = text(input.refreshUrl || input.refresh_url || existing?.refreshUrl, 1000);
  const ipChannel = ['ip-api', 'ip2location'].includes(String(input.ipChannel || existing?.ipChannel || ''))
    ? String(input.ipChannel || existing?.ipChannel)
    : 'ip-api';

  let raw = String(input.raw || input.proxy || '').trim();
  if (!raw) {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('主机和端口必填');
    }
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    raw = `${protocol}://${auth}${host}:${port}`;
  }

  const parsed = parseProxy(raw);
  if (!parsed) throw new Error('当前记录是直连，请填写代理地址');

  const now = new Date().toISOString();
  return {
    id: existing?.id || text(input.id, 100) || uid(),
    name: name || `${parsed.protocol.toUpperCase()} ${parsed.host}:${parsed.port}`,
    protocol: parsed.protocol,
    host: parsed.host,
    port: parsed.port,
    username: parsed.username || '',
    password: parsed.password || '',
    raw: parsed.raw,
    chromeUrl: parsed.chromeUrl,
    authenticated: parsed.authenticated,
    refreshUrl,
    ipChannel,
    remark,
    groupId: text(input.groupId ?? existing?.groupId, 80),
    sourceType: text(input.sourceType ?? existing?.sourceType, 40) || 'manual',
    subscriptionId: text(input.subscriptionId ?? existing?.subscriptionId, 80),
    sourceKey: text(input.sourceKey ?? existing?.sourceKey, 80),
    clashProxy: input.clashProxy ?? existing?.clashProxy ?? null,
    requiresMihomo: Boolean(input.requiresMihomo ?? existing?.requiresMihomo),
    lastCheck: existing?.lastCheck || null,
    lastIp: existing?.lastIp || '',
    lastCountryCode: existing?.lastCountryCode || '',
    lastLatencyMs: existing?.lastLatencyMs ?? null,
    lastNetworkType: existing?.lastNetworkType || '',
    lastErrorClass: existing?.lastErrorClass || '',
    lastCheckOk: existing?.lastCheckOk ?? null,
    create_time: existing?.create_time || now,
    update_time: now,
  };
}

function nativeClashProxy(node) {
  const type = text(node.type, 40).toLowerCase();
  if (!['http', 'socks5', 'socks4'].includes(type)) return null;
  const host = text(node.server, 300);
  const port = Number(node.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const protocol = type === 'http' && node.tls === true ? 'https' : type;
  const username = String(node.username ?? '');
  const password = String(node.password ?? '');
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  return {
    protocol,
    host,
    port,
    username,
    password,
    raw: `${protocol}://${auth}${host}:${port}`,
  };
}

function nativeRecordToClashProxy(item) {
  const protocol = text(item?.protocol, 40).toLowerCase();
  if (!['http', 'https', 'socks5'].includes(protocol)) return null;
  const host = text(item?.host, 300);
  const port = Number(item?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const node = {
    name: text(item?.name, 300) || `${protocol.toUpperCase()} ${host}:${port}`,
    type: protocol === 'socks5' ? 'socks5' : 'http',
    server: host,
    port,
  };
  const username = String(item?.username || '');
  const password = String(item?.password || '');
  if (username) {
    node.username = username;
    node.password = password;
  }
  if (protocol === 'https') node.tls = true;
  if (protocol === 'socks5') node.udp = true;
  return node;
}

function asMihomoRecord(item) {
  if (!item) return null;
  const clashProxy = item.clashProxy
    ? JSON.parse(JSON.stringify(item.clashProxy))
    : nativeRecordToClashProxy(item);
  if (!clashProxy) return null;
  return {
    ...item,
    clashProxy,
    requiresMihomo: true,
  };
}

function normalizeClashRecord(node, context, existing = null) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('订阅节点格式无效');
  const nodeName = text(node.name, 300);
  const type = text(node.type, 40).toLowerCase();
  const host = text(node.server, 300);
  const port = Number(node.port);
  if (!nodeName || !type || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('订阅节点缺少 name/type/server/port');
  }
  const key = context.sourceKey || sourceKey(context.subscriptionId, node);
  const native = nativeClashProxy(node);
  if (native) {
    return normalizeProxyRecord({
      id: existing?.id,
      name: nodeName,
      ...native,
      groupId: context.groupId,
      sourceType: 'subscription',
      subscriptionId: context.subscriptionId,
      sourceKey: key,
      clashProxy: node,
      requiresMihomo: false,
      remark: `Clash 订阅 · ${type.toUpperCase()}`,
    }, existing);
  }
  const now = new Date().toISOString();
  return {
    id: existing?.id || uid(),
    name: nodeName,
    protocol: type,
    host,
    port,
    username: '',
    password: '',
    raw: '',
    chromeUrl: '',
    authenticated: false,
    refreshUrl: '',
    ipChannel: existing?.ipChannel || 'ip-api',
    remark: `Clash 订阅 · 通过 Mihomo 转换`,
    groupId: context.groupId,
    sourceType: 'clash',
    subscriptionId: context.subscriptionId,
    sourceKey: key,
    clashProxy: JSON.parse(JSON.stringify(node)),
    requiresMihomo: true,
    lastCheck: existing?.lastCheck || null,
    lastIp: existing?.lastIp || '',
    lastCountryCode: existing?.lastCountryCode || '',
    lastLatencyMs: existing?.lastLatencyMs ?? null,
    lastNetworkType: existing?.lastNetworkType || '',
    lastErrorClass: existing?.lastErrorClass || '',
    lastCheckOk: existing?.lastCheckOk ?? null,
    create_time: existing?.create_time || now,
    update_time: now,
  };
}

function normalizeManualClashRecord(input = {}, existing = null) {
  const parsed = parseProxyShareLink(input.raw || input.shareLink || existing?.shareLink);
  const requestedName = text(input.name || existing?.name || parsed.name, 120) || parsed.name;
  const clashProxy = { ...parsed.clashProxy, name: requestedName };
  const record = normalizeClashRecord(clashProxy, {
    subscriptionId: '',
    groupId: text(input.groupId ?? existing?.groupId, 80),
    sourceKey: '',
  }, existing);
  record.name = requestedName;
  record.sourceType = 'manual-clash';
  record.subscriptionId = '';
  record.sourceKey = '';
  record.shareLink = parsed.raw;
  record.username = parsed.username;
  record.password = parsed.password;
  record.authenticated = Boolean(parsed.username || parsed.password);
  record.ipChannel = ['ip-api', 'ip2location'].includes(String(input.ipChannel || existing?.ipChannel || ''))
    ? String(input.ipChannel || existing?.ipChannel)
    : 'ip-api';
  record.remark = text(input.remark ?? existing?.remark, 500) || '手动导入 · 通过 Mihomo 转换';
  record.clashProxy = clashProxy;
  return record;
}

function publicItem(item, groups) {
  const group = groups.find((value) => value.id === item.groupId);
  const copy = { ...item, groupName: group?.name || '未分组' };
  delete copy.clashProxy;
  return copy;
}

class ProxyStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    const dataDir = options.dataDir || path.dirname(filePath);
    this.dataDir = path.resolve(String(dataDir));
    this.mihomo = options.mihomo || new MihomoManager({ dataDir });
    this.scopedMihomo = new Map();
    this.frontBridges = new Map();
    this.data = {
      version: 4,
      items: [],
      groups: [],
      subscriptions: [],
      frontProxy: normalizeFrontProxy(),
    };
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      let frontProxy;
      let frontProxyReset = false;
      try {
        frontProxy = normalizeFrontProxy(parsed.frontProxy || {});
      } catch (_) {
        frontProxy = normalizeFrontProxy();
        frontProxyReset = true;
      }
      if (Number(parsed.version || 1) < 4 && !frontProxy.enabled && frontProxy.protocol === 'http') {
        frontProxy.protocol = 'socks5';
      }
      this.data = {
        version: 4,
        items: Array.isArray(parsed.items) ? parsed.items : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        frontProxy,
      };
      let changed = Number(parsed.version || 1) < 4 || frontProxyReset;
      for (const item of this.data.items) {
        if (item.groupId == null) { item.groupId = ''; changed = true; }
        if (!item.sourceType) { item.sourceType = 'manual'; changed = true; }
      }
      if (changed) await this.save();
    } catch (error) {
      // Never silently overwrite an unreadable library — keep a copy so a corrupt
      // or interrupted write can be recovered instead of resetting to empty.
      if (error?.code !== 'ENOENT') {
        await fsp.rename(this.filePath, `${this.filePath}.corrupt`).catch(() => {});
      }
      await this.save();
    }
    return this.data;
  }

  async save() {
    // Serialized: every mutator calls save(), and concurrent writers sharing one
    // temp path interleave their content and then fail the rename.
    this.saving = Promise.resolve(this.saving).catch(() => {}).then(async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const payload = JSON.stringify(this.data, null, 2);
      try {
        await fsp.writeFile(temporary, payload, 'utf8');
        // rename replaces atomically; removing the target first would leave a
        // window with no file at all.
        await fsp.rename(temporary, this.filePath);
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    return this.saving;
  }

  list(filter = {}) {
    let items = [...this.data.items];
    const q = text(filter.q || filter.keyword, 300).toLowerCase();
    if (q) {
      items = items.filter((item) => {
        const group = this.data.groups.find((value) => value.id === item.groupId);
        return [item.name, item.host, item.protocol, item.remark, item.lastIp, group?.name, String(item.port)]
          .join(' ').toLowerCase().includes(q);
      });
    }
    if (filter.protocol) items = items.filter((item) => item.protocol === text(filter.protocol, 40).toLowerCase());
    if (filter.groupId) items = items.filter((item) => item.groupId === String(filter.groupId));
    return items
      .sort((a, b) => String(b.update_time || '').localeCompare(String(a.update_time || '')))
      .map((item) => publicItem(item, this.data.groups));
  }

  state(filter = {}) {
    return {
      items: this.list(filter),
      groups: [...this.data.groups].sort((a, b) => String(a.create_time || '').localeCompare(String(b.create_time || ''))),
      subscriptions: this.data.subscriptions.map((item) => ({ ...item })),
      frontProxy: { ...this.data.frontProxy },
      mihomo: this.mihomo.status(),
    };
  }

  async updateFrontProxy(input = {}) {
    const next = normalizeFrontProxy(input, this.data.frontProxy);
    this.data.frontProxy = next;
    await this.save();
    await this.stopFrontBridges();
    await this.mihomo.stop();
    return { ...next };
  }

  async testFrontProxy(input = {}) {
    const config = normalizeFrontProxy(input, this.data.frontProxy);
    const result = await testTcpEndpoint(config.host, config.port);
    return { ...result, protocol: config.protocol };
  }

  usesFrontProxy() {
    return Boolean(this.data.frontProxy?.enabled);
  }

  async stopFrontBridges() {
    const bridges = [...this.frontBridges.values()];
    this.frontBridges.clear();
    await Promise.all(bridges.map((entry) => entry.bridge.close().catch(() => {})));
  }

  async resolveSocksThroughFront(item, frontProxy, key = item.id) {
    const target = parseProxy(item.raw);
    if (!target || !['http', 'https', 'socks5'].includes(target.protocol)) {
      throw new Error('前置代理链式桥接仅支持 HTTP、HTTPS 或 SOCKS5 目标代理');
    }
    const front = parseProxy(frontProxy.raw || `${frontProxy.protocol}://${frontProxy.host}:${frontProxy.port}`);
    if (String(target.host).toLowerCase() === String(front.host).toLowerCase()
      && Number(target.port) === Number(front.port)) {
      throw new Error('自定义代理与系统前置代理地址相同，会形成代理循环');
    }
    const signature = crypto.createHash('sha256').update(JSON.stringify({
      target: target.raw,
      front: front.raw,
    })).digest('hex');
    const current = this.frontBridges.get(key);
    if (current?.signature === signature) {
      return {
        id: item.id,
        raw: current.bridge.url,
        protocol: current.bridge.protocol,
        host: '127.0.0.1',
        port: current.bridge.port,
        via: 'front-bridge',
        frontProxy: { ...frontProxy },
      };
    }
    if (current) {
      this.frontBridges.delete(key);
      await current.bridge.close().catch(() => {});
    }
    const bridge = await startChainedProxy(target, front);
    this.frontBridges.set(key, { signature, bridge });
    return {
      id: item.id,
      raw: bridge.url,
      protocol: bridge.protocol,
      host: '127.0.0.1',
      port: bridge.port,
      via: 'front-bridge',
      frontProxy: { ...frontProxy },
    };
  }

  frontProxyForResolve(input = null) {
    if (!input?.enabled) return { enabled: false, protocol: 'socks5', host: '127.0.0.1', port: 7890 };
    const parsed = parseProxy(input.raw || `${input.protocol || 'socks5'}://${input.host}:${input.port}`);
    if (!parsed || !['http', 'socks5'].includes(parsed.protocol)) {
      throw new Error('系统前置代理仅支持 HTTP 或 SOCKS5 固定端点');
    }
    return {
      enabled: true,
      protocol: parsed.protocol,
      host: parsed.host,
      port: parsed.port,
      username: parsed.username || '',
      password: parsed.password || '',
      raw: parsed.raw,
      source: String(input.source || 'system'),
    };
  }

  mihomoForScope(scopeKey = '') {
    const key = String(scopeKey || '').trim();
    if (!key) return this.mihomo;
    if (this.scopedMihomo.has(key)) return this.scopedMihomo.get(key);
    const directory = crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
    const manager = new MihomoManager({
      dataDir: this.dataDir,
      toolDir: this.mihomo.toolDir,
      runtimeDir: path.join(this.dataDir, 'mihomo-runtime-profiles', directory),
    });
    this.scopedMihomo.set(key, manager);
    return manager;
  }

  async releaseScope(scopeKey = '') {
    const key = String(scopeKey || '').trim();
    if (!key) return;
    const manager = this.scopedMihomo.get(key);
    this.scopedMihomo.delete(key);
    await manager?.stop().catch(() => {});
    const bridgeKeys = [...this.frontBridges.keys()].filter((value) => String(value).startsWith(`${key}:`));
    for (const bridgeKey of bridgeKeys) {
      const current = this.frontBridges.get(bridgeKey);
      this.frontBridges.delete(bridgeKey);
      await current?.bridge?.close().catch(() => {});
    }
  }

  parseInput(value) {
    const parsed = parseProxyInput(value);
    return {
      ...parsed,
      clashProxy: parsed.clashProxy ? JSON.parse(JSON.stringify(parsed.clashProxy)) : null,
    };
  }

  get(id) {
    return this.data.items.find((item) => item.id === id) || null;
  }

  getSubscription(id) {
    return this.data.subscriptions.find((item) => item.id === id) || null;
  }

  async create(input) {
    const raw = String(input?.raw || input?.shareLink || '').trim();
    const record = /^(?:vless|hysteria2|hy2):\/\//i.test(raw)
      ? normalizeManualClashRecord(input)
      : normalizeProxyRecord(input);
    if (this.data.items.length >= MAX_PROXIES) throw new Error(`代理数量已达上限 ${MAX_PROXIES}`);
    this.data.items.unshift(record);
    await this.save();
    return publicItem(record, this.data.groups);
  }

  async createMany(list = []) {
    if (!Array.isArray(list) || !list.length) throw new Error('请提供代理数组');
    if (list.length > 500) throw new Error('单次最多导入 500 条');
    if (this.data.items.length + list.length > MAX_PROXIES) throw new Error(`代理数量已达上限 ${MAX_PROXIES}`);
    const created = list.map((item) => normalizeProxyRecord(item));
    this.data.items.unshift(...created);
    await this.save();
    return created.map((item) => publicItem(item, this.data.groups));
  }

  async update(id, input) {
    const existing = this.get(id);
    if (!existing) throw new Error('代理不存在: ' + id);
    if (existing.sourceType === 'clash') throw new Error('Clash 订阅节点请通过重新订阅更新');
    const raw = String(input?.raw || input?.shareLink || existing?.shareLink || '').trim();
    const next = existing.sourceType === 'manual-clash' || /^(?:vless|hysteria2|hy2):\/\//i.test(raw)
      ? normalizeManualClashRecord({ ...input, id, raw }, existing)
      : normalizeProxyRecord({ ...input, id }, existing);
    const index = this.data.items.findIndex((item) => item.id === id);
    this.data.items[index] = next;
    await this.save();
    return publicItem(next, this.data.groups);
  }

  async remove(ids) {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    const before = this.data.items.length;
    this.data.items = this.data.items.filter((item) => !set.has(item.id));
    for (const id of set) {
      const keys = [...this.frontBridges.keys()].filter((key) => key === id || String(key).endsWith(`:${id}`));
      for (const key of keys) {
        const current = this.frontBridges.get(key);
        this.frontBridges.delete(key);
        await current?.bridge?.close().catch(() => {});
      }
    }
    await this.save();
    return { deleted: before - this.data.items.length, ids: [...set] };
  }

  async updateGroup(input = {}) {
    const id = text(input.id, 80);
    const existing = this.data.groups.find((item) => item.id === id) || null;
    if (id && !existing) throw new Error('代理分组不存在');
    const group = normalizeGroup(input, existing);
    if (existing) this.data.groups[this.data.groups.indexOf(existing)] = group;
    else this.data.groups.push(group);
    const subscription = this.data.subscriptions.find((item) => item.groupId === group.id);
    if (subscription) {
      subscription.name = group.name;
      subscription.update_time = group.update_time;
    }
    await this.save();
    return group;
  }

  async upsertSubscription(input = {}) {
    const url = text(input.url, 2000);
    if (!url) throw new Error('请输入订阅地址');
    let parsedUrl;
    try { parsedUrl = new URL(url); } catch (_) { throw new Error('订阅地址无效'); }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('订阅地址只支持 HTTP/HTTPS');

    const requestedId = text(input.id, 80);
    let subscription = this.getSubscription(requestedId)
      || this.data.subscriptions.find((item) => item.url === url)
      || null;
    const now = new Date().toISOString();
    if (!subscription) {
      subscription = {
        id: `proxy-sub-${uid()}`,
        name: text(input.groupName || input.name, 80) || '订阅代理',
        url,
        groupId: '',
        create_time: now,
        update_time: now,
        lastSyncAt: null,
        lastError: '',
        proxyCount: 0,
      };
      this.data.subscriptions.push(subscription);
    }
    subscription.url = url;
    subscription.name = text(input.groupName || input.name || subscription.name, 80) || '订阅代理';
    subscription.update_time = now;
    let group = this.data.groups.find((item) => item.id === subscription.groupId) || null;
    group = normalizeGroup({
      id: group?.id,
      name: subscription.name,
      subscriptionId: subscription.id,
      collapsed: group?.collapsed,
    }, group);
    const oldIndex = this.data.groups.findIndex((item) => item.id === group.id);
    if (oldIndex >= 0) this.data.groups[oldIndex] = group;
    else this.data.groups.push(group);
    subscription.groupId = group.id;
    await this.save();

    try {
      const response = await fetchUrlText(url, {
        timeout: 45000,
        maxRedirects: 5,
        headers: {
          Accept: 'application/octet-stream, text/yaml, application/yaml, */*',
          'User-Agent': 'clash-verge/v2.4.3',
        },
      });
      const document = YAML.parse(response.body, {
        maxAliasCount: 50,
        prettyErrors: true,
        uniqueKeys: true,
      });
      const nodes = Array.isArray(document?.proxies) ? document.proxies : [];
      if (!nodes.length) throw new Error('配置中没有找到 proxies 节点');
      if (nodes.length > MAX_SUBSCRIPTION_PROXIES) {
        throw new Error(`单个订阅最多支持 ${MAX_SUBSCRIPTION_PROXIES} 个节点`);
      }
      const currentByKey = new Map(
        this.data.items
          .filter((item) => item.subscriptionId === subscription.id && item.sourceKey)
          .map((item) => [item.sourceKey, item]),
      );
      const context = { subscriptionId: subscription.id, groupId: group.id };
      const imported = [];
      const errors = [];
      const occurrences = new Map();
      for (const node of nodes) {
        try {
          const identity = `${text(node?.name, 300)}\n${text(node?.type, 80).toLowerCase()}`;
          const occurrence = Number(occurrences.get(identity) || 0);
          occurrences.set(identity, occurrence + 1);
          const key = sourceKey(subscription.id, node, occurrence);
          imported.push(normalizeClashRecord(node, { ...context, sourceKey: key }, currentByKey.get(key) || null));
        } catch (error) {
          errors.push(error.message || String(error));
        }
      }
      if (!imported.length) throw new Error(errors[0] || '订阅中没有可用节点');
      const otherItems = this.data.items.filter((item) => item.subscriptionId !== subscription.id);
      if (otherItems.length + imported.length > MAX_PROXIES) throw new Error(`代理数量已达上限 ${MAX_PROXIES}`);
      this.data.items = [...imported, ...otherItems];
      subscription.lastSyncAt = new Date().toISOString();
      subscription.lastError = errors.length ? `${errors.length} 个节点格式无效` : '';
      subscription.proxyCount = imported.length;
      subscription.update_time = subscription.lastSyncAt;
      await this.save();
      return {
        subscription: { ...subscription },
        group: { ...group },
        imported: imported.length,
        skipped: errors.length,
        protocols: imported.reduce((result, item) => {
          result[item.protocol] = Number(result[item.protocol] || 0) + 1;
          return result;
        }, {}),
        mihomo: this.mihomo.status(),
      };
    } catch (error) {
      const message = friendlySubscriptionError(error);
      subscription.lastError = message;
      subscription.update_time = new Date().toISOString();
      await this.save();
      throw new Error(message);
    }
  }

  async syncSubscription(id) {
    const subscription = this.getSubscription(String(id || ''));
    if (!subscription) throw new Error('订阅不存在');
    return this.upsertSubscription({
      id: subscription.id,
      url: subscription.url,
      groupName: subscription.name,
    });
  }

  async resolveForUse(id, options = {}) {
    const item = this.get(String(id || ''));
    if (!item) throw new Error('代理不存在');
    const frontProxy = this.frontProxyForResolve(options.frontProxy);
    const useFrontProxy = Boolean(frontProxy.enabled);
    if (!item.requiresMihomo && !useFrontProxy) {
      if (!item.raw) throw new Error('代理地址为空');
      const parsed = parseProxy(item.raw);
      return {
        id: item.id,
        raw: item.raw,
        protocol: parsed.protocol,
        host: parsed.host,
        port: parsed.port,
        via: 'native',
      };
    }
    if (useFrontProxy && !item.requiresMihomo && ['http', 'https', 'socks5'].includes(item.protocol)) {
      const scope = String(options.scopeKey || '').trim();
      return this.resolveSocksThroughFront(item, frontProxy, scope ? `${scope}:${item.id}` : item.id);
    }
    const records = useFrontProxy
      ? this.data.items.map(asMihomoRecord).filter(Boolean)
      : this.data.items
        .filter((value) => value.clashProxy && ['clash', 'manual-clash'].includes(value.sourceType))
        .map(asMihomoRecord)
        .filter(Boolean);
    const resolvedItem = records.find((value) => value.id === item.id);
    if (!resolvedItem) {
      throw new Error(useFrontProxy
        ? `当前代理协议 ${String(item.protocol || '').toUpperCase()} 暂不支持前置代理`
        : '代理节点无法转换为 Mihomo 配置');
    }
    return this.mihomoForScope(options.scopeKey).resolve(
      resolvedItem,
      records,
      useFrontProxy ? frontProxy : { ...frontProxy, enabled: false },
    );
  }

  async resolveDraft(input = {}, options = {}) {
    const raw = String(input?.raw || input?.shareLink || '').trim();
    const baseItem = /^(?:vless|hysteria2|hy2):\/\//i.test(raw)
      ? normalizeManualClashRecord({ ...input, id: `proxy-preview-${uid()}` })
      : normalizeProxyRecord({ ...input, id: `proxy-preview-${uid()}`, raw });
    const frontProxy = this.frontProxyForResolve(options.frontProxy);
    const useFrontProxy = Boolean(frontProxy.enabled);
    if (useFrontProxy && !baseItem.requiresMihomo && ['http', 'https', 'socks5'].includes(baseItem.protocol)) {
      const scope = String(options.scopeKey || 'proxy-preview');
      return this.resolveSocksThroughFront(baseItem, frontProxy, `${scope}:proxy-preview`);
    }
    const item = asMihomoRecord(baseItem);
    if (!item) throw new Error(`当前代理协议 ${String(baseItem.protocol || '').toUpperCase()} 暂不支持前置代理`);
    const storedRecords = useFrontProxy
      ? this.data.items.map(asMihomoRecord).filter(Boolean)
      : this.data.items
        .filter((value) => value.clashProxy && ['clash', 'manual-clash'].includes(value.sourceType))
        .map(asMihomoRecord)
        .filter(Boolean);
    const records = [
      item,
      ...storedRecords.filter((value) => value.id !== item.id),
    ];
    return this.mihomoForScope(options.scopeKey).resolve(
      item,
      records,
      useFrontProxy ? frontProxy : { ...frontProxy, enabled: false },
    );
  }

  async markCheck(id, result = {}) {
    const item = this.get(id);
    if (!item) throw new Error('代理不存在: ' + id);
    item.lastCheck = new Date().toISOString();
    item.lastIp = String(result.ip || '');
    item.lastCountryCode = String(result.countryCode || result.country_code || '');
    item.lastLatencyMs = Number.isFinite(Number(result.latencyMs)) ? Number(result.latencyMs) : null;
    item.lastNetworkType = String(result.networkType || '');
    item.lastErrorClass = result.errorClass ? String(result.errorClass) : '';
    item.lastCheckOk = !result.errorClass && Boolean(result.ip);
    item.update_time = item.lastCheck;
    await this.save();
    return publicItem(item, this.data.groups);
  }

  async markCheckError(id, error = {}) {
    const item = this.get(id);
    if (!item) throw new Error('代理不存在: ' + id);
    item.lastCheck = new Date().toISOString();
    item.lastLatencyMs = Number.isFinite(Number(error.latencyMs)) ? Number(error.latencyMs) : null;
    item.lastErrorClass = String(error.errorClass || error.code || 'unknown');
    item.lastCheckOk = false;
    item.update_time = item.lastCheck;
    await this.save();
    return publicItem(item, this.data.groups);
  }

  async markCheckMany(entries = []) {
    const updated = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const item = this.get(String(entry?.id || ''));
      if (!item) continue;
      item.lastCheck = new Date().toISOString();
      if (entry.ok) {
        const result = entry.result || {};
        item.lastIp = String(result.ip || '');
        item.lastCountryCode = String(result.countryCode || result.country_code || '');
        item.lastLatencyMs = Number.isFinite(Number(result.latencyMs)) ? Number(result.latencyMs) : null;
        item.lastNetworkType = String(result.networkType || '');
        item.lastErrorClass = result.errorClass ? String(result.errorClass) : '';
        item.lastCheckOk = !result.errorClass && Boolean(result.ip);
      } else {
        const error = entry.error || {};
        item.lastLatencyMs = Number.isFinite(Number(error.latencyMs)) ? Number(error.latencyMs) : null;
        item.lastErrorClass = String(error.errorClass || error.code || 'unknown');
        item.lastCheckOk = false;
      }
      item.update_time = item.lastCheck;
      updated.push(item);
    }
    if (updated.length) await this.save();
    return updated.map((item) => publicItem(item, this.data.groups));
  }

  toChromeString(id) {
    const item = this.get(id);
    if (!item || item.requiresMihomo) return null;
    return item.raw;
  }

  display(item) {
    if (item?.requiresMihomo) return `${String(item.protocol || '').toUpperCase()} · ${item.host}:${item.port} · Mihomo`;
    return displayProxy(item.raw);
  }

  async stop() {
    await this.stopFrontBridges();
    await Promise.all([...this.scopedMihomo.values()].map((manager) => manager.stop().catch(() => {})));
    this.scopedMihomo.clear();
    await this.mihomo.stop();
  }
}

module.exports = {
  ProxyStore,
  normalizeProxyRecord,
  normalizeClashRecord,
  normalizeManualClashRecord,
  normalizeFrontProxy,
  parseProxyInput,
  parseProxyShareLink,
  nativeRecordToClashProxy,
  asMihomoRecord,
  nativeClashProxy,
};
