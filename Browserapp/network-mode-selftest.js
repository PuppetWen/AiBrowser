'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const { BrowserEngine } = require('./engine');
const externalKernel = require('./automation/external-kernel');
const { normalizeWindowsProxyServer, parseWindowsInternetSettings, parseMacSystemProxy } = require('./automation/system-proxy');

async function main() {
  const fakeApp = { getPath: () => path.join(__dirname, '..', 'functional-selftest-data') };
  const engine = new BrowserEngine(fakeApp);
  engine.persist = async () => {}; // This suite checks normalization, not storage.
  // Optional detection and direct/system modes belong to compatibility mode.
  engine.sanitizeProfile = raw => BrowserEngine.prototype.sanitizeProfile.call(engine, { ...raw, privacy: { ...raw.privacy, strict: false } });

  const direct = engine.sanitizeProfile({ id: 'direct', name: 'Direct', networkMode: 'direct', proxy: 'System' });
  assert.strictEqual(direct.networkMode, 'direct');
  assert.strictEqual(direct.proxy, 'Direct');

  const system = engine.sanitizeProfile({ id: 'system', name: 'System', networkMode: 'system', proxy: '', autoStart: true });
  assert.strictEqual(system.networkMode, 'system');
  assert.strictEqual(system.proxy, 'System');
  assert.strictEqual(system.autoStart, true);

  const custom = engine.sanitizeProfile({ id: 'proxy', name: 'Proxy', networkMode: 'proxy', proxy: 'http://127.0.0.1:7890' });
  assert.strictEqual(custom.networkMode, 'proxy');
  assert.strictEqual(custom.proxy, 'http://127.0.0.1:7890');
  const customWithSystemFront = engine.sanitizeProfile({
    ...custom,
    proxyMeta: { frontProxyMode: 'system' },
  });
  assert.strictEqual(customWithSystemFront.proxyMeta.frontProxyMode, 'system');
  assert.strictEqual(engine.sanitizeProfile({ ...custom, proxyMeta: { frontProxyMode: 'invalid' } }).proxyMeta.frontProxyMode, 'none');

  const windows = parseWindowsInternetSettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=127.0.0.1:8080;https=127.0.0.1:7890
    ProxyOverride  REG_SZ       localhost;127.*
  `);
  assert.strictEqual(windows.enabled, true);
  assert.strictEqual(normalizeWindowsProxyServer(windows.server), 'http://127.0.0.1:7890');
  assert.deepStrictEqual(
    parseMacSystemProxy('HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 7890\n'),
    { enabled: true, raw: 'http://127.0.0.1:7890', bypass: '', pacUrl: '', source: 'macos-scutil' },
  );

  engine.networkInfo.set(system.id, { ip: '101.87.124.141' });
  engine.profiles.set(system.id, system);
  engine.syncProfiles([{ ...system, networkMode: 'direct', proxy: 'Direct' }]);
  assert.strictEqual(engine.networkInfo.has(system.id), false, 'network-mode change must invalidate stale exit data');

  let startupChecks = 0;
  engine.checkSystemProxy = async () => { startupChecks += 1; return { ip: '92.223.71.89', countryCode: 'US' }; };
  const uncheckedSystem = engine.sanitizeProfile({
    ...system,
    privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
    proxyMeta: { checkOnStart: false, refreshOnStart: false },
  });
  assert.strictEqual(await engine.ensureExitNetworkForLocale(uncheckedSystem), null);
  assert.strictEqual(startupChecks, 0, 'unchecked startup detection must not query the public exit');

  const uncheckedProfiles = [
    engine.sanitizeProfile({
      id: 'unchecked-direct', name: 'Unchecked Direct', number: 2, kernel: 'chromium', networkMode: 'direct', proxy: 'Direct',
      privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
      proxyMeta: { checkOnStart: false, refreshOnStart: false },
    }),
    engine.sanitizeProfile({
      id: 'unchecked-custom', name: 'Unchecked Custom', number: 3, kernel: 'chromium', networkMode: 'proxy', proxy: 'http://127.0.0.1:7890',
      privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
      proxyMeta: { checkOnStart: false, refreshOnStart: false },
    }),
    engine.sanitizeProfile({
      id: 'unchecked-firefox', name: 'Unchecked Firefox', number: 4, kernel: 'firefox-reverse', networkMode: 'system', proxy: 'System',
      privacy: { languageMode: 'ip', timezoneMode: 'ip', geoMode: 'ip' },
      proxyMeta: { checkOnStart: false, refreshOnStart: false },
    }),
  ];
  for (const profile of uncheckedProfiles) {
    assert.strictEqual(
      await engine.ensureExitNetworkForLocale(profile),
      null,
      `${profile.id} must not query the public exit when startup detection is unchecked`,
    );
  }
  assert.strictEqual(startupChecks, 0, 'unchecked detection must apply to every environment and kernel');

  const checkedSystem = engine.sanitizeProfile({
    ...uncheckedSystem,
    proxyMeta: { checkOnStart: true, refreshOnStart: false },
  });
  assert.strictEqual((await engine.ensureExitNetworkForLocale(checkedSystem)).ip, '92.223.71.89');
  assert.strictEqual(startupChecks, 1, 'checked startup detection must query the public exit');

  const engineSource = await fs.readFile(path.join(__dirname, 'engine.js'), 'utf8');
  assert.match(engineSource, /checksExitBeforeLaunch \? 'proxy' : 'network'/);
  assert.match(
    engineSource,
    /async startExternalKernel\(profile\)[\s\S]*?ensureExitNetworkForLocale\(profile\)/,
    'Firefox-Reverse startup must honor the same per-environment network detection setting',
  );
  assert.match(engineSource, /startProfileProxyForwarder\([\s\S]*?startChainedProxy/);
  assert.match(engineSource, /proxy:\s*profile\.networkMode === 'direct'[^\n]*proxyForwarder\?\.url/);
  const rendererSource = await fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.match(rendererSource, /network:\s*18/);

  const root = await fs.mkdtemp(path.join(process.env.AIBROWSER_TEST_TMP || __dirname, '.network-mode-selftest-'));
  try {
    await externalKernel.writeProfilePrefs(path.join(root, 'direct'), { networkMode: 'direct' });
    await externalKernel.writeProfilePrefs(path.join(root, 'system'), { networkMode: 'system' });
    await externalKernel.writeProfilePrefs(path.join(root, 'custom'), { networkMode: 'proxy', proxy: 'socks5://127.0.0.1:1080' });
    assert.match(await fs.readFile(path.join(root, 'direct', 'user.js'), 'utf8'), /network\.proxy\.type", 0/);
    assert.match(await fs.readFile(path.join(root, 'system', 'user.js'), 'utf8'), /network\.proxy\.type", 5/);
    assert.match(await fs.readFile(path.join(root, 'custom', 'user.js'), 'utf8'), /network\.proxy\.type", 1/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }

  const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, 'renderer.js'), 'utf8');
  assert.match(html, /name="editor-network" value="system"/);
  assert.match(html, /id="editor-proxy-system-front"/);
  assert.match(html, /id="create-proxy-system-front"/);
  assert.doesNotMatch(html, /id="proxy-front-settings"/);
  assert.match(html, /class="col-default"/);
  assert.match(renderer, /startConfiguredDefaultProfiles/);
  assert.match(renderer, /dataset\.profileAutostart/);
  assert.match(renderer, /frontProxyMode:\s*selectedNetwork === 'custom'/);
  console.log('network-mode-selftest: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
