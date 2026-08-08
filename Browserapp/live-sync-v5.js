const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cdp = require('./cdp');
const { LiveSyncController: LiveSyncV4, PersistentCdp, injection } = require('./live-sync-v4');
const { planFanoutFromPayload } = require('./automation/protocol/sync-fanout');
const { settingsToOperateList } = require('./automation/protocol/event-map');
const { syncCapabilities } = require('./automation/protocol/cross-platform');
const { MarionetteClient } = require('./marionette-client');

const firefoxSemanticScript = String.raw`
const p=arguments[0]||{};
const deep=(path)=>{let root=document,e=null;for(const part of String(path||'').split(/\s*>>>\s*/).filter(Boolean)){e=root.querySelector(part);if(!e)return null;root=e.shadowRoot||e;}return e;};
const visible=(e)=>{try{const r=e.getBoundingClientRect();return r.width>0&&r.height>0}catch(_){return false}};
const similar=()=>{const list=[...document.querySelectorAll('button,input,textarea,select,a,[role],[tabindex],[contenteditable="true"]')];let best=null,score=-1e9;for(const e of list){if(!visible(e))continue;const r=e.getBoundingClientRect();let s=-Math.hypot(r.left+r.width/2-(Number(p.x)||0),r.top+r.height/2-(Number(p.y)||0));if(p.tag&&e.tagName.toLowerCase()===String(p.tag).toLowerCase())s+=120;if(p.elementType&&String(e.type||'')===p.elementType)s+=140;if(p.role&&String(e.getAttribute('role')||'')===p.role)s+=260;if(p.ariaLabel&&String(e.getAttribute('aria-label')||'')===p.ariaLabel)s+=500;const text=String(e.innerText||e.textContent||'').trim().replace(/\s+/g,' ').slice(0,200);if(p.text&&text===p.text)s+=450;if(s>score){score=s;best=e}}return best;};
const atPoint=()=>document.elementFromPoint(Number(p.x)||0,Number(p.y)||0);
const target=()=>deep(p.selector)||similar()||atPoint();
if(p.type==='scroll'){scrollTo(Number(p.x)||0,Number(p.y)||0);return true;}
if(p.type==='wheel'){scrollBy(Number(p.deltaX)||0,Number(p.deltaY)||0);return true;}
const e=target();if(!e)return false;
if(p.type==='focus'||p.type==='beforeinput'||(p.type==='mouse'&&p.phase==='down')){try{e.focus({preventScroll:true})}catch(_){try{e.focus()}catch(__){}}return true;}
if(p.type==='mouse'&&p.phase==='up'){e.click();return true;}
if(p.type==='input'){
  try{e.focus({preventScroll:true})}catch(_){try{e.focus()}catch(__){}}
  const value=String(p.value??'');
  if('value' in e){const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(e,value);else e.value=value;}else e.textContent=value;
  if(typeof e.setSelectionRange==='function'&&Number.isInteger(p.start))e.setSelectionRange(p.start,Number.isInteger(p.end)?p.end:p.start);
  e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:String(p.inputType||'insertText'),data:p.data==null?null:String(p.data)}));e.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return true;
}
if(p.type==='key'&&p.phase==='down'){
  const key=String(p.key||'');if(key==='Enter'&&(e.matches('button,a,[role="button"],input[type="submit"]')||e.onclick)){e.click();return true;}
  e.dispatchEvent(new KeyboardEvent('keydown',{key,code:String(p.code||''),ctrlKey:!!p.ctrl,altKey:!!p.alt,shiftKey:!!p.shift,metaKey:!!p.meta,bubbles:true,composed:true}));return true;
}
return false;`;

const syncMarkerCleanup = String.raw`(() => {
  for (const id of ['aibrowser-master-marker','aibrowser-environment-marker','aibrowser-profile-marker']) document.getElementById(id)?.remove();
  const root=document.documentElement;if(!root)return true;
  if(root.hasAttribute('data-aibrowser-sync-shadow')){const original=root.getAttribute('data-aibrowser-sync-shadow')||'';if(original)root.style.boxShadow=original;else root.style.removeProperty('box-shadow');root.removeAttribute('data-aibrowser-sync-shadow');}
  root.removeAttribute('data-aibrowser-sync-active');return true;
})()`;

const masterMarker = String.raw`(() => {
  const install = () => { if (!document.documentElement) return requestAnimationFrame(install); const root=document.documentElement;root.setAttribute('data-aibrowser-sync-active','1');if(!root.hasAttribute('data-aibrowser-sync-shadow'))root.setAttribute('data-aibrowser-sync-shadow',root.style.boxShadow||'');if (document.getElementById('aibrowser-master-marker')) return; const marker = document.createElement('div'); marker.id='aibrowser-master-marker'; marker.textContent='\u4e3b\u63a7\u7a97\u53e3'; marker.style.cssText='position:fixed;left:12px;top:12px;z-index:2147483647;background:#123a8c;color:white;padding:8px 14px;border-radius:8px;font:700 14px Segoe UI,sans-serif;box-shadow:0 4px 18px #0005;pointer-events:none'; root.appendChild(marker); root.style.boxShadow='inset 0 0 0 5px #123a8c'; };
  install();
})();`;

function environmentMarker(id, master) { const text = (master ? '\u4e3b\u63a7 | ' : '') + '\u73af\u5883\u7f16\u53f7: ' + id; const color = master ? '#123a8c' : '#334155'; return `(() => { const install=()=>{if(!document.documentElement)return requestAnimationFrame(install);document.documentElement.setAttribute('data-aibrowser-sync-active','1');let e=document.getElementById('aibrowser-environment-marker');if(!e){e=document.createElement('div');e.id='aibrowser-environment-marker';document.documentElement.appendChild(e);}e.textContent=${JSON.stringify(text)};e.style.cssText='position:fixed;right:12px;top:12px;z-index:2147483646;background:${color};color:white;padding:7px 12px;border-radius:8px;font:700 13px Segoe UI,sans-serif;box-shadow:0 4px 16px #0004;pointer-events:none';};install();})()`; }

function managedTabs(values) { return values.filter((tab) => !/^(devtools|chrome-extension|edge-extension):/i.test(tab.url)); }
function normalTabs(values) { return values.filter((tab) => !/^(devtools|chrome-extension|edge-extension):/i.test(tab.url) && (!/^(chrome|edge):/i.test(tab.url) || /^chrome:\/\/(newtab|new-tab-page)/i.test(tab.url))); }
function extensionPages(values) { return values.filter((tab) => ['page', 'iframe'].includes(String(tab.type || 'page')) && /^(chrome|edge)-extension:\/\//i.test(String(tab.url || ''))); }
function extensionPageKey(tab) {
  try { const value = new URL(String(tab.url || '')); return (value.protocol + '//' + value.hostname + value.pathname).toLowerCase(); }
  catch (_) { return String(tab.url || '').split(/[?#]/)[0].toLowerCase(); }
}
function extensionHost(tab) {
  try { return new URL(String(tab.url || '')).hostname.toLowerCase(); }
  catch (_) { return ''; }
}
function isEnvironmentStartUrl(value) {
  const s = String(value || '');
  if (/aibrowser-start\.html/i.test(s)) return true;
  if (/aibrowser-start|aibrowser-native/i.test(s)) return true;
  if (/https?:\/\/127\.0\.0\.1:5032\d+\/?/i.test(s)) return true;
  return false;
}
function normalizeEnvironmentStartUrl(value) {
  const raw = String(value || '');
  if (!isEnvironmentStartUrl(raw)) return null;
  try {
    const parsed = new URL(raw);
    // The native start page removes its one-time token with history.replaceState.
    // Comparing the browser-visible URL with running.startUrl byte-for-byte therefore
    // creates a Page.navigate loop on every 650 ms sync tick.
    parsed.searchParams.delete('token');
    parsed.searchParams.sort();
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return raw.replace(/([?&])token=[^&#]*(&?)/i, (match, lead, tail) => (lead === '?' && tail ? '?' : '')).replace(/[?&]$/, '').replace(/\/$/, '');
  }
}
function equivalentEnvironmentStartUrl(actual, desired) {
  const left = normalizeEnvironmentStartUrl(actual);
  const right = normalizeEnvironmentStartUrl(desired);
  return Boolean(left && right && left === right);
}
function environmentStartUrl(engine, id) {
  const running = engine.running.get(id);
  if (running?.startUrl) return running.startUrl;
  try {
    if (engine.startPageServer && running?.profile) {
      return engine.startPageServer.buildUrl(running.profile);
    }
  } catch (_) {}
  const root = running?.root;
  return root ? 'file:///' + path.join(root, 'aibrowser-start.html').replace(/\\/g, '/') : null;
}
function environmentNumber(engine, id) {
  const profile = engine.running?.get?.(id)?.profile || engine.profiles?.get?.(id);
  return String(profile?.number || profile?.name || id);
}

class LiveSyncController extends LiveSyncV4 {
  constructor(engine, emit) {
    super(engine, emit);
    this.tabMap = new Map();
    this.extensionMap = new Map(); this.extensionConnections = new Map();
    this.mappingReady = false;
    this.activeMasterTab = null; this.lastWindowSync = 0; this.lastHealthCheck = 0; this.nativeInputMirror = null;
    this.nativeRestartTimer = null; this.nativeRestartCount = 0; this.nativeDevToolsMode = false;
    this.nativeTargets = []; this.nativeInputReady = false; this.syncMode = 'idle';
    this.marionetteTargets = new Map();
    this.slaveMarkerScripts = new Map();
    this.markerCleanupPromise = Promise.resolve();
    this.syncSettings = { keyboard: true, click: true, scroll: true, track: true, delayClick: false, delayInput: false, inputMinMs: 300, inputMaxMs: 300, clickMinMs: 100, clickMaxMs: 300 };
  }

  updateSettings(value = {}) {
    const boolean = (name) => value[name] === undefined ? this.syncSettings[name] : value[name] !== false;
    const range = (name, fallback) => Math.max(0, Math.min(5000, Number(value[name] ?? fallback) || 0));
    const next = { ...this.syncSettings, keyboard: boolean('keyboard'), click: boolean('click'), scroll: boolean('scroll'), track: boolean('track'), delayClick: boolean('delayClick'), delayInput: boolean('delayInput') };
    next.inputMinMs = range('inputMinMs', next.inputMinMs); next.inputMaxMs = Math.max(next.inputMinMs, range('inputMaxMs', next.inputMaxMs));
    next.clickMinMs = range('clickMinMs', next.clickMinMs); next.clickMaxMs = Math.max(next.clickMinMs, range('clickMaxMs', next.clickMaxMs));
    this.syncSettings = next;
    if (this.master) this.startNativeInputMirror();
    this.emit({ type: 'sync-settings', settings: { ...next }, operate: settingsToOperateList(next), capabilities: syncCapabilities() });
    return { ...next, operate: settingsToOperateList(next) };
  }

  getSettings() {
    return { ...this.syncSettings, operate: settingsToOperateList(this.syncSettings), capabilities: syncCapabilities() };
  }

  /** Operate list for gates / Local API */
  getOperateList() {
    return settingsToOperateList(this.syncSettings);
  }

  /**
   * Plan fanout using protocol event types (1/2/3/20/21...).
   * Does not replace semantic forward(); validates gates + exposes command map.
   */
  planProtocolFanout(payload) {
    return planFanoutFromPayload(payload, {
      syncSettings: this.syncSettings,
      isDelay: this.syncSettings.delayClick || this.syncSettings.delayInput ? '1' : '0',
      mouseDelayMin: this.syncSettings.clickMinMs,
      mouseDelayMax: this.syncSettings.clickMaxMs,
      delayClick: this.syncSettings.delayClick,
      delayInput: this.syncSettings.delayInput,
      inputMinMs: this.syncSettings.inputMinMs,
      inputMaxMs: this.syncSettings.inputMaxMs,
      clickMinMs: this.syncSettings.clickMinMs,
      clickMaxMs: this.syncSettings.clickMaxMs,
    });
  }

  randomDelay(min, max) { return min + Math.random() * Math.max(0, max - min); }

  async start(ids, options = {}) {
    await this.markerCleanupPromise.catch(() => {});
    const entries = [...new Set(ids || [])]
      .map((id) => ({ id, item: this.engine.running.get(id) }))
      .filter((entry) => entry.item && (entry.item.port || (process.platform === 'win32' && Number.isInteger(entry.item.pid) && entry.item.pid > 0)));
    if (entries.length < 2) throw new Error('\u8bf7\u81f3\u5c11\u9009\u62e9\u4e24\u4e2a\u53ef\u540c\u6b65\u7684\u8fd0\u884c\u4e2d\u6d4f\u89c8\u5668\u73af\u5883');

    const requestedMaster = entries[0];
    const semanticEntries = requestedMaster.item.port ? entries.filter((entry) => entry.item.port) : [];
    let semanticResult = null;
    if (semanticEntries.length >= 2) {
      semanticResult = await super.start(semanticEntries.map((entry) => entry.id));
    } else if (semanticEntries.length === 1 && requestedMaster.item.port) {
      await this.stop();
      this.master = requestedMaster; this.slaves = [];
      await this.refreshMasterTabs();
      if (!this.connections.size) throw new Error('主控环境没有可同步的网页标签');
      this.timer = setInterval(() => this.runRefreshTick(), 650);
      semanticResult = { active: true, master: requestedMaster.id, slaves: [], tabs: this.connections.size };
    } else {
      await this.stop();
      this.master = requestedMaster;
      this.slaves = [];
    }
    this.nativeTargets = entries.slice(1).map((entry) => ({ id: entry.id, item: entry.item }));
    // beginSync has just applied a complete grid. Reading the master bounds again
    // immediately can return its pre-layout size and overwrite only CDP slaves.
    if (!options.preserveWindowLayout) await this.syncWindowGeometryToMaster();
    await this.startMarionetteTargets();
    const hasExternalTarget = entries.some((entry) => !entry.item.port);
    this.syncMode = semanticResult ? (hasExternalTarget ? 'hybrid' : 'semantic-native') : 'native';
    this.nativeRestartCount = 0;
    this.startNativeInputMirror();
    if (!semanticResult && process.platform === 'win32') {
      const ready = await this.waitForNativeReady(3000);
      if (!ready) { await this.stop(); throw new Error('\u539f\u751f\u8f93\u5165\u540c\u6b65\u7a0b\u5e8f\u672a\u5c31\u7eea\uff0c\u8bf7\u67e5\u770b\u64cd\u4f5c\u65e5\u5fd7'); }
    }
    this.unsubscribeMasterClose = this.engine.on((event) => { if (event.type === 'status' && event.running === false && event.id === this.master?.id) this.closeControlledAfterMaster().catch((error) => this.emit({ type: 'sync-error', action: 'master-close', message: error.message })); });
    const result = { active: true, master: this.master.id, slaves: this.nativeTargets.map((item) => item.id), tabs: this.connections.size, mode: this.syncMode, nativeReady: this.nativeInputReady };
    this.emit({ type: 'live-sync', ...result });
    return result;
  }

  async startMarionetteTargets() {
    const external = this.nativeTargets.filter((target) => Number.isInteger(target.item?.marionettePort) && target.item.marionettePort > 0);
    try {
      await Promise.all(external.map(async (target) => {
        const client = new MarionetteClient(target.item.marionettePort);
        await client.open(); this.marionetteTargets.set(target.id, client);
      }));
    } catch (error) {
      for (const client of this.marionetteTargets.values()) client.close().catch(() => {});
      this.marionetteTargets.clear();
      await this.stop();
      throw new Error('Firefox 同步通道连接失败：' + error.message);
    }
  }

  waitForNativeReady(timeoutMs = 2500) {
    if (this.nativeInputReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = () => {
        if (this.nativeInputReady) return resolve(true);
        if (!this.nativeInputMirror || Date.now() >= deadline) return resolve(false);
        setTimeout(poll, 40);
      };
      poll();
    });
  }

  runtimeStatus() {
    return { active: Boolean(this.master), mode: this.syncMode, nativeReady: this.nativeInputReady, master: this.master?.id || null, targets: this.nativeTargets.map((item) => item.id) };
  }

  async syncWindowGeometryToMaster() {
    if (!this.master?.item?.port) return;
    let bounds;
    try {
      bounds = (await cdp.windowForPort(this.master.item.port)).bounds;
    } catch (_) {
      return;
    }
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (!Number.isInteger(width) || !Number.isInteger(height)) return;
    const geometry = { width, height, windowState: 'normal' };
    await Promise.all(this.nativeTargets.map(async (item) => {
      const slavePort = this.engine.running.get(item.id)?.port;
      if (!slavePort) return;
      await cdp.setWindowBounds(slavePort, geometry).catch(() => {});
    }));
  }

  async performTextAction(id, action, text = '') {
    const client = this.marionetteTargets.get(String(id));
    if (!client) throw new Error('Firefox 文本操作需要先启动操作同步');
    const script = String.raw`
const action=String(arguments[0]||''),text=String(arguments[1]||'');
let e=document.activeElement,seen=new Set();while(e&&!seen.has(e)){seen.add(e);const nested=e.shadowRoot&&e.shadowRoot.activeElement;if(!nested)break;e=nested;}
const tag=String(e&&e.tagName||'').toLowerCase(),type=String(e&&e.type||'').toLowerCase();
const rejected=new Set(['button','checkbox','color','file','hidden','image','radio','range','reset','submit']);
const editable=!!(e&&!e.disabled&&!e.readOnly&&((tag==='input'&&!rejected.has(type))||tag==='textarea'||e.isContentEditable));
if(!editable)return {success:false,error:'请先在 Firefox 网页中点击要输入的文本框'};
e.focus();let next='';
if(e.isContentEditable){const old=String(e.textContent||'');next=action==='clear'?'':old+text;e.textContent=next;}
else{const old=String(e.value||'');if(action==='clear')next='';else{const start=Number.isInteger(e.selectionStart)?e.selectionStart:old.length,end=Number.isInteger(e.selectionEnd)?e.selectionEnd:start;next=old.slice(0,start)+text+old.slice(end);}const proto=tag==='textarea'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,'value')&&Object.getOwnPropertyDescriptor(proto,'value').set;if(setter)setter.call(e,next);else e.value=next;}
e.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:action==='clear'?'deleteContentBackward':'insertText',data:action==='clear'?null:text}));e.dispatchEvent(new Event('change',{bubbles:true,composed:true}));return {success:true,length:next.length};`;
    const result = await client.execute(script, [action, String(text)]);
    const value = result?.value || result;
    if (!value?.success) throw new Error(value?.error || 'Firefox 文本框没有接受输入');
    return { success: true, targetId: 'firefox-current', insertedLength: String(text).length };
  }

  startNativeInputMirror() {
    this.stopNativeInputMirror(false);
    if (!this.master) return;
    if (process.platform !== 'win32') {
      this.emit({ type: 'native-input', active: false, mode: 'cdp-only', platform: process.platform, message: 'macOS/Linux 使用 CDP 页面同步；Chrome 原生 UI 输入镜像仅 Windows 支持' });
      return;
    }
    const executable = path.join(__dirname, 'native-input-mirror.exe');
    if (!fs.existsSync(executable)) { this.emit({ type: 'sync-error', action: 'native-input', message: 'Windows input bridge is missing' }); return; }
    const masterPid = this.engine.running.get(this.master.id)?.pid;
    const slavePids = this.nativeTargets.map((slave) => this.engine.running.get(slave.id)?.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
    if (!Number.isInteger(masterPid) || masterPid <= 0 || !slavePids.length) return;
    const masterItem = this.engine.running.get(this.master.id);
    // With a CDP master, webpage input (including committed IME text) already reaches
    // Firefox through firefoxSemanticScript. Raw full-window key mirroring duplicates
    // the pinyin keystrokes and can submit them before compositionend.
    const fullWindowPids = masterItem?.port ? [] : slavePids;
    const addressText = process.env.OPENBROWSER_SYNC_ADDRESS_TEXT ?? (this.syncSettings.keyboard ? '1' : '0');
    const addressPoll = process.env.OPENBROWSER_UIA_POLL ?? addressText;
    const nativeEnv = { ...process.env, OPENBROWSER_SYNC_KEYBOARD: this.syncSettings.keyboard ? '1' : '0', OPENBROWSER_SYNC_CLICK: this.syncSettings.click ? '1' : '0', OPENBROWSER_SYNC_SCROLL: this.syncSettings.scroll ? '1' : '0', OPENBROWSER_SYNC_TRACK: this.syncSettings.track ? '1' : '0', OPENBROWSER_DELAY_CLICK: this.syncSettings.delayClick ? '1' : '0', OPENBROWSER_DELAY_INPUT: this.syncSettings.delayInput ? '1' : '0', OPENBROWSER_INPUT_MIN_MS: String(this.syncSettings.inputMinMs), OPENBROWSER_INPUT_MAX_MS: String(this.syncSettings.inputMaxMs), OPENBROWSER_CLICK_MIN_MS: String(this.syncSettings.clickMinMs), OPENBROWSER_CLICK_MAX_MS: String(this.syncSettings.clickMaxMs), OPENBROWSER_FULL_WINDOW_MASTER: masterItem?.port ? '0' : '1', OPENBROWSER_FULL_WINDOW_SLAVE_PIDS: fullWindowPids.join(','), OPENBROWSER_SYNC_ADDRESS_TEXT: addressText, OPENBROWSER_UIA_POLL: addressPoll };
    const child = spawn(executable, [String(masterPid), ...slavePids.map(String)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: nativeEnv });
    this.nativeInputMirror = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim() === 'READY' && !this.nativeInputReady) {
          this.nativeInputReady = true;
          this.emit({ type: 'native-input', active: true, mode: this.syncMode, master: this.master?.id, slaves: this.nativeTargets.map((slave) => slave.id) });
        }
        const match = line.match(/^DEVTOOLS_MODE=([01])$/);
        if (match) { this.nativeDevToolsMode = match[1] === '1'; this.emit({ type: 'native-devtools', active: this.nativeDevToolsMode }); }
      }
    });
    child.once('error', (error) => {
      if (this.nativeInputMirror === child) { this.nativeInputMirror = null; this.nativeInputReady = false; this.scheduleNativeInputRestart(error.message); }
      this.emit({ type: 'sync-error', action: 'native-input', message: error.message });
    });
    child.once('exit', (code) => {
      if (this.nativeInputMirror !== child) return; this.nativeInputMirror = null; this.nativeInputReady = false;
      this.emit({ type: 'native-input', active: false, mode: this.syncMode, master: this.master?.id, slaves: this.nativeTargets.map((slave) => slave.id) });
      if (this.master) { this.emit({ type: 'sync-error', action: 'native-input', message: 'Windows input bridge exited: ' + code }); this.scheduleNativeInputRestart('exit ' + code); }
    });
    this.emit({ type: 'native-input', active: false, starting: true, mode: this.syncMode, master: this.master.id, slaves: this.nativeTargets.map((slave) => slave.id) });
  }

  scheduleNativeInputRestart(reason) {
    if (this.nativeRestartTimer || !this.master) return;
    if (this.nativeRestartCount >= 3) { this.emit({ type: 'sync-error', action: 'native-input-restart', message: 'Windows input bridge could not be recovered automatically' }); return; }
    const attempt = ++this.nativeRestartCount; const delay = 350 * (2 ** (attempt - 1));
    this.emit({ type: 'sync-recovering', component: 'native-input', attempt, delay, reason });
    this.nativeRestartTimer = setTimeout(() => { this.nativeRestartTimer = null; if (this.master) this.startNativeInputMirror(); }, delay);
    this.nativeRestartTimer.unref?.();
  }

  stopNativeInputMirror(resetAttempts = true) {
    if (this.nativeRestartTimer) clearTimeout(this.nativeRestartTimer); this.nativeRestartTimer = null;
    if (resetAttempts) this.nativeRestartCount = 0;
    const child = this.nativeInputMirror; this.nativeInputMirror = null; this.nativeInputReady = false; this.nativeDevToolsMode = false;
    if (child && !child.killed) { try { child.kill(); } catch (_) {} }
  }

  enqueueForward(tabId, payload, action = 'forward') {
    const type = payload?.type;
    if (action === 'forward') {
      if (!this.syncSettings.keyboard && ['key', 'input', 'beforeinput'].includes(type)) return;
      if (!this.syncSettings.click && (type === 'click' || type === 'focus' || (type === 'mouse' && payload?.phase !== 'move'))) return;
      if (!this.syncSettings.track && type === 'mouse' && payload?.phase === 'move') return;
      if (!this.syncSettings.scroll && ['wheel', 'scroll'].includes(type)) return;
      if (this.nativeDevToolsMode && ['click', 'mouse', 'wheel', 'scroll'].includes(type)) return;
    }
    return super.enqueueForward(tabId, payload, action);
  }

  async forward(tabId, payload) {
    // Protocol gate: operate flags (click+move / scroll+move / keyboard)
    const plan = this.planProtocolFanout(payload);
    if (plan.skip && plan.reason === 'operate-gate') return;
    if (plan.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, plan.delayMs));
    else {
      const type = payload?.type;
      const clickEvent = type === 'click';
      const inputEvent = type === 'beforeinput' || (type === 'key' && payload?.phase === 'down');
      if (clickEvent && this.syncSettings.delayClick) await new Promise((resolve) => setTimeout(resolve, this.randomDelay(this.syncSettings.clickMinMs, this.syncSettings.clickMaxMs)));
      if (inputEvent && this.syncSettings.delayInput) await new Promise((resolve) => setTimeout(resolve, this.randomDelay(this.syncSettings.inputMinMs, this.syncSettings.inputMaxMs)));
    }
    // Semantic selector-based forward remains in v4 (more accurate than raw x/y on multi-resolution slaves).
    // Protocol plan is retained for Local API telemetry / debugging.
    const tasks = [];
    if (this.slaves.length) tasks.push(super.forward(tabId, payload));
    if (payload && this.marionetteTargets.size) {
      for (const client of this.marionetteTargets.values()) {
        tasks.push(client.execute(firefoxSemanticScript, [payload]).catch((error) => this.emit({ type: 'sync-error', action: 'firefox-forward', message: error.message })));
      }
    }
    const result = await Promise.all(tasks);
    if (plan && !plan.skip && this.emit) {
      this.lastProtocolPlan = { eventType: plan.eventType, proprietary: plan.proprietary?.command, standardCount: plan.standard?.length || 0, at: Date.now() };
    }
    return result;
  }

  async closeControlledAfterMaster() {
    const controlled = [...new Set(this.nativeTargets.map((item) => item.id))];
    await this.stop();
    await Promise.all(controlled.map((id) => this.engine.stop(id)));
    this.emit({ type: 'master-closed', controlled });
  }

  async stop() {
    const cleanup = this.cleanupSyncMarkers().catch(() => {});
    this.markerCleanupPromise = cleanup;
    this.stopNativeInputMirror();
    this.unsubscribeMasterClose?.(); this.unsubscribeMasterClose = null;
    this.tabMap?.clear(); this.mappingReady = false; this.activeMasterTab = null;
    for (const value of this.extensionConnections.values()) value.connection.close();
    this.extensionConnections.clear(); this.extensionMap.clear();
    for (const client of this.marionetteTargets.values()) client.close().catch(() => {});
    this.marionetteTargets.clear();
    super.stop();
    this.nativeTargets = []; this.nativeInputReady = false; this.syncMode = 'idle';
    await cleanup;
  }

  cleanupSyncMarkers() {
    const targets = [];
    for (const value of this.connections.values()) targets.push({ socket: value.tab?.webSocketDebuggerUrl, identifiers: value.syncMarkerScriptIds || [] });
    for (const value of this.slaveMarkerScripts.values()) targets.push(value);
    this.slaveMarkerScripts.clear();
    return Promise.all(targets.map(async (target) => {
      if (!target.socket) return;
      await cdp.call(target.socket, 'Runtime.evaluate', { expression: syncMarkerCleanup }).catch(() => {});
      for (const identifier of target.identifiers || []) {
        if (identifier) await cdp.call(target.socket, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }).catch(() => {});
      }
    }));
  }

  waitForMarkerCleanup() { return this.markerCleanupPromise || Promise.resolve(); }

  async attach(tab) {
    await super.attach(tab); const value = this.connections.get(tab.id); if (!value) return;
    const masterScript = await value.connection.command('Page.addScriptToEvaluateOnNewDocument', { source: masterMarker });
    await value.connection.command('Runtime.evaluate', { expression: masterMarker });
    const environment = environmentMarker(environmentNumber(this.engine, this.master.id), true); const environmentScript = await value.connection.command('Page.addScriptToEvaluateOnNewDocument', { source: environment }); await value.connection.command('Runtime.evaluate', { expression: environment });
    value.syncMarkerScriptIds = [masterScript?.identifier, environmentScript?.identifier].filter(Boolean);
  }

  async refreshMasterTabs() {
    if (!this.master) return;
    const allMasterTargets = await cdp.targets(this.master.item.port);
    const tabs = normalTabs(allMasterTargets.filter((target) => target.type === 'page'));
    const masterExtensionPages = extensionPages(allMasterTargets);
    if (Date.now() - this.lastHealthCheck >= 2000) {
      this.lastHealthCheck = Date.now();
      await Promise.all(this.slaves.map((slave) => cdp.tabs(slave.port)));
    }
    const live = new Set(tabs.map((tab) => tab.id));

    for (const [id, value] of this.connections) {
      if (!live.has(id) || value.connection.socket?.readyState !== 1) {
        value.connection.close(); this.connections.delete(id);
        if (!live.has(id)) { await this.closeMappedTabs(id); this.tabMap.delete(id); }
      }
    }

    for (const id of [...this.tabMap.keys()]) if (!live.has(id)) { await this.closeMappedTabs(id); this.tabMap.delete(id); }
    this.masterTabs = tabs;
    const slaveLists = new Map(); const slaveExtensionLists = new Map();
    for (const slave of this.slaves) {
      const targets = await cdp.targets(slave.port);
      slaveLists.set(slave.id, normalTabs(targets.filter((target) => target.type === 'page')));
      slaveExtensionLists.set(slave.id, extensionPages(targets));
    }
    for (let index = 0; index < tabs.length; index += 1) await this.ensureMapping(tabs[index], index, slaveLists);
    this.mappingReady = true;

    await this.reconcileSlaveTabs(tabs, slaveLists);
    for (const tab of tabs) if (!this.connections.has(tab.id)) await this.attach(tab);
    await this.refreshExtensionConnections(masterExtensionPages, slaveExtensionLists);
    await Promise.all([...this.connections.entries()].map(async ([id, value]) => {
      try { await this.pollTabState(value); }
      catch (error) {
        if (this.connections.get(id) !== value) return;
        value.connection.close(); this.connections.delete(id);
        this.emit({ type: 'live-sync-reattach', targetId: id, message: String(error?.message || error) });
      }
    }));
    // Window placement is intentionally one-shot when sync starts. Do not keep
    // correcting bounds here: users must remain free to move, resize or maximize
    // any managed Chromium or Firefox window after the initial desktop layout.
  }

  async refreshExtensionConnections(masterTargets, slaveLists) {
    const live = new Set(masterTargets.map((target) => target.id));
    for (const [id, value] of this.extensionConnections) {
      if (!live.has(id) || value.connection.socket?.readyState !== 1) {
        value.connection.close(); this.extensionConnections.delete(id);
        if (!live.has(id)) this.extensionMap.delete(id);
      }
    }
    for (const id of [...this.extensionMap.keys()]) if (!live.has(id)) this.extensionMap.delete(id);

    for (const masterTarget of masterTargets) {
      const mapping = this.extensionMap.get(masterTarget.id) || new Map();
      for (const slave of this.slaves) {
        const available = slaveLists.get(slave.id) || [];
        const current = mapping.get(slave.id);
        if (current && available.some((target) => target.id === current.id)) continue;
        if (current) mapping.delete(slave.id);
        const used = new Set([...this.extensionMap.values()].map((value) => value.get(slave.id)?.id).filter(Boolean));
        const candidates = available.filter((target) => !used.has(target.id));
        const exactKey = extensionPageKey(masterTarget); const host = extensionHost(masterTarget);
        const target = candidates.find((candidate) => extensionPageKey(candidate) === exactKey)
          || candidates.find((candidate) => extensionHost(candidate) === host);
        if (target) mapping.set(slave.id, target);
      }
      this.extensionMap.set(masterTarget.id, mapping);
      if (!this.extensionConnections.has(masterTarget.id)) await this.attachExtensionPage(masterTarget);
    }
  }

  async attachExtensionPage(tab) {
    const connection = new PersistentCdp(tab.webSocketDebuggerUrl, (event) => this.handleExtensionPage(tab.id, event));
    await connection.open();
    const value = { tab, connection }; this.extensionConnections.set(tab.id, value);
    try {
      await connection.command('Runtime.addBinding', { name: 'aiBrowserSync' });
      await connection.command('Page.addScriptToEvaluateOnNewDocument', { source: injection }).catch(() => {});
      await connection.command('Runtime.enable');
      await connection.command('Runtime.evaluate', { expression: injection });
      await connection.command('Page.enable').catch(() => {});
      this.emit({ type: 'live-sync-extension-attached', targetId: tab.id, url: tab.url, targets: this.extensionMap.get(tab.id)?.size || 0 });
    } catch (error) {
      connection.close(); this.extensionConnections.delete(tab.id); throw error;
    }
  }

  async handleExtensionPage(tabId, event) {
    if (event.method === 'Runtime.executionContextCreated') {
      // Skip isolated worlds — injecting there duplicates listeners and doubles events.
      const auxData = event.params?.context?.auxData;
      if (auxData && auxData.isDefault === false) return;
      const contextId = event.params?.context?.id; const connection = this.extensionConnections.get(tabId)?.connection;
      if (contextId && connection) connection.command('Runtime.evaluate', { expression: injection, contextId }).catch(() => {});
    }
    if (event.method === 'Runtime.bindingCalled' && event.params?.name === 'aiBrowserSync') {
      let payload; try { payload = JSON.parse(event.params.payload); } catch (_) { return; }
      // V13: extension documents (including side-panel/OOPIF content) are authoritative for
      // semantic mouse, focus and text events. The native bridge remains responsible for Chrome UI.
      this.enqueueForward(tabId, payload);
    }
  }

  async ensureMapping(masterTab, index = -1, initialLists = null) {
    const mapping = this.tabMap.get(masterTab.id) || new Map();
    const isStart = isEnvironmentStartUrl;
    const isBlank = (url) => /^(about:blank|chrome:\/\/(newtab|new-tab-page)\/?)/i.test(String(url || ''));
    const equivalent = (a, b) => String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '') || equivalentEnvironmentStartUrl(a, b) || (isBlank(a) && isBlank(b));
    await Promise.all(this.slaves.map(async (slave) => {
      const available = initialLists?.get(slave.id) || normalTabs(await cdp.tabs(slave.port));
      const mappedId = mapping.get(slave.id);
      if (mappedId && available.some((tab) => tab.id === mappedId)) return;
      if (mappedId) mapping.delete(slave.id);
      const used = new Set([...this.tabMap.values()].map((value) => value.get(slave.id)).filter(Boolean));
      const candidates = available.filter((tab) => !used.has(tab.id));
      let target = candidates.find((tab) => tab.url === masterTab.url)
        || (isStart(masterTab.url) ? candidates.find((tab) => isStart(tab.url)) : null)
        || (isBlank(masterTab.url) ? candidates.find((tab) => isBlank(tab.url)) : null);
      if (!target && index >= 0 && available[index] && !used.has(available[index].id)) target = available[index];
      if (!target && candidates.length) target = candidates.find((tab) => isBlank(tab.url)) || candidates[candidates.length - 1];
      const desiredUrl = isStart(masterTab.url) ? (environmentStartUrl(this.engine, slave.id) || masterTab.url) : masterTab.url;
      if (!target) target = await cdp.newTab(slave.port, desiredUrl || 'about:blank');
      mapping.set(slave.id, target.id); await this.markSlave(target, slave.id);
      const needsNavigation = !equivalent(target.url, desiredUrl);
      if (desiredUrl && needsNavigation) await cdp.call(target.webSocketDebuggerUrl, 'Page.navigate', { url: desiredUrl }).catch(() => {});
    }));
    this.tabMap.set(masterTab.id, mapping);
  }

  async reconcileSlaveTabs(masterTabs, knownLists = null) {
    if (!masterTabs.length) return;
    let closed = 0;
    await Promise.all(this.slaves.map(async (slave) => {
      const allowed = new Set(masterTabs.map((tab) => this.tabMap.get(tab.id)?.get(slave.id)).filter(Boolean));
      const current = knownLists?.get(slave.id) || normalTabs(await cdp.tabs(slave.port));
      const extras = current.filter((tab) => !allowed.has(tab.id));
      for (const tab of extras) { await cdp.closeTab(slave.port, tab.id).catch(() => {}); closed += 1; }
    }));
    if (closed) this.emit({ type: 'live-sync-tab-reconcile', masterTabs: masterTabs.length, closed });
  }

  async markSlave(tab, id) {
    const source = environmentMarker(environmentNumber(this.engine, id), false);
    const registered = await cdp.call(tab.webSocketDebuggerUrl, 'Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => null);
    await cdp.call(tab.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: source }).catch(() => {});
    this.slaveMarkerScripts.set(tab.id, { socket: tab.webSocketDebuggerUrl, identifiers: [registered?.identifier].filter(Boolean) });
  }

  async closeMappedTabs(masterTabId) {
    const mapping = this.tabMap.get(masterTabId); if (!mapping) return;
    await Promise.all(this.slaves.map((slave) => { const targetId = mapping.get(slave.id); return targetId ? cdp.closeTab(slave.port, targetId).catch(() => {}) : Promise.resolve(); }));
  }

  async slaveTab(slave, masterTabId) {
    const masterTab = this.masterTabs.find((tab) => tab.id === masterTabId);
    if (!this.tabMap.has(masterTabId)) await this.ensureMapping(masterTab || { id: masterTabId, url: 'about:blank' });
    const mapping = this.tabMap.get(masterTabId); let targetId = mapping?.get(slave.id);
    let tabs = await cdp.tabs(slave.port); let tab = tabs.find((item) => item.id === targetId);
    if (!tab) {
      const desiredUrl = isEnvironmentStartUrl(masterTab?.url) ? (environmentStartUrl(this.engine, slave.id) || masterTab.url) : masterTab?.url;
      tab = await cdp.newTab(slave.port, desiredUrl || 'about:blank'); targetId = tab.id;
      if (!mapping) this.tabMap.set(masterTabId, new Map([[slave.id, targetId]])); else mapping.set(slave.id, targetId);
    }
    return tab;
  }

  async navigateSlaves(masterTabId, url) {
    if (!isEnvironmentStartUrl(url)) {
      if (this.slaves.length) await super.navigateSlaves(masterTabId, url);
      await Promise.all([...this.marionetteTargets.values()].map((client) => client.navigate(url).catch(() => {})));
      return;
    }
    await this.eachSlave(masterTabId, async (tab, slave) => {
      const desiredUrl = environmentStartUrl(this.engine, slave.id) || url;
      if (equivalentEnvironmentStartUrl(tab.url, desiredUrl)) return;
      await cdp.call(tab.webSocketDebuggerUrl, 'Page.navigate', { url: desiredUrl }).catch(() => {});
    });
    await Promise.all([...this.marionetteTargets.entries()].map(([id, client]) => client.navigate(environmentStartUrl(this.engine, id) || url).catch(() => {})));
  }

  async eachSlave(masterTabId, action) {
    const extensionTargets = this.extensionMap.get(masterTabId);
    if (extensionTargets) {
      await Promise.all(this.slaves.map(async (slave) => { const target = extensionTargets.get(slave.id); if (target) await action(target, slave); }));
      return;
    }
    await Promise.all(this.slaves.map(async (slave) => { const tab = await this.slaveTab(slave, masterTabId); if (tab) await action(tab, slave); }));
  }

  async activateMapped(masterTabId) {
    await Promise.all(this.slaves.map(async (slave) => { const tab = await this.slaveTab(slave, masterTabId); if (tab) await cdp.activateTab(slave.port, tab.id); }));
    this.emit({ type: 'live-sync-tab', masterTabId, targets: this.slaves.length });
  }

  async syncZoom(masterTabId, factor) {
    let corrected = 0;
    const masterTab = this.masterTabs.find((tab) => tab.id === masterTabId);
    const isStartPage = (v) => {
      const s = String(v || '').toLowerCase();
      return s.includes('aibrowser-start.html')
        || s.includes('aibrowser-start')
        || s.includes('aibrowser-native')
        || /https?:\/\/127\.0\.0\.1:5032\d+\/?/.test(s);
    };
    const equivalentUrl = (a, b) => {
      const x = String(a || '').toLowerCase().replace(/\/$/, '');
      const y = String(b || '').toLowerCase().replace(/\/$/, '');
      const newTab = (v) => v === 'chrome://newtab' || v === 'chrome://new-tab-page';
      return x === y || (newTab(x) && newTab(y)) || (isStartPage(x) && isStartPage(y));
    };
    await Promise.all(this.slaves.map(async (slave) => {
      const mapped = await this.slaveTab(slave, masterTabId);
      const candidates = normalTabs(await cdp.tabs(slave.port));
      const targets = new Map();
      if (mapped) targets.set(mapped.id, mapped);
      if (masterTab) for (const tab of candidates) if (equivalentUrl(tab.url, masterTab.url)) targets.set(tab.id, tab);
      for (const tab of targets.values()) {
        try {
        const metrics = await cdp.call(tab.webSocketDebuggerUrl, 'Page.getLayoutMetrics');
        const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
        const browserZoom = Number(viewport.zoom) || 1;
        const currentScale = Number(viewport.scale) || 1;
        const effective = browserZoom * currentScale;
        if (Math.abs(effective - factor) <= 0.01) continue;
        const correctedScale = Math.max(0.25, Math.min(5, factor / browserZoom));
        await cdp.call(tab.webSocketDebuggerUrl, 'Emulation.setPageScaleFactor', { pageScaleFactor: correctedScale });
        corrected += 1;
        } catch (_) {}
      }
    }));
    if (corrected) this.emit({ type: 'live-sync-zoom', masterTabId, factor, corrected });
  }

  async pollTabState(value) {
    const result = await value.connection.command('Runtime.evaluate', { expression: "({x:scrollX,y:scrollY,visible:document.visibilityState==='visible',url:location.href})", returnByValue: true });
    const state = result.result?.value; if (!state) return;
    const metrics = await value.connection.command('Page.getLayoutMetrics'); const viewport = metrics.cssVisualViewport || metrics.visualViewport || {}; const zoom = (Number(viewport.scale) || 1) * (Number(viewport.zoom) || 1);
    value.zoom = zoom; await this.syncZoom(value.tab.id, zoom);
    if (state.visible) {
      if (state.url && !/^(chrome|edge|devtools|chrome-extension|edge-extension):/i.test(state.url)) await this.navigateSlaves(value.tab.id, state.url);
      if (this.activeMasterTab !== value.tab.id) { this.activeMasterTab = value.tab.id; await this.activateMapped(value.tab.id); }
    }
    if (state.x !== value.scroll.x || state.y !== value.scroll.y) { value.scroll = { x: state.x, y: state.y }; await this.forward(value.tab.id, { type: 'scroll', x: state.x, y: state.y }); }
  }}

module.exports = { LiveSyncController };
