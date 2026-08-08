'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const { AiService, PROVIDER_PRESETS, validateRpaSteps } = require('./ai-service');

async function main() {
  assert.deepStrictEqual(
    PROVIDER_PRESETS.map((item) => item.id),
    ['openai', 'anthropic', 'kimi', 'glm', 'deepseek', 'gemini', 'minimax', 'qwen', 'custom'],
  );

  const steps = validateRpaSteps([
    { type: 'gotoUrl', url: 'https://example.com' },
    { type: 'waitForSelector', selector: '#search', timeout: 30000 },
    { type: 'inputContent', selector: '#search', content: 'AiBrowser', isClear: true },
    { type: 'click', selector: 'button[type="submit"]' },
  ]);
  assert.strictEqual(steps.length, 4);
  assert.throws(() => validateRpaSteps([{ type: 'madeUpAction' }]), /不支持/);
  assert.throws(() => validateRpaSteps([{ type: 'click' }]), /selector/);

  const root = path.resolve(__dirname, '..', '..', '.cache', 'ai-selftest');
  const workspace = path.resolve(__dirname, '..', '..');
  assert.ok(root.startsWith(workspace + path.sep));
  await fs.rm(root, { recursive: true, force: true });
  const service = new AiService({ userDataPath: root, getContext: () => ({ profiles: [] }) });
  await service.init();
  if (process.platform === 'win32') {
    const encryptedKey = service.encryptKey('selftest-local-key');
    assert.ok(encryptedKey.startsWith('dpapi:v1:'));
    assert.strictEqual(service.decryptKey({ apiKeyEncrypted: encryptedKey }), 'selftest-local-key');
  }

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (value.endsWith('/chat/completions')) {
      const body = JSON.parse(options.body);
      assert.strictEqual(body.model, 'model-a');
      assert.strictEqual(options.headers.Authorization, 'Bearer selftest-key');
      return new Response(JSON.stringify({
        model: 'model-a',
        choices: [{ message: { content: 'AiBrowser AI 连接成功' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected URL ${value}`);
  };

  try {
    const provider = {
      presetId: 'custom',
      name: 'Selftest',
      adapter: 'openai',
      baseUrl: 'https://ai.example.test/v1',
      apiKey: 'selftest-key',
      model: 'model-a',
    };
    const models = await service.listModels(provider);
    assert.deepStrictEqual(models.models, ['model-a', 'model-b']);
    const tested = await service.testProvider(provider);
    assert.strictEqual(tested.success, true);
    assert.match(tested.reply, /连接成功/);
  } finally {
    global.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }

  const html = await fs.readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const preload = await fs.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const mainSource = await fs.readFile(path.join(__dirname, '..', 'main.js'), 'utf8');
  for (const id of [
    'view-ai',
    'ai-provider-dialog',
    'ai-active-provider',
    'ai-message-scroll',
    'ai-input',
    'rpa-ai-customize',
  ]) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  for (const method of ['aiState', 'aiModels', 'aiTest', 'aiChat', 'aiGenerateRpa']) {
    assert.ok(preload.includes(`${method}:`), `missing preload ${method}`);
  }
  for (const channel of ['ai:state', 'ai:models', 'ai:test', 'ai:chat', 'ai:generate-rpa']) {
    assert.ok(mainSource.includes(`'${channel}'`), `missing IPC ${channel}`);
  }

  console.log('AI integration selftest passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
