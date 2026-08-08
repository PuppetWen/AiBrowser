#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const renderer = read('renderer.js');
const index = read('index.html');
const refined = read('ui-refined.css');
const main = read('main.js');
const preload = read('preload.js');
const floatingHtml = read('sync-floating.html');
const floatingRenderer = read('sync-floating-renderer.js');
const floatingPreload = read('sync-floating-preload.js');
const liveSync = read('live-sync-v5.js');
const marionette = read('marionette-client.js');
const nativeMirror = read('native-input-mirror.cs');
const nativeWindow = read('native-window-bounds.cs');
const packager = read('scripts/package-portable.js');
const brand = read('scripts/brand-exe.mjs');

const tableCount = (index.match(/<table\b/g) || []).length;
assert.strictEqual(tableCount, 7, 'all seven application tables must be covered');
for (const id of [
  'profile-table', 'group-table', 'proxy-table', 'session-table',
  'rpa-plan-table', 'rpa-task-table', 'rpa-run-table',
]) {
  assert.match(index, new RegExp(`<tbody\\s+id=["']${id}["']`), `missing table body ${id}`);
}
assert.match(renderer, /function installResizableTables\(/);
assert.match(renderer, /TABLE_WIDTHS_KEY\s*=\s*['"]aibrowser-table-widths-v3['"]/);
assert.match(renderer, /DEFAULT_TABLE_WIDTHS/);
assert.match(renderer, /DEFAULT_TABLE_FLEX_COLUMN/);
assert.match(renderer, /defaultLayout \? `max\(100%, \$\{total\}px\)` : `\$\{total\}px`/);
assert.match(renderer, /installResizableTables\(root \|\| document\)/);
assert.match(renderer, /addEventListener\(['"]pointerdown['"]/);
assert.match(renderer, /addEventListener\(['"]dblclick['"]/);
assert.match(renderer, /localStorage\.setItem\(TABLE_WIDTHS_KEY/);
assert.match(refined, /\.table-column-resizer/);
assert.match(refined, /\.table-resizable-wrap\s*\{[\s\S]*?overflow-x:\s*auto\s*!important/);
assert.match(renderer, /function updateTableHorizontalRail\(/);
assert.match(refined, /\.table-horizontal-rail\.visible/);
console.log(`PASS resizable columns cover ${tableCount} tables and persist widths`);

assert.match(renderer, /data\.uiTooltip|dataset\.uiTooltip/);
assert.match(refined, /\.ui-tooltip\.visible/);
assert.match(refined, /\.profile-action-label\s*\{\s*display:\s*none\s*!important/);
assert.match(refined, /#view-ai \.ai-layout\s*\{[\s\S]*?height:\s*100%\s*!important/);
assert.match(refined, /\.retro-log-columns,[\s\S]*?\.log-row[\s\S]*?grid-template-columns:\s*112px 132px minmax\(0, 1fr\)/);
console.log('PASS icon-only table actions, themed tooltips, AI height, and log columns are constrained');

assert.match(main, /function createSyncFloatingWindow\(/);
assert.match(main, /syncFloatingEnabled/);
assert.match(preload, /setSyncFloatingEnabled/);
assert.match(index, /id="sync-floating-enabled"/);
assert.match(floatingHtml, /id="sync-select-all"/);
for (const panel of ['environments', 'window', 'text', 'tabs']) assert.match(floatingHtml, new RegExp(`data-panel-body=["']${panel}["']`));
assert.match(floatingHtml, /AiBrowser 工具条/);
assert.match(floatingRenderer, /syncFloat\.apply/);
assert.match(floatingRenderer, /syncFloat\.select/);
assert.match(floatingRenderer, /syncFloat\.windowAction/);
assert.match(floatingRenderer, /syncFloat\.textAction/);
assert.match(floatingRenderer, /syncFloat\.tabAction/);
assert.match(floatingRenderer, /syncFloat\.restart/);
assert.match(floatingPreload, /sync-floating:set-expanded/);
assert.match(floatingPreload, /sync-floating:selection/);
assert.match(floatingPreload, /sync-floating:window/);
assert.match(floatingPreload, /sync-floating:text/);
assert.match(floatingPreload, /sync-floating:tabs/);
assert.match(main, /width = 460/);
assert.match(main, /height = 50/);
assert.match(main, /sync-floating:set-expanded/);
assert.match(floatingRenderer, /state\.selected = new Set\(state\.sessions\.filter/);
assert.match(renderer, /button\.getAttribute\('aria-pressed'\) !== 'true'/);
assert.match(renderer, /setSyncFloatingEnabled\(next\)/);
assert.match(renderer, /preferredMasterId = value\.active \? value\.master : \(value\.selected\?\.\[0\]/);
assert.match(main, /function performWindowAction\(/);
assert.match(main, /runNativeWindowHelper\(\[item\.pid, action\]/);
assert.match(main, /function performTextAction\(/);
assert.match(main, /function performTabAction\(/);
assert.match(nativeWindow, /case "minimized": command = SW_MINIMIZE/);
assert.match(nativeWindow, /case "maximized": command = SW_MAXIMIZE/);
assert.match(nativeWindow, /case "normal": command = SW_RESTORE/);
console.log('PASS floating multi-environment sync controller and local visibility setting are wired');

assert.match(liveSync, /nativeTargets/);
assert.match(liveSync, /OPENBROWSER_FULL_WINDOW_MASTER/);
assert.match(liveSync, /line\.trim\(\) === 'READY'/);
assert.match(nativeMirror, /Thread automation = new Thread\(UiAutomationLoop\)/);
assert.match(nativeMirror, /QueueEditorSnapshot\(\)/);
assert.match(nativeMirror, /MozillaWindowClass/);
assert.match(main, /engine\.runningSyncable/);
assert.match(main, /native-window-bounds\.exe/);
assert.doesNotMatch(main, /async function beginSync\(ids = syncSelection\)[\s\S]*?await tile\(selected, false\)/);
assert.match(main, /if \(action === 'tile'\) return tile\(ids, false\)/);
assert.match(main, /process\.platform === 'win32'[\s\S]*?native-window-bounds\.exe[\s\S]*?if \(item\.port\) return cdp\.setWindowBounds/);
assert.match(main, /const rowItemCount = Math\.min\(cols, remaining - rowsAfter\)/);
assert.match(main, /relaunchCommand: `"\$\{relaunchExecutable\}"`/);
assert.match(main, /shell\.writeShortcutLink/);
assert.match(main, /appUserModelId: 'com\.aibrowser\.localworkspace'/);
assert.match(floatingRenderer, /custom-layout-sheet/);
assert.match(index, /id="profiles-sync-floating"/);
assert.match(liveSync, /new MarionetteClient\(target\.item\.marionettePort\)/);
assert.match(liveSync, /firefoxSemanticScript/);
assert.doesNotMatch(liveSync, /await this\.syncWindowGeometry\(/);
assert.match(marionette, /this\.currentUrl === destination/);
console.log('PASS project Chromium + Firefox Marionette hybrid sync, explicit-only window tiling, and environment quick-launch are wired');

assert.match(refined, /--titlebar-drag-height:\s*32px/);
assert.match(refined, /--titlebar-content-offset:\s*0px/);
assert.match(refined, /\[data-platform="windows"\]\[data-titlebar="integrated"\][\s\S]*?\.content > header[\s\S]*?padding-top:\s*0\s*!important/);
assert.doesNotMatch(main, /height:\s*40,\s*\n\s*\}/);
console.log('PASS Windows native caption overlay no longer reserves a blank row');

assert.match(main, /setAppUserModelId\(['"]com\.aibrowser\.localworkspace['"]\)/);
assert.match(main, /isWin && fs\.existsSync\(ico\)/);
assert.match(main, /loadFile\(path\.join\(__dirname, ['"]index\.html['"]\)\)/);
assert.match(main, /loadFile\(path\.join\(__dirname, ['"]sync-floating\.html['"]\)\)/);
assert.match(main, /return path\.basename\(executableDir\)[\s\S]*?\? path\.dirname\(executableDir\)[\s\S]*?: executableDir/);
assert.match(packager, /const runtimeRoot = packageRoot;/);
assert.doesNotMatch(packager, /const runtimeRoot = path\.join\(packageRoot, ['"]runtime['"]\)/);
assert.doesNotMatch(packager, /writeText\(path\.join\(packageRoot, ['"]START\.cmd['"]\)/);
assert.match(packager, /CreateShortCut[^\n]+\$INSTDIR\\\\AiBrowser\.exe/);
assert.match(packager, /Exec[^\n]+\$0\\\\AiBrowser\.exe/);
assert.doesNotMatch(packager, /SilentInstall\s+silent/);
assert.ok((packager.match(/`Icon \"\$\{packageIcon\}\"`/g) || []).length >= 2, 'installer and portable EXE must both declare the app icon');
assert.match(packager, /path\.dirname\(process\.execPath\).*browser-data/);
assert.match(brand, /'file-version':\s*'1\.0\.2\.0'/);
assert.match(brand, /FileDescription:\s*'AiBrowser Local Workspace'/);
console.log('PASS portable and installer use a branded root AiBrowser.exe with stable taskbar identity');
