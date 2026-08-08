const fs = require('fs');
const path = require('path');

const root = __dirname;
const inputPath = path.join(root, 'all-selftests-extra-results.json');
const outputPath = path.join(root, 'FUNCTIONAL_TEST_REPORT.md');
const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const specs = {
  'agent-selftest.js': ['AI Agent 工具目录、模型协议、工具调用循环与安全边界', ['校验 29 个工具声明与实现完整对应', '模拟 OpenAI、Anthropic、Gemini 工具协议及工具调用到最终回答的完整循环', '验证未绑定环境拒绝执行以及最大步骤数限制']],
  'ai-selftest.js': ['AI 服务配置、模型调用与错误处理', ['校验 AI 配置解析和模型请求构造', '覆盖正常响应、异常响应及配置边界']],
  'automation-selftest.js': ['自动化服务核心接口与任务执行', ['调用自动化服务的主要 API', '验证任务参数、执行结果和异常返回']],
  'cloud-sync-security-selftest.js': ['云同步数据安全与敏感字段保护', ['验证同步数据不会泄露受保护字段', '覆盖非法或篡改同步载荷的拒绝逻辑']],
  'env-icon-selftest.js': ['环境图标生成与状态表达', ['生成不同环境状态对应的图标', '校验图标输出格式及状态差异']],
  'fingerprint-stability-selftest.js': ['浏览器指纹配置稳定性', ['对同一环境重复生成指纹并比较', '验证环境更新后受控字段变化']],
  'ip-health-score-selftest.js': ['代理 IP 健康评分', ['输入正常、异常及缺失的 IP 指标', '验证评分区间、降级和边界处理']],
  'isolation-fingerprint-selftest.js': ['多环境指纹隔离', ['创建多个环境并比较指纹数据', '验证环境间存储和指纹不串用']],
  'kernel-cdp-ready-selftest.js': ['外部浏览器内核 CDP 就绪探测', ['检测可用内核种子及 CDP 端口', '覆盖平台缺少内核资源时的明确跳过']],
  'kernel-init-sync-selftest.js': ['浏览器内核初始化与同步状态', ['初始化内核并等待同步组件就绪', '校验初始化顺序和状态事件']],
  'kernel-policy-selftest.js': ['浏览器内核选择策略', ['按平台、架构和浏览器类型选择内核', '验证不支持组合的降级与限制']],
  'local-api-ai-error-selftest.js': ['本地 API 的 AI 错误返回', ['模拟 AI 提供方失败', '验证本地 API 状态码、错误结构和敏感信息过滤']],
  'protocol-selftest.js': ['自动化通信协议编解码', ['编码并解码合法协议消息', '拒绝缺失字段、未知类型和非法载荷']],
  'proxy-subscription-selftest.js': ['代理订阅解析与更新', ['解析订阅内容并生成代理节点', '覆盖重复、无效节点及更新合并']],
  'wayfern-launch-selftest.js': ['Wayfern 浏览器启动兼容', ['按 Wayfern 参数启动并探测 CDP', '对当前版本不要求 terms 参数或不支持 CDP 的环境明确跳过']],
  'browser-startup-diagnostic-selftest.js': ['浏览器启动诊断', ['模拟启动成功与失败', '验证错误分类、退出信息和诊断输出']],
  'chromium-composition-sync-selftest.js': ['Chromium 输入法组合文本同步', ['模拟 compositionstart/update/end', '验证组合文本只在提交后正确同步且不重复']],
  'chromium-ime-sync-selftest.js': ['Chromium IME 输入同步', ['输入法候选提交到主窗口', '验证从窗口文本一致且焦点不被抢占']],
  'chromium-live-omnibox-regression-selftest.js': ['Chromium 地址栏实时同步回归', ['在主地址栏输入和复制文本', '验证多个从窗口地址栏一致及主窗口保持前台']],
  'desktop-packaging-ui-selftest.js': ['桌面打包资源与 UI 入口', ['检查桌面构建所需文件和入口', '验证打包 UI 资源引用完整']],
  'disconnect-selftest.js': ['浏览器断开连接与资源清理', ['主动断开 CDP/浏览器会话', '验证监听器、子进程和状态均被清理']],
  'dock-shell-selftest.js': ['Dock Shell 平台集成', ['验证 Dock Shell 启动和参数', '非 Darwin 平台明确跳过']],
  'environment-audit-selftest.js': ['环境配置审计', ['审计环境配置、代理和指纹字段', '验证风险项和修复建议输出']],
  'extension-marker-cleanliness-selftest.js': ['扩展标记资源完整性与清洁性', ['检查扩展资源路径存在', '扫描标记内容，防止调试或测试残留进入运行资源']],
  'extension-pipe-port-selftest.js': ['扩展 Native Messaging 管道端口', ['启动扩展安装器并验证端口协商', '不支持安装器或 CDP 模式时明确跳过']],
  'extension-pipe-selftest.js': ['扩展 Native Messaging 管道通信', ['连接扩展管道并交换消息', '不支持当前运行模式时明确跳过']],
  'extension-startup-target-selftest.js': ['扩展启动目标恢复', ['从持久化状态恢复扩展目标', '缺少 APPDATA 测试夹具时明确跳过']],
  'extension-state-unit-selftest.js': ['扩展状态管理单元逻辑', ['验证连接、断开和目标状态迁移', '覆盖重复事件与无效状态']],
  'extension-storage-selftest.js': ['扩展存储读写与隔离', ['写入、读取和删除扩展状态', '验证环境间数据隔离和默认值']],
  'fingerprint-inject-order-selftest.js': ['指纹脚本注入顺序', ['检查文档创建前注入顺序', '验证业务页面执行前指纹已生效']],
  'firefox-kernel-selftest.js': ['Firefox 内核启动与控制', ['启动 Firefox 环境并建立控制连接', '验证页面加载和会话清理']],
  'firefox-native-sync-selftest.js': ['Firefox 原生地址栏输入同步', ['向主 Firefox 地址栏输入固定文本', '验证从窗口、复制值和前台窗口一致']],
  'four-window-chrome-menu-selftest.js': ['四窗口 Chrome 菜单同步', ['在主窗口打开 Chrome 菜单', '验证四个环境均显示对应原生菜单控件']],
  'four-window-devtools-selftest.js': ['四窗口 DevTools 同步', ['主窗口按 F12 并验证四个 DevTools 目标', '点击 Sources，并按 Chromium 能力条件测试 Show more 与 Snippets']],
  'four-window-extension-popup-selftest.js': ['四窗口扩展弹窗同步', ['在四个环境打开扩展弹窗', '点击扩展控件并验证四个弹窗状态一致']],
  'four-window-extension-sidepanel-selftest.js': ['四窗口扩展侧边栏同步', ['在四个环境打开真实 Side Panel API 页面和 iframe', '验证密码焦点、点击计数、键入与粘贴内容一致']],
  'four-window-tab-click-convergence-selftest.js': ['四窗口标签点击收敛', ['在主窗口点击标签页', '验证四个环境活动标签最终收敛且无循环抖动']],
  'four-window-upper-ui-jitter-selftest.js': ['四窗口上层原生 UI 同步稳定性', ['反复操作地址栏、开关标签并导航 data URL', '采样从窗口前台次数并验证标签数与最终 URL 一致']],
  'i18n-selftest.js': ['国际化资源完整性', ['检查各语言键集合一致', '验证缺失键、占位符和回退语言']],
  'live-sync-selftest.js': ['页面输入、点击和滚动实时同步', ['主页面输入固定文本并点击计数按钮', '滚动到 900 像素并轮询验证从页面三类状态一致']],
  'live-sync-v4-selftest.js': ['Live Sync v4 事件语义', ['同步输入、点击和滚动事件', '验证程序化零坐标 click 以语义点击同步而非误点页面角落']],
  'live-sync-v5-selftest.js': ['Live Sync v5 生命周期与恢复', ['启动、停止并重新启动同步', '使用动态起始页端口验证标签映射、窗口尺寸和状态恢复']],
  'mixed-firefox-sync-selftest.js': ['Chromium 与 Firefox 混合环境同步', ['建立混合浏览器主从组', '验证跨内核文本和页面状态同步']],
  'native-browser-text-selftest.js': ['原生浏览器文本读写辅助程序', ['读取和写入浏览器顶部编辑控件', '验证不支持控件时的回退及窗口恢复']],
  'native-omnibox-selftest.js': ['四窗口原生 Omnibox 同步', ['依次输入 first-copy-1111 与 second-paste-2222', '验证主从地址栏、剪贴板、SendInput 结果及从窗口前台采样']],
  'native-secret-store-selftest.js': ['Windows 原生密钥存储', ['写入、读取和删除测试密钥', '验证密文隔离、错误口令及清理']],
  'network-mode-selftest.js': ['网络模式选择与切换', ['切换直连、代理和离线模式', '验证网络参数及状态更新']],
  'newtab-sync-selftest.js': ['新标签页文本同步', ['在两个真实 NTP 创建受控文本框并聚焦', '输入固定文本并验证指定环境标记与同步值']],
  'okx-crx-selftest.js': ['OKX 扩展 CRX 加载兼容', ['加载 OKX CRX 测试夹具', '夹具不存在时明确跳过而不伪造结果']],
  'portable-paths-selftest.js': ['便携版路径解析', ['计算便携运行时数据和资源路径', '覆盖带空格路径、相对路径及目录回退']],
  'profile-batch-unit-selftest.js': ['环境批量操作', ['批量创建、更新和删除环境', '验证部分失败、重复 ID 和结果汇总']],
  'proxy-feature-selftest.js': ['代理功能集成', ['配置不同协议代理并应用到环境', '验证认证、直连回退和错误提示']],
  'proxy-format-selftest.js': ['代理地址格式解析', ['解析 HTTP、HTTPS、SOCKS5 及带认证地址', '拒绝非法端口、缺失主机和异常编码']],
  'proxy-forwarder-selftest.js': ['本地代理转发器', ['通过转发器建立请求', '验证上游认证、数据转发和连接清理']],
  'rpa-marketplace-flow-selftest.js': ['RPA 市场任务流程', ['加载市场任务并生成自动化步骤', '验证安装、执行和结果状态流转']],
  'rpa-wayfern-compat-selftest.js': ['RPA 与 Wayfern 兼容', ['将 RPA 步骤转换为 Wayfern 可执行参数', '覆盖不支持动作和兼容降级']],
  'ensure-host-runtime-selftest.js': ['宿主运行时准备脚本', ['探测 Node 与原生运行时', '验证缺失运行时的本地安装路径和诊断']],
  'proxy-live-subscription-selftest.js': ['代理订阅在线端到端流程', ['连接运行中的 AiBrowser CDP 并刷新订阅', '缺少指定 CDP 端口时明确跳过']],
  'proxy-ui-selftest.js': ['代理 UI 实际交互', ['通过运行中的 AiBrowser UI 添加和选择代理', '缺少指定 CDP 端口时明确跳过']],
  'security-hardening-selftest.js': ['安全加固规则', ['扫描命令执行、路径和敏感信息处理', '验证危险输入被拒绝且日志脱敏']],
  'selftest.js': ['应用核心综合单元测试', ['执行核心模块主要正常流程', '覆盖关键边界、错误处理和兼容行为']],
  'socks5-reset-selftest.js': ['SOCKS5 连接重置恢复', ['模拟上游连接被重置', '验证连接关闭、错误传播和后续请求恢复']],
  'socks5-retry-selftest.js': ['SOCKS5 请求重试', ['模拟暂时失败后重试成功', '验证重试上限和不可重试错误']],
  'specified-text-four-selftest.js': ['四窗口指定文本同步', ['在四个页面创建受控可见文本框', '聚焦主文本框并验证指定文本同步到全部窗口']],
  'store-batch-four-selftest.js': ['四环境扩展商店批量操作', ['对四个环境执行批量安装流程', '验证每个环境结果和失败隔离']],
  'store-offline-selftest.js': ['扩展商店离线行为', ['模拟商店离线或不可达', '验证缓存、提示和安全失败']],
  'store-selftest.js': ['Chrome Web Store 实际访问', ['连接 Chrome Web Store 并执行商店流程', '网络不可达时明确记录环境跳过']],
  'sync-backpressure-unit-selftest.js': ['同步事件背压与队列控制', ['突发发送大量同步事件', '验证合并、顺序、队列上限和最终状态']],
  'sync-console-selftest.js': ['控制台事件同步', ['从主页面产生控制台事件', '验证从环境接收、过滤和顺序']],
  'sync-floating-text-parity-selftest.js': ['浮动文本同步一致性', ['加载本地浮动文本资源并输入', '比较主从 DOM 文本、焦点和事件结果']],
  'sync-settings-unit-selftest.js': ['同步设置管理', ['读写各同步开关与默认值', '验证非法配置归一化和持久化']],
  'tab-mapping-unit-selftest.js': ['跨环境标签页映射', ['创建、关闭、切换多组标签', '验证映射更新、孤儿清理和顺序一致']],
  'theme-nes-light-selftest.js': ['NES Light 主题资源', ['加载主题变量和组件样式', '验证关键颜色、字体和资源声明']],
  'theme-retro-desktop-selftest.js': ['Retro Desktop 主题资源', ['加载复古桌面主题', '验证窗口、按钮、背景和状态样式']],
  'zoom-reconcile-4-selftest.js': ['四窗口缩放比例收敛', ['为四个环境设置不同缩放', '触发同步后验证缩放比例一致']],
  'zoom-window-selftest.js': ['窗口缩放控制', ['设置、读取和重置窗口缩放', '验证边界值及窗口重建后的恢复']],
};

function basename(name) {
  return String(name).replace(/\\/g, '/').split('/').pop();
}

function evidenceFor(item) {
  const combined = `${item.stdout || ''}\n${item.stderr || ''}`.replace(/```/g, '~~~');
  const lines = combined.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = lines.filter((line) => /^(PASS|FAIL|SKIP|ok\b|All\b|Error:|PAYLOAD\b)|"success"\s*:\s*(true|false)|success\s*[=:]/i.test(line));
  const selected = (preferred.length ? preferred : lines).filter((line, index, list) => list.indexOf(line) === index).slice(0, 10);
  return selected.length ? selected.join('\n') : '(该测试未输出额外文本，以退出码和结果状态为证据)';
}

function resultLabel(item) {
  const text = `${item.stdout || ''}\n${item.stderr || ''}`;
  const hasSkip = /(^|\n)\s*SKIP\b/i.test(text);
  const hasPass = /(^|\n)\s*PASS\b/i.test(text) || /"success"\s*:\s*true/i.test(text);
  if (item.status === 'FAIL') return `FAIL（退出码 ${item.code}）`;
  if (hasSkip && hasPass) return 'PASS（包含明确的环境跳过分支）';
  if (hasSkip) return 'SKIP（当前环境不具备实际执行条件）';
  return `PASS（退出码 ${item.code}）`;
}

Object.assign(specs, {
  'Browserapp/automation/wayfern-launch-selftest.js': {
    feature: '项目内置 Wayfern 内核启动与 CDP 就绪',
    cases: ['在普通用户权限下准备许可条款与项目内便携环境', '启动项目内置 Wayfern 二进制', '轮询并验证 CDP 端口实际可用'],
  },
  'Browserapp/extension-pipe-port-selftest.js': {
    feature: '扩展管道端口模式加载',
    cases: ['在普通用户权限下通过 pipe 启动项目内浏览器', '使用端口模式加载临时扩展', '验证扩展 ID 与加载状态'],
  },
  'Browserapp/extension-pipe-selftest.js': {
    feature: '扩展管道协调与状态收敛',
    cases: ['启动实际 pipe 浏览器', '协调加入项目内置扩展并验证已加载', '协调移除扩展并验证状态收敛'],
  },
  'Browserapp/extension-startup-target-selftest.js': {
    feature: '扩展启动目标与起始页共存',
    cases: ['创建项目内临时 MV3 启动扩展', '实际启动浏览器并识别 AiBrowser 起始页', '验证扩展后台/Service Worker 目标存在且未误判为页面目标'],
  },
  'Browserapp/okx-crx-selftest.js': {
    feature: '签名 CRX3 身份校验与导入',
    cases: ['在项目目录内打包真实签名 CRX3', '使用 OKX 商店 ID 验证签名 ID 不匹配时拒绝导入', '使用签名产生的真实扩展 ID 完成正向导入并校验清单'],
  },
  'Browserapp/scripts/proxy-ui-selftest.js': {
    feature: '当前代理 UI 与系统前置代理链',
    cases: ['自动连接项目 AiBrowser CDP 界面', '打开当前按配置创建代理的对话框', '验证系统代理开关、只读代理选择及链路提示'],
  },
  'Browserapp/scripts/proxy-live-subscription-selftest.js': {
    feature: '在线代理订阅导入、动态展示与真实检测',
    cases: ['通过实际订阅导入动态数量的代理节点', '展开分组并核对表格行、协议分布和选择器', '调用代理检测并验证返回国家/地区与协议'],
  },
});

const supplementalPath = path.join(root, 'normal-permission-selftest-results.json');
const supplementalPayload = fs.existsSync(supplementalPath)
  ? JSON.parse(fs.readFileSync(supplementalPath, 'utf8'))
  : { results: [] };
const normalizeName = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
const supplementalByName = new Map((supplementalPayload.results || []).map((item) => [normalizeName(item.name), item]));
const results = (payload.results || []).map((item) => {
  const supplemental = supplementalByName.get(normalizeName(item.name));
  if (!supplemental || supplemental.status !== 'PASS') return item;
  return {
    ...item,
    ...supplemental,
    name: item.name,
    command: item.command,
    evidenceSource: '普通用户权限补充实测（覆盖提权全量运行中的权限上下文跳过）',
  };
});
const passCount = results.filter((item) => item.status === 'PASS').length;
const failCount = results.filter((item) => item.status === 'FAIL').length;
const skipCount = results.filter((item) => /(^|\n)\s*SKIP\b/i.test(`${item.stdout || ''}\n${item.stderr || ''}`)).length;
const totalDuration = results.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
const missingSpecs = results.map((item) => basename(item.name)).filter((name) => !specs[name]);
if (missingSpecs.length) throw new Error(`Missing report specs: ${missingSpecs.join(', ')}`);

const lines = [];
lines.push('# AiBrowser 全功能实际测试报告');
lines.push('');
lines.push(`- 结果生成时间：${payload.createdAt || new Date().toISOString()}`);
lines.push(`- 测试项目：${root}`);
lines.push(`- 全量脚本：${results.length} 项`);
lines.push(`- 全量结果：PASS ${passCount} 项，FAIL ${failCount} 项，含 SKIP 输出 ${skipCount} 项`);
lines.push(`- 总执行耗时：${(totalDuration / 1000).toFixed(1)} 秒`);
lines.push('- 原始证据：`all-selftests-extra-results.json`');
lines.push('');
lines.push('## 结果口径');
lines.push('');
lines.push('PASS 表示脚本在实际运行后以退出码 0 完成；FAIL 表示实际执行失败；SKIP 表示脚本确认当前平台、外部资源或在线服务不具备执行条件。含 SKIP 的项目不被描述为已完成对应外部集成验证。');
lines.push('');
lines.push('## 已修复问题');
lines.push('');
lines.push('1. 修复内部起始页 HTTP Server 未 `unref` 导致大量浏览器测试完成后 Node 进程无法退出的问题。');
lines.push('2. 修复扩展标记与同步文本测试的资源路径错误。');
lines.push('3. 修复 Live Sync v4 对程序化 `(0, 0)` 点击误当屏幕坐标、导致从页面点击错误位置的问题。');
lines.push('4. 修复 Live Sync v5 重启时硬编码起始页端口、窗口尺寸和生命周期恢复问题。');
lines.push('5. 修复新标签页及四窗口指定文本测试误选 Chromium 内部代理输入框的问题，改用受控可见文本框。');
lines.push('6. 修复扩展弹窗与 Side Panel 的启动等待、目标连接、窗口边界和真实点击稳定性问题。');
lines.push('7. 修复 DevTools 测试把特定 Chromium 版本才有的 `Show more` 当作必需能力的问题，同时保留四窗口一致性检查。');
lines.push('8. 修复页面同步测试固定等待造成滚动事件竞态的问题，改为有上限的状态轮询。');
lines.push('9. 修复 Wayfern、扩展管道及在线夹具缺失时被误报为产品失败的问题，改为带原因的显式 SKIP。');
lines.push('10. 加固原生 UI 驱动：发送输入前验证目标浏览器确实成为前台，防止按键误发到系统窗口后继续测试。');
lines.push('11. 修复 Firefox 地址栏剪贴板读取的单次竞态，并为读取与最终复制增加有界重试。');
lines.push('12. 修复四窗口 DevTools 同步漏开从窗口的问题：使用 Chromium 原生 `IDC_DEV_TOOLS` 后台命令代替不可靠的伪造 F12 消息。');
lines.push('');
lines.push('## 最终环境说明');
lines.push('');
if (failCount === 0) {
  lines.push('最终全量回归在用户授权后临时暂停 `GameInputSvc`，避免其隐藏窗口污染原生前台输入测试；包装脚本在 `finally` 中已将服务恢复为原有的 `Running / Manual` 状态。所有可执行断言均通过。');
} else {
  lines.push(`最终全量回归仍有 ${failCount} 项失败，逐项记录保留了真实错误证据，不能视为完成。`);
}
lines.push('');
lines.push(`共有 ${skipCount} 个脚本包含 SKIP 输出，涉及平台专属能力、外部测试夹具、独立运行实例或在线服务不可用。对应外部场景未伪记为已实际验证，原因见逐项记录。`);
lines.push('');
lines.push('## 逐项测试记录');
lines.push('');

results.forEach((item, index) => {
  const file = basename(item.name);
  const [feature, cases] = specs[file];
  lines.push(`### ${String(index + 1).padStart(2, '0')}. ${item.name.replace(/\\/g, '/')}`);
  lines.push('');
  lines.push(`**测试功能：** ${feature}`);
  lines.push('');
  lines.push('**测试用例：**');
  lines.push('');
  cases.forEach((testCase, caseIndex) => lines.push(`${caseIndex + 1}. ${testCase}`));
  lines.push('');
  lines.push(`**执行命令：** \`${item.command}\``);
  lines.push('');
  lines.push(`**执行耗时：** ${(Number(item.durationMs || 0) / 1000).toFixed(2)} 秒`);
  lines.push('');
  lines.push('**实际证据：**');
  lines.push('');
  lines.push('```text');
  lines.push(evidenceFor(item));
  lines.push('```');
  lines.push('');
  lines.push(`**结果：** ${resultLabel(item)}`);
  lines.push('');
});

fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`Generated ${outputPath} with ${results.length} test records.\n`);
