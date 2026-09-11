'use strict';

// Render the real application DOM and stylesheet cascade with an isolated Electron
// host. Business IPC, browser launch and user settings are deliberately absent.
// Theme/popup functions are taken verbatim from renderer.js; sample rows are local.
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cacheRoot = path.resolve(__dirname, '..', '.cache');
const outputRoot = path.join(cacheRoot, 'liquid-glass-qa');
const appVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const variants = [
  ['pixel-workstation', 'dark'], ['nes-light', 'light'], ['retro-desktop', 'light'],
  ['element-admin', 'light'], ['element-admin', 'dark'], ['aurora-glass', 'dark'], ['paper-studio', 'light'],
];

function rendererFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Missing real renderer function ${name}`);
  const end = source.indexOf('\n}', start);
  assert(end >= 0);
  return source.slice(start, end + 2);
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();
  await fsp.mkdir(outputRoot, { recursive: true });
  const baseline = process.env.GLASS_BASELINE === '1';
  const failures = [];
  const report = { scope: 'Real index.html, real CSS cascade, extracted real theme/popup functions, synthetic local rows; no business services', variants: [] };
  let win;
  function check(condition, message) { if (!condition) failures.push(message); }
  try {
    const originalHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    if (!baseline) assert(originalHtml.includes('liquid-glass.css'), 'index.html must load liquid-glass.css');
    const html = originalHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
      .replace('<head>', `<head><base href="${pathToFileURL(__dirname + path.sep).href}">`);
    const fixture = path.join(process.env.GLASS_TEST_ROOT, 'fixture.html');
    await fsp.writeFile(fixture, html);
    win = new BrowserWindow({ width: 1440, height: 960, useContentSize: true, frame: false, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error('Fixture:', event.message); });
    await win.loadFile(fixture);
    const evaluate = async (source) => {
      try { return await win.webContents.executeJavaScript(source, true); }
      catch (error) { throw new Error(source.slice(0, 140) + '\n' + error.message); }
    };
    const renderer = fs.readFileSync(path.join(__dirname, 'renderer.js'), 'utf8');
    const themeDef = renderer.match(/const UI_THEMES = Object\.freeze\(\{[\s\S]*?\n\}\);/)[0];
    await evaluate(`
      const $ = (selector) => document.querySelector(selector);
      const $$ = (selector) => [...document.querySelectorAll(selector)];
      const t = (key) => ({'theme.pixel.name':'像素工作站','theme.nes.name':'浅色像素风','theme.retro.name':'复古桌面','theme.native.name':'系统原生','theme.light':'浅色','theme.dark':'深色'}[key] || key);
      const UI_THEME_KEY = 'glass-fixture-theme', UI_COLOR_MODE_KEY = 'glass-fixture-mode';
      let uiColorMode = 'light', openSelectMenu = null, uiChromeRequest = 0;
      function refreshIcons() { window.lucide?.createIcons(); }
      ${themeDef}
      ${['themeDisplayName','closeSelectMenu','applyNativeGlassMaterial','syncUiChrome','syncAppearanceControls','applyColorMode','applyUiTheme','themePopoverViewport','ensureThemePopoverPortaled','positionThemePopover','setThemePopoverOpen'].map((name) => rendererFunction(renderer, name)).join('\n')}
      document.documentElement.dataset.platform = 'windows';
      document.documentElement.classList.add('titlebar-integrated');
      $('#page-subtitle').textContent = '管理独立浏览器环境、网络和应用';
      $('#engine-badge').className = 'engine-badge';
      $('.engine-badge-text').textContent = '浏览器就绪';
      $('#app-version').textContent = ${JSON.stringify('v' + appVersion)};
      $('#profile-search').value = '设计工作空间';
      $('#profile-total').textContent = '3';
      $('#profile-group-chips').innerHTML = '<button type="button" class="group-chip active" data-group-filter="all"><span class="dot"></span><span>全部</span><b>3</b></button><button type="button" class="group-chip" data-group-filter="work"><span class="dot"></span><span>工作空间</span><b>3</b></button>';
      $('#profile-table').innerHTML = ['设计工作空间','开发与验证','研究资料'].map((name, index) => '<tr><td><input type="checkbox"></td><td>'+(index+1)+'</td><td><input type="checkbox"></td><td><div class="profile-name env-identity"><strong>'+name+'</strong><small>独立环境 · 本地保存</small></div></td><td><span class="group-chip">工作</span></td><td>Chromium</td><td>本地直连</td><td>—</td><td>0</td><td><span class="status">已停止</span></td><td><button class="primary">启动</button><button class="outline">编辑</button></td></tr>').join('');
      $$('#profile-table tr').forEach((row,index) => {
        row.querySelector('.status').classList.add('status-compact');
        row.cells[5].innerHTML = '<div class="env-browser-cell env-browser-cell-app"><div class="env-browser-label"><strong>环境 '+(index+1)+'</strong><small>独立内核</small></div></div>';
      });
      $('#kernel-path').textContent = 'E:\\u005cJS\\u005cjsTools\\u005cAiBrowser\\u005ckernels\\u005cwindows-x64\\u005cchrome.exe';
      $('#kernel-active-path').textContent = $('#kernel-path').textContent;
      $('#kernel-version').textContent = 'Chromium · 安装包内置';
      $('#kernel-launch-mode').textContent = '独立内核优先';
      $('#profile-storage-path').textContent = 'E:\\u005cJS\\u005cjsTools\\u005cAiBrowser\\u005cprofile-data';
      $('#theme-trigger').addEventListener('click', () => setThemePopoverOpen($('#theme-popover').hidden));
      $$('[data-ui-theme-option]').forEach((button) => button.addEventListener('click', () => applyUiTheme(button.dataset.uiThemeOption, false)));
      $$('[data-color-mode]').forEach((button) => button.addEventListener('click', () => applyColorMode(button.dataset.colorMode, false)));
      function showView(view) {
        $$('.view').forEach((section) => section.classList.toggle('active', section.id === 'view-' + view));
        $$('.nav[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
        $('#page-title').textContent = ({system:'本地设置',logs:'操作日志','api-mcp':'API & MCP',rpa:'自动脚本',ai:'AI 接入'})[view] || '环境管理';
        $('.content main').scrollTop = 0;
      }
      $$('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));
      $('#create-profile').addEventListener('click', () => $('#profile-dialog').showModal());
      window.glassFixture = { applyUiTheme, applyColorMode, showView, setThemePopoverOpen }; void 0;
    `);
    await evaluate(fs.readFileSync(path.join(__dirname, 'assets/vendor/lucide.min.js'), 'utf8'));
    await evaluate('refreshIcons(); document.fonts.ready.then(() => true)');
    async function screenshot(name) {
      await delay(100);
      const image = await win.webContents.capturePage();
      const file = path.join(outputRoot, `${name}.png`);
      await fsp.writeFile(file, image.toPNG());
      return file;
    }
    async function styles(selectors) {
      return evaluate(`(${function (items) {
        return items.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return { selector, missing: true };
          const css = getComputedStyle(element), rect = element.getBoundingClientRect();
          return { selector, background: css.backgroundColor, image: css.backgroundImage, filter: css.backdropFilter,
            color: css.color, opacity: css.opacity, border: css.borderColor, outline: css.outlineStyle,
            shadow: css.boxShadow, width: rect.width, height: rect.height,
            x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
            scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
        });
      }} )(${JSON.stringify(selectors)})`);
    }
    async function click(selector) {
      const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
      await delay(80);
    }
    async function contrast(selectors, label) {
      // Capture the actual composited background, including gradients and blur,
      // with just these glyphs hidden. A CSS-color-only contrast estimate would
      // miss exactly the transparency regressions that this change can cause.
      const targets = await evaluate(`(${function (items) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', {willReadFrequently:true});
        return items.map((selector) => {
          const element = document.querySelector(selector);
          if (!element) return {selector, missing:true};
          const css = getComputedStyle(element);
          context.clearRect(0,0,1,1); context.fillStyle = css.color; context.fillRect(0,0,1,1);
          const color = [...context.getImageData(0,0,1,1).data];
          let rect;
          if (element instanceof HTMLInputElement) {
            const bounds = element.getBoundingClientRect();
            rect = {x:bounds.x + parseFloat(css.paddingLeft) + 3, y:bounds.y + bounds.height / 2 - 5,
              width:Math.min(120,bounds.width-24), height:10};
          } else {
            const walker = document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
            let textNode;
            while (walker.nextNode()) { if (walker.currentNode.textContent.trim()) { textNode=walker.currentNode; break; } }
            const range = document.createRange(); range.selectNodeContents(textNode || element);
            rect = [...range.getClientRects()].find((r) => r.width > 2 && r.height > 2);
          }
          if (!rect || rect.y < 0 || rect.y + rect.height > innerHeight) return {selector, offscreen:true};
          const style = ['color','-webkit-text-fill-color','text-shadow','caret-color'].map((name) => ({name,value:element.style.getPropertyValue(name),priority:element.style.getPropertyPriority(name)}));
          element.style.setProperty('color','transparent','important');
          element.style.setProperty('-webkit-text-fill-color','transparent','important');
          element.style.setProperty('text-shadow','none','important');
          element.style.setProperty('caret-color','transparent','important');
          return {selector,color,style,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
        });
      }})(${JSON.stringify(selectors)})`);
      await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      await delay(80);
      const background = await win.webContents.capturePage();
      const bitmap = background.toBitmap(), {width,height} = background.getSize();
      await evaluate(`(${function (items) {
        for (const item of items) {
          if (!item.rect) continue;
          const element = document.querySelector(item.selector);
          for (const property of item.style) {
            if (property.value) element.style.setProperty(property.name,property.value,property.priority);
            else element.style.removeProperty(property.name);
          }
        }
      }})(${JSON.stringify(targets)})`);
      const luminance = (rgb) => rgb.map((c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
        .reduce((sum, value, i) => sum + value * [0.2126,0.7152,0.0722][i], 0);
      return targets.map((target) => {
        check(!!target.rect, `${label}: ${target.selector} is visible for contrast sampling`);
        if (!target.rect) return target;
        const ratios = [];
        for (const tx of [0.15,0.35,0.55,0.75,0.9]) for (const ty of [0.25,0.5,0.75]) {
          const x = Math.max(0,Math.min(width-1,Math.round(target.rect.x+target.rect.width*tx)));
          const y = Math.max(0,Math.min(height-1,Math.round(target.rect.y+target.rect.height*ty)));
          const offset = (y*width+x)*4;
          const bg = [bitmap[offset+2],bitmap[offset+1],bitmap[offset]];
          const alpha = target.color[3]/255;
          const fg = target.color.slice(0,3).map((c,i) => c*alpha+bg[i]*(1-alpha));
          const a = luminance(bg), b = luminance(fg);
          ratios.push((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05));
        }
        const minimum = Math.min(...ratios);
        check(minimum >= 4.5, `${label}: ${target.selector} rendered contrast ${minimum.toFixed(2)}:1 below 4.5:1`);
        return {selector:target.selector,foreground:target.color,minimumContrast:Number(minimum.toFixed(2))};
      });
    }
    for (const [theme, mode] of (baseline ? variants.slice(0,1) : variants)) {
      const label = `${theme}-${mode}`;
      await evaluate(`glassFixture.applyColorMode(${JSON.stringify(mode)}, false); glassFixture.applyUiTheme(${JSON.stringify(theme)}, false); glassFixture.showView('profiles');`);
      await delay(200);
      const item = { theme, mode, screens: [], surfaces: [], contrast: [] };
      item.screens.push(await screenshot(`${baseline ? 'baseline-' : ''}${label}-profiles`));
      if (baseline) { report.variants.push(item); continue; }
      item.surfaces.push(...await styles(['.sidebar','.content > header','.profile-primary-toolbar','.table-card','#profile-search','.search']));
      item.contrast.push(...await contrast(['#page-title','#page-subtitle','.sidebar [data-view="system"] span','#profile-table .profile-name strong','#profile-table tr:nth-child(2) .profile-name strong','#profile-table .env-browser-label strong','#profile-table .env-browser-label small','#profile-table tr:first-child .status-compact','#profile-table .group-chip','#profile-total','.profile-pagination .profile-total > span','#profile-group-chips .group-chip.active > span:nth-child(2)','#profile-group-chips .group-chip:not(.active) > span:nth-child(2)','#profile-search','#create-profile span'],label));
      await click('#theme-trigger');
      const popup = (await styles(['#theme-popover']))[0];
      check(await evaluate("!document.querySelector('#theme-popover').hidden"), `${label}: theme trigger receives pointer input through glass`);
      check(popup.right <= 1440 && popup.bottom <= 960 && popup.x >= 0 && popup.y >= 0, `${label}: theme popup stays in viewport`);
      item.surfaces.push(popup);
      item.contrast.push(...await contrast(['#theme-popover .theme-popover-head strong','#theme-popover .theme-option.active strong'],label));
      item.screens.push(await screenshot(`${label}-menu`));
      await click(`[data-ui-theme-option="${theme}"]`);
      check(await evaluate(`document.documentElement.dataset.uiTheme === ${JSON.stringify(theme)}`), `${label}: theme option remains clickable`);
      await evaluate('glassFixture.setThemePopoverOpen(false)');
      await click('#create-profile');
      check(await evaluate("document.querySelector('#profile-dialog').open"), `${label}: create button opens dialog through glass`);
      await evaluate("document.querySelector('#profile-form [name=title]').focus()");
      item.surfaces.push(...await styles(['#profile-dialog','#profile-form [name=title]']));
      await evaluate("document.querySelector('#profile-form [name=title]').value = '液态玻璃工作空间'");
      item.contrast.push(...await contrast(['#profile-dialog h2','#profile-form [name=title]','#profile-create-kernel-hint','#profile-dialog .network-mode-block .network-mode-hint','#profile-dialog .segmented label:has(input:checked)','#profile-dialog .segmented label:has(input:not(:checked))'],label));
      const focus = (await styles(['#profile-form [name=title]']))[0];
      check(focus.outline !== 'none' || focus.shadow !== 'none', `${label}: focused dialog field has visible affordance`);
      item.screens.push(await screenshot(`${label}-dialog`));
      await click('#profile-form .dialog-actions [value=cancel]');
      check(!await evaluate("document.querySelector('#profile-dialog').open"), `${label}: cancel remains clickable`);
      await click('[data-view="system"]');
      await evaluate("document.querySelector('#kernel-settings-card').scrollIntoView({block:'start'})");
      item.surfaces.push(...await styles(['#kernel-settings-card','.storage-path-box','#kernel-path']));
      item.contrast.push(...await contrast(['#kernel-settings-card h3','#kernel-path','#kernel-settings-card .storage-path-box small','#kernel-settings-card .storage-settings-head code','#kernel-progress','#view-system .ok'],label));
      item.screens.push(await screenshot(`${label}-paths`));
      for (const surface of item.surfaces.filter((entry) => !['#kernel-path', '.search'].includes(entry.selector))) {
        check(!surface.missing, `${label}: ${surface.selector} exists`);
        const color = surface.background.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/);
        check(color && Number(color[1]) < 1, `${label}: ${surface.selector} has translucent background (${surface.background})`);
      }
      const rootGeometry = await evaluate('({width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth})');
      check(rootGeometry.scroll <= rootGeometry.width + 1, `${label}: root does not overflow horizontally`);
      win.setContentSize(1024,768);
      await evaluate("glassFixture.showView('profiles'); glassFixture.setThemePopoverOpen(true)");
      await delay(150);
      const compact = (await styles(['#theme-popover']))[0];
      check(compact.right <= 1024 && compact.bottom <= 768 && compact.x >= 0 && compact.y >= 0, `${label}: compact theme popup stays in viewport`);
      await evaluate("glassFixture.setThemePopoverOpen(false); document.querySelector('#profile-dialog').showModal()");
      const compactDialog = (await styles(['#profile-dialog']))[0];
      check(compactDialog.right <= 1024 && compactDialog.bottom <= 768 && compactDialog.x >= 0 && compactDialog.y >= 0, `${label}: compact modal stays in viewport`);
      await evaluate("document.querySelector('#profile-dialog').close()");
      win.setContentSize(1440,960);
      report.variants.push(item);
      console.log(`PASS rendered ${label}: profiles, popup, modal and local paths`);
    }
    if (!baseline) {
      await win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-motion',value:'reduce'}] });
      const reduced = await evaluate(`({matches:matchMedia('(prefers-reduced-motion: reduce)').matches, animation:getComputedStyle(document.body,'::before').animationName, duration:getComputedStyle(document.querySelector('.sidebar')).transitionDuration})`);
      report.reducedMotion = reduced;
      check(reduced.matches, 'Chromium reduced-motion emulation is active');
      check(reduced.animation === 'none', 'Ambient decoration does not animate under reduced motion');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{name:'prefers-reduced-transparency',value:'reduce'}] });
      const solid = await evaluate(`({matches:matchMedia('(prefers-reduced-transparency: reduce)').matches, background:getComputedStyle(document.querySelector('.sidebar')).backgroundColor, filter:getComputedStyle(document.querySelector('.sidebar')).backdropFilter})`);
      report.reducedTransparency = solid;
      check(solid.matches && !solid.background.startsWith('rgba(') && solid.filter === 'none', 'Reduced transparency produces opaque, unblurred chrome');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      win.webContents.debugger.detach();

      report.additionalViews = [];
      for (const mode of ['dark','light']) {
        await evaluate(`glassFixture.applyColorMode(${JSON.stringify(mode)}, false); glassFixture.applyUiTheme('element-admin', false)`);
        for (const view of ['logs','api-mcp','rpa','ai']) {
          await evaluate(`glassFixture.showView(${JSON.stringify(view)})`);
          await delay(160);
          const scene = {mode,view,screenshot:await screenshot(`element-admin-${mode}-${view}`)};
          if (view === 'logs') {
            scene.surfaces = await styles(['.retro-log-window','.retro-log-titlebar','.log-runtime-note','.retro-log-columns','.log-card']);
            check(scene.surfaces.every((surface)=>surface.background.startsWith('rgba(')),`element-admin-${mode}: log window and bars have translucent backgrounds`);
            scene.contrast = await contrast(['.retro-log-title strong','.retro-log-title span','.log-runtime-note span'],`element-admin-${mode} logs`);
          }
          if (view === 'ai') scene.contrast = await contrast(['.ai-context-strip button.active'],`element-admin-${mode} AI`);
          report.additionalViews.push(scene);
        }
      }

      const floatingHtml = fs.readFileSync(path.join(__dirname,'sync-floating.html'),'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
        .replace('<head>',`<head><base href="${pathToFileURL(__dirname + path.sep).href}">`);
      const floatingFixture = path.join(process.env.GLASS_TEST_ROOT,'floating.html');
      await fsp.writeFile(floatingFixture,floatingHtml);
      win.setContentSize(460,50);
      await win.loadFile(floatingFixture);
      await evaluate(`
        window.floatSnapshot = { theme:{themeId:'pixel-workstation',colorMode:'dark',nativeGlass:'none'},
          sessions:[{id:'fixture-1',number:1,name:'设计工作空间',browser:'Chromium',syncable:true,canMaster:true},
            {id:'fixture-2',number:2,name:'开发与验证',browser:'Chromium',syncable:true,canMaster:true}],
          sync:{active:false,selected:['fixture-1','fixture-2'],master:'fixture-1'} };
        window.syncFloat = {
          snapshot:async()=>window.floatSnapshot,
          setExpanded:async(value)=> { window.floatExpanded=value; return {success:true}; },
          select:async(value)=> { window.floatSnapshot.sync.selected=value.ids; return {selected:value.ids}; },
          onTheme:(callback)=>{window.floatTheme=callback;}, onEvent:()=>{},
          hide:async()=>{}, openManager:async()=>{}, setSettings:async(value)=>value
        }; void 0;
      `);
      await evaluate(fs.readFileSync(path.join(__dirname,'assets/vendor/lucide.min.js'),'utf8'));
      await evaluate(fs.readFileSync(path.join(__dirname,'sync-floating-renderer.js'),'utf8') + '\nvoid 0;');
      report.floating = [];
      for (const [theme,mode] of variants) {
        const label = `floating-${theme}-${mode}`;
        await evaluate(`window.floatSnapshot.theme={themeId:${JSON.stringify(theme)},colorMode:${JSON.stringify(mode)},nativeGlass:'none'}; window.floatTheme(window.floatSnapshot.theme)`);
        await delay(100);
        const floating = {theme,mode,screens:[await screenshot(`${label}-collapsed`)],surfaces:await styles(['.floating-shell','.floating-bar'])};
        floating.contrast = await contrast(['#sync-status-title','#sync-targets-label'],label);
        await click('#sync-targets');
        check(await evaluate('window.floatExpanded === true && !document.querySelector("#floating-drawer").hidden'), `${label}: real renderer expands drawer`);
        win.setContentSize(460,360);
        await delay(100);
        floating.screens.push(await screenshot(`${label}-environments`));
        floating.contrast.push(...await contrast(['.selection-toolbar strong','.selection-toolbar small','.environment-copy strong','.environment-copy small','.environment-number'],label));
        await click('[data-panel="text"]');
        check(await evaluate('document.querySelector("[data-panel-body=text]").classList.contains("active")'),`${label}: drawer tab responds to mouse input`);
        await click('#floating-sync-text');
        win.webContents.insertText('玻璃工具条文本输入');
        await delay(60);
        check(await evaluate('document.querySelector("#floating-sync-text").value === "玻璃工具条文本输入"'),`${label}: text field accepts keyboard input`);
        floating.surfaces.push(...await styles(['.floating-drawer','#floating-sync-text']));
        floating.screens.push(await screenshot(`${label}-text`));
        await evaluate('document.querySelector("#floating-sync-text").value = ""');
        await click('#sync-targets');
        check(await evaluate('window.floatExpanded === false && document.querySelector("#floating-drawer").hidden'), `${label}: real renderer collapses drawer`);
        win.setContentSize(460,50);
        report.floating.push(floating);
      }
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
      report.floatingReducedTransparency = await styles(['.floating-shell','.floating-bar']);
      check(report.floatingReducedTransparency.every((surface)=>!surface.background.startsWith('rgba(') && surface.filter === 'none'),'Floating reduced transparency renders opaque controls');
      win.webContents.debugger.detach();
    }
    report.failures = failures;
    await fsp.writeFile(path.join(outputRoot, baseline ? 'baseline.json' : 'report.json'), JSON.stringify(report, null, 2));
    assert.deepStrictEqual(failures, [], failures.join('\n'));
    console.log(`PASS liquid glass visual QA: ${report.variants.length} appearance variants; ${outputRoot}`);
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
  }
}

async function launch() {
  const { spawn } = require('child_process');
  const { resolveHostDist, findHostWindowsExe } = require('./scripts/resolve-host-dist');
  const dist = resolveHostDist(__dirname);
  assert.equal(process.platform, 'win32', 'This live visual regression currently targets the installed Windows host');
  await fsp.mkdir(cacheRoot, { recursive: true });
  const root = await fsp.mkdtemp(path.join(cacheRoot, 'glass-test-runtime-'));
  const env = { ...process.env, GLASS_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try {
    child = spawn(findHostWindowsExe(dist), [`--user-data-dir=${root}`, __filename],
      { cwd: __dirname, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timeout = setTimeout(() => child.kill(), 120000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      process.stdout.write(output);
      assert.equal(code, 0, 'Isolated Electron visual selftest failed');
    } finally { clearTimeout(timeout); }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), cacheRoot, 'Only remove the owned temporary runtime directory');
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 400 });
  }
}

(process.versions.electron ? runElectron() : launch()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
