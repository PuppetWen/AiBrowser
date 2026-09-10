'use strict';

// Pure local regression checks: temporary Firefox prefs and loopback proxy
// servers only. No browser is launched and no user profile is opened.
const assert = require('assert');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const tls = require('tls');
const vm = require('vm');
const { EventEmitter } = require('events');
const { createRequire } = require('module');
const externalKernel = require('./automation/external-kernel');
const { parseProxy, startAuthenticatedProxy } = require('./proxy-forwarder');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: 'http://example.test/resource', agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Local proxy request timed out')));
    req.on('error', reject);
  });
}

async function checkProxyBridge(protocol) {
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push(req.headers);
    res.end('ok');
  });
  const agent = new http.Agent({ keepAlive: true });
  const originalTlsConnect = tls.connect;
  let bridge;
  const options = [];
  try {
    const port = await listen(upstream);
    if (protocol === 'https') {
      // Inspect the real bridge's TLS setup while retaining a local socket.
      // The upstream in this test deliberately does not perform actual TLS.
      tls.connect = (opts) => {
        options.push(opts);
        process.nextTick(() => opts.socket.emit('secureConnect'));
        return opts.socket;
      };
    }
    bridge = await startAuthenticatedProxy(parseProxy(`${protocol}://user:password@127.0.0.1:${port}`));
    assert.strictEqual(await request(bridge.port, agent), 'ok');
    assert.strictEqual(await request(bridge.port, agent), 'ok');
    assert.strictEqual(received.length, 2);
    for (const headers of received) {
      assert.strictEqual(headers['proxy-authorization'], 'Basic ' + Buffer.from('user:password').toString('base64'));
      assert.strictEqual(headers.connection, 'close', 'ordinary HTTP requests must close before reuse can bypass authentication');
    }
    if (protocol === 'https') {
      assert.strictEqual(options.length, 2);
      for (const opts of options) {
        assert.deepStrictEqual(opts.ALPNProtocols, ['http/1.1']);
        assert.strictEqual(opts.rejectUnauthorized, true);
      }
    }
  } finally {
    tls.connect = originalTlsConnect;
    agent.destroy();
    await bridge?.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

async function main() {
  assert.strictEqual(parseProxy('http://proxy.example:80').port, 80);
  assert.strictEqual(parseProxy('http://user:pass@proxy.example:80').port, 80);
  assert.strictEqual(parseProxy('https://proxy.example:443').port, 443);
  assert.throws(() => parseProxy('http://proxy.example:65536'));

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aibrowser-network-regression-'));
  try {
    const prefs = { 'network.proxy.http': 'old-http.test', 'network.proxy.ssl': 'old-https.test', 'network.proxy.socks_version': 4 };
    const applyPrefs = async (proxy) => {
      await externalKernel.writeProfilePrefs(root, { networkMode: 'proxy', proxy });
      const source = await fs.readFile(path.join(root, 'user.js'), 'utf8');
      vm.runInNewContext(source, { user_pref: (name, value) => { prefs[name] = value; } });
      return source;
    };
    await applyPrefs('socks5://proxy.example:1080');
    assert.strictEqual(prefs['network.proxy.http'], '');
    assert.strictEqual(prefs['network.proxy.ssl'], '');
    assert.strictEqual(prefs['network.proxy.socks'], 'proxy.example');
    assert.strictEqual(prefs['network.proxy.socks_version'], 5);
    assert.strictEqual(prefs['network.proxy.failover_direct'], false);
    assert.strictEqual(prefs['network.proxy.no_proxies_on'], '');
    await applyPrefs('socks4://proxy.example:1080');
    assert.strictEqual(prefs['network.proxy.socks_version'], 4);
    const validSource = await applyPrefs('http://proxy.example:80');
    assert.strictEqual(prefs['network.proxy.socks'], '');
    assert.strictEqual(prefs['network.proxy.http_port'], 80);
    for (const proxy of ['', 'Direct', 'invalid-endpoint', 'http://proxy.example:65536', 'https://proxy.example:443', 'http://u:p@proxy.example:80']) {
      await assert.rejects(() => externalKernel.writeProfilePrefs(root, { networkMode: 'proxy', proxy }));
      assert.strictEqual(await fs.readFile(path.join(root, 'user.js'), 'utf8'), validSource, 'invalid proxy must not replace saved prefs with direct mode');
    }
    await externalKernel.writeProfilePrefs(root, { networkMode: 'direct' });
    vm.runInNewContext(await fs.readFile(path.join(root, 'user.js'), 'utf8'), { user_pref: (name, value) => { prefs[name] = value; } });
    assert.strictEqual(prefs['network.proxy.type'], 0);

    const filename = require.resolve('./automation/external-kernel');
    const realRequire = createRequire(filename);
    const sandbox = {
      require: (id) => id === 'child_process' ? {
        spawn: () => {
          const child = new EventEmitter();
          process.nextTick(() => child.emit('error', new Error('spawn EACCES')));
          return child;
        },
      } : realRequire(id),
      module: { exports: {} }, process, __dirname: path.dirname(filename), setTimeout, clearTimeout,
    };
    vm.runInNewContext(await fs.readFile(filename, 'utf8'), sandbox, { filename });
    await assert.rejects(() => sandbox.module.exports.launch({
      binary: filename, profileDir: root, networkMode: 'direct', marionettePort: 2828,
    }), /spawn EACCES/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  await checkProxyBridge('http');
  await checkProxyBridge('https');
  console.log('BROWSER_NETWORK_REGRESSION_SELFTEST_OK default_ports=1 firefox_proxy_switch=1 fail_closed=1 spawn_error=1 repeat_http_auth=1 https_alpn=1');
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
