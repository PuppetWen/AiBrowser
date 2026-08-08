'use strict';

const assert = require('assert');
const { startAiBrowserCdp } = require('./aibrowser-cdp-fixture');

async function loadTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json`).then((item) => item.json());
  return Array.isArray(response) ? response : [];
}

async function main() {
  const port = Number(process.argv[2] || 19333);
  let fixture = null;
  let targets;
  try {
    targets = await loadTargets(port);
  } catch (error) {
    fixture = await startAiBrowserCdp(port);
    targets = await loadTargets(port);
  }
  const target = targets.find((item) => item.title === 'AiBrowser');
  if (!target?.webSocketDebuggerUrl) throw new Error('AiBrowser CDP target not found');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.error) task.reject(new Error(message.error.message));
    else task.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  try {
    const response = await call('Runtime.evaluate', {
      expression: `(async () => {
        switchView('proxies');
        await refreshProxies();
        const subscriptionId = proxySubscriptions[0]?.id;
        if (!subscriptionId) throw new Error('subscription missing');
        const sync = await window.ops.proxySubscriptionSync(subscriptionId);
        await refreshProxies();
        openCreateProfileDialog();
        const proxyRadio = document.querySelector('input[name="create-network"][value="proxy"]');
        proxyRadio.checked = true;
        proxyRadio.dispatchEvent(new Event('change', { bubbles: true }));
        const select = document.querySelector('#create-proxy-library');
        const first = proxyLibrary[0];
        select.value = first?.id || '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        let controlledIpcError = false;
        try {
          await window.ops.proxySubscriptionSync('missing-selftest-subscription');
        } catch (error) {
          controlledIpcError = /订阅不存在/.test(String(error?.message || error));
        }
        let engineProxyCheck = null;
        let lastProxyError = '';
        for (const [index, item] of proxyLibrary.slice(0, 3).entries()) {
          try {
            const network = await window.ops.testProfileProxy({
              id: 'proxy-live-selftest',
              name: 'proxy-live-selftest',
              networkMode: 'proxy',
              proxy: 'socks5://127.0.0.1:9',
              proxyMeta: { libraryProxyId: item.id },
            });
            engineProxyCheck = {
              ok: Boolean(network?.ip),
              countryCode: network?.countryCode || '',
              protocol: item.protocol,
              testedIndex: index + 1,
            };
            break;
          } catch (error) {
            lastProxyError = String(error?.message || error);
          }
        }
        if (!engineProxyCheck) throw new Error(lastProxyError || 'AnyTLS proxy check failed');
        for (const group of proxyGroups) group.collapsed = false;
        renderProxies();
        const state = {
          imported: sync.imported,
          skipped: sync.skipped,
          itemCount: proxyLibrary.length,
          groupCount: proxyGroups.length,
          protocols: proxyLibrary.reduce((out, item) => {
            out[item.protocol] = Number(out[item.protocol] || 0) + 1;
            return out;
          }, {}),
          tableRows: document.querySelectorAll('#proxy-table tr').length,
          countText: document.querySelector('#proxy-count')?.textContent || '',
          selectorOptions: select.options.length,
          selectorGroups: select.querySelectorAll('optgroup').length,
          selected: select.value === first?.id,
          inputReadOnly: Boolean(document.querySelector('#create-proxy-input')?.readOnly),
          subscriptionError: proxySubscriptions[0]?.lastError || '',
          controlledIpcError,
          engineProxyCheck,
        };
        document.querySelector('#profile-dialog')?.close();
        return state;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed');
    const value = response.result?.value;
    assert(Number.isInteger(value?.imported) && value.imported > 0);
    assert.equal(value?.skipped, 0);
    assert(value?.itemCount >= value.imported);
    assert(value?.protocols?.anytls >= value.imported);
    assert(value?.tableRows >= value.itemCount + 1);
    assert.match(value?.countText || '', new RegExp(String(value.itemCount)));
    assert(value?.selectorOptions >= value.itemCount + 1);
    assert(value?.selectorGroups >= 1);
    assert(value?.selected);
    assert(value?.inputReadOnly);
    assert.equal(value?.subscriptionError, '');
    assert(value?.controlledIpcError);
    assert(value?.engineProxyCheck?.ok);
    assert.equal(value?.engineProxyCheck?.protocol, 'anytls');
    console.log(JSON.stringify({ ok: true, ...value }));
  } finally {
    socket.close();
    await fixture?.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
