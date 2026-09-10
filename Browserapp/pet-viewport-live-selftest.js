'use strict';

// Exercise the actual pet CSS and renderer in an isolated, hidden desktop host.
// No user settings, accounts, physical display settings, or 3D assets are changed.
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  await app.whenReady();
  let win;
  try {
    win = new BrowserWindow({ width: 1000, height: 760, frame: false, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><html><body><main id="pet-stage"></main><div id="pet-hitbox"></div><div id="pet-status"></div></body></html>'));
    const css = fs.readFileSync(path.join(__dirname, 'pet.css'), 'utf8');
    await win.webContents.insertCSS(css);
    await win.webContents.executeJavaScript(`
      window.desktopPet = {
        onEvent(callback) { window.petTestEvent = callback; },
        rendererState() {}, beginDrag() {}, endDrag() {}, scale() {},
        snapshot: async () => ({ config: { scale: 1, position: { x: 600, y: 220 } },
          desktopBounds: { x: 0, y: 0, width: 1000, height: 760 }, pets: [] })
      };
      ${fs.readFileSync(path.join(__dirname, 'pet-renderer.js'), 'utf8')}
    `);
    const result = await win.webContents.executeJavaScript(`(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stage = document.getElementById('pet-stage');
      const canvas = document.createElement('canvas');
      canvas.style.width = '640px'; canvas.style.height = '864px';
      stage.append(canvas);
      const measure = () => ({
        gutterX: innerWidth - document.documentElement.clientWidth,
        gutterY: innerHeight - document.documentElement.clientHeight,
        scrollX, scrollY,
        rootOverflow: getComputedStyle(document.documentElement).overflow,
        stageOverflow: getComputedStyle(stage).overflow,
      });
      // Reproduce the original root overflow rule with the same renderer.
      const oldRule = document.createElement('style');
      oldRule.textContent = 'html,body { overflow:visible !important; } body { position:static !important; }';
      document.head.append(oldRule);
      const before = measure();
      oldRule.remove();
      scrollTo(0, 0);
      const checks = [];
      for (const scale of [0.25, 1, 1.6]) {
        const w = Math.round(400 * scale), h = Math.round(540 * scale);
        for (const p of [{x:0,y:0}, {x:innerWidth-w,y:0},
          {x:0,y:innerHeight-h}, {x:innerWidth-w,y:innerHeight-h},
          {x:innerWidth-48,y:innerHeight-48}]) {
          window.petTestEvent({ type: 'scale', scale, position: p });
          await new Promise((resolve) => setTimeout(resolve, 220));
          scrollTo(200,200);
          checks.push({scale, ...measure()});
        }
      }
      document.body.classList.add('dragging');
      window.petTestEvent({type:'desktop-bounds', desktopBounds:{x:-1280,y:-100,width:2280,height:860},
        position:{x:-1100,y:50}, scale:0.5});
      return { before, checks, relocated: window.__petDebugSnapshot(),
        dragging: document.body.classList.contains('dragging') };
    })()`);
    assert.ok(result.before.gutterX > 0 && result.before.gutterY > 0,
      'original rules reproduce both desktop-edge scrollbars: ' + JSON.stringify(result.before));
    for (const check of result.checks) {
      assert.equal(check.gutterX, 0, JSON.stringify(check));
      assert.equal(check.gutterY, 0, JSON.stringify(check));
      assert.equal(check.scrollX, 0, JSON.stringify(check));
      assert.equal(check.scrollY, 0, JSON.stringify(check));
      assert.equal(check.stageOverflow, 'visible', 'action overscan remains enabled');
    }
    assert.deepStrictEqual(result.relocated.inputBounds, { x: 180, y: 150, width: 200, height: 270 });
    assert.equal(result.dragging, false);
    console.log('PASS original CSS reproduces scrollbars: ' + JSON.stringify(result.before));
    console.log('PASS 15 corner/scale layouts have no scrollbars or scroll offset; display-origin change repositions input');
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    app.quit();
  }
}

async function launch() {
  const { spawn } = require('child_process');
  const { resolveHostDist, findHostWindowsExe } = require('./scripts/resolve-host-dist');
  const parent = path.resolve(__dirname, '..', '.cache');
  await fsp.mkdir(parent, { recursive: true });
  const root = await fsp.mkdtemp(path.join(parent, 'pet-viewport-test-'));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(findHostWindowsExe(resolveHostDist(__dirname)),
      [`--user-data-dir=${root}`, __filename], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const watchdog = setTimeout(() => child.kill(), 45000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, output);
      console.log(output.split(/\r?\n/).filter((line) => line.startsWith('PASS ')).join('\n'));
    } finally { clearTimeout(watchdog); }
  } finally {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

(process.versions.electron ? runElectron() : launch()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
