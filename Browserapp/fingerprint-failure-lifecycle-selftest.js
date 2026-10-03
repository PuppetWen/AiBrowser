'use strict';

// Execute production engine methods with synthetic CDP targets/processes.
// This test never launches, inspects, or kills an actual browser process.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const fingerprintModule = require('./automation/fingerprint');

const filename = require.resolve('./engine');
const source = fs.readFileSync(filename, 'utf8');
const localRequire = createRequire(filename);
const hardError = () => Object.assign(new Error('document-start registration failed'), { documentStartOk: false });
const fp = fingerprintModule.buildFingerprint({ id: 'fp-test' });

function harness() {
  const calls = [];
  const kills = [];
  let killResult = true;
  let inject = async () => {};
  let attached;
  let disconnected;
  const target = { id: 'managed-target', webSocketDebuggerUrl: 'ws://synthetic', url: 'about:blank' };
  const cdp = {
    tabs: async () => [target],
    closeTab: async (port, id) => { calls.push(['closeTab', { port, id }]); },
    browserSocket: async () => 'ws://synthetic-browser',
    call: async (_ws, method, params) => {
      calls.push([method, params]);
      return { result: { value: { hardwareConcurrency: 64, userAgent: 'host-ua' } } };
    },
    connect: async (_ws, options) => { attached = options.onEvent; disconnected = options.onDisconnect; return connection; },
  };
  const connection = {
    command: async (method, params, options) => { calls.push([method, params, options]); return { success: true }; },
    close: () => { calls.push(['connection.close']); },
  };
  const context = {
    process, Buffer, URL, __dirname: path.dirname(filename), module: { exports: {} },
    setTimeout: (callback) => { const timer = setTimeout(callback, 0); timer.unref = () => timer; return timer; }, clearTimeout, setInterval, clearInterval,
    require: (id) => {
      if (id === './cdp') return cdp;
      if (id === 'child_process') return { spawn: () => { throw new Error('Real spawn forbidden'); }, execFileSync: () => { throw new Error('Real process inspection forbidden'); } };
      if (id === './automation/fingerprint') return { ...fingerprintModule, applyFingerprintToTab: (...args) => inject(...args) };
      if (id === './automation/protocol/cross-platform') return {
        ...localRequire(id), killProcessTree: async (pid, options) => { kills.push({ pid, options }); return killResult; },
      };
      if (id === './automation/fingerprint-debug-log') return {
        ...localRequire(id), fpLog: async () => {}, logPath: () => 'synthetic-log',
      };
      return localRequire(id);
    },
  };
  vm.runInNewContext(source, context, { filename });
  const engine = Object.create(context.module.exports.BrowserEngine.prototype);
  const events = [];
  engine.networkInfo = new Map();
  engine.running = new Map();
  engine.emit = (event) => { events.push(event); };
  engine.clearRunningWatch = () => {};
  return { engine, cdp, calls, kills, connection, context, events, setKillResult: (value) => { killResult = value; }, setInject: (callback) => { inject = callback; }, onAttached: (event) => attached(event, connection), onDisconnect: () => disconnected(new Error('CDP lost')) };
}

async function checkRuntimeAndReload() {
  for (const retry of [false, true]) {
    const h = harness();
    let attempts = 0;
    h.setInject(async () => { if (!retry || ++attempts > 1) throw hardError(); });
    const applied = new Set();
    await assert.rejects(() => h.engine.applyRuntimeSettings(123, { id: 'fp-test', advanced: {}, privacy: {} }, fp, { appliedTargetIds: applied }), (error) => error.documentStartOk === false);
    assert.equal(applied.size, 0);
    assert.equal(h.calls.filter(([method]) => method === 'closeTab').length, 1);
    assert.equal(h.calls.find(([method]) => method === 'closeTab')[1].id, 'managed-target');
  }
  const h = harness();
  h.setInject(async () => { throw hardError(); });
  h.engine.isStartPageUrl = () => true;
  h.engine.applyRuntimeSettings = async () => fp;
  await assert.rejects(() => h.engine.ensureStartPageFingerprint({ port: 123 }, { id: 'fp-test' }, fp, 'https://synthetic.test'), (error) => error.documentStartOk === false);
  assert.equal(h.calls.some(([method]) => method === 'Page.navigate' || method === 'Page.reload'), false);
}

async function checkAttached() {
  for (const scenario of ['hard', 'hard-close-failed', 'soft', 'ok']) {
    const h = harness();
    const item = { port: 123, pid: 424242, root: 'synthetic-profile-root', profile: { id: 'fp-test' }, child: { exitCode: null }, browser: { path: 'synthetic-browser' } };
    let cleaned = false;
    item.fingerprintFailureCleanup = () => { cleaned = true; };
    const command = h.connection.command;
    h.connection.command = async (method, params, options) => {
      const result = await command(method, params, options);
      if (method === 'Target.closeTarget' && scenario === 'hard-close-failed') return { success: false };
      if (method === 'Browser.close') item.child.exitCode = 0;
      return result;
    };
    h.engine.applyFingerprintToSession = async () => {
      if (scenario.startsWith('hard')) throw hardError();
      if (scenario === 'soft') throw new Error('temporary soft override');
    };
    await h.engine.startWorkerFingerprintInjection(item, fp);
    h.onAttached({ method: 'Target.attachedToTarget', params: { sessionId: 'session-a', targetInfo: { type: 'page', targetId: 'target-a' }, waitingForDebugger: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const resumes = h.calls.filter(([method]) => method === 'Runtime.runIfWaitingForDebugger');
    assert.equal(resumes.length, scenario.startsWith('hard') ? 0 : 1);
    if (scenario.startsWith('hard')) {
      assert.equal(item.fingerprintStartupError.documentStartOk, false);
      assert.equal(h.calls.find(([method]) => method === 'Target.closeTarget')[1].targetId, 'target-a');
    }
    assert.equal(cleaned, scenario === 'hard-close-failed');
    assert.equal(h.kills.length, 0);
  }
}

async function checkStartupTail() {
  // Isolate the production post-spawn startup block; all filesystem/process
  // preparation is outside this test, while the actual nested catches run.
  const begin = source.indexOf('    item.startupExtensionGuard =');
  const endText = '    return this.publicRunning(profile.id);';
  const end = source.indexOf(endText, begin) + endText.length;
  assert.ok(begin >= 0 && end > begin);
  const tail = source.slice(begin, end);
  for (const failureAt of ['pre', 'worker', 'reinject', 'attached', 'soft', 'ok']) {
    const h = harness();
    const profile = { id: 'fp-test' };
    const item = { profile, port: 123, pid: 424242, child: { exitCode: null }, root: 'synthetic-profile-root', browser: { path: 'synthetic-browser' } };
    let navigations = 0;
    let ready = false;
    let browserClosed = false;
    const cleanup = () => h.engine.running.delete(profile.id);
    item.cdpConnection = { command: async (method) => { assert.equal(method, 'Browser.close'); browserClosed = true; item.child.exitCode = 0; } };
    h.engine.running.set(profile.id, item);
    h.engine.suppressStartupExtensionPages = async () => {};
    h.engine.applyRuntimeSettings = async () => {
      if (failureAt === 'pre') throw hardError();
      if (failureAt === 'soft') throw new Error('ordinary soft override');
      return fp;
    };
    h.engine.startWorkerFingerprintInjection = async () => {
      if (failureAt === 'worker') throw hardError();
      if (failureAt === 'attached') item.fingerprintStartupError = hardError();
    };
    h.engine.keepDefaultTab = async () => { navigations += 1; };
    h.engine.ensureStartPageFingerprint = async () => { if (failureAt === 'reinject') throw hardError(); };
    h.engine.applyEnvWindowTitle = async () => {};
    h.engine.startRunningWatch = () => {};
    h.engine.publicRunning = () => ({ running: h.engine.running.has(profile.id) });
    h.engine.emitStartProgress = (_id, phase) => { if (phase === 'ready') ready = true; };
    const context = {
      item, profile, connection: {}, reconciled: { installed: [] }, cleanup,
      restoreSession: false, startUrl: 'https://synthetic.test', fingerprint: fp, runtimeFingerprint: fp,
      launchBinary: 'synthetic-browser', browser: item.browser, fpLog: async () => {},
      summarizeFp: () => ({}), fingerprintLogPath: () => 'synthetic-log',
      fingerprintForNativeKernelInject: (value) => value, Set,
      customStartUrls: [], ...require('./automation/privacy-policy'),
    };
    const run = vm.runInNewContext('(async function() {\n' + tail + '\n})', context);
    if (['soft', 'ok'].includes(failureAt)) {
      await run.call(h.engine);
      assert.equal(ready, true);
      assert.equal(browserClosed, false);
    } else {
      await assert.rejects(() => run.call(h.engine), (error) => error.documentStartOk === false);
      assert.equal(ready, false);
      assert.equal(browserClosed, true);
      assert.equal(h.engine.running.has(profile.id), false);
      assert.equal(navigations, failureAt === 'reinject' ? 1 : 0);
    }
    assert.equal(h.kills.length, 0, 'graceful close must not escalate to process termination');
  }
}

async function checkOwnedTerminationFallback() {
  const h = harness();
  const item = { profile: { id: 'fp-test' }, root: 'only-this-profile', pid: 424242, child: { exitCode: null }, browser: { path: 'only-this-browser' }, cdpConnection: { command: async () => { throw new Error('CDP closed'); } } };
  let cleaned = false;
  item.fingerprintFailureCleanup = () => { cleaned = true; };
  await h.engine.abortFingerprintProtection(item, hardError());
  assert.equal(h.kills.length, 1);
  assert.equal(h.kills[0].pid, item.pid);
  assert.equal(h.kills[0].options.expectedUserDataDir, item.root);
  assert.ok(h.kills[0].options.expectedExecutables.includes(item.browser.path));
  assert.equal(cleaned, true);

  const uncertain = harness();
  uncertain.setKillResult(false);
  let released = false;
  const liveItem = { ...item, fingerprintAbortPromise: null, fingerprintFailureCleanup: () => { released = true; } };
  assert.equal(await uncertain.engine.abortFingerprintProtection(liveItem, hardError()), false);
  assert.equal(released, false, 'failed termination must retain the profile lock');
  assert.equal(liveItem.stopping, true);
  assert.equal(uncertain.events.at(-1).running, true);
  assert.equal(uncertain.events.at(-1).reason, 'fingerprint-injection-failed');
}

async function checkStrictRuntime() {
  for (const scenario of ['page-soft', 'worker-exception', 'worker-mismatch', 'disconnect']) {
    const h = harness(); let blocked = false;
    const item = { profile: { id: 'strict-test', privacy: { strict: true }, exitTimezone: 'UTC' }, port: 123, pid: 424242, root: 'owned', browser: { path: 'owned-browser' }, child: { exitCode: null }, proxyForwarder: { block: () => { blocked = true; } } };
    const command = h.connection.command;
    h.connection.command = async (method, params, options) => {
      await command(method, params, options);
      if (method === 'Browser.close') { assert.equal(blocked, true, 'gate closes before asynchronous shutdown'); item.child.exitCode = 0; }
      if (method === 'Runtime.evaluate') return scenario === 'worker-exception' ? { exceptionDetails: { text: 'Uncaught' } } : { result: { value: ['timezone'] } };
      return { success: true };
    };
    h.engine.applyFingerprintToSession = async () => { throw new Error('temporary soft override'); };
    await h.engine.startWorkerFingerprintInjection(item, fp);
    if (scenario === 'disconnect') h.onDisconnect();
    else h.onAttached({ method: 'Target.attachedToTarget', params: { sessionId: 'protected', targetInfo: { type: scenario === 'page-soft' ? 'page' : 'worker', targetId: 'target', url: 'https://fixture.invalid' }, waitingForDebugger: true } });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(blocked, true); assert.equal(item.stopping, true);
    assert.equal(h.calls.some(([method]) => method === 'Runtime.runIfWaitingForDebugger'), false);
  }
  console.log('PASS strict page/worker errors and CDP loss close network before process work; targets never resume');
}

(async () => {
  await checkRuntimeAndReload();
  await checkAttached();
  await checkStartupTail();
  await checkOwnedTerminationFallback();
  await checkStrictRuntime();
  console.log('FINGERPRINT_FAILURE_LIFECYCLE_SELFTEST_OK runtime_close=1 retry_propagation=1 reload_propagation=1 attached_no_resume=1 startup_no_ready=1 soft_compatibility=1 owned_stop=1');
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
