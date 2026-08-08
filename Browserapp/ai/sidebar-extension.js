'use strict';

/**
 * Emits the AI side panel into a profile's generated extension.
 *
 * Docking, and why it is a native side panel rather than an in-page overlay:
 * an overlay can shrink <html>, but the *viewport* is unchanged, so every
 * position:fixed element on the page still spans the full width and slides
 * underneath it. Chrome's side panel is browser chrome — the page viewport
 * really is narrower, exactly like DevTools docked to the right. It is also
 * resizable and persistent across tabs for free.
 *
 * Split by trust boundary:
 *   ai-background.js — service worker. Sole holder of the loopback API key.
 *   ai-panel.js      — extension page (the panel UI). Reaches the API only
 *                      through the worker, so the key stays in one place.
 *   ai-launcher.js   — tiny content script: a button that asks the worker to
 *                      open the panel. Never sees the key.
 *   ai-bridge.js     — MAIN-world content script used by the agent's tools to
 *                      evaluate in the page. Unrelated to the UI.
 */

const path = require('path');
const fsp = require('fs/promises');

function backgroundJs(config) {
  return `// AiBrowser side panel — privileged half. Owns the loopback credential.
const CONFIG = ${JSON.stringify(config, null, 2)};

async function api(pathname, { method = 'GET', body = null } = {}) {
  const url = new URL(pathname, CONFIG.apiBase);
  const response = await fetch(url.toString(), {
    method,
    headers: { 'Content-Type': 'application/json', 'api-key': CONFIG.apiKey },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch (_) { /* keep null */ }
  if (!response.ok) throw new Error((payload && (payload.msg || payload.message)) || ('HTTP ' + response.status));
  if (payload && payload.code != null && payload.code !== 0) throw new Error(payload.msg || '请求失败');
  return payload ? payload.data : null;
}

// Clicking the toolbar icon opens the panel. This is the reliable path: a
// programmatic open needs a user gesture that a content-script message does
// not always carry.
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (_) {}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'openPanel') {
        const tabId = sender.tab && sender.tab.id;
        const windowId = sender.tab && sender.tab.windowId;
        try {
          if (tabId != null) await chrome.sidePanel.setOptions({ tabId, path: 'ai-panel.html', enabled: true });
          await chrome.sidePanel.open(windowId != null ? { windowId } : { tabId });
          sendResponse({ ok: true });
        } catch (_) {
          // Chrome requires sidePanel.open() to run inside a user gesture, and a
          // gesture does not survive the hop from a content script through
          // runtime.sendMessage. The toolbar icon is the dependable route and is
          // already wired via openPanelOnActionClick, so point there rather than
          // surfacing a raw API error the user cannot act on.
          sendResponse({ ok: false, error: '请点击工具栏上的 AiBrowser 图标（环境编号）打开 AI 侧边栏' });
        }
        return;
      }
      if (message.type === 'config') {
        sendResponse({ ok: true, data: { profileId: CONFIG.profileId, envLabel: CONFIG.envLabel } });
        return;
      }
      if (message.type === 'providers') {
        sendResponse({ ok: true, data: await api('/api/ai/agent/providers') });
        return;
      }
      if (message.type === 'tools') {
        sendResponse({ ok: true, data: await api('/api/ai/agent/tools') });
        return;
      }
      if (message.type === 'workspace') {
        sendResponse({ ok: true, data: await api('/api/ai/agent/workspace') });
        return;
      }
      if (message.type === 'setWorkspace') {
        sendResponse({ ok: true, data: await api('/api/ai/agent/workspace', { method: 'POST', body: { path: message.path } }) });
        return;
      }
      if (message.type === 'run') {
        sendResponse({ ok: true, data: await api('/api/ai/agent/run', {
          method: 'POST',
          body: {
            profileId: CONFIG.profileId,
            sessionId: message.sessionId || null,
            message: message.text,
            providerId: message.providerId || null,
          },
        }) });
        return;
      }
      sendResponse({ ok: false, error: '未知指令: ' + message.type });
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message || error) });
    }
  })();
  return true; // async responder
});
`;
}

/**
 * MAIN-world evaluation bridge.
 *
 * The bundled Wayfern kernel refuses Runtime.evaluate ("requires a paid Donut
 * Browser plan"), which would otherwise disable most page tools. This runs in
 * the page's own JS world (MV3 world: "MAIN") and takes commands through
 * attributes on <html> — DOM.setAttributeValue / DOM.getAttributes are allowed
 * on that kernel.
 *
 * MAIN world matters: an isolated-world bridge could touch the DOM but never
 * read page globals or wrap page functions, which is what reverse engineering
 * actually needs.
 */
const BRIDGE_JS = String.raw`(() => {
  if (window.__aibrowserAgentBridge) return;
  window.__aibrowserAgentBridge = true;

  const CMD = 'data-aibrowser-agent-cmd';
  const RES = 'data-aibrowser-agent-res';
  const root = document.documentElement;
  let lastId = null;

  function reply(id, ok, payload) {
    let body;
    try {
      body = JSON.stringify({ id, ok, value: ok ? payload : undefined, error: ok ? undefined : String(payload) });
    } catch (error) {
      body = JSON.stringify({ id, ok: false, error: 'result not serialisable: ' + String(error && error.message) });
    }
    if (body.length > 1000000) {
      body = JSON.stringify({ id, ok: false, error: 'result too large (' + body.length + ' bytes)' });
    }
    root.setAttribute(RES, body);
  }

  // Fixed operations: plain code paths, never eval, so a page CSP without
  // 'unsafe-eval' cannot disable them.
  const OPS = {
    info() {
      return {
        url: location.href, title: document.title,
        readyState: document.readyState,
        cookieCount: (document.cookie || '').split(';').filter(Boolean).length,
      };
    },
    text(a) {
      const el = a.selector ? document.querySelector(a.selector)
        : (document.querySelector('article,main,[role=main]') || document.body);
      return el ? (el.innerText || el.textContent || '') : '';
    },
    html(a) {
      const el = a.selector ? document.querySelector(a.selector) : document.documentElement;
      return el ? el.outerHTML : '';
    },
    query(a) {
      const limit = Math.min(Number(a.limit) || 30, 200);
      return Array.from(document.querySelectorAll(a.selector)).slice(0, limit).map((el, i) => ({
        i, tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 120),
        id: el.id || undefined,
        cls: typeof el.className === 'string' ? el.className.slice(0, 80) : undefined,
        href: el.getAttribute ? (el.getAttribute('href') || undefined) : undefined,
      }));
    },
    click(a) {
      const el = document.querySelector(a.selector);
      if (!el) return { ok: false, reason: 'not found' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase() };
    },
    type(a) {
      const el = document.querySelector(a.selector);
      if (!el) return { ok: false, reason: 'not found' };
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      const next = a.clear === false ? String(el.value || '') + String(a.text) : String(a.text);
      if (desc && desc.set) desc.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: String(el.value || '').slice(0, 80) };
    },
    exists(a) { return !!document.querySelector(a.selector); },
    storage(a) {
      const store = a.kind === 'session' ? sessionStorage : localStorage;
      const out = {};
      for (let i = 0; i < store.length && i < 100; i += 1) {
        const key = store.key(i);
        out[key] = String(store.getItem(key) || '').slice(0, 300);
      }
      return out;
    },
    scroll(a) { window.scrollBy({ top: Number(a.deltaY) || 600, behavior: 'smooth' }); return { ok: true }; },
  };

  // Arbitrary expressions still need eval; a strict page CSP can refuse it.
  // Fall back to an inline script, and if that is refused too, say so plainly
  // rather than returning a misleading empty result.
  function evaluateExpression(expression) {
    try {
      return { ok: true, value: (0, eval)(expression) };
    } catch (error) {
      if (!/Content Security Policy|unsafe-eval/i.test(String(error && error.message))) throw error;
    }
    const slot = '__aibrowserEvalOut_' + Math.random().toString(16).slice(2);
    const script = document.createElement('script');
    script.textContent = 'try{window["' + slot + '"]={ok:true,value:(' + expression + ')}}'
      + 'catch(e){window["' + slot + '"]={ok:false,error:String(e&&e.message||e)}}';
    (document.head || document.documentElement).appendChild(script);
    script.remove();
    const out = window[slot];
    delete window[slot];
    if (!out) {
      throw new Error('页面 CSP 同时禁止了 eval 和内联脚本，无法在此页执行任意表达式；'
        + 'DOM 类操作仍可用，或改用支持完整 CDP 的内核');
    }
    if (!out.ok) throw new Error(out.error);
    return { ok: true, value: out.value };
  }

  async function run() {
    const raw = root.getAttribute(CMD);
    if (!raw) return;
    let command;
    try { command = JSON.parse(raw); } catch (_) { return; }
    if (!command || command.id === lastId) return;
    lastId = command.id;
    try {
      let value;
      if (command.op && OPS[command.op]) {
        value = await Promise.resolve(OPS[command.op](command.args || {}));
      } else {
        value = await Promise.resolve(evaluateExpression(command.expression).value);
      }
      reply(command.id, true, value === undefined ? null : value);
    } catch (error) {
      reply(command.id, false, (error && error.message) || error);
    }
  }

  new MutationObserver(run).observe(root, { attributes: true, attributeFilter: [CMD] });
  run();
})();
`;

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AiBrowser AI</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column;
    background: #0f1720; color: #e8f1f2;
    font: 13px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
    border-bottom: 1px solid rgba(120,220,210,.16); }
  .mark { width: 18px; height: 18px; border-radius: 5px; flex: 0 0 18px;
    background: linear-gradient(160deg, #0E3B57, #2FD8C3); }
  .title { font-weight: 650; letter-spacing: -.01em; }
  .env { color: #8CA7B5; font-size: 11px; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 8px 12px;
    border-bottom: 1px solid rgba(120,220,210,.12); }
  select, input {
    background: #16222c; color: #e8f1f2; border: 1px solid rgba(120,220,210,.2);
    border-radius: 6px; padding: 5px 8px; font: inherit; min-width: 0;
  }
  select { flex: 1; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: #2FD8C3; }
  .status { color: #2FD8C3; font-size: 11px; white-space: nowrap; }
  .ws-label { color: #8CA7B5; font-size: 11px; flex: 0 0 auto; }
  .ws-path { flex: 1; font: 11px ui-monospace, Consolas, monospace; }
  .ws-apply { flex: 0 0 auto; background: transparent; color: #2FD8C3;
    border: 1px solid rgba(47,216,195,.45); border-radius: 6px;
    padding: 4px 9px; font: 11px system-ui, sans-serif; cursor: pointer; }
  .ws-apply:hover { background: rgba(47,216,195,.12); }
  .messages { flex: 1; min-height: 0; overflow-y: auto; padding: 12px;
    display: flex; flex-direction: column; gap: 10px; }
  .msg { white-space: pre-wrap; word-break: break-word; padding: 8px 10px; border-radius: 8px; }
  .msg.user { background: rgba(47,216,195,.13); align-self: flex-end; max-width: 88%; }
  .msg.assistant { background: #16222c; }
  .msg.pending { color: #8CA7B5; font-style: italic; }
  .msg.error { background: rgba(255,110,110,.14); color: #ffb3b3; }
  .trace { border: 1px solid rgba(120,220,210,.18); border-radius: 8px; overflow: hidden; }
  .trace-head { padding: 6px 10px; background: #14202a; color: #8CA7B5;
    font-size: 11px; cursor: pointer; user-select: none; }
  .trace-body { display: none; max-height: 260px; overflow: auto; }
  .trace.open .trace-body { display: block; }
  .trace-row { padding: 6px 10px; border-top: 1px solid rgba(120,220,210,.1);
    font: 11px/1.5 ui-monospace, Consolas, monospace; white-space: pre-wrap;
    word-break: break-all; color: #a7c4cf; }
  .trace-row.bad { color: #ffb3b3; }
  .composer { display: flex; gap: 8px; padding: 10px 12px;
    border-top: 1px solid rgba(120,220,210,.16); }
  .composer textarea { flex: 1; min-height: 62px; max-height: 170px; resize: vertical;
    background: #16222c; color: #e8f1f2; border: 1px solid rgba(120,220,210,.2);
    border-radius: 8px; padding: 8px; font: inherit; }
  .send { align-self: flex-end; background: #2FD8C3; color: #04211d; border: 0;
    border-radius: 8px; padding: 9px 14px; font: 650 13px system-ui, sans-serif; cursor: pointer; }
  .send:disabled { opacity: .5; cursor: not-allowed; }
  .hint { padding: 0 12px 10px; color: #6d8794; font-size: 11px; }
</style>
</head>
<body>
  <div class="head">
    <span class="mark"></span><span class="title">AiBrowser AI</span><span class="env"></span>
  </div>
  <div class="bar">
    <select class="provider"></select>
    <span class="status"></span>
  </div>
  <div class="bar">
    <span class="ws-label">工作目录</span>
    <input class="ws-path" spellcheck="false" placeholder="脚本与抓包结果的保存位置">
    <button class="ws-apply" type="button">应用</button>
  </div>
  <div class="messages"></div>
  <div class="composer">
    <textarea placeholder="描述你要做的事，例如：抓包找出这个页面登录请求里的 sign 参数是怎么算的"></textarea>
    <button class="send">发送</button>
  </div>
  <div class="hint">Ctrl+Enter 发送 · 面板宽度可拖动边缘调整</div>
  <script src="ai-panel.js"></script>
</body>
</html>
`;

const PANEL_JS = String.raw`// AiBrowser AI panel UI. Extension page — no credential here; the worker holds it.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const list = $('.messages');
  const input = $('.composer textarea');
  const sendBtn = $('.send');
  const providerSel = $('.provider');
  const envLabel = $('.env');
  const status = $('.status');
  const wsPath = $('.ws-path');
  const wsApply = $('.ws-apply');

  let sessionId = null;
  let busy = false;

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
          resolve(reply || { ok: false, error: '无响应' });
        });
      } catch (error) { resolve({ ok: false, error: String(error && error.message || error) }); }
    });
  }

  function addMessage(role, text) {
    const item = document.createElement('div');
    item.className = 'msg ' + role;
    item.textContent = text;
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    return item;
  }

  function addTrace(entries) {
    if (!entries || !entries.length) return;
    const box = document.createElement('div');
    box.className = 'trace';
    const head = document.createElement('div');
    head.className = 'trace-head';
    head.textContent = '工具调用 ' + entries.length + ' 次（点击展开）';
    const body = document.createElement('div');
    body.className = 'trace-body';
    for (const entry of entries) {
      const row = document.createElement('div');
      row.className = 'trace-row' + (entry.ok ? '' : ' bad');
      row.textContent = (entry.ok ? '✓ ' : '✗ ') + entry.name + '  ' + entry.ms + 'ms\n' + (entry.preview || '');
      body.appendChild(row);
    }
    head.addEventListener('click', () => box.classList.toggle('open'));
    box.appendChild(head); box.appendChild(body);
    list.appendChild(box);
    list.scrollTop = list.scrollHeight;
  }

  async function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; input.value = ''; sendBtn.disabled = true;
    addMessage('user', text);
    const pending = addMessage('assistant pending', '正在工作…');
    status.textContent = '运行中';

    const reply = await send({ type: 'run', text, sessionId, providerId: providerSel.value || null });

    status.textContent = '';
    if (!reply.ok) {
      pending.className = 'msg error';
      pending.textContent = '失败：' + reply.error;
    } else {
      sessionId = reply.data.sessionId || sessionId;
      pending.className = 'msg assistant';
      pending.textContent = reply.data.text || '(无内容)';
      addTrace(reply.data.trace);
    }
    busy = false; sendBtn.disabled = false; input.focus();
  }

  sendBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
  });

  wsApply.addEventListener('click', async () => {
    const value = wsPath.value.trim();
    if (!value) return;
    status.textContent = '设置目录…';
    const reply = await send({ type: 'setWorkspace', path: value });
    if (reply.ok) {
      wsPath.value = reply.data.path;
      status.textContent = '目录已更新';
      setTimeout(() => { status.textContent = ''; }, 2000);
    } else {
      status.textContent = '';
      addMessage('error', '设置工作目录失败：' + reply.error);
    }
  });
  wsPath.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); wsApply.click(); }
  });

  (async () => {
    const config = await send({ type: 'config' });
    if (config.ok) envLabel.textContent = '环境 ' + (config.data.envLabel || '');

    const ws = await send({ type: 'workspace' });
    if (ws.ok && ws.data) wsPath.value = ws.data.path || '';
    else wsPath.placeholder = '读取工作目录失败：' + (ws.error || '无数据');

    const providers = await send({ type: 'providers' });
    providerSel.replaceChildren();
    if (providers.ok && providers.data && providers.data.providers.length) {
      let usableProviders = 0;
      let firstProviderError = '';
      for (const provider of providers.data.providers) {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.name + (provider.model ? ' · ' + provider.model : '');
        option.disabled = provider.keyUsable === false;
        if (option.disabled) {
          option.textContent += ' · 需要重新填写 API Key';
          firstProviderError ||= provider.keyError || 'API Key 当前不可用';
        } else {
          usableProviders += 1;
          if (provider.id === providers.data.activeProviderId) option.selected = true;
        }
        providerSel.appendChild(option);
      }
      if (!providerSel.value || providerSel.selectedOptions[0]?.disabled) {
        const firstUsable = [...providerSel.options].find((option) => !option.disabled);
        if (firstUsable) firstUsable.selected = true;
      }
      if (!usableProviders) {
        sendBtn.disabled = true;
        addMessage('error', firstProviderError + '。请回到 AiBrowser 主程序的“AI 接入”中重新填写并测试保存。');
      }
    } else {
      const option = document.createElement('option');
      option.textContent = '未配置 AI（请在主程序「AI 接入」中添加）';
      providerSel.appendChild(option);
      sendBtn.disabled = true;
    }
  })();
})();
`;

/** Stable 0..65535 digest — manifest version parts cap at 65535. */
function buildStamp(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) & 0xffff;
  }
  return hash;
}

/**
 * Build stamp for a config, computable before anything is written.
 *
 * The caller uses this to pick a build-specific extension directory. Chrome
 * keys a registered MV3 service worker to the extension id, which for an
 * unpacked extension derives from its path — so reusing the path meant an
 * edited background script kept being answered by the previously registered
 * worker even after a manifest version bump. A new path is a new id, which is
 * the only reliable way to guarantee a fresh worker.
 */
function stampFor(config) {
  return buildStamp(backgroundJs(config) + BRIDGE_JS + PANEL_HTML + PANEL_JS);
}

/**
 * Write panel files into an already-prepared extension directory and return
 * the manifest fragments the caller must merge.
 */
async function writeSidebarAssets(dest, config) {
  const background = backgroundJs(config);
  await fsp.writeFile(path.join(dest, 'ai-background.js'), background, 'utf8');
  await fsp.writeFile(path.join(dest, 'ai-bridge.js'), BRIDGE_JS, 'utf8');
  await fsp.writeFile(path.join(dest, 'ai-panel.html'), PANEL_HTML, 'utf8');
  await fsp.writeFile(path.join(dest, 'ai-panel.js'), PANEL_JS, 'utf8');
  return {
    buildStamp: stampFor(config),
    background: { service_worker: 'ai-background.js' },
    host_permissions: [`${config.apiBase.replace(/\/+$/, '')}/*`],
    permissions: ['storage', 'sidePanel'],
    sidePanel: { default_path: 'ai-panel.html' },
    // No in-page launcher. Chrome only opens a side panel from a toolbar-action
    // gesture, so an in-page button could never do it — verified with both a
    // synthetic click and a real dispatched mouse event. Shipping a button that
    // cannot work is worse than not shipping one; the toolbar icon is the entry.
    contentScripts: [
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['ai-bridge.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: false,
      },
    ],
  };
}

module.exports = {
  writeSidebarAssets,
  stampFor,
  BRIDGE_JS,
  PANEL_HTML,
  PANEL_JS,
  backgroundJs,
};
