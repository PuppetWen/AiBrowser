'use strict';

/**
 * CDP-backed toolset for the in-browser AI agent.
 *
 * Scope, stated plainly: everything here rides on the Chrome DevTools Protocol
 * against a browser kernel we launch but do not build. That covers page
 * control, full network capture, script source search, real breakpoints with
 * call frames and scope inspection, page-level hooks, and Node verification —
 * which is the bulk of practical JS reverse engineering.
 *
 * It does NOT cover engine-internal observation (per-instruction JSVMP trace,
 * WASM import boundary, V8 branch diffing). Those require patching and building
 * the engine itself; there is no CDP surface for them. Tools are named and
 * documented so the model cannot mistake one for the other.
 *
 * Each session pins one profile -> one CDP port -> one persistent connection,
 * so captured network/debugger state belongs to exactly one browser env.
 */

const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const cdp = require('../cdp');

const MAX_TEXT = 24000;
const MAX_ROWS = 200;
const MAX_BODY = 200000;

// Attribute channel to the MAIN-world bridge injected by the sidebar extension.
const BRIDGE_CMD = 'data-aibrowser-agent-cmd';
const BRIDGE_RES = 'data-aibrowser-agent-res';

/** Kernels that gate automation report it as a plan restriction, not a CDP error. */
function isAutomationGated(error) {
  return /paid .*plan|Browser automation requires/i.test(String(error?.message || ''));
}

function clip(value, max = MAX_TEXT) {
  const text = String(value == null ? '' : value);
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

function safeName(value, fallback = 'output') {
  const raw = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
  return raw && !/^\.+$/.test(raw) ? raw.slice(0, 120) : fallback;
}

/** One live attachment to a profile's browser: page session + captured state. */
class ProfileSession {
  constructor(port) {
    this.port = port;
    this.connection = null;
    this.sessionId = null;
    this.targetId = null;
    this.requests = new Map();   // requestId -> record
    this.order = [];
    this.capturing = false;
    this.paused = null;          // Debugger.paused payload
    this.scripts = new Map();    // scriptId -> { url, length }
    this.hookLogs = [];
    this.bridgeOnly = false;     // set once the kernel refuses Runtime.evaluate
    this._htmlNodeId = 0;
  }

  /** nodeId of <html>, re-resolved after navigation invalidates the old one. */
  async htmlNodeId() {
    if (this._htmlNodeId) {
      const check = await this.cmd('DOM.getAttributes', { nodeId: this._htmlNodeId }).catch(() => null);
      if (check) return this._htmlNodeId;
      this._htmlNodeId = 0;
    }
    await this.cmd('DOM.enable', {}).catch(() => {});
    const doc = await this.cmd('DOM.getDocument', { depth: 1, pierce: true });
    const rootNodeId = doc?.root?.nodeId;
    if (!rootNodeId) throw new Error('无法获取文档根节点');
    const html = await this.cmd('DOM.querySelector', { nodeId: rootNodeId, selector: 'html' });
    this._htmlNodeId = Number(html.nodeId) || 0;
    if (!this._htmlNodeId) throw new Error('无法定位 <html> 节点');
    return this._htmlNodeId;
  }

  async open() {
    if (this.connection && !this.connection.closed) return this;
    const tab = await cdp.firstTab(this.port);
    if (!tab?.webSocketDebuggerUrl) throw new Error('浏览器没有可用标签页');
    this.targetId = tab.id;
    this.connection = new cdp.PersistentConnection(tab.webSocketDebuggerUrl, {
      onEvent: (message) => this.onEvent(message),
    });
    await this.connection.open(8000);
    await this.connection.command('Runtime.enable', {}).catch(() => {});
    await this.connection.command('Page.enable', {}).catch(() => {});
    return this;
  }

  onEvent(message) {
    const { method, params } = message || {};
    if (!method) return;

    if (method === 'Network.requestWillBeSent') {
      const record = {
        id: params.requestId,
        url: params.request?.url || '',
        method: params.request?.method || 'GET',
        type: params.type || '',
        requestHeaders: params.request?.headers || {},
        postData: params.request?.postData || null,
        hasPostData: Boolean(params.request?.hasPostData),
        initiatorStack: params.initiator?.stack || null,
        status: null,
        responseHeaders: null,
        mimeType: null,
        body: null,
        at: this.order.length,
      };
      this.requests.set(record.id, record);
      this.order.push(record.id);
      // Bound memory; a busy page can emit thousands of requests.
      while (this.order.length > 1200) {
        const drop = this.order.shift();
        this.requests.delete(drop);
      }
      return;
    }

    if (method === 'Network.responseReceived') {
      const record = this.requests.get(params.requestId);
      if (!record) return;
      record.status = params.response?.status ?? null;
      record.responseHeaders = params.response?.headers || null;
      record.mimeType = params.response?.mimeType || null;
      return;
    }

    if (method === 'Debugger.scriptParsed') {
      this.scripts.set(params.scriptId, {
        scriptId: params.scriptId,
        url: params.url || '(inline)',
        length: params.length || 0,
      });
      return;
    }

    if (method === 'Debugger.paused') {
      this.paused = params;
      return;
    }

    if (method === 'Debugger.resumed') {
      this.paused = null;
      return;
    }

    if (method === 'Runtime.bindingCalled' && params.name === '__aibrowserHookLog') {
      try { this.hookLogs.push(JSON.parse(params.payload)); } catch (_) { /* ignore */ }
      while (this.hookLogs.length > 500) this.hookLogs.shift();
    }
  }

  cmd(method, params = {}, timeout = 15000) {
    if (!this.connection) throw new Error('CDP 会话未建立');
    return this.connection.command(method, params, { timeout });
  }

  close() {
    try { this.connection?.close(); } catch (_) { /* ignore */ }
    this.connection = null;
  }
}

class AgentToolset {
  /**
   * @param {object} options
   * @param {object} options.engine  BrowserEngine — resolves profileId -> CDP port
   * @param {string} options.outputDir  where generated scripts and dumps land
   * @param {string} [options.nodeBinary]
   */
  constructor(options = {}) {
    this.engine = options.engine || null;
    this.outputDir = options.outputDir || path.resolve(process.cwd(), 'rpa-output');
    this.nodeBinary = options.nodeBinary || process.execPath;
    this.sessions = new Map(); // profileId -> ProfileSession
  }

  portFor(profileId) {
    const id = String(profileId || '');
    const running = this.engine?.running;
    const entry = running instanceof Map ? running.get(id) : null;
    const port = Number(entry?.port || 0);
    if (!port) throw new Error(`环境未启动或没有调试端口：${id || '(未指定)'}`);
    return port;
  }

  async session(profileId) {
    const id = String(profileId || '');
    let session = this.sessions.get(id);
    if (session && session.connection && !session.connection.closed) return session;
    session = new ProfileSession(this.portFor(id));
    await session.open();
    this.sessions.set(id, session);
    return session;
  }

  release(profileId) {
    const id = String(profileId || '');
    this.sessions.get(id)?.close();
    this.sessions.delete(id);
  }

  releaseAll() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  /** JSON-schema tool definitions handed to the model. */
  definitions() {
    return TOOL_DEFS;
  }

  async call(name, args = {}, context = {}) {
    const handler = HANDLERS[name];
    if (!handler) throw new Error(`未知工具：${name}`);
    const profileId = context.profileId;
    return handler(this, args || {}, profileId);
  }

  // ---------- helpers ----------

  /**
   * Evaluate in the page.
   *
   * Prefers Runtime.evaluate. The bundled Wayfern kernel gates that behind a
   * paid plan, so on refusal we fall back to the MAIN-world bridge the sidebar
   * extension injects, driven through DOM attributes (DOM.* is not gated).
   * The fallback is sticky per session — retrying a blocked call every time
   * would double the latency of every single tool.
   */
  async evaluate(profileId, expression, options = {}) {
    const session = await this.session(profileId);
    if (!session.bridgeOnly) {
      try {
        const result = await session.cmd('Runtime.evaluate', {
          expression,
          returnByValue: options.returnByValue !== false,
          awaitPromise: options.awaitPromise !== false,
          allowUnsafeEvalBlockedByCSP: true,
        }, 30000);
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description
            || result.exceptionDetails.text
            || 'JS 执行失败');
        }
        return result.result?.value;
      } catch (error) {
        if (!isAutomationGated(error)) throw error;
        session.bridgeOnly = true;
      }
    }
    return this.evaluateViaBridge(session, expression);
  }

  /**
   * A page operation with two equivalent implementations.
   *
   * Full-CDP kernels take the Runtime.evaluate path; gated kernels take the
   * bridge's fixed op, which needs no eval and therefore survives a page CSP.
   * Callers state both once and never branch themselves.
   */
  async pageOp(profileId, opName, args, evalExpression) {
    const session = await this.session(profileId);
    if (!session.bridgeOnly) {
      try {
        const result = await session.cmd('Runtime.evaluate', {
          expression: evalExpression,
          returnByValue: true,
          awaitPromise: true,
          allowUnsafeEvalBlockedByCSP: true,
        }, 30000);
        if (result.exceptionDetails) {
          throw new Error(result.exceptionDetails.exception?.description
            || result.exceptionDetails.text || 'JS 执行失败');
        }
        return result.result?.value;
      } catch (error) {
        if (!isAutomationGated(error)) throw error;
        session.bridgeOnly = true;
      }
    }
    return this.bridgeCall(session, { op: opName, args });
  }

  /**
   * Run a fixed bridge operation.
   *
   * Preferred over `evaluate` for anything the bridge already implements: these
   * are concrete code paths in the injected script, so a page CSP without
   * 'unsafe-eval' cannot break them. Only genuinely arbitrary expressions
   * (page_eval, hooks) need the eval path.
   */
  async op(profileId, opName, args = {}) {
    const session = await this.session(profileId);
    return this.bridgeCall(session, { op: opName, args });
  }

  /** DOM-attribute round trip to the MAIN-world bridge script. */
  async evaluateViaBridge(session, expression) {
    return this.bridgeCall(session, { expression });
  }

  async bridgeCall(session, payload) {
    const nodeId = await session.htmlNodeId();
    const id = `ag-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const command = JSON.stringify({ id, ...payload });
    if (command.length > 64 * 1024) throw new Error('表达式过长，无法通过桥接执行');

    await session.cmd('DOM.removeAttribute', { nodeId, name: BRIDGE_RES }).catch(() => {});
    await session.cmd('DOM.setAttributeValue', { nodeId, name: BRIDGE_CMD, value: command });

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const attrs = await session.cmd('DOM.getAttributes', { nodeId }).catch(() => null);
      const list = Array.isArray(attrs?.attributes) ? attrs.attributes : [];
      let raw = null;
      for (let i = 0; i + 1 < list.length; i += 2) {
        if (list[i] === BRIDGE_RES) { raw = list[i + 1]; break; }
      }
      if (raw) {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        if (parsed && parsed.id === id) {
          await session.cmd('DOM.removeAttribute', { nodeId, name: BRIDGE_RES }).catch(() => {});
          if (!parsed.ok) throw new Error(parsed.error || '页面执行失败');
          return parsed.value;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error('页面桥接超时：请确认该标签页是 http/https 页面，且 AI 侧边栏扩展已加载');
  }

  outputPath(name, extension) {
    const base = safeName(name, 'output');
    const suffix = path.extname(base) ? '' : extension;
    return path.join(this.outputDir, base + suffix);
  }
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const HANDLERS = {
  // ----- page -----

  async page_info(kit, args, profileId) {
    return kit.pageOp(profileId, 'info', {}, `({
      url: location.href, title: document.title,
      readyState: document.readyState,
      cookieCount: (document.cookie||'').split(';').filter(Boolean).length
    })`);
  },

  async page_navigate(kit, args, profileId) {
    const url = String(args.url || '').trim();
    if (!url) throw new Error('page_navigate 需要 url');
    const session = await kit.session(profileId);
    await session.cmd('Page.navigate', { url }, 30000);
    await new Promise((resolve) => setTimeout(resolve, Number(args.waitMs) || 1500));
    return kit.evaluate(profileId, '({ url: location.href, title: document.title })');
  },

  async page_text(kit, args, profileId) {
    const selector = String(args.selector || '').trim();
    const expression = selector
      ? `(document.querySelector(${JSON.stringify(selector)})?.innerText || '')`
      : `((document.querySelector('article,main,[role=main]') || document.body).innerText || '')`;
    return clip(await kit.pageOp(profileId, 'text', { selector }, expression));
  },

  async page_html(kit, args, profileId) {
    const selector = String(args.selector || '').trim();
    const expression = selector
      ? `(document.querySelector(${JSON.stringify(selector)})?.outerHTML || '')`
      : 'document.documentElement.outerHTML';
    return clip(await kit.pageOp(profileId, 'html', { selector }, expression));
  },

  async page_query(kit, args, profileId) {
    const selector = String(args.selector || '').trim();
    if (!selector) throw new Error('page_query 需要 selector');
    const limit = Math.min(Number(args.limit) || 30, MAX_ROWS);
    return kit.pageOp(profileId, 'query', { selector, limit }, `(() => Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
      .slice(0, ${limit}).map((el, i) => ({
        i, tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 120),
        id: el.id || undefined,
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : undefined,
        href: el.getAttribute && el.getAttribute('href') || undefined
      })))()`);
  },

  async page_click(kit, args, profileId) {
    const selector = String(args.selector || '').trim();
    if (!selector) throw new Error('page_click 需要 selector');
    return kit.pageOp(profileId, 'click', { selector }, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not found' };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName.toLowerCase() };
    })()`);
  },

  async page_type(kit, args, profileId) {
    const selector = String(args.selector || '').trim();
    if (!selector) throw new Error('page_type 需要 selector');
    const text = String(args.text ?? '');
    const clear = args.clear !== false;
    return kit.pageOp(profileId, 'type', { selector, text, clear }, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'not found' };
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value');
      const next = ${clear ? '' : '(el.value || "") + '}${JSON.stringify(text)};
      if (setter && setter.set) setter.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: String(el.value || '').slice(0, 80) };
    })()`);
  },

  async page_eval(kit, args, profileId) {
    const expression = String(args.expression || '').trim();
    if (!expression) throw new Error('page_eval 需要 expression');
    const value = await kit.evaluate(profileId, expression);
    return typeof value === 'string' ? clip(value) : value;
  },

  async page_wait_selector(kit, args, profileId) {
    const selector = String(args.selector || '').trim();
    if (!selector) throw new Error('page_wait_selector 需要 selector');
    const deadline = Date.now() + Math.min(Number(args.timeoutMs) || 15000, 60000);
    for (;;) {
      const found = await kit.pageOp(profileId, 'exists', { selector },
        `!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return { ok: true, selector };
      if (Date.now() > deadline) return { ok: false, selector, reason: 'timeout' };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  },

  async page_cookies(kit, args, profileId) {
    const session = await kit.session(profileId);
    await session.cmd('Network.enable', {}).catch(() => {});
    const result = await session.cmd('Network.getCookies', {});
    return (result.cookies || []).slice(0, MAX_ROWS).map((c) => ({
      name: c.name, domain: c.domain, path: c.path,
      httpOnly: c.httpOnly, secure: c.secure,
      valuePreview: String(c.value || '').slice(0, 40),
    }));
  },

  async page_storage(kit, args, profileId) {
    const kind = String(args.kind || 'local') === 'session' ? 'sessionStorage' : 'localStorage';
    return kit.pageOp(profileId, 'storage', { kind: args.kind }, `(() => {
      const out = {};
      for (let i = 0; i < ${kind}.length && i < 100; i++) {
        const k = ${kind}.key(i);
        out[k] = String(${kind}.getItem(k) || '').slice(0, 300);
      }
      return out;
    })()`);
  },

  // ----- network capture -----

  async net_start(kit, args, profileId) {
    const session = await kit.session(profileId);
    await session.cmd('Network.enable', { maxTotalBufferSize: 40 * 1024 * 1024 });
    session.capturing = true;
    session.requests.clear();
    session.order.length = 0;
    return { ok: true, message: '已开始抓包（此后发生的请求会被记录）' };
  },

  async net_stop(kit, args, profileId) {
    const session = await kit.session(profileId);
    session.capturing = false;
    return { ok: true, captured: session.order.length };
  },

  async net_list(kit, args, profileId) {
    const session = await kit.session(profileId);
    const filter = String(args.urlContains || '').toLowerCase();
    const method = String(args.method || '').toUpperCase();
    const rows = session.order
      .map((id) => session.requests.get(id))
      .filter(Boolean)
      .filter((r) => (!filter || r.url.toLowerCase().includes(filter))
        && (!method || r.method === method))
      .slice(-(Math.min(Number(args.limit) || 50, MAX_ROWS)))
      .map((r) => ({
        id: r.id, method: r.method, status: r.status,
        type: r.type, mimeType: r.mimeType,
        url: r.url.slice(0, 300), hasPostData: r.hasPostData,
      }));
    return { total: session.order.length, shown: rows.length, requests: rows };
  },

  async net_detail(kit, args, profileId) {
    const session = await kit.session(profileId);
    const record = session.requests.get(String(args.id || ''));
    if (!record) throw new Error('未找到该请求 id，先用 net_list 获取');
    let body = record.body;
    if (body == null) {
      try {
        const res = await session.cmd('Network.getResponseBody', { requestId: record.id }, 20000);
        body = res.base64Encoded ? '[base64 binary]' : String(res.body || '');
        record.body = body;
      } catch (error) {
        body = `[响应体不可用：${error.message}]`;
      }
    }
    return {
      id: record.id,
      method: record.method,
      url: record.url,
      status: record.status,
      requestHeaders: record.requestHeaders,
      postData: clip(record.postData || '', 8000),
      responseHeaders: record.responseHeaders,
      body: clip(body, MAX_BODY > MAX_TEXT ? MAX_TEXT : MAX_BODY),
      initiatorTop: (record.initiatorStack?.callFrames || []).slice(0, 5)
        .map((f) => `${f.functionName || '(anonymous)'} @ ${f.url}:${f.lineNumber + 1}`),
    };
  },

  async net_search(kit, args, profileId) {
    const needle = String(args.pattern || '').trim();
    if (!needle) throw new Error('net_search 需要 pattern');
    const session = await kit.session(profileId);
    const lower = needle.toLowerCase();
    const hits = [];
    for (const id of session.order) {
      const record = session.requests.get(id);
      if (!record) continue;
      const where = [];
      if (record.url.toLowerCase().includes(lower)) where.push('url');
      if (String(record.postData || '').toLowerCase().includes(lower)) where.push('postData');
      if (JSON.stringify(record.requestHeaders || {}).toLowerCase().includes(lower)) where.push('requestHeaders');
      if (where.length) hits.push({ id: record.id, url: record.url.slice(0, 200), method: record.method, where });
      if (hits.length >= 50) break;
    }
    return { pattern: needle, hits };
  },

  // ----- scripts / debugger -----

  async script_list(kit, args, profileId) {
    const session = await kit.session(profileId);
    await session.cmd('Debugger.enable', {}).catch(() => {});
    // scriptParsed only fires forward; give the page a beat to replay on enable.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const filter = String(args.urlContains || '').toLowerCase();
    const rows = [...session.scripts.values()]
      .filter((s) => !filter || s.url.toLowerCase().includes(filter))
      .sort((a, b) => b.length - a.length)
      .slice(0, Math.min(Number(args.limit) || 40, MAX_ROWS));
    return { total: session.scripts.size, scripts: rows };
  },

  async script_source(kit, args, profileId) {
    const scriptId = String(args.scriptId || '').trim();
    if (!scriptId) throw new Error('script_source 需要 scriptId');
    const session = await kit.session(profileId);
    await session.cmd('Debugger.enable', {}).catch(() => {});
    const res = await session.cmd('Debugger.getScriptSource', { scriptId }, 30000);
    const source = String(res.scriptSource || '');
    const start = Math.max(0, Number(args.offset) || 0);
    return {
      scriptId,
      totalLength: source.length,
      offset: start,
      source: clip(source.slice(start), MAX_TEXT),
    };
  },

  async script_search(kit, args, profileId) {
    const query = String(args.pattern || '').trim();
    if (!query) throw new Error('script_search 需要 pattern');
    const session = await kit.session(profileId);
    await session.cmd('Debugger.enable', {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    const isRegex = args.isRegex === true;
    const targets = String(args.scriptId || '').trim()
      ? [{ scriptId: String(args.scriptId).trim(), url: '' }]
      : [...session.scripts.values()].sort((a, b) => b.length - a.length).slice(0, 60);
    const hits = [];
    for (const target of targets) {
      let res;
      try {
        res = await session.cmd('Debugger.searchInContent', {
          scriptId: target.scriptId, query, caseSensitive: false, isRegex,
        }, 15000);
      } catch (_) { continue; }
      for (const match of res.result || []) {
        hits.push({
          scriptId: target.scriptId,
          url: (session.scripts.get(target.scriptId)?.url || target.url || '').slice(0, 160),
          line: match.lineNumber + 1,
          text: String(match.lineContent || '').trim().slice(0, 240),
        });
        if (hits.length >= 80) break;
      }
      if (hits.length >= 80) break;
    }
    return { pattern: query, hits };
  },

  async debugger_set_breakpoint(kit, args, profileId) {
    const scriptId = String(args.scriptId || '').trim();
    if (!scriptId) throw new Error('debugger_set_breakpoint 需要 scriptId');
    const session = await kit.session(profileId);
    await session.cmd('Debugger.enable', {}).catch(() => {});
    const res = await session.cmd('Debugger.setBreakpoint', {
      location: {
        scriptId,
        lineNumber: Math.max(0, (Number(args.line) || 1) - 1),
        columnNumber: Number(args.column) || 0,
      },
      ...(args.condition ? { condition: String(args.condition) } : {}),
    }, 15000);
    return { breakpointId: res.breakpointId, actualLine: (res.actualLocation?.lineNumber ?? 0) + 1 };
  },

  async debugger_set_xhr_breakpoint(kit, args, profileId) {
    const session = await kit.session(profileId);
    await session.cmd('Debugger.enable', {}).catch(() => {});
    await session.cmd('DOMDebugger.setXHRBreakpoint', { url: String(args.urlContains || '') }, 15000);
    return { ok: true, urlContains: String(args.urlContains || ''), message: '命中时会暂停，用 debugger_state 查看调用栈' };
  },

  async debugger_state(kit, args, profileId) {
    const session = await kit.session(profileId);
    if (!session.paused) return { paused: false, message: '当前未暂停' };
    const frames = (session.paused.callFrames || []).slice(0, 12).map((frame, i) => ({
      index: i,
      functionName: frame.functionName || '(anonymous)',
      url: (session.scripts.get(frame.location?.scriptId)?.url || '').slice(0, 160),
      scriptId: frame.location?.scriptId,
      line: (frame.location?.lineNumber ?? 0) + 1,
    }));
    return { paused: true, reason: session.paused.reason, callFrames: frames };
  },

  async debugger_eval_frame(kit, args, profileId) {
    const session = await kit.session(profileId);
    if (!session.paused) throw new Error('当前未暂停，无法在栈帧上求值');
    const index = Math.max(0, Number(args.frameIndex) || 0);
    const frame = (session.paused.callFrames || [])[index];
    if (!frame) throw new Error(`没有第 ${index} 个栈帧`);
    const res = await session.cmd('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: String(args.expression || ''),
      returnByValue: true,
    }, 20000);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || '栈帧求值失败');
    const value = res.result?.value;
    return typeof value === 'string' ? clip(value) : value;
  },

  async debugger_resume(kit, args, profileId) {
    const session = await kit.session(profileId);
    const step = String(args.step || 'resume');
    const method = step === 'over' ? 'Debugger.stepOver'
      : step === 'into' ? 'Debugger.stepInto'
        : step === 'out' ? 'Debugger.stepOut'
          : 'Debugger.resume';
    await session.cmd(method, {}, 15000);
    return { ok: true, step };
  },

  // ----- page-level hooks -----

  async hook_function(kit, args, profileId) {
    const objectPath = String(args.objectPath || '').trim();
    const method = String(args.method || '').trim();
    if (!objectPath || !method) throw new Error('hook_function 需要 objectPath 和 method');
    const session = await kit.session(profileId);
    await session.cmd('Runtime.addBinding', { name: '__aibrowserHookLog' }).catch(() => {});
    const value = await kit.evaluate(profileId, `(() => {
      const target = ${objectPath};
      if (!target) return { ok: false, reason: 'objectPath 求值为空' };
      const key = ${JSON.stringify(method)};
      const original = target[key];
      if (typeof original !== 'function') return { ok: false, reason: key + ' 不是函数' };
      if (original.__aibrowserHooked) return { ok: true, already: true };
      const wrapped = function (...callArgs) {
        try {
          window.__aibrowserHookLog(JSON.stringify({
            fn: ${JSON.stringify(objectPath + '.' + method)},
            args: callArgs.map((a) => {
              try { return typeof a === 'string' ? a.slice(0, 300) : JSON.parse(JSON.stringify(a)); }
              catch (_) { return String(a).slice(0, 200); }
            }),
            stack: (new Error()).stack.split('\\n').slice(2, 8).join(' | ')
          }));
        } catch (_) {}
        const out = original.apply(this, callArgs);
        try {
          window.__aibrowserHookLog(JSON.stringify({
            fn: ${JSON.stringify(objectPath + '.' + method)},
            ret: typeof out === 'string' ? out.slice(0, 300) : String(out).slice(0, 200)
          }));
        } catch (_) {}
        return out;
      };
      wrapped.__aibrowserHooked = true;
      target[key] = wrapped;
      return { ok: true };
    })()`);
    return value;
  },

  async hook_logs(kit, args, profileId) {
    const session = await kit.session(profileId);
    const limit = Math.min(Number(args.limit) || 50, MAX_ROWS);
    return { total: session.hookLogs.length, logs: session.hookLogs.slice(-limit) };
  },

  // ----- files / verification -----

  async fs_write(kit, args) {
    const name = safeName(args.name, 'script');
    const target = kit.outputPath(name, '.js');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, String(args.content ?? ''), 'utf8');
    return { ok: true, path: target, bytes: Buffer.byteLength(String(args.content ?? ''), 'utf8') };
  },

  async fs_read(kit, args) {
    const target = kit.outputPath(safeName(args.name, 'script'), '.js');
    const text = await fsp.readFile(target, 'utf8');
    return { path: target, content: clip(text) };
  },

  async node_run(kit, args) {
    const target = kit.outputPath(safeName(args.name, 'script'), '.js');
    await fsp.access(target);
    return new Promise((resolve) => {
      const child = spawn(kit.nodeBinary, [target], {
        cwd: kit.outputDir,
        timeout: Math.min(Number(args.timeoutMs) || 20000, 60000),
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk) => { stdout += chunk; });
      child.stderr?.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => resolve({ ok: false, error: error.message }));
      child.on('close', (code) => resolve({
        ok: code === 0,
        exitCode: code,
        stdout: clip(stdout, 8000),
        stderr: clip(stderr, 4000),
      }));
    });
  },
};

// ---------------------------------------------------------------------------
// Schemas handed to the model
// ---------------------------------------------------------------------------

function def(name, description, properties = {}, required = []) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  };
}

const S = {
  selector: { type: 'string', description: 'CSS 选择器' },
  url: { type: 'string', description: '完整 URL' },
};

const TOOL_DEFS = Object.freeze([
  def('page_info', '读取当前页地址、标题、加载状态'),
  def('page_navigate', '导航到指定 URL 并等待', { url: S.url, waitMs: { type: 'number' } }, ['url']),
  def('page_text', '提取正文纯文本；不传 selector 则取主内容区', { selector: S.selector }),
  def('page_html', '提取 HTML；不传 selector 则取整页', { selector: S.selector }),
  def('page_query', '按选择器列出匹配元素的文本与属性', { selector: S.selector, limit: { type: 'number' } }, ['selector']),
  def('page_click', '点击匹配的第一个元素', { selector: S.selector }, ['selector']),
  def('page_type', '向输入框写入文本并派发 input/change 事件', { selector: S.selector, text: { type: 'string' }, clear: { type: 'boolean' } }, ['selector', 'text']),
  def('page_eval', '在页面上下文执行 JS 表达式并返回结果', { expression: { type: 'string' } }, ['expression']),
  def('page_wait_selector', '轮询等待元素出现', { selector: S.selector, timeoutMs: { type: 'number' } }, ['selector']),
  def('page_cookies', '列出当前页 Cookie（值只给前缀，避免泄露完整凭据）'),
  def('page_storage', '导出 localStorage 或 sessionStorage', { kind: { type: 'string', enum: ['local', 'session'] } }),

  def('net_start', '开始抓包。必须先调用，之后发生的请求才会被记录'),
  def('net_stop', '停止抓包并返回已记录数量'),
  def('net_list', '列出已抓到的请求（可按 URL 子串/方法过滤）', { urlContains: { type: 'string' }, method: { type: 'string' }, limit: { type: 'number' } }),
  def('net_detail', '查看单个请求的完整头、请求体、响应体和发起调用栈', { id: { type: 'string' } }, ['id']),
  def('net_search', '在已抓请求的 URL / 请求体 / 请求头里搜索关键字，用于定位加密参数出现在哪个请求', { pattern: { type: 'string' } }, ['pattern']),

  def('script_list', '列出页面已加载的 JS 脚本（按体积倒序）', { urlContains: { type: 'string' }, limit: { type: 'number' } }),
  def('script_source', '读取指定脚本源码，支持 offset 分段读取', { scriptId: { type: 'string' }, offset: { type: 'number' } }, ['scriptId']),
  def('script_search', '在脚本源码中搜索字符串或正则，用于定位签名函数', { pattern: { type: 'string' }, scriptId: { type: 'string' }, isRegex: { type: 'boolean' } }, ['pattern']),

  def('debugger_set_breakpoint', '在脚本指定行下断点，可带条件表达式', { scriptId: { type: 'string' }, line: { type: 'number' }, column: { type: 'number' }, condition: { type: 'string' } }, ['scriptId', 'line']),
  def('debugger_set_xhr_breakpoint', '设置 XHR/fetch 断点：URL 含指定子串时中断，用于抓签名生成的调用栈', { urlContains: { type: 'string' } }, ['urlContains']),
  def('debugger_state', '查看是否已暂停，以及当前调用栈'),
  def('debugger_eval_frame', '在指定栈帧的作用域内求值，可读取闭包内的中间变量', { frameIndex: { type: 'number' }, expression: { type: 'string' } }, ['frameIndex', 'expression']),
  def('debugger_resume', '恢复执行或单步（resume/over/into/out）', { step: { type: 'string', enum: ['resume', 'over', 'into', 'out'] } }),

  def('hook_function', '在页面里包裹指定函数，记录每次调用的入参、返回值和调用栈。objectPath 例如 window.JSON 或 window.crypto.subtle', { objectPath: { type: 'string' }, method: { type: 'string' } }, ['objectPath', 'method']),
  def('hook_logs', '读取 hook 记录到的调用日志', { limit: { type: 'number' } }),

  def('fs_write', '把生成的脚本写入本地 rpa-output 目录', { name: { type: 'string' }, content: { type: 'string' } }, ['name', 'content']),
  def('fs_read', '读回之前写入的脚本', { name: { type: 'string' } }, ['name']),
  def('node_run', '用 Node 实跑生成的脚本并返回 stdout/stderr，用于验证算法是否复现成功', { name: { type: 'string' }, timeoutMs: { type: 'number' } }, ['name']),
]);

module.exports = { AgentToolset, ProfileSession, TOOL_DEFS };
