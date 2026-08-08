'use strict';

const assert = require('assert');
const http = require('http');
const fsp = require('fs/promises');
const path = require('path');
const { ProxyStore } = require('./proxy-store');
const { MihomoManager } = require('./mihomo-manager');

async function main() {
  const root = path.resolve(__dirname, '..', '..', '.cache', 'proxy-subscription-selftest');
  await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });
  const yaml = [
    'proxies:',
    '  - name: Native HTTP',
    '    type: http',
    '    server: 203.0.113.10',
    '    port: 8080',
    '    username: demo',
    '    password: secret',
    '  - name: Converted SS',
    '    type: ss',
    '    server: 198.51.100.20',
    '    port: 443',
    '    cipher: aes-128-gcm',
    '    password: secret',
    '  - name: Converted Hysteria2',
    '    type: hysteria2',
    '    server: 192.0.2.30',
    '    port: 8443',
    '    password: secret',
    '    sni: example.test',
    '  - name: Converted VLESS Reality',
    '    type: vless',
    '    server: 192.0.2.40',
    '    port: 443',
    '    uuid: 00000000-0000-4000-8000-000000000000',
    '    network: tcp',
    '    tls: true',
    '    reality-opts:',
    '      public-key: mock-public-key',
    '      short-id: abcd1234',
  ].join('\n');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
    response.end(yaml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let lastMihomoResolve = null;
  let mihomoStopCount = 0;
  const mockMihomo = {
    status: () => ({ installed: true, running: false, nodes: 0 }),
    resolve: async (item, records, frontProxy) => {
      lastMihomoResolve = { item, records, frontProxy };
      return {
        id: item.id,
        raw: 'socks5://127.0.0.1:39001',
        protocol: 'socks5',
        host: '127.0.0.1',
        port: 39001,
        via: 'mihomo',
      };
    },
    stop: async () => { mihomoStopCount += 1; },
  };
  const store = new ProxyStore(path.join(root, 'proxy-library.json'), { dataDir: root, mihomo: mockMihomo });
  try {
    await store.load();
    const parsedSocks = store.parseInput('192.0.2.10:1080:demo-user:demo-pass');
    assert.equal(parsedSocks.protocol, 'socks5');
    assert.equal(parsedSocks.host, '192.0.2.10');
    assert.equal(parsedSocks.port, 1080);
    assert.equal(parsedSocks.username, 'demo-user');
    assert.equal(parsedSocks.password, 'demo-pass');
    const vlessLink = 'vless://00000000-0000-4000-8000-000000000001@192.0.2.50:443?encryption=none&security=reality&flow=xtls-rprx-vision&type=tcp&sni=example.test&pbk=mock-public-key&fp=chrome#Manual-VLESS';
    const parsedVless = store.parseInput(vlessLink);
    assert.equal(parsedVless.protocol, 'vless');
    assert.equal(parsedVless.clashProxy.uuid, '00000000-0000-4000-8000-000000000001');
    assert.equal(parsedVless.clashProxy.servername, 'example.test');
    assert.equal(parsedVless.clashProxy['reality-opts']['public-key'], 'mock-public-key');
    const hysteriaLink = 'hysteria2://demo-password@192.0.2.60:8443?insecure=1&sni=hy2.example.test&pinSHA256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D#Manual-HY2';
    const parsedHysteria = store.parseInput(hysteriaLink);
    assert.equal(parsedHysteria.protocol, 'hysteria2');
    assert.equal(parsedHysteria.clashProxy.password, 'demo-password');
    assert.equal(parsedHysteria.clashProxy['skip-cert-verify'], true);
    assert.equal(parsedHysteria.clashProxy.fingerprint.split(':').length, 32);

    const synced = await store.upsertSubscription({
      url: `http://127.0.0.1:${port}/subscription`,
      groupName: '自检订阅',
    });
    assert.equal(synced.imported, 4);
    const state = store.state();
    assert.equal(state.items.length, 4);
    assert.equal(state.groups.length, 1);
    assert.equal(state.groups[0].name, '自检订阅');
    assert(state.items.some((item) => item.protocol === 'http' && !item.requiresMihomo));
    assert(state.items.some((item) => item.protocol === 'ss' && item.requiresMihomo));
    assert(state.items.some((item) => item.protocol === 'hysteria2' && item.requiresMihomo));
    assert(state.items.some((item) => item.protocol === 'vless' && item.requiresMihomo));
    const converted = state.items.find((item) => item.requiresMihomo);
    const resolved = await store.resolveForUse(converted.id);
    assert.equal(resolved.raw, 'socks5://127.0.0.1:39001');
    assert.equal(lastMihomoResolve.frontProxy.enabled, false);

    const native = state.items.find((item) => item.protocol === 'http' && !item.requiresMihomo);
    const nativeDirect = await store.resolveForUse(native.id);
    assert.equal(nativeDirect.via, 'native');
    const frontCheck = await store.testFrontProxy({
      protocol: 'http',
      host: '127.0.0.1',
      port,
    });
    assert.equal(frontCheck.port, port);
    const savedFront = await store.updateFrontProxy({
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port,
    });
    assert.equal(savedFront.enabled, true);
    assert.equal(mihomoStopCount, 1);
    const nativeStillDirect = await store.resolveForUse(native.id);
    assert.equal(nativeStillDirect.via, 'native', 'legacy global front proxy must no longer affect environments');
    const environmentFront = { ...savedFront, source: 'selftest-system' };
    const nativeChained = await store.resolveForUse(native.id, { frontProxy: environmentFront, scopeKey: 'env-native' });
    assert.equal(nativeChained.via, 'front-bridge');
    const convertedChained = await store.resolveForUse(converted.id, { frontProxy: environmentFront });
    assert.equal(convertedChained.via, 'mihomo');
    assert.equal(lastMihomoResolve.frontProxy.enabled, true);
    assert.equal(lastMihomoResolve.records.length, 4);
    assert.equal(store.state().frontProxy.port, port);

    const manualSocks = await store.create({
      name: '手工住宅 SOCKS5',
      protocol: 'socks5',
      host: '192.0.2.70',
      port: 1702,
      username: 'manual-user',
      password: 'manual-pass',
    });
    const manualSocksResolved = await store.resolveForUse(manualSocks.id, { frontProxy: environmentFront, scopeKey: 'env-manual' });
    assert.equal(manualSocksResolved.via, 'front-bridge');
    assert.equal(manualSocksResolved.frontProxy.enabled, true);
    assert.equal(manualSocksResolved.protocol, 'http');
    assert.equal(manualSocksResolved.host, '127.0.0.1');
    const draftSocksResolved = await store.resolveDraft({
      name: '草稿 SOCKS5',
      protocol: 'socks5',
      host: '192.0.2.71',
      port: 1703,
      username: 'draft-user',
      password: 'draft-pass',
      raw: 'socks5://draft-user:draft-pass@192.0.2.71:1703',
    }, { frontProxy: environmentFront, scopeKey: 'env-draft' });
    assert.equal(draftSocksResolved.via, 'front-bridge');
    assert.equal(draftSocksResolved.frontProxy.enabled, true);
    assert.equal(draftSocksResolved.protocol, 'http');
    assert.notEqual(draftSocksResolved.port, manualSocksResolved.port);
    await store.remove([manualSocks.id]);

    const manager = new MihomoManager({ dataDir: root });
    const chainedConfig = await manager.buildConfig(
      store.data.items.filter((item) => item.subscriptionId && item.clashProxy),
      new Map(),
      savedFront,
    );
    const frontOutbound = chainedConfig.config.proxies.find((item) => item.name === 'ob-front-proxy');
    assert(frontOutbound, 'front proxy outbound is generated');
    assert.equal(frontOutbound.type, 'http');
    assert.equal(frontOutbound.server, '127.0.0.1');
    assert(chainedConfig.config.proxies
      .filter((item) => item.name !== 'ob-front-proxy')
      .every((item) => item['dialer-proxy'] === 'ob-front-proxy'));

    const beforeSyncIds = state.items.map((item) => item.id).sort();
    await store.updateGroup({ id: state.groups[0].id, name: '重命名组', collapsed: true });
    const refreshed = await store.syncSubscription(state.subscriptions[0].id);
    assert.equal(refreshed.imported, 4);
    assert.deepEqual(store.state().items.map((item) => item.id).sort(), beforeSyncIds);
    await store.markCheckMany([
      { id: state.items[0].id, ok: true, result: { ip: '203.0.113.1', countryCode: 'US', latencyMs: 123, networkType: 'datacenter' } },
      { id: state.items[1].id, ok: false, error: { errorClass: 'timeout', latencyMs: 5000 } },
    ]);
    const updated = store.state();
    assert.equal(updated.groups[0].name, '重命名组');
    assert.equal(updated.groups[0].collapsed, true);
    assert.equal(updated.subscriptions[0].name, '重命名组');
    assert.equal(updated.items.find((item) => item.id === state.items[0].id).lastCheckOk, true);
    assert.equal(updated.items.find((item) => item.id === state.items[1].id).lastErrorClass, 'timeout');
    const manualVless = await store.create({
      name: '手动 VLESS',
      raw: vlessLink,
      ipChannel: 'ip-api',
      remark: 'selftest',
    });
    assert.equal(manualVless.sourceType, 'manual-clash');
    assert.equal(manualVless.requiresMihomo, true);
    assert.equal(manualVless.username, '00000000-0000-4000-8000-000000000001');
    const manualResolved = await store.resolveForUse(manualVless.id);
    assert.equal(manualResolved.via, 'mihomo');
    assert.equal(lastMihomoResolve.frontProxy.enabled, false);
    await store.remove([manualVless.id]);
    console.log(JSON.stringify({
      ok: true,
      imported: synced.imported,
      protocols: synced.protocols,
      group: updated.groups[0].name,
      convertedVia: resolved.via,
      frontProxy: `${savedFront.protocol}://${savedFront.host}:${savedFront.port}`,
      autoParsed: [parsedSocks.protocol, parsedVless.protocol, parsedHysteria.protocol],
    }));
  } finally {
    server.close();
    await store.stop();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
