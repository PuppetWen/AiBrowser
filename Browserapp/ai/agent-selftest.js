'use strict';

/**
 * Agent verification without a browser or a network.
 *
 *   node ai/agent-selftest.js
 *
 * Covers the two places this feature can silently break:
 *   - the three vendor tool-calling protocols (shapes differ a lot)
 *   - the agent loop's bounds and message threading
 * Live CDP behaviour is checked separately against a real browser.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs/promises');
const { AiService } = require('./ai-service');
const { BrowserAgent } = require('./agent');
const { AgentToolset, TOOL_DEFS } = require('./agent-tools');

function ok(name) {
  console.log('  PASS  ' + name);
}

async function main() {
  console.log('AiBrowser agent selftest\n');

  // ---- 1. tool schemas are well formed -------------------------------------
  assert.ok(TOOL_DEFS.length >= 25, 'tool catalog size');
  const names = new Set();
  for (const tool of TOOL_DEFS) {
    assert.ok(/^[a-z][a-z0-9_]*$/.test(tool.name), 'tool name shape: ' + tool.name);
    assert.ok(!names.has(tool.name), 'duplicate tool: ' + tool.name);
    names.add(tool.name);
    assert.ok(tool.description && tool.description.length > 5, 'description: ' + tool.name);
    assert.strictEqual(tool.parameters.type, 'object', 'params object: ' + tool.name);
    for (const required of tool.parameters.required || []) {
      assert.ok(tool.parameters.properties[required], `${tool.name} requires undeclared "${required}"`);
    }
  }
  ok(`tool catalog well-formed (${TOOL_DEFS.length} tools)`);

  // Every declared tool must actually have an implementation. Calling with no
  // args either succeeds (tools with safe defaults) or fails for a real reason
  // — what must never happen is the "unknown tool" path.
  const kit = new AgentToolset({ engine: null, outputDir: path.join(__dirname, '..', '..', '.cache', 'agent-selftest') });
  for (const tool of TOOL_DEFS) {
    try {
      await kit.call(tool.name, {}, { profileId: '' });
    } catch (error) {
      assert.ok(
        !/未知工具/.test(error.message),
        `tool "${tool.name}" is declared but not implemented`
      );
    }
  }
  await assert.rejects(() => kit.call('no_such_tool', {}, {}), /未知工具/);
  ok('every declared tool has an implementation');

  // ---- 1b. the generated extension actually loads ---------------------------
  // These files are emitted as strings from a String.raw template, so a stray
  // backtick in a comment breaks the module and the sidebar silently vanishes.
  // That happened once; this catches it before it ships.
  const { writeSidebarAssets } = require('./sidebar-extension');
  const extDir = path.join(__dirname, '..', '..', '.cache', 'agent-selftest', 'ext');
  await fs.mkdir(extDir, { recursive: true });
  const fragments = await writeSidebarAssets(extDir, {
    profileId: 'env-x', envLabel: '1',
    apiBase: 'http://127.0.0.1:60725', apiKey: 'k-secret-value',
  });
  // Only the MAIN-world bridge is injected. There is deliberately no in-page
  // launcher: Chrome opens a side panel solely from a toolbar-action gesture,
  // so a page button could never work and would just look broken.
  assert.strictEqual(fragments.contentScripts.length, 1, 'MAIN-world bridge only');
  assert.strictEqual(fragments.contentScripts[0].world, 'MAIN', 'bridge must run in the page world');
  // Docked panel, not an in-page overlay: an overlay leaves the viewport
  // unchanged, so every position:fixed page element slides under it.
  assert.strictEqual(fragments.sidePanel.default_path, 'ai-panel.html');
  assert.ok(fragments.permissions.includes('sidePanel'), 'sidePanel permission required');

  const vm = require('vm');
  const fsSync = require('node:fs');
  for (const file of ['ai-bridge.js', 'ai-background.js', 'ai-panel.js']) {
    const source = fsSync.readFileSync(path.join(extDir, file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(source), `${file} must be valid JS`);
  }
  assert.ok(fsSync.existsSync(path.join(extDir, 'ai-panel.html')), 'panel document must exist');

  // Only the service worker may carry the loopback credential.
  for (const file of ['ai-bridge.js', 'ai-panel.js']) {
    assert.ok(
      !fsSync.readFileSync(path.join(extDir, file), 'utf8').includes('k-secret-value'),
      `${file} must not embed the API key`
    );
  }
  assert.ok(fsSync.readFileSync(path.join(extDir, 'ai-background.js'), 'utf8').includes('k-secret-value'),
    'background worker holds the credential');

  // A changed build must land in a new directory, or Chrome keeps answering
  // from the service worker it cached against the old extension id.
  const otherStamp = require('./sidebar-extension').stampFor({
    profileId: 'env-x', envLabel: '1',
    apiBase: 'http://127.0.0.1:60726', apiKey: 'k-secret-value',
  });
  assert.notStrictEqual(fragments.buildStamp, otherStamp, 'build stamp must track content');
  ok('generated extension parses, docks natively, keeps the key server-side');

  // ---- 1b2. every template step carries the params its action dereferences --
  // Type-level checks (findUnsupportedSteps) pass even when a step is missing
  // the field the engine reads, so those failures only surface at run time.
  // This caught four builtin flows whose `params` array shadowed the engine's
  // own params wrapper and silently dropped `expression`.
  const { cloneBuiltinTemplates } = require('../automation/rpa-templates-builtin');
  const REQUIRED = {
    gotoUrl: ['url'], click: ['selector'], inputContent: ['selector'],
    waitForSelector: ['selector'], selectElement: ['selector'],
    forElements: ['selector'], extractData: ['reg'], forLists: ['content'],
    javaScript: ['expression', 'code', 'script', 'content'],
  };
  const missing = [];
  const checkSteps = (steps, trail) => {
    (steps || []).forEach((step, index) => {
      const type = String(step.type || step.action || '');
      // Mirror the engine's own unwrapping so the check sees what it sees.
      const raw = step.params && typeof step.params === 'object' && !Array.isArray(step.params)
        ? step.params : step;
      const at = `${trail}${index + 1}`;
      const need = REQUIRED[type];
      if (need && !need.some((key) => String(raw[key] ?? '').trim() !== '')
        && !raw.element && raw.selectorType !== 'element') {
        missing.push(`${at} ${type} needs one of ${need.join('/')}`);
      }
      checkSteps(step.children || raw.children, `${at}.`);
      checkSteps(step.elseChildren || raw.elseChildren, `${at}E.`);
    });
  };
  for (const template of cloneBuiltinTemplates()) checkSteps(template.steps, `${template.id}:`);
  assert.deepStrictEqual(missing, [], 'builtin templates missing required step params');
  ok('builtin template steps carry their required params');

  // ---- 1c. external kernel contract ----------------------------------------
  // Firefox-Reverse has no CDP. If these ever flipped to true the app would
  // try to drive it over a protocol it does not speak.
  const externalKernel = require('../automation/external-kernel');
  const caps = externalKernel.capabilities();
  assert.strictEqual(caps.protocol, 'marionette');
  for (const off of ['cdp', 'fingerprintInjection', 'rpa', 'aiSidebar']) {
    assert.strictEqual(caps[off], false, `external kernel must report ${off}=false`);
  }
  assert.strictEqual(caps.windowSync, process.platform === 'win32', 'Firefox native window sync is Windows-only');
  for (const on of ['isolatedProfile', 'processControl', 'proxy']) {
    assert.strictEqual(caps[on], true, `external kernel should support ${on}`);
  }
  assert.doesNotThrow(() => externalKernel.detect({}), 'detect must not throw when absent');
  assert.deepStrictEqual(
    externalKernel.parseProxy('socks5://127.0.0.1:1080'),
    { scheme: 'socks', host: '127.0.0.1', port: 1080 }
  );
  assert.strictEqual(externalKernel.parseProxy('Direct'), null);
  ok('external kernel declares its non-CDP limits');

  // ---- 2. the three tool-calling protocols ---------------------------------
  const service = new AiService({ userDataPath: path.join(__dirname, '..', '..', '.cache', 'agent-selftest') });
  await service.init();

  const originalFetch = global.fetch;
  const seen = {};

  const sampleTools = [{
    name: 'page_info',
    description: 'read page',
    parameters: { type: 'object', properties: {}, required: [] },
  }];

  const messages = [
    { role: 'user', content: '看下当前页' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'call-1', name: 'page_info', args: {} }] },
    { role: 'tool', toolCallId: 'call-1', name: 'page_info', content: '{"url":"https://example.com"}' },
  ];

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    const body = JSON.parse(options.body);

    if (target.includes('/messages')) {           // anthropic
      seen.anthropic = body;
      return new Response(JSON.stringify({
        model: 'claude-x',
        content: [
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'tu-1', name: 'page_info', input: { a: 1 } },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes(':generateContent')) {    // gemini
      seen.gemini = body;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [
          { text: '好的' },
          { functionCall: { name: 'page_info', args: { b: 2 } } },
        ] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/chat/completions')) {   // openai-compatible
      seen.openai = body;
      return new Response(JSON.stringify({
        model: 'gpt-x',
        choices: [{ message: {
          content: '好的',
          tool_calls: [{ id: 'tc-1', type: 'function', function: { name: 'page_info', arguments: '{"c":3}' } }],
        } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unexpected url ' + target);
  };

  try {
    const openai = await service.completeTools(
      { adapter: 'openai', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'gpt-x' },
      messages, { tools: sampleTools, system: 'sys' }
    );
    assert.strictEqual(openai.toolCalls.length, 1);
    assert.strictEqual(openai.toolCalls[0].name, 'page_info');
    assert.deepStrictEqual(openai.toolCalls[0].args, { c: 3 });
    assert.strictEqual(seen.openai.tools[0].type, 'function');
    assert.strictEqual(seen.openai.messages[0].role, 'system');
    // the tool result must round-trip as a `tool` role carrying the call id
    const toolMsg = seen.openai.messages.find((m) => m.role === 'tool');
    assert.strictEqual(toolMsg.tool_call_id, 'call-1');
    ok('openai-compatible tool protocol');

    const anthropic = await service.completeTools(
      { adapter: 'anthropic', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'claude-x' },
      messages, { tools: sampleTools, system: 'sys' }
    );
    assert.strictEqual(anthropic.toolCalls[0].name, 'page_info');
    assert.deepStrictEqual(anthropic.toolCalls[0].args, { a: 1 });
    assert.strictEqual(seen.anthropic.tools[0].input_schema.type, 'object');
    const resultBlock = seen.anthropic.messages.find((m) => Array.isArray(m.content)
      && m.content[0]?.type === 'tool_result');
    assert.strictEqual(resultBlock.content[0].tool_use_id, 'call-1');
    ok('anthropic tool protocol');

    const gemini = await service.completeTools(
      { adapter: 'gemini', baseUrl: 'https://x.test/v1beta', apiKey: 'k', model: 'gemini-x' },
      messages, { tools: sampleTools, system: 'sys' }
    );
    assert.strictEqual(gemini.toolCalls[0].name, 'page_info');
    assert.deepStrictEqual(gemini.toolCalls[0].args, { b: 2 });
    assert.ok(seen.gemini.tools[0].functionDeclarations.length === 1);
    const fnResponse = seen.gemini.contents.find((c) => c.parts?.[0]?.functionResponse);
    assert.strictEqual(fnResponse.parts[0].functionResponse.name, 'page_info');
    ok('gemini tool protocol');
  } finally {
    global.fetch = originalFetch;
  }

  // ---- 3. agent loop -------------------------------------------------------
  const calls = [];
  const fakeService = {
    activeProviderId: 'p1',
    resolveProvider: () => ({ id: 'p1', adapter: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://x.test/v1' }),
    async completeTools(provider, turns) {
      // First pass asks for a tool, second pass answers.
      const alreadyRan = turns.some((t) => t.role === 'tool');
      if (!alreadyRan) {
        return { text: '先看看页面', toolCalls: [{ id: 'c1', name: 'page_info', args: {} }] };
      }
      const toolTurn = turns.find((t) => t.role === 'tool');
      calls.push(toolTurn.content);
      return { text: '当前页是 example.com', toolCalls: [] };
    },
  };

  const agent = new BrowserAgent({ aiService: fakeService, engine: null });
  agent.toolset.call = async (name) => ({ stubbed: name, url: 'https://example.com' });

  const events = [];
  const run = await agent.run({ profileId: 'env-1', message: '这是什么页面' }, (e) => events.push(e.type));

  assert.strictEqual(run.text, '当前页是 example.com');
  assert.strictEqual(run.steps, 1, 'exactly one tool step');
  assert.ok(calls[0].includes('example.com'), 'tool result fed back to the model');
  assert.ok(events.includes('tool-start') && events.includes('tool-end') && events.includes('done'));
  ok('agent loop: tool call -> result -> final answer');

  const view = agent.getSession(run.sessionId);
  assert.strictEqual(view.profileId, 'env-1');
  assert.strictEqual(view.messages.length, 3, 'user + assistant note + final answer');
  assert.strictEqual(view.toolTrace.length, 1);
  assert.ok(!JSON.stringify(view).includes('toolCallId'), 'raw tool plumbing not exposed to UI');
  ok('session view exposes messages + trace, hides plumbing');

  // profileId is mandatory — an unbound agent could drive the wrong browser
  await assert.rejects(() => agent.run({ message: 'x' }), /profileId/);
  ok('agent refuses to run unbound to an environment');

  // step cap holds even if the model keeps asking for tools
  const loopyService = {
    activeProviderId: 'p1',
    resolveProvider: () => ({ id: 'p1', adapter: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://x.test/v1' }),
    async completeTools() {
      return { text: '', toolCalls: [{ id: 'c', name: 'page_info', args: {} }] };
    },
  };
  const loopy = new BrowserAgent({ aiService: loopyService, engine: null });
  loopy.toolset.call = async () => ({ ok: true });
  const bounded = await loopy.run({ profileId: 'env-1', message: 'go' });
  assert.ok(bounded.steps <= 24, 'step cap enforced, got ' + bounded.steps);
  assert.match(bounded.text, /上限/);
  ok('runaway loop is bounded by the step cap');

  await fs.rm(path.join(__dirname, '..', '..', '.cache', 'agent-selftest'), { recursive: true, force: true });
  console.log('\nAll agent selftests passed.');
}

main().catch((error) => {
  console.error('\nFAIL', error);
  process.exit(1);
});
