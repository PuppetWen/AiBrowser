'use strict';

// Exercise the editor's real draft and summary paths without reading saved profiles.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { resolveProfileLanguage } = require('./automation/locale-from-country');
const source = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');

function declaration(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert(start >= 0, `Missing function ${name}`);
  const end = source.indexOf('\n}', start);
  assert(end > start, `Missing function end ${name}`);
  return source.slice(start, end + 2);
}

function element(tag, className = '', text = '') {
  return {
    tag, className, text, value: '', checked: false, dataset: {}, children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  };
}
const nodes = new Map();
const node = (selector) => {
  if (!nodes.has(selector)) nodes.set(selector, element('input'));
  return nodes.get(selector);
};
const context = vm.createContext({
  URL, Intl, console, UNGROUPED_ID: '',
  screen: { availWidth: 1707, availHeight: 1019 },
  editingProfileId: 'synthetic', editorNetworkResult: null,
  ui: { profiles: [{ id: 'synthetic', number: 1, kernel: 'chromium', language: 'ja-JP', proxy: 'Direct' }] },
  $: node, element,
  document: { createElement: element, querySelector: (selector) => ({ value: selector.includes('editor-network') ? 'direct' : 'fixed' }) },
  window: {},
  tx: (text) => text, toast() {}, updateEditorVisibility() {},
  refreshUaMetaPreview: async () => {},
  syncEditorKernelUi() {},
  groupNameOf: () => 'Default', maskProxy: (value) => value,
});
for (const name of [
  'positiveProfileNumber', 'normalizeProfileSettings', 'editorSet', 'editorCheck', 'editorSelectedNetwork',
  'serializeEditorProxy', 'editorDraft', 'renderEditorSummary', 'useSystemEditorDefaults', 'useGoogleEditorDefaults', 'readyBrowserLog',
]) vm.runInContext(declaration(name), context, { filename: `renderer.js:${name}` });

node('#editor-language-mode').value = 'ja-JP';
node('#editor-battery').value = 'blocked';
node('#editor-webgl-meta').value = 'noise';
node('#editor-client-rects').value = 'real';
node('#editor-cores').value = '4';
node('#editor-memory').value = '8';
node('#editor-kernel').value = 'chromium';
context.useSystemEditorDefaults();
const draft = context.editorDraft(false);
const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
assert.equal(draft.privacy.languageMode, 'system', 'The button must update the saved language mode, not only a hidden UI field');
assert.equal(draft.privacy.langFromIp, false);
assert.equal(draft.language, systemLocale);
assert.equal(resolveProfileLanguage(draft, { countryCode: 'JP' }), systemLocale, 'A later exit-IP lookup must not override the selected system language');
assert.equal(draft.privacy.battery, 'blocked', 'Reading basic parameters must preserve independent privacy settings');
assert.equal(draft.privacy.webglMeta, 'noise');
assert.equal(draft.privacy.clientRects, 'real');
assert.equal(draft.privacy.cores, 4);
assert.equal(draft.privacy.memory, 8);
assert.equal(draft.width, 1707);
assert.equal(draft.height, 1019);

const summary = () => Object.fromEntries(node('#editor-summary').children.map((row) => row.children.map((part) => part.text)));
assert.equal(summary()['浏览器'], 'Chromium');
assert.equal(summary()['User-Agent'], '按环境自动生成');
node('#editor-user-agent').value = 'Synthetic custom UA';
context.renderEditorSummary();
assert.equal(summary()['User-Agent'], 'Synthetic custom UA');
node('#editor-kernel').value = 'firefox-reverse';
context.renderEditorSummary();
assert.equal(summary()['浏览器'], 'Firefox-Reverse');
assert.equal(summary()['User-Agent'], '由 Firefox-Reverse 内核管理');

const info = { browsers: [{ name: 'Bundled Chromium' }, { name: 'Chrome' }, { name: 'Edge' }] };
context.ui.profiles.push(...[2, 3, 4, 5].map((number) => ({ id: `synthetic-${number}`, number })));
assert.equal(context.readyBrowserLog(info), '引擎启动 · 检测到 3 个浏览器程序', 'Installed program counts must be labelled independently of saved environment counts');
assert.equal(context.readyBrowserLog({ browsers: [] }), '引擎启动 · 未检测到浏览器程序');
context.ui.profiles[0].privacy = { fingerprint: { userAgent: 'stale override', canvas: 'noise', hardwareConcurrency: 99 } };
context.useGoogleEditorDefaults();
const nativeDraft = context.editorDraft(false);
assert.equal(nativeDraft.kernel, 'chromium');
assert.equal(nativeDraft.privacy.fingerprintMode, 'native');
assert.equal(nativeDraft.userAgent, '');
assert.equal(nativeDraft.privacy.geoMode, 'prompt');
assert.equal(nativeDraft.privacy.cores, 0);
assert.equal(nativeDraft.privacy.memory, 0);
assert.equal(nativeDraft.privacy.mediaDevices, 'real');
assert.equal(nativeDraft.privacy.battery, 'real');
assert.equal(nativeDraft.privacy.fingerprint.userAgent, undefined, 'Native preset discards imported overrides');
assert.equal(nativeDraft.privacy.fingerprint.hardwareConcurrency, undefined);
assert.equal(summary()['User-Agent'], '浏览器原生');
context.useSystemEditorDefaults();
assert.equal(context.editorDraft(false).privacy.fingerprintMode, 'custom', 'Basic parameter button restores editable custom mode');
assert.equal(context.editorDraft(false).privacy.fingerprint.userAgent, undefined, 'Discarded overrides do not return when switching modes');
console.log('EDITOR_SYSTEM_DEFAULTS_SELFTEST_OK: saved system language, retained privacy settings, kernel/UA summaries and program-count log');
