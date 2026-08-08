'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
let safeStorage = null;
try {
  ({ safeStorage } = require('../host-bridge'));
} catch (_) {
  // Plain Node self-tests do not load the Electron host. Saving a key remains
  // disabled there; the real desktop main process always provides safeStorage.
}
const {
  RPA_PLUS_ACTIONS,
  ACTION_PARAM_SCHEMA,
  normalizeStep,
  isRegistered,
} = require('../automation/protocol/rpa-registry');

const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'openai',
    name: 'OpenAI',
    mark: '◎',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    color: '#10a37f',
  },
  {
    id: 'anthropic',
    name: 'Claude',
    mark: 'AI',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    color: '#d97757',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    mark: 'K',
    adapter: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    color: '#4f46e5',
  },
  {
    id: 'glm',
    name: 'GLM',
    mark: '智',
    adapter: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    color: '#2563eb',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    mark: 'DS',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    // `deepseek-chat` is no longer in /models; the live catalog is v4-flash/v4-pro.
    defaultModel: 'deepseek-v4-flash',
    color: '#4d6bfe',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    mark: '✦',
    adapter: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    color: '#4285f4',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    mark: 'M',
    adapter: 'openai',
    baseUrl: 'https://api.minimaxi.com/v1',
    defaultModel: '',
    color: '#f04438',
  },
  {
    id: 'qwen',
    name: 'Qwen',
    mark: 'Q',
    adapter: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    color: '#615ced',
  },
  {
    id: 'custom',
    name: '第三方自定义',
    mark: '↗',
    adapter: 'openai',
    baseUrl: '',
    defaultModel: '',
    color: '#64748b',
  },
]);

const ALLOWED_ADAPTERS = new Set(['openai', 'anthropic', 'gemini']);
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_SESSIONS = 40;
const MAX_MESSAGES = 120;
const FETCH_TIMEOUT_MS = 60000;
const WINDOWS_SECRET_PREFIX = 'dpapi:v1:';

function windowsSecretHelperPath() {
  return path.join(__dirname, '..', 'native-secret-store.exe');
}

function runWindowsSecretHelper(action, value) {
  const helper = windowsSecretHelperPath();
  if (!fs.existsSync(helper)) throw new Error('缺少本机密钥保护组件 native-secret-store.exe，请重新运行程序安装包');
  const input = action === 'encrypt'
    ? Buffer.from(String(value || ''), 'utf8').toString('base64')
    : String(value || '');
  const result = spawnSync(helper, [action], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error('Windows 本机密钥保护失败');
  const output = String(result.stdout || '').trim();
  if (!output) throw new Error('Windows 本机密钥保护没有返回数据');
  return action === 'encrypt' ? output : Buffer.from(output, 'base64').toString('utf8');
}

function clampText(value, max = 20000) {
  return String(value == null ? '' : value).slice(0, max);
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) throw new Error('请填写 API URL');
  let parsed;
  try { parsed = new URL(text); } catch (_) { throw new Error('API URL 格式无效'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('API URL 仅支持 http:// 或 https://');
  if (parsed.username || parsed.password) throw new Error('API URL 不能包含账号或密码');
  return parsed.toString().replace(/\/+$/, '');
}

function endpoint(baseUrl, suffix) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`;
}

function safeJsonParse(value, fallback = null) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function extractJsonObject(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```(?:json|aibrowser-flow|aibrowser-actions)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], source].filter(Boolean);
  for (const candidate of candidates) {
    const direct = safeJsonParse(candidate.trim());
    if (direct && typeof direct === 'object') return direct;
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first >= 0 && last > first) {
      const parsed = safeJsonParse(candidate.slice(first, last + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  }
  return null;
}

function publicProvider(provider) {
  if (!provider) return null;
  const {
    apiKeyEncrypted,
    apiKey,
    ...rest
  } = provider;
  return {
    ...rest,
    hasKey: Boolean(apiKeyEncrypted || apiKey),
  };
}

function normalizeCustomHeaders(value) {
  let headers = value;
  if (typeof headers === 'string') headers = safeJsonParse(headers, {});
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const blocked = new Set([
    'host',
    'content-length',
    'connection',
    'cookie',
    'set-cookie',
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
  ]);
  return Object.fromEntries(Object.entries(headers)
    .filter(([key]) => {
      const name = String(key).toLowerCase();
      return !blocked.has(name) && !/(?:token|secret|credential)/i.test(name);
    })
    .slice(0, 20)
    .map(([key, item]) => [String(key).slice(0, 100), String(item).slice(0, 2000)]));
}

function normalizeProviderInput(input = {}, existing = null) {
  const presetId = String(input.presetId || existing?.presetId || 'custom').trim().toLowerCase();
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId)
    || PROVIDER_PRESETS.find((item) => item.id === 'custom');
  const adapter = String(input.adapter || existing?.adapter || preset.adapter || 'openai').trim().toLowerCase();
  if (!ALLOWED_ADAPTERS.has(adapter)) throw new Error('不支持的接口适配类型');
  return {
    id: String(input.id || existing?.id || `ai-provider-${randomUUID()}`),
    presetId,
    name: clampText(input.name || existing?.name || preset.name, 60).trim() || preset.name,
    adapter,
    baseUrl: normalizeBaseUrl(input.baseUrl || existing?.baseUrl || preset.baseUrl),
    model: clampText(input.model || existing?.model || preset.defaultModel, 200).trim(),
    customHeaders: normalizeCustomHeaders(input.customHeaders ?? existing?.customHeaders),
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    apiKeyEncrypted: existing?.apiKeyEncrypted || '',
    lastTestedAt: existing?.lastTestedAt || null,
    lastTestModel: existing?.lastTestModel || '',
  };
}

function validateRpaSteps(rawSteps) {
  if (!Array.isArray(rawSteps) || !rawSteps.length) throw new Error('AI 未返回可执行的步骤数组');
  if (rawSteps.length > 250) throw new Error('AI 生成的步骤超过 250 条，请拆分流程');
  const errors = [];
  const walk = (items, prefix = '') => items.forEach((raw, index) => {
    const step = normalizeStep(raw);
    const location = `${prefix}${index + 1}`;
    if (!step.type || !isRegistered(step.type)) {
      errors.push(`步骤 ${location}: 不支持 ${step.type || '空类型'}`);
      return;
    }
    if (step.type === 'gotoUrl' && !String(step.params.url || '').trim()) errors.push(`步骤 ${location}: gotoUrl 缺少 url`);
    if (['click', 'inputContent', 'waitForSelector', 'selectElement'].includes(step.type)
      && !String(step.params.selector || '').trim()) {
      errors.push(`步骤 ${location}: ${step.type} 缺少 selector`);
    }
    if (Array.isArray(raw.children) && raw.children.length) walk(raw.children, `${location}.`);
    if (Array.isArray(raw.elseChildren) && raw.elseChildren.length) walk(raw.elseChildren, `${location}E.`);
  });
  walk(rawSteps);
  if (errors.length) throw new Error(errors.slice(0, 8).join('；'));
  return rawSteps;
}

function sanitizeAiAction(action) {
  if (!action || typeof action !== 'object') return null;
  const type = String(action.type || '');
  const allowed = new Set([
    'navigate',
    'create_flow',
    'update_current_flow',
    'run_current_flow',
    'create_group',
    'assign_group',
    'set_profile_proxy',
    'set_profiles_direct',
    'refresh_subscription',
  ]);
  if (!allowed.has(type)) return null;
  const raw = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? action.payload : {};
  const ids = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => clampText(item, 120)).filter(Boolean))].slice(0, 200);
  let payload = {};
  if (type === 'navigate') {
    const view = String(raw.view || '');
    if (!['profiles', 'groups', 'proxies', 'extensions', 'sync', 'rpa', 'api-mcp', 'logs', 'system', 'ai'].includes(view)) return null;
    payload = { view };
  } else if (type === 'create_flow' || type === 'update_current_flow') {
    try {
      payload = {
        name: clampText(raw.name || 'AI 定制流程', 120),
        summary: clampText(raw.summary || '', 2000),
        steps: validateRpaSteps(raw.steps),
        profileIds: ids(raw.profileIds),
      };
    } catch (_) { return null; }
  } else if (type === 'run_current_flow' || type === 'set_profiles_direct') {
    payload = { profileIds: ids(raw.profileIds) };
  } else if (type === 'create_group') {
    payload = {
      name: clampText(raw.name, 60),
      note: clampText(raw.note, 200),
      color: /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? String(raw.color) : '#2563eb',
    };
    if (!payload.name.trim()) return null;
  } else if (type === 'assign_group') {
    payload = {
      profileIds: ids(raw.profileIds),
      groupId: clampText(raw.groupId, 120),
      groupName: clampText(raw.groupName, 60),
    };
  } else if (type === 'set_profile_proxy') {
    payload = { profileIds: ids(raw.profileIds), proxyId: clampText(raw.proxyId, 120) };
  } else if (type === 'refresh_subscription') {
    payload = { subscriptionId: clampText(raw.subscriptionId, 120) };
  }
  return {
    type,
    label: clampText(action.label || '', 100),
    payload,
  };
}

class AiService {
  constructor(options = {}) {
    this.userDataPath = path.resolve(options.userDataPath || process.cwd());
    this.configPath = path.join(this.userDataPath, 'ai', 'providers.json');
    this.sessionsPath = path.join(this.userDataPath, 'ai', 'sessions.json');
    this.getContext = typeof options.getContext === 'function' ? options.getContext : () => ({});
    this.providers = [];
    this.sessions = [];
    this.activeProviderId = '';
  }

  async init() {
    await fsp.mkdir(path.dirname(this.configPath), { recursive: true });
    const config = await this.readJson(this.configPath, {});
    this.providers = Array.isArray(config.providers) ? config.providers : [];
    this.activeProviderId = String(config.activeProviderId || this.providers[0]?.id || '');
    const sessions = await this.readJson(this.sessionsPath, {});
    this.sessions = Array.isArray(sessions.sessions) ? sessions.sessions.slice(0, MAX_SESSIONS) : [];
    return this.getState();
  }

  async readJson(filePath, fallback) {
    try { return JSON.parse(await fsp.readFile(filePath, 'utf8')); } catch (_) { return fallback; }
  }

  async writeJson(filePath, value) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, filePath).catch(async () => {
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tmp, filePath);
    });
  }

  encryptKey(value) {
    const key = String(value || '');
    if (!key) return '';
    if (process.platform === 'win32') {
      return WINDOWS_SECRET_PREFIX + runWindowsSecretHelper('encrypt', key);
    }
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new Error('当前系统加密服务不可用，出于安全原因未保存 API Key');
    }
    return safeStorage.encryptString(key).toString('base64');
  }

  decryptKey(provider) {
    if (!provider?.apiKeyEncrypted) return '';
    const encrypted = String(provider.apiKeyEncrypted);
    if (encrypted.startsWith(WINDOWS_SECRET_PREFIX)) {
      try {
        return runWindowsSecretHelper('decrypt', encrypted.slice(WINDOWS_SECRET_PREFIX.length));
      } catch (_) {
        throw new Error('API Key 无法由当前 Windows 用户解密，请在“AI 接入”中重新填写并保存');
      }
    }
    if (!safeStorage?.isEncryptionAvailable?.()) throw new Error('系统加密服务当前不可用，无法读取已保存的 API Key');
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    } catch (_) {
      throw new Error('API Key 来自旧的运行目录或加密环境，无法继续解密；请在“AI 接入”中重新填写并保存一次');
    }
  }

  getState() {
    return {
      presets: PROVIDER_PRESETS,
      providers: this.providers.map(publicProvider),
      activeProviderId: this.activeProviderId,
      encryptionAvailable: process.platform === 'win32'
        ? fs.existsSync(windowsSecretHelperPath())
        : Boolean(safeStorage?.isEncryptionAvailable?.()),
      storagePath: path.dirname(this.configPath),
    };
  }

  async persistProviders() {
    await this.writeJson(this.configPath, {
      version: 1,
      activeProviderId: this.activeProviderId,
      providers: this.providers,
      updatedAt: new Date().toISOString(),
    });
  }

  findProvider(id) {
    return this.providers.find((item) => item.id === String(id || '')) || null;
  }

  resolveProvider(input = {}, requireSaved = false) {
    const existing = this.findProvider(input.id || input.providerId);
    if (requireSaved && !existing) throw new Error('请选择已保存的 AI 配置');
    const provider = normalizeProviderInput(input, existing);
    provider.apiKey = String(input.apiKey || '').trim() || this.decryptKey(existing);
    if (!provider.apiKey) throw new Error('请填写 API Key');
    return provider;
  }

  async saveProvider(input = {}) {
    if (input.tested !== true) throw new Error('请先获取模型并发送测试消息，测试成功后再保存');
    const existing = this.findProvider(input.id);
    const provider = normalizeProviderInput(input, existing);
    const submittedKey = String(input.apiKey || '').trim();
    if (submittedKey) provider.apiKeyEncrypted = this.encryptKey(submittedKey);
    if (!provider.apiKeyEncrypted) throw new Error('请填写 API Key');
    provider.lastTestedAt = new Date().toISOString();
    provider.lastTestModel = provider.model;
    const index = this.providers.findIndex((item) => item.id === provider.id);
    if (index >= 0) this.providers[index] = provider;
    else this.providers.unshift(provider);
    this.activeProviderId = provider.id;
    await this.persistProviders();
    return { provider: publicProvider(provider), state: this.getState() };
  }

  async deleteProvider(id) {
    const target = String(id || '');
    this.providers = this.providers.filter((item) => item.id !== target);
    if (this.activeProviderId === target) this.activeProviderId = this.providers[0]?.id || '';
    await this.persistProviders();
    return this.getState();
  }

  async setActiveProvider(id) {
    if (!this.findProvider(id)) throw new Error('AI 配置不存在');
    this.activeProviderId = String(id);
    await this.persistProviders();
    return this.getState();
  }

  buildHeaders(provider, json = false) {
    const headers = {
      Accept: 'application/json',
      ...normalizeCustomHeaders(provider.customHeaders),
    };
    if (json) headers['Content-Type'] = 'application/json';
    if (provider.adapter === 'anthropic') {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider.adapter === 'gemini') {
      headers['x-goog-api-key'] = provider.apiKey;
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`;
    }
    return headers;
  }

  async requestJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeout || FETCH_TIMEOUT_MS));
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_RESPONSE_BYTES) throw new Error('AI 服务返回内容过大');
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('AI 服务返回内容过大');
      const data = safeJsonParse(text, null);
      if (!response.ok) {
        const detail = data?.error?.message || data?.message || text.slice(0, 500) || response.statusText;
        throw new Error(`HTTP ${response.status}: ${detail}`);
      }
      if (!data) throw new Error('AI 服务未返回有效 JSON');
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('连接 AI 服务超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async listModels(input = {}) {
    const provider = this.resolveProvider(input);
    const url = endpoint(provider.baseUrl, 'models');
    const data = await this.requestJson(url, { headers: this.buildHeaders(provider) });
    let models = [];
    if (provider.adapter === 'gemini') {
      models = (data.models || [])
        .filter((item) => !Array.isArray(item.supportedGenerationMethods)
          || item.supportedGenerationMethods.includes('generateContent'))
        .map((item) => String(item.name || '').replace(/^models\//, ''));
    } else {
      models = (data.data || data.models || []).map((item) => String(item.id || item.name || ''));
    }
    models = [...new Set(models.filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
    if (!models.length && provider.model) models = [provider.model];
    return { models, count: models.length };
  }

  async complete(provider, messages, options = {}) {
    const model = String(options.model || provider.model || '').trim();
    if (!model) throw new Error('请选择模型');
    const system = clampText(options.system || '', 40000);
    const cleanMessages = (messages || []).slice(-40).map((item) => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: clampText(item.content, 30000),
    })).filter((item) => item.content);

    if (provider.adapter === 'anthropic') {
      const data = await this.requestJson(endpoint(provider.baseUrl, 'messages'), {
        method: 'POST',
        headers: this.buildHeaders(provider, true),
        body: JSON.stringify({
          model,
          max_tokens: Number(options.maxTokens || 4096),
          system,
          messages: cleanMessages,
          temperature: Number(options.temperature ?? 0.2),
        }),
      });
      const text = (data.content || []).map((item) => item?.text || '').join('\n').trim();
      if (!text) throw new Error('Claude 未返回文本内容');
      return { text, model: data.model || model, usage: data.usage || null };
    }

    if (provider.adapter === 'gemini') {
      const data = await this.requestJson(endpoint(provider.baseUrl, `models/${encodeURIComponent(model)}:generateContent`), {
        method: 'POST',
        headers: this.buildHeaders(provider, true),
        body: JSON.stringify({
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents: cleanMessages.map((item) => ({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: item.content }],
          })),
          generationConfig: {
            temperature: Number(options.temperature ?? 0.2),
            maxOutputTokens: Number(options.maxTokens || 4096),
          },
        }),
      });
      const text = (data.candidates?.[0]?.content?.parts || []).map((item) => item?.text || '').join('\n').trim();
      if (!text) throw new Error(data.promptFeedback?.blockReason ? `Gemini 已拦截请求：${data.promptFeedback.blockReason}` : 'Gemini 未返回文本内容');
      return { text, model, usage: data.usageMetadata || null };
    }

    const data = await this.requestJson(endpoint(provider.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.buildHeaders(provider, true),
      body: JSON.stringify({
        model,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...cleanMessages,
        ],
        temperature: Number(options.temperature ?? 0.2),
        max_tokens: Number(options.maxTokens || 4096),
        stream: false,
      }),
    });
    const content = data.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((item) => item?.text || item?.content || '').join('\n').trim()
      : String(content || '').trim();
    if (!text) throw new Error('AI 服务未返回文本内容');
    return { text, model: data.model || model, usage: data.usage || null };
  }

  /**
   * One tool-calling turn.
   *
   * `messages` uses a neutral internal shape so the agent loop never has to
   * know which vendor is behind the provider:
   *   { role: 'user'|'assistant', content: string }
   *   { role: 'assistant', toolCalls: [{ id, name, args }] }
   *   { role: 'tool', toolCallId, name, content: string }
   *
   * Returns { text, toolCalls: [{ id, name, args }] }.
   */
  async completeTools(provider, messages, options = {}) {
    const model = String(options.model || provider.model || '').trim();
    if (!model) throw new Error('请选择模型');
    const system = clampText(options.system || '', 40000);
    const tools = Array.isArray(options.tools) ? options.tools : [];
    const maxTokens = Number(options.maxTokens || 4096);
    const history = (messages || []).slice(-60);

    if (provider.adapter === 'anthropic') {
      const converted = [];
      for (const item of history) {
        if (item.role === 'tool') {
          converted.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: item.toolCallId,
              content: clampText(item.content, 30000),
            }],
          });
        } else if (item.role === 'assistant' && Array.isArray(item.toolCalls) && item.toolCalls.length) {
          const blocks = [];
          if (item.content) blocks.push({ type: 'text', text: clampText(item.content, 30000) });
          for (const call of item.toolCalls) {
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args || {} });
          }
          converted.push({ role: 'assistant', content: blocks });
        } else if (item.content) {
          converted.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: clampText(item.content, 30000) });
        }
      }
      const data = await this.requestJson(endpoint(provider.baseUrl, 'messages'), {
        method: 'POST',
        headers: this.buildHeaders(provider, true),
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: converted,
          temperature: Number(options.temperature ?? 0.2),
          ...(tools.length ? {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          } : {}),
        }),
      });
      const blocks = data.content || [];
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').trim(),
        toolCalls: blocks.filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
        model: data.model || model,
        usage: data.usage || null,
      };
    }

    if (provider.adapter === 'gemini') {
      const contents = [];
      for (const item of history) {
        if (item.role === 'tool') {
          contents.push({
            role: 'user',
            parts: [{ functionResponse: { name: item.name, response: { result: clampText(item.content, 30000) } } }],
          });
        } else if (item.role === 'assistant' && Array.isArray(item.toolCalls) && item.toolCalls.length) {
          contents.push({
            role: 'model',
            parts: item.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.args || {} } })),
          });
        } else if (item.content) {
          contents.push({
            role: item.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: clampText(item.content, 30000) }],
          });
        }
      }
      const data = await this.requestJson(
        endpoint(provider.baseUrl, `models/${encodeURIComponent(model)}:generateContent`), {
          method: 'POST',
          headers: this.buildHeaders(provider, true),
          body: JSON.stringify({
            systemInstruction: system ? { parts: [{ text: system }] } : undefined,
            contents,
            ...(tools.length ? {
              tools: [{
                functionDeclarations: tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                })),
              }],
            } : {}),
            generationConfig: {
              temperature: Number(options.temperature ?? 0.2),
              maxOutputTokens: maxTokens,
            },
          }),
        });
      const parts = data.candidates?.[0]?.content?.parts || [];
      return {
        text: parts.map((p) => p.text || '').filter(Boolean).join('\n').trim(),
        toolCalls: parts.filter((p) => p.functionCall)
          .map((p, i) => ({ id: `gemini-${i}-${p.functionCall.name}`, name: p.functionCall.name, args: p.functionCall.args || {} })),
        model,
        usage: data.usageMetadata || null,
      };
    }

    // OpenAI-compatible (also Kimi / GLM / DeepSeek / MiniMax / Qwen / custom)
    const converted = [];
    if (system) converted.push({ role: 'system', content: system });
    for (const item of history) {
      if (item.role === 'tool') {
        converted.push({ role: 'tool', tool_call_id: item.toolCallId, content: clampText(item.content, 30000) });
      } else if (item.role === 'assistant' && Array.isArray(item.toolCalls) && item.toolCalls.length) {
        converted.push({
          role: 'assistant',
          content: item.content || null,
          tool_calls: item.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
          })),
        });
      } else if (item.content) {
        converted.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: clampText(item.content, 30000) });
      }
    }
    const data = await this.requestJson(endpoint(provider.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: this.buildHeaders(provider, true),
      body: JSON.stringify({
        model,
        messages: converted,
        temperature: Number(options.temperature ?? 0.2),
        max_tokens: maxTokens,
        stream: false,
        ...(tools.length ? {
          tools: tools.map((tool) => ({
            type: 'function',
            function: { name: tool.name, description: tool.description, parameters: tool.parameters },
          })),
          tool_choice: 'auto',
        } : {}),
      }),
    });
    const message = data.choices?.[0]?.message || {};
    const rawContent = message.content;
    return {
      text: Array.isArray(rawContent)
        ? rawContent.map((c) => c?.text || '').join('\n').trim()
        : String(rawContent || '').trim(),
      toolCalls: (message.tool_calls || []).map((call) => ({
        id: call.id,
        name: call.function?.name || '',
        args: safeJsonParse(call.function?.arguments || '{}', {}) || {},
      })).filter((call) => call.name),
      model: data.model || model,
      usage: data.usage || null,
    };
  }

  async testProvider(input = {}) {
    const provider = this.resolveProvider(input);
    const result = await this.complete(provider, [
      { role: 'user', content: '请只回复：AiBrowser AI 连接成功' },
    ], {
      model: input.model || provider.model,
      system: '这是一次 API 连通测试。请严格按用户要求回复，不要添加说明。',
      maxTokens: 80,
      temperature: 0,
    });
    return {
      success: true,
      reply: result.text,
      model: result.model,
      testedAt: new Date().toISOString(),
    };
  }

  listSessions() {
    return this.sessions.map((session) => ({
      id: session.id,
      title: session.title,
      mode: session.mode || 'assistant',
      providerId: session.providerId || '',
      model: session.model || '',
      updatedAt: session.updatedAt,
      createdAt: session.createdAt,
      messageCount: session.messages?.length || 0,
    })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  getSession(id) {
    const session = this.sessions.find((item) => item.id === String(id || ''));
    return session ? JSON.parse(JSON.stringify(session)) : null;
  }

  async persistSessions() {
    this.sessions = this.sessions
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, MAX_SESSIONS);
    await this.writeJson(this.sessionsPath, { version: 1, sessions: this.sessions });
  }

  async createSession(input = {}) {
    const now = new Date().toISOString();
    const session = {
      id: `ai-session-${randomUUID()}`,
      title: clampText(input.title || '新对话', 80),
      mode: input.mode === 'rpa' ? 'rpa' : 'assistant',
      providerId: String(input.providerId || this.activeProviderId || ''),
      model: clampText(input.model || '', 200),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.unshift(session);
    await this.persistSessions();
    return this.getSession(session.id);
  }

  async deleteSession(id) {
    this.sessions = this.sessions.filter((item) => item.id !== String(id || ''));
    await this.persistSessions();
    return this.listSessions();
  }

  baseSystemPrompt(context = {}) {
    const compactContext = JSON.stringify(context || {}).slice(0, 30000);
    return `你是 AiBrowser 内置 AI 助手，中文回答，表达清楚、简洁、可核验。
你可以帮助用户理解和配置本机浏览器环境、代理、扩展、窗口同步与自动脚本。
绝不声称已经执行未执行的操作；不得索要、复述或输出 API Key、密码、Cookie 等秘密。
需要改变本机状态时，只能提出受控操作建议。可用操作：
- navigate: {"view":"profiles|groups|proxies|extensions|sync|rpa|api-mcp|logs|system|ai"}
- create_flow: {"name":"流程名","steps":[...],"profileIds":[]}
- update_current_flow: {"name":"流程名","steps":[...]}
- run_current_flow: {"profileIds":[]}
- create_group: {"name":"分组名","note":"","color":"#2563eb"}
- assign_group: {"profileIds":["env-001"],"groupId":"分组 ID","groupName":"分组名称"}
- set_profile_proxy: {"profileIds":["env-001"],"proxyId":"代理库 ID"}
- set_profiles_direct: {"profileIds":["env-001"]}
- refresh_subscription: {"subscriptionId":"订阅 ID"}
如需提出操作，在正常答复末尾添加一个且仅一个 fenced JSON：
\`\`\`aibrowser-actions
{"actions":[{"type":"navigate","label":"打开环境管理","payload":{"view":"profiles"}}]}
\`\`\`
操作必须来自上面的白名单。运行流程、修改配置等操作只提出建议，由用户点击确认后执行。
当前 AiBrowser 上下文（可能已裁剪）：
${compactContext}`;
  }

  async chat(input = {}) {
    const provider = this.resolveProvider({ id: input.providerId || this.activeProviderId }, true);
    let session = this.sessions.find((item) => item.id === String(input.sessionId || ''));
    if (!session) {
      // createSession returns a detached clone; mutations below must hit the stored object.
      const created = await this.createSession({
        mode: input.mode,
        providerId: provider.id,
        model: input.model || provider.model,
      });
      session = this.sessions.find((item) => item.id === created.id);
    }
    const message = clampText(input.message, 30000).trim();
    if (!message) throw new Error('请输入消息');
    session.providerId = provider.id;
    session.model = String(input.model || provider.model || '');
    session.mode = input.mode === 'rpa' ? 'rpa' : (session.mode || 'assistant');
    session.messages.push({
      id: `msg-${randomUUID()}`,
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    });
    if (session.messages.filter((item) => item.role === 'user').length === 1) {
      session.title = message.replace(/\s+/g, ' ').slice(0, 42) || '新对话';
    }
    const appContext = {
      ...(await Promise.resolve(this.getContext())),
      ...(input.context && typeof input.context === 'object' ? input.context : {}),
    };
    const result = await this.complete(provider, session.messages, {
      model: session.model,
      system: this.baseSystemPrompt(appContext),
      maxTokens: 6000,
      temperature: 0.25,
    });
    const actionBlock = result.text.match(/```aibrowser-actions\s*([\s\S]*?)```/i);
    const actionPayload = actionBlock ? safeJsonParse(actionBlock[1].trim(), null) : null;
    const actions = Array.isArray(actionPayload?.actions)
      ? actionPayload.actions.map(sanitizeAiAction).filter(Boolean).slice(0, 8)
      : [];
    const assistant = {
      id: `msg-${randomUUID()}`,
      role: 'assistant',
      content: result.text.replace(/```aibrowser-actions[\s\S]*?```/ig, '').trim(),
      actions,
      model: result.model,
      usage: result.usage,
      createdAt: new Date().toISOString(),
    };
    session.messages.push(assistant);
    session.messages = session.messages.slice(-MAX_MESSAGES);
    session.updatedAt = new Date().toISOString();
    await this.persistSessions();
    return { session: this.getSession(session.id), message: assistant };
  }

  rpaSystemPrompt(context = {}) {
    const schemas = Object.fromEntries(Object.entries(ACTION_PARAM_SCHEMA)
      .map(([key, value]) => [key, { fields: value.fields, defaults: value.defaults }]));
    return `你是 AiBrowser 自动化流程设计器。把用户需求转换为可在本机 RPA 引擎执行的 JSON。
只返回一个 JSON 对象，不要 Markdown，不要解释：
{"name":"流程名称","summary":"流程说明","steps":[...],"assumptions":["..."],"testInstructions":"测试说明"}
每个步骤使用扁平结构，例如：
{"type":"gotoUrl","url":"https://example.com"}
{"type":"waitForSelector","selector":"#email","timeout":30000}
{"type":"inputContent","selector":"#email","content":"\${email}","isClear":true}
{"type":"waitTime","timeoutType":"randomInterval","timeoutMin":500,"timeoutMax":1200}
{"type":"click","selector":"button[type=submit]"}
允许的步骤类型：${RPA_PLUS_ACTIONS.join(', ')}
常用参数协议：${JSON.stringify(schemas)}
规则：
1. 优先稳定 CSS 选择器，关键交互前使用 waitForSelector。
2. 页面跳转或网络加载后加入合理等待；模拟输入可使用小幅随机等待。
3. 不生成绕过验证码、风控、许可或网站安全机制的步骤；遇到人工验证时明确写入 assumptions。
4. 除非用户明确要求且代码安全，不使用 javaScript。
5. 不编造测试成功。testInstructions 应说明如何在已启动环境中测试。
当前流程和环境上下文：${JSON.stringify(context || {}).slice(0, 30000)}`;
  }

  async generateRpa(input = {}) {
    const provider = this.resolveProvider({ id: input.providerId || this.activeProviderId }, true);
    const requirement = clampText(input.requirement, 30000).trim();
    if (!requirement) throw new Error('请描述需要定制的流程');
    let session = this.sessions.find((item) => item.id === String(input.sessionId || ''));
    if (!session) {
      // createSession returns a detached clone; mutations below must hit the stored object.
      const created = await this.createSession({
        mode: 'rpa',
        providerId: provider.id,
        model: input.model || provider.model,
      });
      session = this.sessions.find((item) => item.id === created.id);
    }
    session.providerId = provider.id;
    session.model = String(input.model || provider.model || '');
    session.mode = 'rpa';
    session.messages.push({
      id: `msg-${randomUUID()}`,
      role: 'user',
      content: requirement,
      createdAt: new Date().toISOString(),
    });
    if (session.messages.filter((item) => item.role === 'user').length === 1) {
      session.title = requirement.replace(/\s+/g, ' ').slice(0, 42) || 'AI 定制流程';
    }
    const context = {
      ...(await Promise.resolve(this.getContext())),
      currentPlan: input.currentPlan || null,
      pageContext: input.context || null,
    };
    const result = await this.complete(provider, [{ role: 'user', content: requirement }], {
      model: input.model || provider.model,
      system: this.rpaSystemPrompt(context),
      maxTokens: 8000,
      temperature: 0.15,
    });
    const parsed = extractJsonObject(result.text);
    if (!parsed) throw new Error('AI 返回内容不是有效的流程 JSON，请重试或更换模型');
    const steps = validateRpaSteps(parsed.steps);
    const flow = {
      name: clampText(parsed.name || 'AI 定制流程', 120),
      summary: clampText(parsed.summary || '', 2000),
      steps,
      assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions.map((item) => clampText(item, 500)).slice(0, 20) : [],
      testInstructions: clampText(parsed.testInstructions || '', 3000),
      model: result.model,
      generatedAt: new Date().toISOString(),
    };
    const assistant = {
      id: `msg-${randomUUID()}`,
      role: 'assistant',
      content: [
        `已生成流程“${flow.name}”，共 ${flow.steps.length} 个步骤。`,
        flow.summary,
        flow.assumptions.length ? `\n注意事项：\n${flow.assumptions.map((item) => `- ${item}`).join('\n')}` : '',
        flow.testInstructions ? `\n测试建议：\n${flow.testInstructions}` : '',
      ].filter(Boolean).join('\n'),
      actions: [{
        type: 'create_flow',
        label: '应用到流程编辑器',
        payload: { name: flow.name, steps: flow.steps, profileIds: [] },
      }],
      model: result.model,
      usage: result.usage,
      createdAt: new Date().toISOString(),
    };
    session.messages.push(assistant);
    session.messages = session.messages.slice(-MAX_MESSAGES);
    session.updatedAt = new Date().toISOString();
    await this.persistSessions();
    return { ...flow, session: this.getSession(session.id), message: assistant };
  }
}

module.exports = {
  AiService,
  PROVIDER_PRESETS,
  validateRpaSteps,
};
