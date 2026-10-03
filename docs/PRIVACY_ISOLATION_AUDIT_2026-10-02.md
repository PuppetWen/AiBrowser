# 环境隔离、代理断线与定位隐私审计

审计日期：2026-10-02（America/New_York）
源码基线：`ff7feb1`；应用版本：`1.0.8`。

**结论：现有项目具备浏览器资料隔离和部分代理、指纹保护，但当前配置及实现不能保证“任何故障下只断网、绝不直连”，也不能保证全部指纹与定位接口始终符合配置。可以改造实现严格的环境断网策略；目前尚未达到。**

本次检查了源码、当前保存的四个环境、系统代理状态，并执行了本机模拟与回环网络测试。未启动用户环境访问外网，未修改用户配置、系统代理、防火墙或生产代码。没有进行真实浏览器抓包、公网出口、STUN/IPv6/DNS 泄漏的端到端验证，因此下文区分了已复现行为与尚待验证的风险。

## 当前四个环境

| 环境编号 | 内核 | 网络模式 | WebRTC | 时区 | 网页定位 | 启动检测 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Chromium | 系统代理 | real | real | disabled | 开启 |
| 2 | Chromium | 系统代理 | proxy | ip | ip | 开启 |
| 3 | Firefox-Reverse | 系统代理 | 配置为 proxy，项目未落实此指纹控制 | 配置为 ip，未接入注入 | 配置为 ip，未接入注入 | 关闭 |
| 4 | Chromium | 系统代理 | proxy | ip | ip | 关闭 |

四个环境均保存了 `requireReady=true`、`notReadyPolicy=block`，但系统代理模式不进入对应的自定义代理阻断逻辑。四个环境均未配置自定义直连白名单；保存的配置均没有出口时区和经纬度。环境 1 的 Chromium Preferences 确有默认定位拒绝值 `2`。Firefox 环境的 `user.js` 设置 `network.proxy.type=5`，未发现显式关闭 WebRTC、关闭定位或强制 proxy-only ICE 的设置。

读取时 Windows 系统代理已启用，指向本机代理服务，有绕过规则，没有 PAC。**这不证明当前已经泄漏**，但流量会受该代理软件的分流规则和 Windows 代理设置影响；四个环境不能因此视为具有四个独立网络出口。

## 已具备的隔离与保护

- Chromium 使用 `browser-data/browser-profiles-v2/{id}` 作为独立 `--user-data-dir`，Firefox 使用各自环境下的 `firefox-profile`；本次确认四个目录互不重复，目录本身不是链接。代码还校验路径、拒绝越界和链接，并用锁防止同一环境并发启动。[启动路径](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2228)、[Firefox 路径](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2011)、[隔离校验](E:/JS/jsTools/AiBrowser/Browserapp/automation/isolation.js)
- APPDATA、LOCALAPPDATA、TEMP、TMP 和 Firefox 崩溃目录也按环境设置。这属于资料和进程环境隔离，不等于独立操作系统、网卡、DNS 栈或防火墙。[实现](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:31)
- 自定义代理且启动检测开启时，`block` 会在检测失败后拒绝启动。HTTP/SOCKS5 本地转发器连接上游失败时返回错误；本次真实回环测试中，GET 和 CONNECT 均返回 502，目标服务器直连命中数均为 0。[阻断](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:3131)、[HTTP 转发失败](E:/JS/jsTools/AiBrowser/Browserapp/proxy-forwarder.js:504)、[SOCKS 转发失败](E:/JS/jsTools/AiBrowser/Browserapp/proxy-forwarder.js:374)
- 固定单一 Chromium 代理配置没有附加 `direct://` 备用项。因此不能笼统认定“代理一断 Chrome 就自动直连”。Chromium 官方文档明确区分单代理失败与显式加入 DIRECT 备用。[官方说明](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
- Chromium 的 proxy/disabled WebRTC 配置会添加禁止非代理 UDP 的启动参数；Firefox 自定义代理路径写入 `network.proxy.failover_direct=false`，SOCKS 路径启用远端 DNS。[Chromium](E:/JS/jsTools/AiBrowser/Browserapp/automation/fingerprint.js:1821)、[Firefox](E:/JS/jsTools/AiBrowser/Browserapp/automation/external-kernel.js:118)

上述资料隔离主要防止 Cookie、缓存、存储等意外串用。它不阻止同一 Windows 用户下有权限的本地程序访问这些资料，也不保证网站无法通过共同出口或其他信息关联环境。

## 关键缺口

### 1. 高优先级：当前系统代理模式没有强制失败阻断

`prepareProfileProxyForStart()` 在 `networkMode !== 'proxy'` 时直接返回，因此四个环境的 `block` 配置都没有覆盖系统代理。后续系统代理出口探测失败会被捕获，启动可继续。关闭系统代理、命中绕过规则，或本机代理软件选择 DIRECT，均不受项目的专用断网开关保护。[提前返回](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:3068)、[检测错误处理](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:1428)

本机模拟已复现：system + checkOnStart=true + block 不调用自定义代理检测；系统出口探测失败返回 null，没有抛出启动阻断错误。

需要区别“上游服务拒绝连接”和“系统设置切换到直连”：前者在固定单代理下通常报错，后者改变了浏览器实际使用的网络路径。系统/PAC 配置还可能自行提供 DIRECT；当前系统未配置 PAC，但产品支持此类环境。[Chromium 系统代理与 PAC 说明](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)

### 2. 高优先级：存在明确的直连入口和静默降级

- `notReadyPolicy=direct` 会在代理检测失败后把环境改成 `networkMode=direct`。这是显式功能，当前四个环境没有选中它。[代码](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:3135)
- 即使请求 `networkMode=proxy`，代理地址为空、`none` 或 `offline` 时，清洗逻辑也会转成 direct；`offline` 实际不代表断网。[代码](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:435)
- `checkOnStart=false` 时，即使配置 block/requireReady，未检测出口也只是警告后继续启动。这不等于代理自动直连，但说明“必须先验证代理”的保证不存在。[代码](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:3144)
- `continue` 策略保留代理模式继续启动，不应误报成 direct 策略。

以上四种分支均已用生产方法和模拟故障验证。

### 3. 高优先级：Firefox 的指纹配置未落实

Firefox 路径在 Chromium 指纹逻辑之前分流；模块明确报告 `fingerprintInjection=false`。启动 prefs 不读取环境的 WebRTC、时区和定位伪装配置。它具备资料隔离与代理配置，但不能据此承诺保存的 Chromium 指纹选项会生效。[分流](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2200)、[能力声明](E:/JS/jsTools/AiBrowser/Browserapp/automation/external-kernel.js:65)、[实际 prefs](E:/JS/jsTools/AiBrowser/Browserapp/automation/external-kernel.js:99)

这是当前环境 3 的实际适用限制；本次没有对 Firefox 内核二进制做逆向或端到端定位测试。

### 4. 高优先级：缺少出口信息时，时区和定位保护不是强制拒绝

IP 模式没有有效出口时区时不调用 `Emulation.setTimezoneOverride`；没有有效经纬度时不调用 `Emulation.setGeolocationOverride`。同时 geoMode=ip 不写入默认定位拒绝。因此缺少出口信息时会保留浏览器原有行为，可能显示宿主时区；用户给予网页定位权限后，可能调用真实定位来源。[坐标处理](E:/JS/jsTools/AiBrowser/Browserapp/automation/fingerprint.js:454)、[覆盖条件](E:/JS/jsTools/AiBrowser/Browserapp/automation/fingerprint.js:1848)、[权限设置](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:940)

本机模拟确认缺失出口信息时两个 CDP 覆盖都没有执行，也没有写入默认定位屏蔽。另复现了 native 指纹模式会跳过这些 CDP 操作，并移除 `geoMode=disabled` 对应的默认拒绝设置；这一组合应在产品中明确约束，而不能显示为已保护。

网页定位通常需要用户权限；上述缺口不等于网页无需授权就能获得精确经纬度。拒绝网页定位也不隐藏网络出口 IP。[Geolocation 权限说明](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API)

### 5. 高优先级：指纹注入存在故障后继续执行和启动时序窗口

- 已有文档开始脚本注册失败保护，但仅带 `documentStartOk=false` 的错误会阻止被暂停目标继续执行。时区等更早步骤抛出普通错误时，可以在脚本尚未注册的情况下恢复页面。本次模拟“无效时区”复现了该行为。[恢复分支](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:1275)
- Worker 的 `Runtime.evaluate` 返回 `exceptionDetails` 时没有检查，本次模拟确认 Worker 继续运行且没有记录该注入错误。[Worker 执行](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:1292)
- 启动额外 URL 直接加入命令行，恢复会话也在进程启动阶段进行；CDP 注入和自动附加稍后建立。因此首个 about:blank 的保护不能直接推导到所有启动标签页和恢复页面。此项是代码时序风险，尚未用真实网页实测。[额外 URL](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2362)、[注入建立](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2567)

因此“字段已保存”“首页检测一致”“普通注入测试通过”不足以证明所有页面、iframe 和 Worker 在所有故障下始终一致。

### 6. 中优先级：代理之外的网络路径未形成统一约束

- Chromium 自定义直连白名单可以放行外部域名。默认 localhost/127.0.0.1 用于启动页，不应将这些本机请求本身误判为公网 IP 泄漏，但严格模式应把本机例外收紧到实际服务。[代码](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2352)
- 自定义代理路径禁用 QUIC、DNS 预取及部分后台服务；系统代理路径没有套用同一组参数。未发现浏览器进程的操作系统级出站白名单。仅禁用 DNS 预取不能证明所有解析都受控，尤其产品还支持 SOCKS4，其 Chromium 目标域名解析发生在客户端。[启动参数](E:/JS/jsTools/AiBrowser/Browserapp/engine.js:2370)、[Chromium SOCKS/DNS 文档](https://www.chromium.org/developers/design-documents/network-stack/socks-proxy/)、[SOCKS4 说明](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md)
- 动态代理提取、刷新 URL 通过宿主 Node 的 `http/https.request` 访问，没有显式使用该环境代理。它们访问的服务可能看到宿主网络出口，具体还受 Node 启动配置、全局代理或 VPN 影响。这与被浏览网页的连接是不同的路径。[请求实现](E:/JS/jsTools/AiBrowser/Browserapp/proxy-forwarder.js:1089)、[提取与刷新](E:/JS/jsTools/AiBrowser/Browserapp/proxy-forwarder.js:1213)
- Electron 更新会话使用自己的系统/固定代理配置，也不归某个浏览器环境的失败策略管理。[实现](E:/JS/jsTools/AiBrowser/Browserapp/main.js:320)

Mihomo 配置虽然出现 `MATCH,DIRECT`，每个 listener 同时显式绑定了节点，不能仅凭这一行认定当前 listener 断线必然直连；需要独立验证。这次没有把它计作已复现泄漏。

## 如何达到目标

建议把“隐私严格模式”作为独立且不可静默降级的运行契约：

1. **入口强制有效代理。** 严格模式拒绝空地址、direct、offline 和无法固定解析的系统/PAC 配置；失败策略只允许 block 或切换到经过验证的备用代理，所有备用失败则断网。启动检测不再是可跳过的软门槛。
2. **每环境固定本地网关。** 浏览器始终指向自己的回环端口，上游断开、凭据失败或代理服务退出时保持失败；不要删除代理参数或改用系统网络。恢复时重新验证出口与定位信息后再放行。需要停止的是该环境的外网访问，不必断掉整台电脑的网络。
3. **操作系统级网络约束。** 用 Windows 防火墙/WFP 或具备断线保护的隔离网络限制浏览器只能到受控网关；网关仅能连接选定上游，统一约束 TCP、UDP、IPv4、IPv6 和 DNS。多个环境共用同一浏览器 EXE，单纯按 EXE 路径放行远端地址不足以区分环境；应结合独立网关和进程身份设计。网关可达也不证明其上游没有分流直连，仍需限制上游行为。
4. **定位与指纹失败时拒绝。** 默认禁用真实网页定位和非代理 WebRTC；缺少出口时区/坐标、CDP 断开、注入失败或读取值不一致时拒绝加载外网页面。native 模式应明确暴露真实指纹；严格模式不能依赖尚未实现的 Firefox 指纹控制。
5. **覆盖全部启动入口。** 所有启动 URL 和会话恢复都等到保护就绪后再导航；页面、iframe、Worker、SharedWorker、ServiceWorker 要统一验证并处理执行异常。宿主的代理提取、刷新和其他联网功能也需明确单独的出站策略。

短期配置可以降低风险：使用固定自定义代理，开启启动检测，选择“阻断”，关闭外部直连白名单；Chromium 选自定义指纹、WebRTC 禁用、网页定位禁用，配置有效的出口时区。当前环境 1 应调整 real WebRTC/real 时区；Firefox 在控制补齐并验证前不适合承担上述严格隐私要求。**这些配置调整不能替代代码缺口修复和操作系统级约束。**

即使做到网站只能看到代理出口，也应区分网站与代理服务商：直接承接连接的代理/VPN 服务仍能看到连接来源。时区只能提供地域线索；公网 IP 定位也不等于精确住宅地址。本项目目前无法据此作出“实际位置绝不泄漏”的绝对承诺。

## 本次验证结果

使用现有 `E:/Environment/nvm/nodejs/node.exe` 与项目本地依赖，没有下载依赖。

| 验证 | 结果 |
| --- | --- |
| isolation-fingerprint-selftest | 通过：指纹确定性、资料路径及锁、碰撞审计等 |
| browser-network-regression-selftest | 通过：Firefox 自定义代理 prefs、认证转发、HTTPS ALPN 等 |
| fingerprint-override-regression-selftest | 通过：坐标处理及文档开始注册错误传播 |
| fingerprint-failure-lifecycle-selftest | 通过：已实现的硬失败目标关闭与生命周期处理 |
| proxy-forwarder-selftest | 通过：认证、隧道和链式代理 |
| fingerprint-inject-order-selftest | 通过：首个启动页路径的源码顺序检查 |
| fingerprint-native-selftest | 通过：native 模式确实跳过伪装 |
| 本次临时审计脚本 | 17 条场景记录，全部断言通过；包含危险行为的复现，不代表这些行为安全 |

临时审计记录：block/direct/continue 三种失败策略；未检测/系统模式/空地址/offline 四种入口；系统出口探测失败；custom-ip/native-disabled 两种定位偏好；缺失出口定位覆盖；HTTP/SOCKS5 × GET/CONNECT 四种上游断线；页面时区错误后恢复；Worker 执行异常后恢复。

仍需在修复后单独验收：真实浏览器代理从可用到失效、代理进程崩溃、认证错误、系统代理切换、网卡切换、DNS/IPv6/WebRTC/STUN、会话恢复、多标签页/跨源 iframe/Worker、宿主后台请求。验收应采用受控目标和抓包，检查是否产生绕开指定出口的连接；不能只用首页的 IP 显示判断。
