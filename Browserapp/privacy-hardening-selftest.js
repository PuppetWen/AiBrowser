'use strict';
// Only loopback sockets and synthetic CDP. No public IP/DNS probes or browsers.
const assert = require('assert/strict');
const http = require('http');
const net = require('net');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { BrowserEngine } = require('./engine');
const { parseProxy } = require('./proxy-forwarder');
const { startPrivacyGateway } = require('./automation/privacy-gateway');
const { StartPageServer } = require('./automation/start-page-server');
const { assertStrictProfile, assertExitIdentity } = require('./automation/privacy-policy');
const { buildFingerprint, applyFingerprintToTab, fingerprintVerificationExpression } = require('./automation/fingerprint');
const { privacyFirewall } = require('./automation/privacy-firewall');
const { PersistentConnection } = require('./cdp');
let checks = 0;
function pass(label) { checks++; console.log('PASS ' + label); }
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
function request(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: target, headers, agent: false, timeout: 2000 }, res => {
      let data = ''; res.on('data', chunk => { data += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data })); res.on('error', reject);
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('test timeout')));
  });
}
function readUntil(socket, text) {
  return new Promise((resolve, reject) => {
    let body = ''; const timer = setTimeout(() => done(new Error('socket timeout')), 2000);
    function done(error) { clearTimeout(timer); socket.off('data', onData); socket.off('error', done); error ? reject(error) : resolve(body); }
    function onData(data) { body += data; if (body.includes(text)) done(); }
    socket.on('data', onData); socket.on('error', done);
  });
}
function engineFixture() {
  const engine = Object.create(BrowserEngine.prototype);
  Object.assign(engine, { profiles: new Map(), networkInfo: new Map(), running: new Map(), emit: () => {}, persist: async () => {} });
  return engine;
}

async function policyTests() {
  const engine = engineFixture();
  const profile = engine.sanitizeProfile({ id: 'strict', name: 'Strict fixture', networkMode: 'proxy', proxy: 'http://127.0.0.1:8888', privacy: { webrtc: 'real', timezoneMode: 'real', geoMode: 'prompt' }, proxyMeta: { notReadyPolicy: 'direct', checkOnStart: false, requireReady: false, directBypass: true } });
  assert.equal(profile.privacy.strict, true); assert.equal(profile.privacy.webrtc, 'disabled'); assert.equal(profile.privacy.geoMode, 'disabled'); assert.equal(profile.privacy.timezoneMode, 'ip');
  assert.equal(profile.proxyMeta.notReadyPolicy, 'block'); assert.equal(profile.proxyMeta.checkOnStart, true); assert.equal(profile.proxyMeta.directBypass, false);
  assert.equal(engine.sanitizeProfile({ id: 'empty', name: 'Empty fixture', networkMode: 'proxy', proxy: '' }).networkMode, 'proxy');
  pass('strict defaults override unsafe legacy settings; empty proxy stays proxy');
  for (const change of [{ networkMode: 'direct' }, { kernel: 'firefox-reverse' }, { advanced: { restoreSession: true } }, { privacy: { ...profile.privacy, fingerprintMode: 'native' } }, { proxyMeta: { apiExtractUrl: 'https://extract.invalid' } }, { privacy: { ...profile.privacy, timezoneMode: 'custom', timezone: 'Invalid/Zone' } }]) assert.throws(() => assertStrictProfile({ ...profile, ...change }), e => e.documentStartOk === false);
  assert.throws(() => assertExitIdentity(profile, { ip: '192.0.2.5', countryCode: 'US' }));
  const network = { ip: '192.0.2.5', timezone: 'America/New_York', countryCode: 'US' };
  assertExitIdentity(profile, network);
  pass('unsupported kernel, native identity, direct, restore, extraction and missing timezone blocked');
  engine.testProxy = async () => { throw new Error('upstream down'); };
  await assert.rejects(engine.prepareProfileProxyForStart(profile), /upstream down/);
  let attempts = [];
  engine.testProxy = async (_profile, options) => { attempts.push(options.proxy); if (attempts.length === 1) throw new Error('down'); return network; };
  const ready = await engine.prepareProfileProxyForStart({ ...profile, proxyMeta: { ...profile.proxyMeta, backupProxies: ['socks5://127.0.0.1:9999'] } });
  assert.equal(ready.proxy, attempts[1]); assert.equal(ready.networkMode, 'proxy'); assert.equal(ready.exitTimezone, network.timezone);
  await assert.rejects(engine.refreshProfileProxy(profile), /严格隐私/);
  await assert.rejects(engine.resolveProfileProxyConfig({ ...profile, proxyMeta: { apiExtractUrl: 'https://extract.invalid' } }), /严格隐私/);
  pass('unavailable proxy cannot fall back direct; only a validated backup can start');
  const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
  const normalize = vm.runInNewContext('(' + renderer.slice(renderer.indexOf('function normalizeProfileSettings('), renderer.indexOf('function loadUi(')).trim() + ')', { positiveProfileNumber: value => Number(value) || null, UNGROUPED_ID: '' });
  const ui = normalize({ ...profile, privacy: { strict: true, webrtc: 'real', geoMode: 'ip', timezoneMode: 'real', languageMode: 'system' } });
  const backend = engine.sanitizeProfile(ui);
  for (const key of ['strict', 'webrtc', 'geoMode', 'timezoneMode', 'languageMode']) assert.equal(ui.privacy[key], backend.privacy[key]);
  for (const key of ['notReadyPolicy', 'requireReady', 'checkOnStart', 'directBypass']) assert.equal(ui.proxyMeta[key], backend.proxyMeta[key]);
  pass('renderer and backend agree on effective privacy settings');
  const filename = require.resolve('./engine'), localRequire = createRequire(filename);
  let system = { enabled: true, raw: 'http://127.0.0.1:1234' };
  const context = { module: { exports: {} }, __dirname, process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, require: id => id === './automation/system-proxy' ? { resolveSystemProxy: async () => system } : localRequire(id) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  const systemEngine = Object.assign(Object.create(context.module.exports.BrowserEngine.prototype), { profiles: new Map(), networkInfo: new Map(), running: new Map(), emit: () => {}, testProxy: async (_profile, options) => { assert.equal(options.proxy, system.raw); return network; } });
  const systemProfile = systemEngine.sanitizeProfile({ ...profile, networkMode: 'system', proxy: 'System' });
  const pinned = await systemEngine.prepareProfileProxyForStart(systemProfile);
  assert.equal(pinned.networkMode, 'proxy'); assert.equal(pinned.proxy, system.raw);
  assert.equal(systemEngine.profiles.get(profile.id).networkMode, 'system', 'persisted selection stays system; only runtime endpoint is pinned');
  system = { enabled: false, raw: '' }; await assert.rejects(systemEngine.prepareProfileProxyForStart(systemProfile), /系统代理/);
  system = { enabled: true, raw: 'http://127.0.0.1:1234', pacUrl: 'https://pac.invalid' }; await assert.rejects(systemEngine.prepareProfileProxyForStart(systemProfile), /PAC/);
  pass('system proxy fixed per launch; disabled system proxy and PAC cannot fall back');
  const { MihomoManager } = require('./automation/mihomo-manager');
  const config = await MihomoManager.prototype.buildConfig([{ id: 'a', clashProxy: { name: 'fixture', type: 'http', server: '192.0.2.5', port: 8080 } }]);
  assert.deepEqual(config.config.rules, ['MATCH,REJECT']); assert.equal(config.config.listeners[0].proxy, 'ob-a');
  pass('managed subscription listeners pin an upstream and unmatched traffic is rejected');
}

async function socksTests() {
  let fail = false, host = '', connections = 0;
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket); connections++; socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
    let data = Buffer.alloc(0), stage = 0;
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (stage === 0 && data.length >= data[1] + 2) { data = data.subarray(data[1] + 2); stage = 1; socket.write(Buffer.from([5, 0])); }
      if (stage === 1 && data.length >= 5) {
        assert.equal(data[3], 3, 'destination hostname must reach SOCKS; no local DNS');
        const length = 7 + data[4]; if (data.length < length) return;
        host = data.subarray(5, 5 + data[4]).toString(); data = data.subarray(length); stage = 2;
        socket.write(Buffer.from([5, fail ? 5 : 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        if (fail) { socket.end(); return; }
      }
      if (stage === 2 && data.includes('\r\n\r\n')) { stage = 3; socket.end('HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nsocksproxied'); }
    });
  });
  const port = await listen(server); const gate = await startPrivacyGateway(parseProxy(`socks5://127.0.0.1:${port}`));
  try {
    gate.open(); assert.equal((await request(gate.port, 'http://fixture.invalid/test')).data, 'socksproxied'); assert.equal(host, 'fixture.invalid');
    fail = true; await request(gate.port, 'http://fixture.invalid/fail').catch(() => {});
    assert.equal(gate.state, 'blocked'); assert.equal(connections, 2);
    pass('SOCKS5 uses remote hostname resolution and closes on proxy rejection');
  } finally { await gate.close(); for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); }
  const auth = http.createServer((_req, res) => { res.writeHead(407); res.end(); });
  const authPort = await listen(auth); const rejected = await startPrivacyGateway(parseProxy(`http://127.0.0.1:${authPort}`));
  try { rejected.open(); await request(rejected.port, 'http://fixture.invalid').catch(() => {}); assert.equal(rejected.state, 'blocked'); pass('HTTP proxy authentication failure closes the gate'); }
  finally { await rejected.close(); await new Promise(resolve => auth.close(resolve)); }
}

async function gatewayTests() {
  let upstreamRequests = 0, destinationRequests = 0, auth;
  const sockets = new Set();
  const proxy = http.createServer((req, res) => { upstreamRequests++; auth = req.headers['proxy-authorization']; res.end('proxied'); });
  proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_req, socket) => { upstreamRequests++; socket.write('HTTP/1.1 200 OK\r\n\r\n'); socket.on('data', chunk => socket.write(chunk)); });
  const direct = http.createServer((_req, res) => { destinationRequests++; res.end('LEAK'); });
  const proxyPort = await listen(proxy), directPort = await listen(direct);
  const gateway = await startPrivacyGateway(parseProxy(`http://user:password@127.0.0.1:${proxyPort}`));
  const second = await startPrivacyGateway(parseProxy(`http://127.0.0.1:${proxyPort}`));
  let tunnel;
  try {
    const target = `http://127.0.0.1:${directPort}/canary`;
    assert.equal((await request(gateway.port, target)).status, 503); assert.equal(upstreamRequests, 0);
    gateway.open(); assert.equal((await request(gateway.port, target)).data, 'proxied');
    assert.equal(auth, 'Basic ' + Buffer.from('user:password').toString('base64'));
    assert.equal((await request(second.port, target)).status, 503);
    assert.equal(destinationRequests, 0);
    pass('per-environment locked gates and authenticated proxy forwarding');
    tunnel = net.connect({ host: '127.0.0.1', port: gateway.port }); tunnel.on('error', () => {});
    const connected = readUntil(tunnel, '\r\n\r\n'); tunnel.write('CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\n\r\n');
    assert.match(await connected, /200/);
    const pong = readUntil(tunnel, 'PING'); tunnel.write('PING'); await pong;
    const closed = new Promise(resolve => tunnel.once('close', resolve));
    gateway.block('simulated CDP failure'); await closed;
    assert.equal(gateway.state, 'blocked'); assert.throws(() => gateway.open());
    assert.equal((await request(gateway.port, target)).status, 503);
    pass('CDP failure immediately closes an active CONNECT tunnel and cannot reopen');
    second.open(); assert.equal((await request(second.port, target)).data, 'proxied');
    const proxyClosed = new Promise(resolve => proxy.close(resolve)); for (const socket of sockets) socket.destroy(); await proxyClosed;
    await request(second.port, target).catch(() => {});
    assert.equal(second.state, 'blocked'); assert.equal(destinationRequests, 0);
    assert.equal((await request(second.port, target)).status, 503);
    pass('upstream outage latches network off; direct destination sees zero requests');
  } finally { tunnel?.destroy(); await gateway.close(); await second.close(); for (const socket of sockets) socket.destroy(); await new Promise(r => proxy.close(r)); await new Promise(r => direct.close(r)); }
}

async function fingerprintTests() {
  const profile = { id: 'fp-strict', exitTimezone: 'America/New_York', privacy: { strict: true, timezoneMode: 'ip', geoMode: 'disabled' } };
  const fp = buildFingerprint(profile);
  await assert.rejects(applyFingerprintToTab(async () => ({}), null, fp, { ...profile, exitTimezone: '' }), e => e.documentStartOk === false);
  for (const scenario of ['override', 'evaluate', 'mismatch', 'unreadable', 'ok']) {
    const invoke = async (method, params) => {
      if (scenario === 'override' && method === 'Emulation.setTimezoneOverride') throw new Error('not available');
      if (method === 'Runtime.evaluate') {
        if (scenario === 'evaluate') return { exceptionDetails: { text: 'injection failed' } };
        if (params.returnByValue) return { result: { value: scenario === 'mismatch' ? ['timezone'] : scenario === 'unreadable' ? null : [] } };
      }
      return {};
    };
    if (scenario === 'ok') await applyFingerprintToTab(invoke, null, fp, profile);
    else await assert.rejects(applyFingerprintToTab(invoke, null, fp, profile), e => e.documentStartOk === false);
  }
  const values = vm.runInNewContext(fingerprintVerificationExpression(fp, profile, true), { navigator: { userAgent: 'host-leak', platform: fp.platform, hardwareConcurrency: fp.hardwareConcurrency, deviceMemory: fp.deviceMemory, language: fp.languages[0] }, Intl });
  assert.ok(values.includes('userAgent'));
  pass('critical override, evaluation and fingerprint readback failures are fatal');
  let disconnected = 0, closed = 0;
  const cdp = new PersistentConnection('ws://unused', { onDisconnect: () => disconnected++ });
  cdp.socket = { close: () => closed++, send: () => {} };
  const pending = cdp.command('Runtime.enable'); const rejected = assert.rejects(pending, /lost/);
  cdp.disconnected(new Error('lost')); cdp.disconnected(new Error('twice')); await rejected;
  assert.equal(disconnected, 1); assert.equal(closed, 1);
  pass('CDP disconnect rejects pending commands and calls protection exactly once');
}

async function startPageTests() {
  const engine = engineFixture(); const profile = { id: 'session', privacy: { strict: true }, networkMode: 'proxy', proxy: 'http://original.invalid:8080' };
  const network = { ip: '192.0.2.5', timezone: 'America/New_York', countryCode: 'US' };
  let probes = 0, blocked = false;
  const gateway = { state: 'locked', url: 'http://127.0.0.1:9999', block: () => { blocked = true; gateway.state = 'blocked'; } };
  engine.profiles.set(profile.id, profile); engine.networkInfo.set(profile.id, network); engine.running.set(profile.id, { profile, proxyForwarder: gateway });
  engine.testProxy = async (_profile, options) => { assert.equal(options.proxy, gateway.url); assert.equal(options.skipFrontProxy, true); return network; };
  const page = new StartPageServer({ engine, lookupDirectNetwork: async () => { throw new Error('DIRECT must never run'); }, lookupDnsLeak: async () => { throw new Error('Host DNS must never run'); }, lookupReachability: async options => { assert.equal(options.proxy, gateway.url); probes++; return {}; } });
  await page.start();
  try {
    const url = new URL(page.registerSession(profile, { network })); const token = url.searchParams.get('token');
    const route = async api => request(page.port, `/api/${api}${api.includes('?') ? '&' : '?'}pid=session&token=${encodeURIComponent(token)}`);
    const dns = await route('dns-leak'); assert.equal(dns.status, 200); assert.equal(JSON.parse(dns.data).data.label, '未执行');
    assert.equal((await route('reachability')).status, 409); assert.equal(probes, 0);
    gateway.state = 'open'; assert.equal((await route('reachability')).status, 200); assert.equal(probes, 1);
    assert.equal((await route('network?refresh=1')).status, 200);
    engine.testProxy = async () => ({ ...network, ip: '192.0.2.6' });
    assert.equal((await route('network?refresh=1')).status, 500); assert.equal(blocked, true);
    assert.equal((await route('reachability')).status, 409); assert.equal(probes, 1);
    pass('report page uses only live gateway; no DNS/direct fallback; changed exit closes gate');
  } finally { await page.stop(); }
}

async function firewallTests() {
  const browser = { independent: true, path: process.execPath };
  await assert.rejects(privacyFirewall(browser, 'Check', { platform: 'linux' }), /Windows/);
  await assert.rejects(privacyFirewall({ ...browser, independent: false }, 'Check', { platform: 'win32' }), /独立内核/);
  await assert.rejects(privacyFirewall(browser, 'Check', { platform: 'win32', execute: async () => ({ stdout: '{"ok":false,"error":"missing"}' }) }), /missing/);
  assert.equal((await privacyFirewall(browser, 'Check', { platform: 'win32', execute: async (_shell, args, options) => { assert.equal(args[args.indexOf('-Action') + 1], 'Check'); assert.equal(options.windowsHide, true); return { stdout: '{"ok":true}' }; } })).ok, true);
  pass('missing firewall, unsupported OS and system browser fail closed');
}

(async () => { await policyTests(); await gatewayTests(); await socksTests(); await fingerprintTests(); await startPageTests(); await firewallTests(); console.log(`PRIVACY_HARDENING_SELFTEST_OK ${checks} groups`); })().catch(error => { console.error(error); process.exitCode = 1; });
