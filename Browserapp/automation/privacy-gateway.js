'use strict';

const http = require('http');
const net = require('net');
const { startAuthenticatedProxy, startChainedProxy } = require('../proxy-forwarder');

// One immutable upstream per environment. The outer listener never connects to
// a requested destination: it can only reach its private, fixed proxy bridge.
// Locked until fingerprint setup completes. Failures latch closed until restart.
async function startPrivacyGateway(config, { frontConfig = null, onBlocked = () => {} } = {}) {
  if (!config || !['http', 'https', 'socks5'].includes(config.protocol)) throw new Error('严格隐私模式仅支持 HTTP、HTTPS 或 SOCKS5 固定代理');
  let state = 'locked';
  let failure = '';
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); return socket; };
  const block = (reason = '隐私保护已断开网络') => {
    if (state === 'closed' || state === 'blocked') return;
    state = 'blocked'; failure = String(reason);
    for (const socket of sockets) socket.destroy();
    try { onBlocked(failure); } catch (_) {}
  };
  const onStatus = value => { if (/FAILED|ERROR/.test(value.code || '')) block('上游代理不可用：' + value.code); };
  const bridge = frontConfig
    ? await startChainedProxy(config, frontConfig, onStatus)
    : await startAuthenticatedProxy(config, onStatus);
  if (bridge.protocol !== 'http') { await bridge.close(); throw new Error('严格隐私网关需要 HTTP 转发桥'); }
  const unavailable = res => { res.writeHead(503, { Connection: 'close', 'Cache-Control': 'no-store' }); res.end('AiBrowser privacy gateway is locked'); };
  const server = http.createServer((req, res) => {
    if (state !== 'open') return unavailable(res);
    let target;
    try { target = new URL(req.url); } catch (_) { res.writeHead(400); res.end(); return; }
    if (target.protocol !== 'http:' || target.username || target.password) { res.writeHead(400); res.end(); return; }
    const headers = { ...req.headers, host: target.host, connection: 'close' };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    let cancelled = false;
    const upstream = http.request({ host: '127.0.0.1', port: bridge.port, method: req.method, path: target.href, headers, agent: false }, response => {
      if (state !== 'open') { response.destroy(); res.destroy(); return; }
      if ([407, 502, 503, 504].includes(response.statusCode)) { response.destroy(); block('上游代理请求失败'); return; }
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
      response.on('error', () => { res.destroy(); if (!cancelled) block('上游代理响应中断'); });
    });
    upstream.on('socket', socket => { track(socket); if (state !== 'open') socket.destroy(); });
    upstream.setTimeout(30000, () => upstream.destroy(new Error('Proxy timeout')));
    upstream.on('error', () => { if (!cancelled && state === 'open') block('上游代理连接失败'); res.destroy(); });
    req.on('aborted', () => { cancelled = true; upstream.destroy(); });
    res.on('close', () => { if (!res.writableFinished) { cancelled = true; upstream.destroy(); } });
    req.pipe(upstream);
  });
  server.on('connection', track);
  server.on('clientError', (_error, socket) => socket.destroy());
  // Secure WebSockets use CONNECT. Reject unsupported cleartext upgrades
  // explicitly so they cannot become an untracked socket or bypass the gate.
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
  server.on('connect', (req, client, head) => {
    if (state !== 'open') { client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    // Do not permit header injection or ambiguous CONNECT authorities.
    if (!/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9._-]+):\d{1,5}$/.test(req.url)) { client.destroy(); return; }
    const upstream = track(net.connect({ host: '127.0.0.1', port: bridge.port }));
    upstream.setTimeout(15000, () => { if (state === 'open') block('上游代理隧道超时'); });
    upstream.on('connect', () => {
      if (state !== 'open') { upstream.destroy(); return; }
      upstream.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nConnection: keep-alive\r\n\r\n`);
    });
    let header = Buffer.alloc(0);
    const receive = chunk => {
      header = Buffer.concat([header, chunk]);
      if (header.length > 65536) { block('上游代理响应无效'); return; }
      const marker = header.indexOf('\r\n\r\n');
      if (marker < 0) return;
      if (!/^HTTP\/1\.[01] 200\b/.test(header.toString('latin1'))) { block('上游代理拒绝隧道'); return; }
      upstream.off('data', receive); upstream.setTimeout(0);
      if (state !== 'open') { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = header.subarray(marker + 4); if (rest.length) client.write(rest);
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    };
    upstream.on('data', receive);
    upstream.on('error', () => { if (!client.destroyed && state === 'open') block('上游代理隧道断开'); });
    upstream.on('end', () => client.end());
    client.on('close', () => upstream.destroy());
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { await bridge.close(); throw error; }
  server.on('error', () => block('本地隐私网关故障'));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, port, protocol: 'http',
    get state() { return state; }, get failure() { return failure; },
    open() { if (state !== 'locked') throw new Error(failure || '隐私网关不能重新放行，请重启环境'); state = 'open'; },
    block,
    async close() {
      if (state === 'closed') return;
      state = 'closed'; for (const socket of sockets) socket.destroy();
      await Promise.all([bridge.close(), new Promise(resolve => server.close(resolve))]);
    },
  };
}

module.exports = { startPrivacyGateway };
