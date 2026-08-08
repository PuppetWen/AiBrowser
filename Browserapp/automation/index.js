'use strict';

const path = require('path');
const crypto = require('crypto');
const { LocalApiServer } = require('./local-api-server');
const { RpaEngine } = require('./rpa-engine');
const { RpaStore } = require('./rpa-store');
const { WindowSyncBridge } = require('./window-sync-bridge');
const { AppCenter } = require('./app-center');
const { ProxyStore } = require('./proxy-store');
const { RpaScheduler } = require('./rpa-scheduler');
const { BrowserAgent } = require('../ai/agent');

/**
 * Mount automation stack (Local API + RPA + window-sync + app center + proxy library).
 * MCP is a separate stdio process: `node automation/mcp-server.js`.
 * Fully self-contained — does not call or embed external browser binaries.
 */
async function startAutomation(context = {}) {
  const {
    app,
    engine,
    liveSync,
    beginSync,
    endSync,
    restartSync,
    getSyncState,
    setSelection,
    tile,
    emit = () => {},
    port = Number(process.env.OPENBROWSER_API_PORT || 50325),
    apiKey = process.env.OPENBROWSER_API_KEY || crypto.randomBytes(32).toString('base64url'),
  } = context;

  const storePath = path.join(app.getPath('userData'), 'rpa-store.json');
  const rpaStore = new RpaStore(storePath);
  await rpaStore.load();

  const proxyStore = new ProxyStore(
    path.join(app.getPath('userData'), 'proxy-library.json'),
    { dataDir: app.getPath('userData') },
  );
  await proxyStore.load();

  const rpaEngine = new RpaEngine({
    engine,
    store: rpaStore,
    emit: (event) => emit(event),
    userDataPath: app.getPath('userData'),
  });
  const rpaScheduler = new RpaScheduler({
    store: rpaStore,
    engine: rpaEngine,
    emit: (event) => emit(event),
  });

  const syncBridge = new WindowSyncBridge({
    getLiveSync: () => liveSync,
    beginSync,
    endSync,
    restartSync,
    getSyncState,
    setSelection,
    tile,
    getSettings: () => liveSync.getSettings(),
    updateSettings: (value) => liveSync.updateSettings(value),
  });

  const appCenter = new AppCenter({ engine });

  // In-browser AI agent. `getAiService` is lazy because the AI service is built
  // after this stack in main.js.
  const browserAgent = new BrowserAgent({
    getAiService: typeof context.getAiService === 'function' ? context.getAiService : () => null,
    engine,
    outputDir: path.join(app.getPath('userData'), 'agent-output'),
  });

  const localApi = new LocalApiServer({
    host: '127.0.0.1',
    port,
    apiKey,
    engine,
    rpaEngine,
    rpaScheduler,
    rpaStore,
    syncBridge,
    appCenter,
    proxyStore,
    browserAgent,
    getVersion: () => app.getVersion(),
  });

  const info = await localApi.start();
  rpaScheduler.start();
  emit({ type: 'local-api', ...info });

  return {
    localApi,
    browserAgent,
    rpaEngine,
    rpaScheduler,
    rpaStore,
    syncBridge,
    appCenter,
    proxyStore,
    info,
    apiKey,
    async stop() {
      browserAgent.dispose();
      await rpaScheduler.stop();
      await rpaEngine.stop();
      await proxyStore.stop();
      await localApi.stop();
    },
  };
}

module.exports = {
  startAutomation,
  LocalApiServer,
  RpaEngine,
  RpaScheduler,
  RpaStore,
  WindowSyncBridge,
  AppCenter,
  ProxyStore,
};
