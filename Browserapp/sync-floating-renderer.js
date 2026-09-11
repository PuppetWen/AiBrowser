const state = {
  initialized: false,
  sessions: [],
  selected: new Set(),
  master: null,
  active: false,
  expanded: false,
  refreshing: false,
  runtime: null,
  settings: { delayInput: false, inputMinMs: 300, inputMaxMs: 300 },
  panel: 'environments',
  customLayout: null,
  customLayoutHover: null,
  customLayoutCount: 0,
  customLayoutOpen: false,
};

const TEXT_GROUPS_KEY = 'aibrowser-specified-text-groups-v1';
const TEXT_GROUP_LIMIT = 20;
let textGroupSerial = 0;

function createTextGroup(index = 0) {
  textGroupSerial += 1;
  return { id: `text-group-${Date.now().toString(36)}-${textGroupSerial}`, mode: 'sequence', text: '', cursor: 0, index };
}

function loadTextGroups() {
  try {
    const value = JSON.parse(localStorage.getItem(TEXT_GROUPS_KEY) || '[]');
    if (Array.isArray(value) && value.length) return value.slice(0, TEXT_GROUP_LIMIT).map((group, index) => ({
      id: String(group?.id || createTextGroup(index).id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
      mode: group?.mode === 'random' ? 'random' : 'sequence',
      text: String(group?.text || '').slice(0, 500000),
      cursor: Math.max(0, Number.parseInt(group?.cursor, 10) || 0),
      index,
    }));
  } catch (_) {}
  return [createTextGroup(0)];
}

let textGroups = loadTextGroups();
let composingSpecifiedText = false;

const byId = (id) => document.getElementById(id);
let messageTimer = null;

function refreshIcons() {
  try { window.lucide?.createIcons?.({ attrs: { 'stroke-width': 1.9 } }); } catch (_) {}
}

function applyTheme(theme = {}) {
  document.documentElement.dataset.uiTheme = String(theme.themeId || 'pixel-workstation');
  document.documentElement.dataset.colorMode = String(theme.colorMode || 'dark');
  document.documentElement.dataset.nativeGlass = ['acrylic', 'vibrancy'].includes(theme.nativeGlass) ? theme.nativeGlass : 'none';
}

async function setExpanded(expanded) {
  state.expanded = Boolean(expanded);
  byId('floating-drawer').hidden = !state.expanded;
  byId('sync-targets').setAttribute('aria-expanded', String(state.expanded));
  byId('sync-targets').classList.toggle('expanded', state.expanded);
  await window.syncFloat.setExpanded(state.expanded);
}

function setPanel(name) {
  state.panel = ['environments', 'window', 'text', 'tabs'].includes(name) ? name : 'environments';
  document.querySelectorAll('[data-panel]').forEach((button) => button.classList.toggle('active', button.dataset.panel === state.panel));
  document.querySelectorAll('[data-panel-body]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panelBody === state.panel));
}

function showMessage(message = '', tone = 'error') {
  const box = byId('floating-message');
  if (messageTimer) clearTimeout(messageTimer); messageTimer = null;
  box.hidden = !message;
  box.textContent = message;
  box.classList.toggle('success', Boolean(message) && tone === 'success');
  if (message && tone !== 'success' && !state.expanded) setExpanded(true).catch(() => {});
  if (message && tone === 'success') messageTimer = setTimeout(() => showMessage(''), 1600);
}

function selectedSyncableIds() {
  const syncable = new Set(state.sessions.filter((item) => item.syncable).map((item) => item.id));
  return [...state.selected].filter((id) => syncable.has(id));
}

function preferredMaster(ids = selectedSyncableIds()) {
  if (ids.includes(state.master) && state.sessions.find((item) => item.id === state.master)?.canMaster) return state.master;
  return ids.find((id) => state.sessions.find((item) => item.id === id)?.canMaster) || null;
}

function orderedSelection() {
  const ids = selectedSyncableIds();
  const master = preferredMaster(ids);
  return master ? [master, ...ids.filter((id) => id !== master)] : ids;
}

function isUsableCustomLayout(layout, count) {
  return Boolean(layout)
    && layout.columns >= 1
    && layout.rows >= 1
    && layout.rows <= count
    && layout.columns * layout.rows >= count
    && count > 0;
}

function paintCustomLayoutSheet(count) {
  const layout = state.customLayoutHover || state.customLayout;
  document.querySelectorAll('#custom-layout-sheet .custom-layout-cell').forEach((cell) => {
    const column = Number.parseInt(cell.dataset.column, 10);
    const row = Number.parseInt(cell.dataset.row, 10);
    cell.classList.toggle('in-range', Boolean(layout) && column <= layout.columns && row <= layout.rows);
    cell.classList.toggle('range-corner', Boolean(layout) && column === layout.columns && row === layout.rows);
    cell.setAttribute('aria-selected', String(Boolean(layout) && column <= layout.columns && row <= layout.rows));
  });
  const valid = isUsableCustomLayout(layout, count);
  const capacity = layout ? layout.columns * layout.rows : 0;
  byId('custom-layout-summary').textContent = layout
    ? `${layout.columns}列 × ${layout.rows}行 · ${count} 个窗口`
    : `已选 ${count} 个窗口`;
  byId('custom-layout-hint').textContent = !layout
    ? '从左上角移动到目标格子，点击确定表格范围'
    : (capacity < count
      ? `当前只有 ${capacity} 个格子，还不能容纳 ${count} 个窗口`
      : (valid ? '布局可用；每行至少安排一个窗口，行内窗口自动铺满' : '当前布局不可用'));
  byId('custom-layout-apply').disabled = !valid;
}

function renderCustomLayoutPicker(count = selectedSyncableIds().length) {
  const picker = byId('custom-layout-picker');
  picker.hidden = !state.customLayoutOpen;
  if (!state.customLayoutOpen) return;
  const axis = Math.max(1, count);
  if (state.customLayoutCount !== count) {
    const columns = Math.ceil(Math.sqrt(axis));
    state.customLayout = { columns, rows: Math.ceil(axis / columns) };
    state.customLayoutHover = null;
    state.customLayoutCount = count;
  }
  const sheet = byId('custom-layout-sheet');
  sheet.replaceChildren();
  sheet.style.gridTemplateColumns = `repeat(${axis}, 25px)`;
  sheet.style.gridTemplateRows = `repeat(${axis}, 21px)`;
  for (let row = 1; row <= axis; row += 1) {
    for (let column = 1; column <= axis; column += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'custom-layout-cell';
      cell.dataset.column = String(column);
      cell.dataset.row = String(row);
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', `${column} 列 ${row} 行`);
      cell.addEventListener('mouseenter', () => {
        state.customLayoutHover = { columns: column, rows: row };
        paintCustomLayoutSheet(count);
      });
      cell.addEventListener('focus', () => {
        state.customLayoutHover = { columns: column, rows: row };
        paintCustomLayoutSheet(count);
      });
      cell.addEventListener('click', () => {
        state.customLayout = { columns: column, rows: row };
        state.customLayoutHover = null;
        paintCustomLayoutSheet(count);
      });
      sheet.append(cell);
    }
  }
  sheet.onmouseleave = () => { state.customLayoutHover = null; paintCustomLayoutSheet(count); };
  paintCustomLayoutSheet(count);
  refreshIcons();
}

function modeText(session) {
  if (session.syncMode === 'marionette-native') return 'Firefox · 网页语义 + 原生界面同步';
  return session.syncMode === 'native-coordinate' ? 'Firefox · 原生坐标同步' : `${session.browser} · 语义 + 原生同步`;
}

function failureMessage(result, fallback) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  if (!failures.length) return fallback;
  return failures.map((item) => {
    const session = state.sessions.find((value) => value.id === item.id);
    return `环境 ${session?.number ?? item.id}：${item.message}`;
  }).join('；');
}

async function persistSelection() {
  if (state.active) return;
  const ids = orderedSelection();
  const result = await window.syncFloat.select({ ids, master: preferredMaster(ids) });
  state.selected = new Set(result?.selected || ids);
  state.master = result?.selected?.[0] || preferredMaster(ids);
}

function render() {
  const list = byId('sync-environment-list');
  list.replaceChildren();
  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '暂无已打开的浏览器环境';
    list.append(empty);
  }
  for (const session of state.sessions) {
    const row = document.createElement('label');
    row.className = 'environment-row';
    if (state.selected.has(session.id)) row.classList.add('selected');
    if (!session.syncable) row.classList.add('unsupported');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(session.id);
    checkbox.disabled = state.active || !session.syncable;
    checkbox.addEventListener('change', async () => {
      if (checkbox.checked) state.selected.add(session.id); else state.selected.delete(session.id);
      const ids = selectedSyncableIds();
      if (!ids.includes(state.master) || !state.sessions.find((item) => item.id === state.master)?.canMaster) state.master = preferredMaster(ids);
      render();
      try { await persistSelection(); } catch (error) { showMessage(error.message || String(error)); await refreshSnapshot(); }
    });

    const number = document.createElement('span');
    number.className = 'environment-number';
    number.textContent = String(session.number ?? session.id).slice(0, 4);
    const copy = document.createElement('span');
    copy.className = 'environment-copy';
    const name = document.createElement('strong');
    name.textContent = session.name;
    const browser = document.createElement('small');
    browser.textContent = session.syncable ? modeText(session) : `${session.browser} · 当前平台不支持`;
    copy.append(name, browser);

    const masterChoice = document.createElement('label');
    masterChoice.className = 'master-choice';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'floating-master';
    radio.checked = state.master === session.id;
    radio.disabled = state.active || !session.syncable || !session.canMaster || !state.selected.has(session.id);
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      state.master = session.id; render();
      try { await persistSelection(); } catch (error) { showMessage(error.message || String(error)); await refreshSnapshot(); }
    });
    const masterText = document.createElement('span');
    masterText.textContent = '主控';
    masterChoice.append(radio, masterText);
    row.append(checkbox, number, copy, masterChoice);
    list.append(row);
  }

  const selected = selectedSyncableIds();
  const syncableCount = state.sessions.filter((item) => item.syncable).length;
  const hasMaster = Boolean(preferredMaster(selected));
  byId('sync-selected-count').textContent = `${selected.length} / ${syncableCount}`;
  byId('sync-targets-label').textContent = `环境 ${selected.length}/${syncableCount}`;
  byId('sync-select-all').disabled = state.active || syncableCount === 0;
  byId('sync-clear').disabled = state.active || selected.length === 0;

  const toggle = byId('sync-toggle');
  toggle.disabled = !state.active && (selected.length < 2 || !hasMaster);
  toggle.classList.toggle('stop', state.active);
  toggle.setAttribute('aria-label', state.active ? '停止操作同步' : '开始操作同步');
  const toggleIcon = document.createElement('i');
  toggleIcon.setAttribute('data-lucide', state.active ? 'square' : 'play');
  toggle.replaceChildren(toggleIcon);
  byId('sync-restart').disabled = selected.length < 2 || !hasMaster;

  document.querySelectorAll('[data-window-action], [data-tab-action], #floating-send-text, #floating-clear-text').forEach((button) => {
    button.disabled = selected.length === 0;
  });
  byId('floating-custom-layout').disabled = selected.length === 0;
  renderCustomLayoutPicker(selected.length);

  const ready = state.runtime?.nativeReady !== false;
  byId('sync-status-dot').classList.toggle('active', state.active && ready);
  byId('sync-status-dot').classList.toggle('waiting', state.active && !ready);
  byId('sync-status-title').textContent = state.active
    ? (ready ? `同步中 · 主控 ${state.sessions.find((item) => item.id === state.master)?.number ?? state.master}` : '原生通道启动中')
    : (selected.length >= 2 && hasMaster ? '已准备' : '请选择至少 2 个环境');
  byId('floating-delay-input').checked = Boolean(state.settings?.delayInput);
  renderTextGroups();
  setPanel(state.panel);
  refreshIcons();
}

async function refreshSnapshot() {
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    const snapshot = await window.syncFloat.snapshot();
    applyTheme(snapshot.theme);
    state.sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    state.runtime = snapshot.sync?.runtime || null;
    state.settings = { ...state.settings, ...(snapshot.sync?.settings || {}) };
    state.active = Boolean(snapshot.sync?.active);
    const valid = new Set(state.sessions.filter((item) => item.syncable).map((item) => item.id));
    const shared = (snapshot.sync?.selected || []).filter((id) => valid.has(id));
    const initializeAll = !state.initialized && !shared.length && !state.active;
    state.selected = new Set(initializeAll ? valid : shared);
    state.master = state.active ? snapshot.sync?.master : (shared[0] || null);
    if (!state.selected.has(state.master) || !state.sessions.find((item) => item.id === state.master)?.canMaster) state.master = preferredMaster();
    state.initialized = true;
    if (initializeAll && state.selected.size) await persistSelection();
    showMessage('');
    render();
  } catch (error) {
    showMessage(error.message || String(error));
  } finally {
    state.refreshing = false;
  }
}

async function runCommand(action, successMessage) {
  showMessage('');
  try {
    const result = await action();
    await refreshSnapshot();
    if (result?.success === false) showMessage(failureMessage(result, `${successMessage}未全部完成`));
    else if (successMessage) showMessage(successMessage, 'success');
    return result;
  } catch (error) {
    showMessage(error.message || String(error));
    return null;
  }
}

function normalizeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'about:blank';
  if (/^(https?:\/\/|about:)/i.test(raw)) return raw;
  return `https://${raw}`;
}

function selectedTextIds() {
  const ids = selectedSyncableIds();
  if (!ids.length) throw new Error('请至少选择一个运行中的浏览器环境');
  return ids.sort((left, right) => {
    const a = state.sessions.find((item) => item.id === left); const b = state.sessions.find((item) => item.id === right);
    return String(a?.number ?? left).localeCompare(String(b?.number ?? right), 'zh-CN', { numeric: true, sensitivity: 'base' }) || left.localeCompare(right);
  });
}

function textDelayRange() {
  return state.settings?.delayInput
    ? [Math.max(0, Number(state.settings.inputMinMs) || 0) / 1000, Math.max(0, Number(state.settings.inputMaxMs) || 0) / 1000]
    : [0, 0];
}

function textItems(value) { return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }

function distributeTexts(items, count, mode, cursor) {
  if (!items.length || count <= 0) return { texts: [], nextCursor: Math.max(0, Number(cursor) || 0) };
  if (mode === 'random') return { texts: Array.from({ length: count }, () => items[Math.floor(Math.random() * items.length)]), nextCursor: Math.max(0, Number(cursor) || 0) };
  const start = ((Number(cursor) || 0) % items.length + items.length) % items.length;
  return { texts: Array.from({ length: count }, (_item, index) => items[(start + index) % items.length]), nextCursor: (start + count) % items.length };
}

function saveTextGroups() {
  try { localStorage.setItem(TEXT_GROUPS_KEY, JSON.stringify(textGroups.map(({ id, mode, text, cursor }) => ({ id, mode, text, cursor })))); } catch (_) {}
}

function renderTextGroups(force = false) {
  const target = byId('floating-specified-groups'); if (!target) return;
  // Replacing a focused textarea destroys the browser's IME composition
  // session. Snapshot refreshes run every 2.5 seconds, so never rebuild this
  // part of the drawer while the user is editing it.
  const focusedText = document.activeElement?.closest?.('[data-text-value]');
  if (!force && (composingSpecifiedText || (focusedText && target.contains(focusedText)))) return;
  target.replaceChildren();
  textGroups.forEach((group, index) => {
    const card = document.createElement('article'); card.className = 'floating-specified-group'; card.dataset.textGroup = group.id;
    const head = document.createElement('div'); head.className = 'floating-specified-head';
    const title = document.createElement('strong'); title.textContent = `文本组${index + 1}`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.textRemove = group.id; remove.textContent = '删除'; remove.hidden = textGroups.length <= 1;
    head.append(title, remove);
    const modes = document.createElement('div'); modes.className = 'floating-specified-modes';
    for (const [value, labelText] of [['sequence', '顺序输入'], ['random', '随机输入']]) {
      const label = document.createElement('label'); const radio = document.createElement('input'); radio.type = 'radio'; radio.name = `floating-mode-${group.id}`; radio.value = value; radio.checked = group.mode === value; radio.dataset.textMode = group.id; label.append(radio, document.createTextNode(labelText)); modes.append(label);
    }
    const textarea = document.createElement('textarea'); textarea.value = group.text; textarea.dataset.textValue = group.id; textarea.placeholder = '每行一条文本，按环境分别输入';
    const foot = document.createElement('div'); foot.className = 'floating-specified-foot';
    const count = document.createElement('span'); count.textContent = `${textItems(group.text).length} 条文本`; count.dataset.textCount = group.id;
    const send = document.createElement('button'); send.type = 'button'; send.dataset.textSend = group.id; send.textContent = '输入';
    foot.append(count, send); card.append(head, modes, textarea, foot); target.append(card);
  });
}

async function sendSpecifiedGroup(id) {
  const group = textGroups.find((item) => item.id === id); if (!group) return;
  let ids; try { ids = selectedTextIds(); } catch (error) { return showMessage(error.message); }
  const items = textItems(group.text); if (!items.length) return showMessage('请先在文本组中每行填写一条文本');
  const assignment = distributeTexts(items, ids.length, group.mode, group.cursor); const [min, max] = textDelayRange();
  const result = await runCommand(() => window.syncFloat.batchTextAction(ids, assignment.texts, min, max), group.mode === 'random' ? '随机指定文本已输入' : '顺序指定文本已输入');
  if (result?.success && group.mode === 'sequence') { group.cursor = assignment.nextCursor; saveTextGroups(); }
}

byId('sync-targets').addEventListener('click', () => {
  if (!state.expanded) setPanel('environments');
  setExpanded(!state.expanded).catch((error) => showMessage(error.message));
});
document.querySelectorAll('[data-panel]').forEach((button) => button.addEventListener('click', () => setPanel(button.dataset.panel)));
byId('sync-refresh').addEventListener('click', refreshSnapshot);
byId('sync-open-manager').addEventListener('click', () => window.syncFloat.openManager(false).catch((error) => showMessage(error.message)));
byId('sync-select-all').addEventListener('click', async () => {
  state.selected = new Set(state.sessions.filter((item) => item.syncable).map((item) => item.id));
  state.master = preferredMaster(); render();
  try { await persistSelection(); } catch (error) { showMessage(error.message || String(error)); }
});
byId('sync-clear').addEventListener('click', async () => {
  state.selected.clear(); state.master = null; render();
  try { await persistSelection(); } catch (error) { showMessage(error.message || String(error)); }
});
byId('sync-toggle').addEventListener('click', async () => {
  const button = byId('sync-toggle'); button.disabled = true; showMessage('');
  try {
    if (state.active) await window.syncFloat.stop();
    else await window.syncFloat.apply({ ids: orderedSelection(), master: preferredMaster() });
    await refreshSnapshot();
  } catch (error) { showMessage(error.message || String(error)); render(); }
});
byId('sync-restart').addEventListener('click', () => runCommand(() => window.syncFloat.restart(), '同步已重启'));
byId('floating-custom-layout').addEventListener('click', () => {
  state.customLayoutOpen = true;
  renderCustomLayoutPicker();
});
byId('custom-layout-close').addEventListener('click', () => {
  state.customLayoutOpen = false;
  renderCustomLayoutPicker();
});
byId('custom-layout-apply').addEventListener('click', () => {
  if (!state.customLayout) return showMessage('请先选择一个布局');
  const layout = { ...state.customLayout };
  state.customLayoutOpen = false;
  renderCustomLayoutPicker();
  return runCommand(
    () => window.syncFloat.windowAction(orderedSelection(), 'custom-tile', layout),
    '自定义布局已应用',
  );
});
document.querySelectorAll('[data-window-action]').forEach((button) => button.addEventListener('click', () => runCommand(
  () => window.syncFloat.windowAction(orderedSelection(), button.dataset.windowAction),
  '窗口操作已完成',
)));
byId('floating-send-text').addEventListener('click', () => runCommand(
  () => { const [min, max] = textDelayRange(); return window.syncFloat.textAction(selectedTextIds(), 'insert', byId('floating-sync-text').value, min, max); },
  '文本输入已完成',
));
byId('floating-clear-text').addEventListener('click', () => runCommand(
  () => window.syncFloat.textAction(selectedTextIds(), 'clear', '', 0, 0),
  '内容已清空',
));
byId('floating-send-random').addEventListener('click', () => {
  let ids; try { ids = selectedTextIds(); } catch (error) { return showMessage(error.message); }
  let min = Number(byId('floating-random-min').value), max = Number(byId('floating-random-max').value);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return showMessage('请输入有效的随机数字范围');
  if (max < min) [min, max] = [max, min];
  const decimals = Math.max((String(byId('floating-random-min').value).split('.')[1] || '').length, (String(byId('floating-random-max').value).split('.')[1] || '').length);
  const texts = ids.map(() => (min + Math.random() * (max - min)).toFixed(Math.min(8, decimals))); const [delayMin, delayMax] = textDelayRange();
  return runCommand(() => window.syncFloat.batchTextAction(ids, texts, delayMin, delayMax), '随机数字已输入');
});
byId('floating-delay-input').addEventListener('change', async (event) => {
  try { state.settings = { ...state.settings, ...await window.syncFloat.setSettings({ ...state.settings, delayInput: event.target.checked }) }; render(); }
  catch (error) { showMessage(error.message || String(error)); }
});
byId('floating-add-text-group').addEventListener('click', () => {
  if (textGroups.length >= TEXT_GROUP_LIMIT) return showMessage(`最多添加 ${TEXT_GROUP_LIMIT} 个文本组`);
  textGroups.push(createTextGroup(textGroups.length)); saveTextGroups(); renderTextGroups(true); refreshIcons();
});
byId('floating-specified-groups').addEventListener('compositionstart', (event) => {
  if (event.target?.matches?.('[data-text-value]')) composingSpecifiedText = true;
});
byId('floating-specified-groups').addEventListener('compositionend', (event) => {
  if (!event.target?.matches?.('[data-text-value]')) return;
  composingSpecifiedText = false;
  const group = textGroups.find((item) => item.id === event.target.dataset.textValue); if (!group) return;
  group.text = event.target.value.slice(0, 500000);
  group.cursor = Math.min(group.cursor, Math.max(0, textItems(group.text).length - 1));
  saveTextGroups();
});
byId('floating-specified-groups').addEventListener('input', (event) => {
  const group = textGroups.find((item) => item.id === event.target.dataset.textValue); if (!group) return;
  group.text = event.target.value.slice(0, 500000); group.cursor = Math.min(group.cursor, Math.max(0, textItems(group.text).length - 1));
  if (!event.isComposing && !composingSpecifiedText) saveTextGroups();
  const count = document.querySelector(`[data-text-count="${group.id}"]`); if (count) count.textContent = `${textItems(group.text).length} 条文本`;
});
byId('floating-specified-groups').addEventListener('change', (event) => {
  const group = textGroups.find((item) => item.id === event.target.dataset.textMode); if (!group) return;
  group.mode = event.target.value === 'random' ? 'random' : 'sequence'; group.cursor = 0; saveTextGroups();
});
byId('floating-specified-groups').addEventListener('click', (event) => {
  const send = event.target.closest('[data-text-send]'); if (send) return sendSpecifiedGroup(send.dataset.textSend);
  const remove = event.target.closest('[data-text-remove]'); if (!remove || textGroups.length <= 1) return;
  textGroups = textGroups.filter((item) => item.id !== remove.dataset.textRemove); saveTextGroups(); renderTextGroups(true);
});
document.querySelectorAll('[data-tab-action]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.tabAction;
  return runCommand(
    () => window.syncFloat.tabAction(orderedSelection(), action, { url: normalizeUrl(byId('floating-tab-url').value) }),
    '标签页操作已完成',
  );
}));
byId('floating-hide').addEventListener('click', () => window.syncFloat.hide().catch((error) => showMessage(error.message)));
window.syncFloat.onTheme(applyTheme);
window.addEventListener('storage', (event) => {
  if (event.key !== TEXT_GROUPS_KEY) return;
  const editor = document.activeElement?.closest?.('[data-text-value]');
  if (composingSpecifiedText || editor) return;
  textGroups = loadTextGroups();
  renderTextGroups();
});
window.syncFloat.onEvent((value) => {
  if (['status', 'sync-state', 'sync-disconnected', 'native-input', 'live-sync', 'sync-settings'].includes(value?.type)) refreshSnapshot();
});

refreshIcons();
refreshSnapshot();
setInterval(refreshSnapshot, 2500);
