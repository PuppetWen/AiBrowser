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
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    const result = await call('Runtime.evaluate', {
      expression: `(async () => {
        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        switchView('proxies');
        await refreshProxies();
        const settings = document.querySelector('#proxy-subscription-settings');
        settings.click();
        await delay(80);
        const subscriptionDialog = document.querySelector('#proxy-subscription-dialog');
        const subscriptionForm = {
          opened: Boolean(subscriptionDialog?.open),
          urlConfigured: Boolean(document.querySelector('#proxy-subscription-url')?.value),
          groupName: document.querySelector('#proxy-subscription-group')?.value || '',
        };
        subscriptionDialog?.close();
        let created = null;
        try {
          created = await window.ops.proxyCreate({
            name: 'AiBrowser UI selftest',
            protocol: 'socks5',
            host: '127.0.0.1',
            port: 65530,
            groupId: proxyGroups[0]?.id || '',
            remark: 'temporary UI selftest',
          });
          await refreshProxies();
          openCreateProfileDialog();
          const proxyRadio = document.querySelector('input[name="create-network"][value="proxy"]');
          proxyRadio.checked = true;
          proxyRadio.dispatchEvent(new Event('change', { bubbles: true }));
          const select = document.querySelector('#create-proxy-library');
          select.value = created.id;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          const systemFront = document.querySelector('#create-proxy-system-front');
          systemFront.checked = true;
          systemFront.dispatchEvent(new Event('change', { bubbles: true }));
          const chainHint = document.querySelector('#create-proxy-chain-hint');
          const selected = proxyLibrary.find((item) => item.id === created.id);
          return {
            toolbar: {
              subscribe: Boolean(document.querySelector('#proxy-subscribe')),
              settings: Boolean(settings),
              legacyFrontSettings: Boolean(document.querySelector('#proxy-front-settings')),
              updateCard: Boolean(document.querySelector('[data-proxy-subscription-sync]')),
            },
            subscriptionForm,
            groupRows: document.querySelectorAll('.proxy-group-row').length,
            createDialog: {
              opened: Boolean(document.querySelector('#profile-dialog')?.open),
              optionFound: [...select.options].some((option) => option.value === created.id),
              selectedId: select.value,
              inputReadOnly: Boolean(document.querySelector('#create-proxy-input')?.readOnly),
              selectedName: selected?.name || '',
              systemFrontAvailable: Boolean(systemFront),
              systemFrontChecked: Boolean(systemFront?.checked),
              chainHintVisible: Boolean(chainHint && !chainHint.hidden),
              chainHintText: chainHint?.textContent || '',
            },
          };
        } finally {
          document.querySelector('#profile-dialog')?.close();
          if (created?.id) {
            await window.ops.proxyDelete([created.id]);
            await refreshProxies();
          }
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
    const value = result.result?.value;
    assert.equal(value?.toolbar?.subscribe, false);
    assert(value?.toolbar?.settings);
    assert.equal(value?.toolbar?.legacyFrontSettings, false);
    assert(value?.toolbar?.updateCard);
    assert(value?.subscriptionForm?.opened);
    assert.equal(value?.subscriptionForm?.urlConfigured, false);
    assert(value?.subscriptionForm?.groupName);
    assert(value?.groupRows >= 1);
    assert(value?.createDialog?.opened);
    assert(value?.createDialog?.optionFound);
    assert(value?.createDialog?.selectedId);
    assert(value?.createDialog?.inputReadOnly);
    assert(value?.createDialog?.systemFrontAvailable);
    assert(value?.createDialog?.systemFrontChecked);
    assert(value?.createDialog?.chainHintVisible);
    assert.match(value?.createDialog?.chainHintText || '', /系统代理/);
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
