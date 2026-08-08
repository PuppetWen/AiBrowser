#!/usr/bin/env node
'use strict';

// Live provider diagnostic for the exact side-panel request shape. It never
// prints credentials and never executes a returned browser tool.
const path = require('path');
const { app } = require('../host-bridge');

async function main() {
  const userDataPath = path.resolve(process.argv[2] || app.getPath('userData'));
  app.setName('AiBrowser');
  try { app.setAppUserModelId('com.aibrowser.localworkspace'); } catch (_) {}
  app.setPath('userData', userDataPath);
  try { app.setPath('sessionData', userDataPath); } catch (_) {}
  await app.whenReady();
  const { AiService } = require('./ai-service');
  const { AgentToolset } = require('./agent-tools');
  const service = new AiService({ userDataPath });
  await service.init();
  const state = service.getState();
  const provider = service.resolveProvider({ id: state.activeProviderId }, true);
  const tools = new AgentToolset({ engine: null, outputDir: path.join(userDataPath, 'agent-output') }).definitions();
  const publicInfo = { id: provider.id, name: provider.name, adapter: provider.adapter, baseUrl: provider.baseUrl, model: provider.model, toolCount: tools.length };
  try {
    const result = await service.completeTools(provider, [{ role: 'user', content: '请简短回复：诊断成功。不要调用工具。' }], {
      model: provider.model,
      system: '这是一次浏览器侧边栏 Agent 请求格式诊断。',
      tools,
      maxTokens: 80,
      temperature: 0,
    });
    console.log(JSON.stringify({ success: true, provider: publicInfo, text: result.text, toolCallCount: result.toolCalls?.length || 0 }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ success: false, provider: publicInfo, error: String(error?.message || error) }, null, 2));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}

main().catch((error) => { console.error(String(error?.message || error)); app.quit(); process.exitCode = 1; });
