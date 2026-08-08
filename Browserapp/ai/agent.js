'use strict';

/**
 * In-browser AI agent: a tool-calling loop over the CDP toolset.
 *
 * One agent session is pinned to one browser environment. The loop is
 * deliberately bounded (step cap + wall clock) — an agent that can navigate,
 * set breakpoints and run Node should not be able to spin unattended.
 *
 * Tool results are fed back as strings; large payloads are already clipped by
 * the toolset so a single script dump cannot blow the context window.
 */

const { randomUUID } = require('crypto');
const { AgentToolset } = require('./agent-tools');

const MAX_STEPS = 24;
const MAX_WALL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 40;
const MAX_TURNS = 200;

function nowIso() {
  return new Date().toISOString();
}

function summarise(value, max = 400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const raw = String(text == null ? '' : text);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

const SYSTEM_PROMPT = `你是 AiBrowser 内置的浏览器 AI Agent，运行在用户本机、绑定在一个已启动的浏览器环境上。
你能通过工具直接操作这个浏览器：页面读写、抓包、脚本搜索、下断点看调用栈与闭包变量、hook 函数、写脚本并用 Node 实跑验证。

工作方式：
1. 先用工具观察，再下结论。不要凭猜测描述页面内容或请求参数。
2. 逆向加密参数的常规路径：net_start 抓包 → net_search 定位参数出现在哪个请求 → net_detail 看发起调用栈
   → script_search 在源码里搜关键字 → debugger_set_xhr_breakpoint 或 debugger_set_breakpoint 断下来
   → debugger_state 看栈、debugger_eval_frame 读闭包中间值 → 还原算法 → fs_write 写成脚本 → node_run 实跑比对。
3. 每次只调用确实需要的工具。拿到足够信息就停下来给结论。
4. 绝不编造运行结果。node_run 没跑通就说没跑通，不要声称验证成功。
5. 不要输出完整 Cookie、token、密码等凭据原文。

能力边界（重要，不要误导用户）：
- 你的观测都在 CDP 层。页面级 hook 可能被页面反射检测或覆盖。
- 你没有引擎内核层能力：无法做 JSVMP 逐指令 trace、WASM import 边界观测、V8 分支差分。
  遇到重度 JSVMP / WASM 保护时，如实说明这一点，并给出 CDP 层能做到的替代方案。

回答用中文，简洁、可核验。`;

class BrowserAgent {
  /**
   * @param {object} options
   * @param {import('./ai-service').AiService} options.aiService
   * @param {object} options.engine  BrowserEngine
   * @param {string} options.outputDir
   */
  constructor(options = {}) {
    // Lazy resolution: the AI service is constructed after the automation stack
    // in main.js, so the agent must not capture it at build time.
    this._getAiService = typeof options.getAiService === 'function' ? options.getAiService : null;
    this._aiService = options.aiService || null;
    this.toolset = new AgentToolset({
      engine: options.engine || null,
      outputDir: options.outputDir,
      nodeBinary: options.nodeBinary,
    });
    this.sessions = new Map(); // sessionId -> { id, profileId, turns: [], createdAt, updatedAt }
  }

  get aiService() {
    return this._aiService || (this._getAiService ? this._getAiService() : null);
  }

  /**
   * Where generated scripts and dumps land.
   *
   * Reverse-engineering output belongs next to the work, so this is settable
   * per session from the sidebar. Rejecting a non-existent directory here beats
   * failing later inside fs_write, when the model has already burned steps.
   */
  getWorkspace() {
    return { path: this.toolset.outputDir };
  }

  setWorkspace(dir) {
    const next = String(dir || '').trim();
    if (!next) throw new Error('请提供工作目录');
    const fs = require('fs');
    const resolved = require('path').resolve(next);
    if (!fs.existsSync(resolved)) throw new Error('目录不存在：' + resolved);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('不是目录：' + resolved);
    this.toolset.outputDir = resolved;
    return { path: resolved };
  }

  set aiService(value) {
    this._aiService = value;
  }

  listSessions(profileId = null) {
    const wanted = profileId == null ? null : String(profileId);
    return [...this.sessions.values()]
      .filter((session) => wanted == null || session.profileId === wanted)
      .map((session) => ({
        id: session.id,
        profileId: session.profileId,
        title: session.title,
        turns: session.turns.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getSession(id) {
    const session = this.sessions.get(String(id || ''));
    if (!session) return null;
    return {
      id: session.id,
      profileId: session.profileId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      // Only the human-facing turns; raw tool plumbing stays server side.
      messages: session.turns
        .filter((turn) => turn.role === 'user' || (turn.role === 'assistant' && turn.content))
        .map((turn) => ({ role: turn.role, content: turn.content, at: turn.at })),
      toolTrace: session.trace.slice(-60),
    };
  }

  createSession(profileId) {
    const id = `agent-${randomUUID()}`;
    const session = {
      id,
      profileId: String(profileId || ''),
      title: '新会话',
      turns: [],
      trace: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.sessions.set(id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()]
        .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }
    return session;
  }

  deleteSession(id) {
    this.sessions.delete(String(id || ''));
    return { ok: true };
  }

  /**
   * Run one user message to completion (model may call tools in between).
   * `onEvent` streams progress so the sidebar can show tool activity live.
   */
  async run(input = {}, onEvent = null) {
    if (!this.aiService) throw new Error('AI 服务未就绪');
    const profileId = String(input.profileId || '').trim();
    if (!profileId) throw new Error('缺少 profileId：Agent 必须绑定一个已启动的环境');

    const message = String(input.message || '').trim();
    if (!message) throw new Error('请输入内容');

    let session = this.sessions.get(String(input.sessionId || ''));
    if (!session) session = this.createSession(profileId);
    session.profileId = profileId;
    if (session.turns.length === 0) session.title = message.replace(/\s+/g, ' ').slice(0, 42);

    const provider = this.aiService.resolveProvider(
      { id: input.providerId || this.aiService.activeProviderId }, true
    );
    const model = String(input.model || provider.model || '');

    session.turns.push({ role: 'user', content: message, at: nowIso() });
    const emit = (event) => { try { onEvent?.(event); } catch (_) { /* ignore */ } };

    const tools = this.toolset.definitions();
    const started = Date.now();
    let steps = 0;
    let finalText = '';

    for (;;) {
      if (steps >= MAX_STEPS) {
        finalText = `已达到单轮工具调用上限（${MAX_STEPS} 步）。目前的进展见上方工具记录；如需继续请再发一条消息。`;
        break;
      }
      if (Date.now() - started > MAX_WALL_MS) {
        finalText = '已达到单轮时间上限（5 分钟），先停下来。可以再发一条消息继续。';
        break;
      }

      const result = await this.aiService.completeTools(provider, session.turns, {
        model,
        system: SYSTEM_PROMPT,
        tools,
        maxTokens: 4096,
        temperature: 0.15,
      });

      if (!result.toolCalls || !result.toolCalls.length) {
        finalText = result.text || '(模型没有返回内容)';
        session.turns.push({ role: 'assistant', content: finalText, at: nowIso() });
        break;
      }

      session.turns.push({
        role: 'assistant',
        content: result.text || '',
        toolCalls: result.toolCalls,
        at: nowIso(),
      });
      if (result.text) emit({ type: 'assistant-note', text: result.text });

      for (const call of result.toolCalls) {
        steps += 1;
        emit({ type: 'tool-start', name: call.name, args: call.args });
        const startedAt = Date.now();
        let payload;
        let ok = true;
        try {
          const value = await this.toolset.call(call.name, call.args, { profileId });
          payload = typeof value === 'string' ? value : JSON.stringify(value);
        } catch (error) {
          ok = false;
          payload = `工具执行失败：${error.message}`;
        }
        const entry = {
          name: call.name,
          args: call.args,
          ok,
          ms: Date.now() - startedAt,
          preview: summarise(payload),
          at: nowIso(),
        };
        session.trace.push(entry);
        while (session.trace.length > 300) session.trace.shift();
        emit({ type: 'tool-end', ...entry });

        session.turns.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: String(payload),
          at: nowIso(),
        });
      }
    }

    while (session.turns.length > MAX_TURNS) session.turns.shift();
    session.updatedAt = nowIso();
    emit({ type: 'done', text: finalText });

    return {
      sessionId: session.id,
      profileId,
      text: finalText,
      steps,
      trace: session.trace.slice(-steps || -1),
    };
  }

  dispose() {
    this.toolset.releaseAll();
  }
}

module.exports = { BrowserAgent, SYSTEM_PROMPT };
