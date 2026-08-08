'use strict';

var aiUiState = {
  presets: [],
  providers: [],
  activeProviderId: '',
  encryptionAvailable: false,
  storagePath: '',
};
var aiSessions = [];
var aiCurrentSessionId = '';
var aiMode = 'assistant';
var aiBusy = false;
var aiProviderTested = false;
var aiSelectedPresetId = 'openai';
var aiDraft = null;
var aiAttachCurrentFlow = false;

function aiEl(id) {
  return document.getElementById(id);
}

function aiErrorMessage(error) {
  return String(error?.message || error || '未知错误')
    .replace(/^Error invoking remote method '[^']+': Error:\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function aiPreset(id) {
  return aiUiState.presets.find((item) => item.id === String(id || ''))
    || aiUiState.presets.find((item) => item.id === 'custom')
    || { id: 'custom', name: '第三方自定义', mark: '↗', color: '#64748b', adapter: 'openai', baseUrl: '', defaultModel: '' };
}

function aiProvider(id) {
  return aiUiState.providers.find((item) => item.id === String(id || '')) || null;
}

function aiCurrentProvider() {
  return aiProvider(aiEl('ai-active-provider')?.value || aiUiState.activeProviderId);
}

function aiSetLucide(root = document) {
  try { afterUiRender?.(root); } catch (_) {
    try { window.lucide?.createIcons?.(); } catch (_) {}
  }
}

function aiSetTestState(state, text) {
  const result = aiEl('ai-test-result');
  if (!result) return;
  result.dataset.state = state;
  const icon = state === 'success' ? 'circle-check'
    : state === 'error' ? 'circle-x'
      : state === 'loading' ? 'loader-circle' : 'circle-dashed';
  result.innerHTML = `<i data-lucide="${icon}"></i><span></span>`;
  result.querySelector('span').textContent = text;
  aiSetLucide(result);
}

function aiInvalidateProviderTest() {
  aiProviderTested = false;
  if (aiEl('ai-save-provider')) aiEl('ai-save-provider').disabled = true;
  aiSetTestState('idle', '配置有变更，请重新发送测试消息');
}

function aiProviderLogo(preset, className = 'ai-provider-logo') {
  const logo = document.createElement('span');
  logo.className = className;
  logo.style.setProperty('--provider-color', preset.color || '#64748b');
  logo.textContent = preset.mark || preset.name?.slice(0, 2) || 'AI';
  logo.title = preset.name || '';
  return logo;
}

function aiRenderProviderPresets() {
  const grid = aiEl('ai-provider-grid');
  if (!grid) return;
  grid.replaceChildren();
  for (const preset of aiUiState.presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ai-provider-preset${preset.id === aiSelectedPresetId ? ' active' : ''}`;
    button.dataset.aiPreset = preset.id;
    button.style.setProperty('--provider-color', preset.color || '#64748b');
    const copy = document.createElement('span');
    const strong = document.createElement('strong');
    const small = document.createElement('small');
    strong.textContent = preset.name;
    small.textContent = preset.id === 'custom' ? '自定义兼容接口' : (
      preset.adapter === 'openai' ? 'OpenAI 兼容' : preset.adapter === 'anthropic' ? 'Messages API' : 'GenerateContent'
    );
    copy.append(strong, small);
    button.append(aiProviderLogo(preset), copy);
    grid.append(button);
  }
}

function aiRenderSavedConfigs() {
  const list = aiEl('ai-saved-configs');
  if (!list) return;
  list.replaceChildren();
  if (!aiUiState.providers.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-saved-config-empty';
    empty.textContent = '尚未保存配置';
    list.append(empty);
    return;
  }
  for (const provider of aiUiState.providers) {
    const preset = aiPreset(provider.presetId);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ai-saved-config${provider.id === aiEl('ai-provider-id')?.value ? ' active' : ''}`;
    button.dataset.aiSavedProvider = provider.id;
    const copy = document.createElement('span');
    const strong = document.createElement('strong');
    const small = document.createElement('small');
    const status = document.createElement('i');
    strong.textContent = provider.name;
    small.textContent = `${provider.model || '未选择模型'} · ${provider.baseUrl}`;
    status.textContent = provider.hasKey ? '已加密' : '缺少 Key';
    copy.append(strong, small);
    button.append(aiProviderLogo(preset), copy, status);
    list.append(button);
  }
}

function aiFillModelSelect(models = [], selected = '') {
  const select = aiEl('ai-provider-model');
  if (!select) return;
  const values = [...new Set([selected, ...models].filter(Boolean))];
  select.replaceChildren();
  if (!values.length) {
    select.add(new Option('请先获取模型', ''));
    return;
  }
  for (const model of values) select.add(new Option(model, model));
  select.value = selected && values.includes(selected) ? selected : values[0];
}

function aiSelectProviderPreset(presetId, existing = null) {
  const preset = aiPreset(presetId);
  aiSelectedPresetId = preset.id;
  aiEl('ai-provider-preset').value = preset.id;
  aiEl('ai-provider-id').value = existing?.id || '';
  aiEl('ai-provider-name').value = existing?.name || preset.name;
  aiEl('ai-provider-adapter').value = existing?.adapter || preset.adapter;
  aiEl('ai-provider-url').value = existing?.baseUrl || preset.baseUrl;
  aiEl('ai-provider-key').value = '';
  aiEl('ai-provider-key').placeholder = existing?.hasKey
    ? '已加密保存；留空表示保留现有 Key'
    : '输入 API Key';
  aiEl('ai-provider-headers').value = Object.keys(existing?.customHeaders || {}).length
    ? JSON.stringify(existing.customHeaders, null, 2) : '';
  aiFillModelSelect([], existing?.model || preset.defaultModel || '');
  aiEl('ai-delete-provider').hidden = !existing;
  const logo = aiEl('ai-provider-selected-logo');
  if (logo) {
    logo.textContent = preset.mark || 'AI';
    logo.style.setProperty('--provider-color', preset.color || '#64748b');
  }
  aiEl('ai-provider-selected-name').textContent = existing?.name || preset.name;
  aiProviderTested = false;
  aiEl('ai-save-provider').disabled = true;
  aiSetTestState('idle', existing?.lastTestedAt
    ? `上次测试：${new Date(existing.lastTestedAt).toLocaleString()}；修改后需重新测试`
    : '尚未测试连接');
  aiRenderProviderPresets();
  aiRenderSavedConfigs();
}

function aiOpenProviderDialog(providerId = '', presetId = '') {
  const existing = aiProvider(providerId);
  aiSelectProviderPreset(existing?.presetId || presetId || 'openai', existing);
  const dialog = aiEl('ai-provider-dialog');
  dialog?.showModal?.();
  aiSetLucide(dialog || document);
}

function aiReadProviderForm() {
  let customHeaders = {};
  const headersText = aiEl('ai-provider-headers')?.value?.trim() || '';
  if (headersText) {
    try { customHeaders = JSON.parse(headersText); } catch (error) {
      throw new Error(`附加请求头不是有效 JSON：${error.message}`);
    }
  }
  return {
    id: aiEl('ai-provider-id')?.value || undefined,
    presetId: aiEl('ai-provider-preset')?.value || 'custom',
    name: aiEl('ai-provider-name')?.value?.trim() || '',
    adapter: aiEl('ai-provider-adapter')?.value || 'openai',
    baseUrl: aiEl('ai-provider-url')?.value?.trim() || '',
    apiKey: aiEl('ai-provider-key')?.value?.trim() || '',
    customHeaders,
    model: aiEl('ai-provider-model')?.value || '',
  };
}

async function aiRefreshState(options = {}) {
  aiUiState = await window.ops.aiState();
  aiSessions = await window.ops.aiSessions();
  if (!aiCurrentSessionId && aiSessions[0]) aiCurrentSessionId = aiSessions[0].id;
  aiRenderProviderSelects();
  aiRenderSessions();
  if (options.loadSession !== false && aiCurrentSessionId) {
    const session = await window.ops.aiSessionGet(aiCurrentSessionId);
    if (session) aiRenderSession(session);
  }
  const storage = aiEl('ai-storage-hint');
  if (storage) storage.textContent = aiUiState.encryptionAvailable
    ? String(aiUiState.storagePath || 'browser-data/ai')
    : '系统加密服务不可用';
  aiRenderProviderPresets();
  aiRenderSavedConfigs();
  aiUpdateContextSummary();
}

function aiRenderProviderSelects() {
  const providerSelect = aiEl('ai-active-provider');
  const modelSelect = aiEl('ai-active-model');
  if (!providerSelect || !modelSelect) return;
  providerSelect.replaceChildren();
  if (!aiUiState.providers.length) {
    providerSelect.add(new Option('尚未配置', ''));
    modelSelect.replaceChildren(new Option('请先配置服务', ''));
    aiEl('ai-chat-subtitle').textContent = '配置 URL、API Key 并完成连接测试';
    return;
  }
  for (const provider of aiUiState.providers) providerSelect.add(new Option(provider.name, provider.id));
  const activeId = aiUiState.providers.some((item) => item.id === aiUiState.activeProviderId)
    ? aiUiState.activeProviderId : aiUiState.providers[0].id;
  providerSelect.value = activeId;
  const active = aiProvider(activeId);
  modelSelect.replaceChildren();
  if (active?.model) modelSelect.add(new Option(active.model, active.model));
  else modelSelect.add(new Option('未选择模型', ''));
  aiEl('ai-chat-subtitle').textContent = active
    ? `${active.name} · ${active.model || '未选择模型'}`
    : '配置模型后即可开始对话';
}

function aiSessionTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toLocaleDateString();
}

function aiRenderSessions() {
  const list = aiEl('ai-session-list');
  if (!list) return;
  list.replaceChildren();
  const query = aiEl('ai-session-search')?.value?.trim().toLowerCase() || '';
  const visible = aiSessions.filter((item) => !query || String(item.title || '').toLowerCase().includes(query));
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-session-empty';
    empty.textContent = query ? '没有匹配的对话' : '暂无对话';
    list.append(empty);
    return;
  }
  for (const session of visible) {
    const item = document.createElement('div');
    item.className = `ai-session-item${session.id === aiCurrentSessionId ? ' active' : ''}`;
    item.dataset.aiSession = session.id;
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    const icon = document.createElement('i');
    icon.dataset.lucide = session.mode === 'rpa' ? 'workflow' : 'message-square';
    const copy = document.createElement('span');
    copy.className = 'ai-session-item-copy';
    const title = document.createElement('strong');
    const meta = document.createElement('small');
    title.textContent = session.title || '新对话';
    meta.textContent = `${session.model || 'AI'} · ${aiSessionTime(session.updatedAt)}`;
    copy.append(title, meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ai-session-delete';
    del.dataset.aiDeleteSession = session.id;
    del.title = '删除对话';
    del.innerHTML = '<i data-lucide="trash-2"></i>';
    item.append(icon, copy, del);
    list.append(item);
  }
  aiSetLucide(list);
}

function aiEscapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function aiInlineMarkdown(value) {
  return aiEscapeHtml(value)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function aiRenderMarkdown(container, value) {
  container.replaceChildren();
  const source = String(value || '');
  const expression = /```([a-z0-9_-]*)\s*\n?([\s\S]*?)```/ig;
  let cursor = 0;
  let match;
  const appendPlain = (plain) => {
    const chunks = String(plain || '').trim().split(/\n{2,}/).filter(Boolean);
    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      const allList = lines.every((line) => /^\s*[-*]\s+/.test(line));
      if (allList) {
        const ul = document.createElement('ul');
        for (const line of lines) {
          const li = document.createElement('li');
          li.innerHTML = aiInlineMarkdown(line.replace(/^\s*[-*]\s+/, ''));
          ul.append(li);
        }
        container.append(ul);
      } else {
        const p = document.createElement('p');
        p.innerHTML = lines.map(aiInlineMarkdown).join('<br>');
        container.append(p);
      }
    }
  };
  while ((match = expression.exec(source))) {
    appendPlain(source.slice(cursor, match.index));
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (match[1]) code.dataset.language = match[1];
    code.textContent = match[2].trim();
    pre.append(code);
    container.append(pre);
    cursor = match.index + match[0].length;
  }
  appendPlain(source.slice(cursor));
}

function aiActionLabel(action) {
  if (action?.label) return action.label;
  return {
    navigate: '打开页面',
    create_flow: '创建流程草稿',
    update_current_flow: '更新当前流程',
    run_current_flow: '运行当前流程',
    create_group: '创建环境分组',
    assign_group: '分配环境分组',
    set_profile_proxy: '设置环境代理',
    set_profiles_direct: '切换本地直连',
    refresh_subscription: '更新代理订阅',
  }[action?.type] || '查看建议';
}

function aiActionIcon(type) {
  return {
    navigate: 'panel-left-open',
    create_flow: 'workflow',
    update_current_flow: 'file-pen-line',
    run_current_flow: 'play',
    create_group: 'folder-plus',
    assign_group: 'folder-input',
    set_profile_proxy: 'network',
    set_profiles_direct: 'wifi',
    refresh_subscription: 'refresh-cw',
  }[type] || 'sparkles';
}

function aiRenderActions(container, actions) {
  if (!Array.isArray(actions) || !actions.length) return;
  const list = document.createElement('div');
  list.className = 'ai-action-list';
  actions.forEach((action, index) => {
    const card = document.createElement('div');
    card.className = 'ai-action-card';
    const icon = document.createElement('i');
    icon.dataset.lucide = aiActionIcon(action.type);
    const label = document.createElement('span');
    label.textContent = aiActionLabel(action);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = action.type === 'run_current_flow' ? 'ai-gradient-button' : 'outline';
    button.textContent = action.type === 'navigate' ? '打开' : '审阅';
    button.dataset.aiActionIndex = String(index);
    button.addEventListener('click', () => aiExecuteAction(action).catch((error) => toast(aiErrorMessage(error))));
    card.append(icon, label, button);
    list.append(card);
  });
  container.append(list);
  aiSetLucide(list);
}

function aiRenderMessage(message) {
  const row = document.createElement('article');
  row.className = `ai-message ${message.role === 'user' ? 'user' : 'assistant'}`;
  const avatar = document.createElement('div');
  avatar.className = 'ai-message-avatar';
  if (message.role === 'user') avatar.textContent = '你';
  else avatar.innerHTML = '<i data-lucide="sparkles"></i>';
  const body = document.createElement('div');
  body.className = 'ai-message-body';
  const meta = document.createElement('div');
  meta.className = 'ai-message-meta';
  meta.textContent = message.role === 'user'
    ? '你'
    : `AiBrowser AI${message.model ? ` · ${message.model}` : ''}`;
  const content = document.createElement('div');
  content.className = 'ai-message-content';
  aiRenderMarkdown(content, message.content || '');
  body.append(meta, content);
  aiRenderActions(body, message.actions);
  row.append(avatar, body);
  return row;
}

function aiRenderSession(session) {
  if (!session) return;
  aiCurrentSessionId = session.id;
  aiMode = session.mode === 'rpa' ? 'rpa' : 'assistant';
  const messages = aiEl('ai-messages');
  messages?.replaceChildren();
  for (const message of session.messages || []) messages?.append(aiRenderMessage(message));
  aiEl('ai-empty-state').hidden = Boolean(session.messages?.length);
  aiEl('ai-chat-title').textContent = session.title || 'AiBrowser AI';
  document.querySelectorAll('[data-ai-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.aiMode === aiMode);
  });
  aiRenderSessions();
  aiSetLucide(messages || document);
  requestAnimationFrame(() => {
    const scroll = aiEl('ai-message-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  });
}

function aiRenderTyping(show) {
  const messages = aiEl('ai-messages');
  aiEl('ai-empty-state').hidden = show || Boolean(messages?.children.length);
  aiEl('ai-typing-row')?.remove();
  if (!show || !messages) return;
  const row = document.createElement('article');
  row.id = 'ai-typing-row';
  row.className = 'ai-message assistant';
  row.innerHTML = '<div class="ai-message-avatar"><i data-lucide="sparkles"></i></div><div class="ai-message-body"><div class="ai-message-meta">AiBrowser AI · 正在思考</div><div class="ai-typing"><i></i><i></i><i></i></div></div>';
  messages.append(row);
  aiSetLucide(row);
  const scroll = aiEl('ai-message-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

function aiScrubSecrets(value, depth = 0) {
  if (depth > 8) return '[已裁剪]';
  if (Array.isArray(value)) return value.slice(0, 150).map((item) => aiScrubSecrets(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 5000) : value;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 150)) {
    if (/pass(word)?|secret|token|api.?key|cookie|authorization|credential/i.test(key)) result[key] = '[已隐藏]';
    else result[key] = aiScrubSecrets(item, depth + 1);
  }
  return result;
}

function aiCurrentPlanContext() {
  if (!aiAttachCurrentFlow) return null;
  let steps = [];
  try { steps = JSON.parse(aiEl('rpa-steps-json')?.value || '[]'); } catch (_) {}
  return aiScrubSecrets({
    id: typeof rpaSelectedId !== 'undefined' ? rpaSelectedId : null,
    name: aiEl('rpa-plan-name')?.value || '',
    profileIds: typeof selectedRpaProfileIds === 'function' ? selectedRpaProfileIds() : [],
    steps,
  });
}

function aiBuildContext() {
  const activeView = document.querySelector('.view.active')?.id?.replace(/^view-/, '') || 'profiles';
  const profiles = (typeof ui !== 'undefined' && Array.isArray(ui.profiles) ? ui.profiles : []).map((profile) => ({
    id: profile.id,
    number: profile.number,
    name: profile.name,
    groupId: profile.groupId || '',
    running: Boolean(typeof profileEngine === 'function' ? profileEngine(profile.id).running : false),
    networkMode: profile.networkMode || profile.proxyMode || '',
  })).slice(0, 200);
  const groups = (typeof ui !== 'undefined' && Array.isArray(ui.groups) ? ui.groups : []).map((group) => ({
    id: group.id,
    name: group.name,
    note: group.note || '',
  })).slice(0, 100);
  const proxies = (typeof proxyLibrary !== 'undefined' && Array.isArray(proxyLibrary) ? proxyLibrary : []).map((proxy) => ({
    id: proxy.id,
    name: proxy.name,
    protocol: proxy.protocol,
    latency: proxy.latency ?? null,
    available: proxy.available ?? null,
    groupId: proxy.groupId || '',
  })).slice(0, 300);
  return {
    activeView,
    profiles,
    groups,
    proxies,
    subscriptions: (typeof proxySubscriptions !== 'undefined' && Array.isArray(proxySubscriptions) ? proxySubscriptions : []).map((item) => ({
      id: item.id,
      name: item.name || item.groupName || '',
      updatedAt: item.updatedAt || item.syncedAt || null,
    })).slice(0, 100),
    currentPlan: aiCurrentPlanContext(),
  };
}

function aiUpdateContextSummary() {
  const context = aiBuildContext();
  const parts = [
    `${context.profiles.length} 个环境`,
    `${context.proxies.length} 个代理`,
    context.currentPlan ? '已附加当前流程（敏感字段已隐藏）' : '未附加流程',
  ];
  if (aiEl('ai-context-summary')) aiEl('ai-context-summary').textContent = parts.join(' · ');
  aiEl('ai-use-current-flow')?.classList.toggle('active', aiAttachCurrentFlow);
}

function aiProviderPayloadForSend() {
  const provider = aiCurrentProvider();
  if (!provider) throw new Error('请先配置并测试 AI 模型服务');
  const model = aiEl('ai-active-model')?.value || provider.model;
  if (!model) throw new Error('当前配置没有可用模型，请打开配置获取模型');
  return { provider, model };
}

async function aiSendMessage() {
  if (aiBusy) return;
  const input = aiEl('ai-input');
  const message = input?.value?.trim() || '';
  if (!message) return;
  let selection;
  try { selection = aiProviderPayloadForSend(); } catch (error) {
    toast(aiErrorMessage(error));
    aiOpenProviderDialog('', 'openai');
    return;
  }
  aiBusy = true;
  aiEl('ai-send').disabled = true;
  input.value = '';
  input.style.height = 'auto';
  const localUser = { role: 'user', content: message, createdAt: new Date().toISOString() };
  aiEl('ai-empty-state').hidden = true;
  aiEl('ai-messages')?.append(aiRenderMessage(localUser));
  aiRenderTyping(true);
  try {
    let result;
    if (aiMode === 'rpa') {
      result = await window.ops.aiGenerateRpa({
        providerId: selection.provider.id,
        model: selection.model,
        sessionId: aiCurrentSessionId || undefined,
        requirement: message,
        currentPlan: aiCurrentPlanContext(),
        context: aiBuildContext(),
      });
      aiDraft = {
        name: result.name,
        summary: result.summary,
        steps: result.steps,
        assumptions: result.assumptions || [],
        testInstructions: result.testInstructions || '',
        profileIds: aiCurrentPlanContext()?.profileIds || [],
        updateCurrent: aiAttachCurrentFlow && Boolean(aiCurrentPlanContext()?.id),
      };
      aiRenderDraft();
    } else {
      result = await window.ops.aiChat({
        providerId: selection.provider.id,
        model: selection.model,
        sessionId: aiCurrentSessionId || undefined,
        mode: aiMode,
        message,
        context: aiBuildContext(),
      });
    }
    aiCurrentSessionId = result.session?.id || aiCurrentSessionId;
    aiSessions = await window.ops.aiSessions();
    aiRenderSession(result.session);
  } catch (error) {
    aiRenderTyping(false);
    const failure = {
      role: 'assistant',
      content: `请求失败：${aiErrorMessage(error)}`,
      createdAt: new Date().toISOString(),
    };
    aiEl('ai-messages')?.append(aiRenderMessage(failure));
    toast(aiErrorMessage(error));
  } finally {
    aiBusy = false;
    aiEl('ai-send').disabled = false;
    aiRenderTyping(false);
    input?.focus();
  }
}

function aiRenderDraft() {
  const box = aiEl('ai-rpa-draft');
  if (!box) return;
  box.hidden = !aiDraft;
  if (!aiDraft) return;
  aiEl('ai-rpa-draft-name').textContent = `${aiDraft.name || 'AI 流程草稿'} · ${aiDraft.steps?.length || 0} 步`;
  aiEl('ai-rpa-draft-summary').textContent = aiDraft.summary || aiDraft.testInstructions || '已通过本机步骤协议校验';
  aiSetLucide(box);
}

function aiPreviewDraft() {
  if (!aiDraft) return toast('当前没有 AI 流程草稿');
  aiEl('ai-rpa-preview-meta').textContent = [
    aiDraft.summary,
    ...(aiDraft.assumptions || []).map((item) => `注意：${item}`),
    aiDraft.testInstructions ? `测试：${aiDraft.testInstructions}` : '',
  ].filter(Boolean).join(' · ');
  aiEl('ai-rpa-preview-json').textContent = JSON.stringify(aiDraft.steps || [], null, 2);
  aiEl('ai-rpa-preview-dialog')?.showModal?.();
  aiSetLucide(aiEl('ai-rpa-preview-dialog'));
}

async function aiApplyDraft(runAfter = false) {
  if (!aiDraft?.steps?.length) throw new Error('当前没有可应用的流程草稿');
  const currentId = typeof rpaSelectedId !== 'undefined' ? rpaSelectedId : null;
  const updateCurrent = Boolean(aiDraft.updateCurrent && currentId);
  const actionText = runAfter
    ? `${updateCurrent ? '替换当前流程' : '创建新流程'}并在所选环境运行测试`
    : `${updateCurrent ? '替换当前流程' : '创建新流程'}并打开流程编辑器`;
  if (!confirm(`确认${actionText}？\n\n执行前仍可在流程编辑器中检查 JSON。`)) return null;
  const selectedIds = Array.isArray(aiDraft.profileIds) && aiDraft.profileIds.length
    ? aiDraft.profileIds
    : (typeof selectedRpaProfileIds === 'function' ? selectedRpaProfileIds() : []);
  const plan = await window.ops.rpaSavePlan({
    id: updateCurrent ? currentId : undefined,
    plan_name: aiDraft.name || 'AI 定制流程',
    profile_ids: selectedIds,
    steps: aiDraft.steps,
  });
  if (typeof rpaSelectedId !== 'undefined') rpaSelectedId = plan.id;
  switchView('rpa', 'flows');
  if (typeof refreshRpaPage === 'function') await refreshRpaPage();
  if (typeof loadRpaPlanToEditor === 'function') loadRpaPlanToEditor(plan);
  log?.('AI', `应用流程 ${plan.plan_name || plan.id}`);
  if (!runAfter) {
    toast('AI 流程已应用，请检查后运行');
    return plan;
  }
  const profileIds = selectedIds.length ? selectedIds : (plan.profile_ids || []);
  if (!profileIds.length) {
    throw new Error('流程已应用，但没有选择运行环境。请在流程编辑器选择已启动环境后再测试');
  }
  if (typeof appendRpaLog === 'function') appendRpaLog(`AI 测试：${plan.plan_name} → ${profileIds.join(',')}`);
  const result = await window.ops.rpaRun({ plan_id: plan.id, profile_ids: profileIds });
  if (result?.success === false || result?.results?.some?.((item) => item.success === false)) {
    const errorText = JSON.stringify(result).slice(0, 5000);
    aiMode = 'rpa';
    aiAttachCurrentFlow = true;
    if (aiEl('ai-input')) aiEl('ai-input').value = `刚才流程测试失败，请根据以下结果修复当前流程，并保留已经正确的步骤：\n${errorText}`;
    toast('测试未通过，失败结果已放入 AI 输入框，可继续让 AI 修复');
  } else {
    toast('AI 流程测试完成');
  }
  return plan;
}

async function aiExecuteAction(action) {
  const payload = action?.payload || {};
  if (action.type === 'navigate') {
    switchView(String(payload.view || 'profiles'));
    return;
  }
  if (action.type === 'create_flow' || action.type === 'update_current_flow') {
    if (!Array.isArray(payload.steps) || !payload.steps.length) throw new Error('操作建议缺少流程步骤');
    aiDraft = {
      name: String(payload.name || 'AI 定制流程'),
      summary: String(payload.summary || ''),
      steps: payload.steps,
      profileIds: Array.isArray(payload.profileIds) ? payload.profileIds : [],
      updateCurrent: action.type === 'update_current_flow',
    };
    aiRenderDraft();
    toast('流程草稿已准备，请先查看 JSON 再应用');
    return;
  }
  if (action.type === 'run_current_flow') {
    const currentPlan = aiCurrentPlanContext();
    if (!currentPlan?.id) throw new Error('当前没有已保存流程');
    if (!confirm(`确认运行当前流程“${currentPlan.name || currentPlan.id}”？`)) return;
    const profileIds = Array.isArray(payload.profileIds) && payload.profileIds.length
      ? payload.profileIds : currentPlan.profileIds;
    if (!profileIds.length) throw new Error('请先在流程编辑器选择运行环境');
    const result = await window.ops.rpaRun({ plan_id: currentPlan.id, profile_ids: profileIds });
    toast(result?.success === false ? '流程有失败任务，请查看运行记录' : '流程运行完成');
    return;
  }
  if (action.type === 'create_group') {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('分组名称不能为空');
    if (!confirm(`确认创建环境分组“${name}”？`)) return;
    if (typeof ui === 'undefined' || !Array.isArray(ui.groups)) throw new Error('环境分组数据未就绪');
    if (ui.groups.some((item) => item.name === name)) throw new Error('同名分组已经存在');
    const group = normalizeGroup({
      id: createGroupId(),
      name,
      note: String(payload.note || ''),
      color: /^#[0-9a-f]{6}$/i.test(payload.color || '') ? payload.color : '#2563eb',
      sort: ui.groups.length,
    }, ui.groups.length);
    ui.groups.push(group);
    save();
    renderGroupsPage();
    toast(`已创建分组：${name}`);
    return;
  }
  if (action.type === 'assign_group') {
    const ids = [...new Set((Array.isArray(payload.profileIds) ? payload.profileIds : []).map(String))];
    if (!ids.length) throw new Error('操作建议没有指定环境');
    const group = (payload.groupId ? findGroup(String(payload.groupId)) : null)
      || (typeof listGroups === 'function' ? listGroups().find((item) => item.name === String(payload.groupName || '')) : null);
    if (!group) throw new Error('目标分组不存在，请先创建分组');
    const validIds = ids.filter((id) => ui.profiles.some((item) => item.id === id));
    if (!validIds.length) throw new Error('操作建议中的环境不存在');
    if (!confirm(`确认将 ${validIds.length} 个环境移动到“${group.name}”？`)) return;
    ui.profiles = ui.profiles.map((profile) => validIds.includes(profile.id)
      ? { ...profile, groupId: group.id } : profile);
    save();
    engineProfiles = await window.ops.syncProfiles(ui.profiles);
    renderProfiles();
    toast(`已移动 ${validIds.length} 个环境`);
    return;
  }
  if (action.type === 'set_profile_proxy') {
    const ids = [...new Set((Array.isArray(payload.profileIds) ? payload.profileIds : []).map(String))]
      .filter((id) => ui.profiles.some((item) => item.id === id));
    const proxyId = String(payload.proxyId || '');
    if (!ids.length) throw new Error('操作建议没有指定有效环境');
    if (!proxyId || !proxyLibrary.some((item) => String(item.id) === proxyId)) throw new Error('目标代理不存在');
    if (!confirm(`确认给 ${ids.length} 个环境设置所选代理？运行中的环境需要重启后生效。`)) return;
    const resolved = await window.ops.proxyResolve(proxyId);
    const proxyText = normalizeProxy(resolved.raw, resolved.protocol || 'socks5');
    ui.profiles = ui.profiles.map((profile) => ids.includes(profile.id) ? {
      ...profile,
      networkMode: 'proxy',
      proxy: proxyText,
      proxyMeta: { ...(profile.proxyMeta || {}), libraryProxyId: proxyId },
    } : profile);
    save();
    engineProfiles = await window.ops.syncProfiles(ui.profiles);
    renderProfiles();
    toast(`已给 ${ids.length} 个环境设置代理`);
    return;
  }
  if (action.type === 'set_profiles_direct') {
    const ids = [...new Set((Array.isArray(payload.profileIds) ? payload.profileIds : []).map(String))]
      .filter((id) => ui.profiles.some((item) => item.id === id));
    if (!ids.length) throw new Error('操作建议没有指定有效环境');
    if (!confirm(`确认将 ${ids.length} 个环境切换为本地直连？运行中的环境需要重启后生效。`)) return;
    ui.profiles = ui.profiles.map((profile) => ids.includes(profile.id) ? {
      ...profile,
      networkMode: 'direct',
      proxy: 'Direct',
      proxyMeta: { ...(profile.proxyMeta || {}), libraryProxyId: '' },
    } : profile);
    save();
    engineProfiles = await window.ops.syncProfiles(ui.profiles);
    renderProfiles();
    toast(`已将 ${ids.length} 个环境切换为本地直连`);
    return;
  }
  if (action.type === 'refresh_subscription') {
    const id = String(payload.subscriptionId || '');
    if (!id) throw new Error('操作建议缺少订阅 ID');
    if (!confirm('确认立即更新这个代理订阅？')) return;
    await window.ops.proxySubscriptionSync(id);
    if (typeof refreshProxies === 'function') await refreshProxies();
    toast('代理订阅已更新');
    return;
  }
  throw new Error('不支持的 AI 操作');
}

async function aiNewSession() {
  const provider = aiCurrentProvider();
  const session = await window.ops.aiSessionCreate({
    providerId: provider?.id || '',
    model: provider?.model || '',
    mode: aiMode,
  });
  aiCurrentSessionId = session.id;
  aiSessions = await window.ops.aiSessions();
  aiRenderSession(session);
  aiEl('ai-input')?.focus();
}

async function refreshAiPage() {
  try {
    await aiRefreshState();
    if (!aiUiState.providers.length) {
      aiEl('ai-empty-state').hidden = false;
      aiEl('ai-messages')?.replaceChildren();
    }
  } catch (error) {
    toast(`AI 页面加载失败：${aiErrorMessage(error)}`);
  }
}

aiEl('ai-provider-grid')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ai-preset]');
  if (!button) return;
  aiSelectProviderPreset(button.dataset.aiPreset);
});

aiEl('ai-saved-configs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-ai-saved-provider]');
  if (!button) return;
  const existing = aiProvider(button.dataset.aiSavedProvider);
  if (existing) aiSelectProviderPreset(existing.presetId, existing);
});

for (const id of ['ai-provider-name', 'ai-provider-adapter', 'ai-provider-url', 'ai-provider-key', 'ai-provider-headers', 'ai-provider-model']) {
  aiEl(id)?.addEventListener(id === 'ai-provider-model' || id === 'ai-provider-adapter' ? 'change' : 'input', aiInvalidateProviderTest);
}

aiEl('ai-fetch-models')?.addEventListener('click', async () => {
  const button = aiEl('ai-fetch-models');
  button.disabled = true;
  aiSetTestState('loading', '正在远程获取模型列表…');
  try {
    const payload = aiReadProviderForm();
    const result = await window.ops.aiModels(payload);
    aiFillModelSelect(result.models || [], payload.model);
    aiProviderTested = false;
    aiEl('ai-save-provider').disabled = true;
    aiSetTestState('idle', `已获取 ${result.count || 0} 个模型，请选择后发送测试消息`);
  } catch (error) {
    aiSetTestState('error', aiErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

aiEl('ai-test-provider')?.addEventListener('click', async () => {
  const button = aiEl('ai-test-provider');
  button.disabled = true;
  aiProviderTested = false;
  aiEl('ai-save-provider').disabled = true;
  aiSetTestState('loading', '正在发送测试消息…');
  try {
    const payload = aiReadProviderForm();
    if (!payload.model) throw new Error('请先获取并选择模型');
    const result = await window.ops.aiTest(payload);
    aiProviderTested = true;
    aiEl('ai-save-provider').disabled = false;
    aiSetTestState('success', `${result.reply || '连接成功'} · ${result.model || payload.model}`);
  } catch (error) {
    aiSetTestState('error', aiErrorMessage(error));
  } finally {
    button.disabled = false;
  }
});

aiEl('ai-save-provider')?.addEventListener('click', async () => {
  if (!aiProviderTested) return toast('请先发送测试消息');
  const button = aiEl('ai-save-provider');
  button.disabled = true;
  try {
    const result = await window.ops.aiProviderSave({ ...aiReadProviderForm(), tested: true });
    aiUiState = result.state;
    aiEl('ai-provider-dialog')?.close?.();
    await aiRefreshState();
    toast('AI 配置已加密保存');
    log?.('AI', `保存模型配置 ${result.provider?.name || ''}`);
  } catch (error) {
    aiSetTestState('error', aiErrorMessage(error));
    button.disabled = false;
  }
});

aiEl('ai-delete-provider')?.addEventListener('click', async () => {
  const id = aiEl('ai-provider-id')?.value;
  const provider = aiProvider(id);
  if (!provider || !confirm(`确认删除 AI 配置“${provider.name}”？`)) return;
  try {
    aiUiState = await window.ops.aiProviderDelete(id);
    aiEl('ai-provider-dialog')?.close?.();
    await aiRefreshState();
    toast('AI 配置已删除');
  } catch (error) { toast(aiErrorMessage(error)); }
});

aiEl('ai-toggle-key')?.addEventListener('click', () => {
  const input = aiEl('ai-provider-key');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  aiEl('ai-toggle-key').innerHTML = `<i data-lucide="${input.type === 'password' ? 'eye' : 'eye-off'}"></i>`;
  aiSetLucide(aiEl('ai-toggle-key'));
});

aiEl('ai-active-provider')?.addEventListener('change', async (event) => {
  if (!event.target.value) return;
  try {
    aiUiState = await window.ops.aiProviderActive(event.target.value);
    aiRenderProviderSelects();
  } catch (error) { toast(aiErrorMessage(error)); }
});

aiEl('ai-edit-provider')?.addEventListener('click', () => {
  const current = aiCurrentProvider();
  aiOpenProviderDialog(current?.id || '', current?.presetId || 'openai');
});
aiEl('ai-add-provider')?.addEventListener('click', () => aiOpenProviderDialog('', 'openai'));
aiEl('ai-new-chat')?.addEventListener('click', () => aiNewSession().catch((error) => toast(aiErrorMessage(error))));
aiEl('ai-session-search')?.addEventListener('input', aiRenderSessions);

aiEl('ai-session-list')?.addEventListener('click', async (event) => {
  const deleteButton = event.target.closest('[data-ai-delete-session]');
  if (deleteButton) {
    event.stopPropagation();
    const id = deleteButton.dataset.aiDeleteSession;
    if (!confirm('确认删除这段 AI 对话？')) return;
    aiSessions = await window.ops.aiSessionDelete(id);
    if (aiCurrentSessionId === id) aiCurrentSessionId = aiSessions[0]?.id || '';
    aiRenderSessions();
    if (aiCurrentSessionId) aiRenderSession(await window.ops.aiSessionGet(aiCurrentSessionId));
    else {
      aiEl('ai-messages')?.replaceChildren();
      aiEl('ai-empty-state').hidden = false;
    }
    return;
  }
  const item = event.target.closest('[data-ai-session]');
  if (!item) return;
  aiCurrentSessionId = item.dataset.aiSession;
  const session = await window.ops.aiSessionGet(aiCurrentSessionId);
  if (session) aiRenderSession(session);
});

document.querySelectorAll('[data-ai-mode]').forEach((button) => {
  button.addEventListener('click', () => {
    aiMode = button.dataset.aiMode === 'rpa' ? 'rpa' : 'assistant';
    document.querySelectorAll('[data-ai-mode]').forEach((item) => item.classList.toggle('active', item === button));
    aiEl('ai-input').placeholder = aiMode === 'rpa'
      ? '描述你想自动完成的操作、目标网页和期望结果…'
      : '向 AiBrowser AI 提问，或描述需要配置的功能…';
  });
});

document.querySelectorAll('[data-ai-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    const prompt = button.dataset.aiPrompt || '';
    if (/流程|脚本/.test(prompt)) {
      aiMode = 'rpa';
      document.querySelectorAll('[data-ai-mode]').forEach((item) => item.classList.toggle('active', item.dataset.aiMode === 'rpa'));
    }
    aiEl('ai-input').value = prompt;
    aiEl('ai-input').focus();
  });
});

aiEl('ai-use-current-flow')?.addEventListener('click', () => {
  aiAttachCurrentFlow = !aiAttachCurrentFlow;
  aiUpdateContextSummary();
  toast(aiAttachCurrentFlow ? '已附加当前流程，敏感字段会隐藏' : '已取消附加当前流程');
});

aiEl('ai-input')?.addEventListener('input', (event) => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 150)}px`;
});
aiEl('ai-input')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    aiSendMessage();
  }
});
aiEl('ai-send')?.addEventListener('click', aiSendMessage);

aiEl('ai-preview-rpa')?.addEventListener('click', aiPreviewDraft);
aiEl('ai-apply-rpa')?.addEventListener('click', () => aiApplyDraft(false).catch((error) => toast(aiErrorMessage(error))));
aiEl('ai-test-rpa')?.addEventListener('click', () => aiApplyDraft(true).catch((error) => toast(aiErrorMessage(error))));
aiEl('ai-close-rpa-preview')?.addEventListener('click', () => aiEl('ai-rpa-preview-dialog')?.close?.());
aiEl('ai-apply-rpa-preview')?.addEventListener('click', () => {
  aiEl('ai-rpa-preview-dialog')?.close?.();
  aiApplyDraft(false).catch((error) => toast(aiErrorMessage(error)));
});
aiEl('ai-test-rpa-preview')?.addEventListener('click', () => {
  aiEl('ai-rpa-preview-dialog')?.close?.();
  aiApplyDraft(true).catch((error) => toast(aiErrorMessage(error)));
});
aiEl('ai-copy-rpa-json')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(aiDraft?.steps || [], null, 2));
    toast('流程 JSON 已复制');
  } catch (error) { toast(aiErrorMessage(error)); }
});

aiEl('rpa-ai-customize')?.addEventListener('click', () => {
  aiMode = 'rpa';
  aiAttachCurrentFlow = true;
  switchView('ai');
  document.querySelectorAll('[data-ai-mode]').forEach((item) => item.classList.toggle('active', item.dataset.aiMode === 'rpa'));
  aiUpdateContextSummary();
  const input = aiEl('ai-input');
  if (input) {
    input.placeholder = '描述希望如何创建或修改当前流程…';
    input.focus();
  }
});

const aiPreviousSwitchView = switchView;
switchView = function aiAwareSwitchView(view) {
  aiPreviousSwitchView.apply(this, arguments);
  if (view === 'ai') {
    refreshAiPage().catch((error) => toast(aiErrorMessage(error)));
    aiSetLucide(aiEl('view-ai') || document);
  }
};
