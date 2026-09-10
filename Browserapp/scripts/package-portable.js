#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  resolveHostDist,
  findHostAppBundle,
  findHostWindowsExe,
  findMacBinary,
} = require('./resolve-host-dist');
const { ensureHostRuntime } = require('./ensure-host-runtime');
const {
  findBundledWayfernKernel,
  isIntegratedKernelCdpReady,
  companionLibraryForKernelBinary,
} = require('../automation/browser-kernel');

const appRoot = path.resolve(__dirname, '..');
const appManifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const appVersion = String(appManifest.version || '1.0.0');
const windowsFileVersion = `${appVersion}.0`.split('.').slice(0, 4).join('.');
const packageArch = resolvePackageArch();
let hostDist = (() => {
  try {
    return resolveHostDist(appRoot);
  } catch (_) {
    return null;
  }
})();
const distRoot = process.env.OPENBROWSER_PACKAGE_OUTPUT
  ? path.resolve(process.env.OPENBROWSER_PACKAGE_OUTPUT)
  : path.join(appRoot, 'dist');

/**
 * Default packaging always ships the integrated kernel.
 * Opt out only with OPENBROWSER_PACKAGE_VARIANT=without-kernel or OPENBROWSER_BUNDLE_KERNEL=false.
 */
function packageVariant() {
  const variant = String(process.env.OPENBROWSER_PACKAGE_VARIANT || '').trim().toLowerCase();
  if (variant === 'without-kernel' || variant === 'no-kernel' || variant === 'kernel-free') {
    return 'without-kernel';
  }
  if (variant === 'with-kernel' || variant === 'kernel' || variant === '') {
    // Empty defaults to with-kernel (product default).
    if (variant === '' && String(process.env.OPENBROWSER_BUNDLE_KERNEL || 'true').toLowerCase() === 'false') {
      return 'without-kernel';
    }
    return 'with-kernel';
  }
  throw new Error('OPENBROWSER_PACKAGE_VARIANT must be with-kernel (default) or without-kernel');
}

function bundleKernelVariantEnabled() {
  return packageVariant() === 'with-kernel';
}

function packageVariantSuffix(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const isVariantPlatform = p === 'win32' || (p === 'darwin' && a === 'arm64');
  if (!isVariantPlatform) return '';
  // Default product SKU is with-kernel; keep stable artifact suffix for CI/release assets.
  return packageVariant() === 'without-kernel' ? '-without-kernel' : '-with-kernel';
}

function packageArtifactStem(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const productPlatform = p === 'win32' ? 'Windows' : 'macOS';
  return `AiBrowser-${productPlatform}-${arch}${packageVariantSuffix(platform, arch)}`;
}

function resolvePackageArch() {
  const raw = process.env.OPENBROWSER_PACKAGE_ARCH
    || process.env.npm_config_target_arch
    || process.env.npm_config_arch
    || process.env.ELECTRON_INSTALL_ARCH
    || os.arch();
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'amd64') return 'x86_64';
  if (normalized === 'aarch64') return 'arm64';
  return normalized || os.arch();
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

function copyRecursive(source, destination) {
  const stats = fs.lstatSync(source);
  if (stats.isSymbolicLink()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(fs.readlinkSync(source), destination);
    return;
  }
  if (stats.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyRecursive(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, stats.mode & 0o777);
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function writeText(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** aibrowser-148 ships only in macOS x86_64 packages. */
function shouldShipAiBrowser148Kernel(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const isX64 = a === 'x64' || a === 'x86_64' || a === 'amd64';
  return p === 'darwin' && isX64;
}

function shouldShipIntegratedWayfern(platform = process.platform, arch = packageArch) {
  const p = String(platform || '').toLowerCase();
  const a = String(arch || '').toLowerCase();
  const supportedPlatform = (p === 'win32' && ['x86_64', 'x64', 'amd64'].includes(a))
    || (p === 'darwin' && a === 'arm64');
  return supportedPlatform && bundleKernelVariantEnabled();
}

/** @deprecated alias for shouldShipIntegratedWayfern. */
function shouldShipBundledWayfern(platform = process.platform, arch = packageArch) {
  return shouldShipIntegratedWayfern(platform, arch);
}

/**
 * App tree entries NOT copied into resources/app for this package.
 *
 * Integrated independent kernels live side-by-side under Browserapp/kernels/:
 *   - macos-x64/    AiBrowser 148 (macOS Intel)
 *   - windows-x64/  Windows independent kernel
 *   - macos-arm64/  macOS arm64 independent kernel
 *
 * Always copy kernels/, then prune foreign platform seeds after copy.
 * Legacy bundled-kernels/ is never shipped.
 */
function appResourceExcludes() {
  return new Set([
    'node_modules', 'dist', 'tools', '.git', '.cache', 'browser-data', 'rpa-output',
    'CODE_OVERVIEW.md', 'bundled-kernels',
  ]);
}

function isGeneratedPackageEntry(entry) {
  return /\.(?:log|tmp|orig)$/i.test(entry)
    || /^tmp-run-.*\.js$/i.test(entry)
    || (/\.json$/i.test(entry) && /(?:^|[-_.])(?:results?|reports?)(?:[-_.]|$)/i.test(entry))
    || /^(?:full|remaining|script)-selftest-.*\.json$/i.test(entry);
}

function pruneForeignKernelSeeds(resourceApp, platform = process.platform, arch = packageArch) {
  const kernelsDir = path.join(resourceApp, 'kernels');
  if (!fs.existsSync(kernelsDir)) return;
  const shipAiBrowser = shouldShipAiBrowser148Kernel(platform, arch);
  const shipWayfern = shouldShipIntegratedWayfern(platform, arch);
  const a = String(arch || '').toLowerCase();
  const isWin = String(platform || '').toLowerCase() === 'win32';
  const isDarwin = String(platform || '').toLowerCase() === 'darwin';
  const isArm64 = a === 'arm64' || a === 'aarch64';

  // Keep only the platform seed for this SKU (+ shared meta/README if present).
  const keep = new Set(['meta', 'README.md']);
  if (shipAiBrowser) {
    keep.add('macos-x64');
    keep.add('aibrowser'); // compat symlink/name
  }
  if (shipWayfern) {
    if (isWin) keep.add('windows-x64');
    if (isDarwin && isArm64) keep.add('macos-arm64');
    keep.add('wayfern'); // legacy compat path; pruned below if empty
  }
  if (isWin && fs.existsSync(path.join(kernelsDir, 'firefox-reverse', 'firefox.exe'))) {
    keep.add('firefox-reverse');
  }

  for (const entry of fs.readdirSync(kernelsDir)) {
    if (keep.has(entry)) continue;
    fs.rmSync(path.join(kernelsDir, entry), { recursive: true, force: true });
  }

  // Strip legacy nested seed dirs to only the shipped platform.
  const wayfernDir = path.join(kernelsDir, 'wayfern');
  if (fs.existsSync(wayfernDir)) {
    if (!shipWayfern) {
      fs.rmSync(wayfernDir, { recursive: true, force: true });
    } else {
      const wayKeep = new Set(['meta', 'README.md']);
      if (isWin) wayKeep.add('windows-x64');
      if (isDarwin && isArm64) wayKeep.add('macos-arm64');
      for (const entry of fs.readdirSync(wayfernDir)) {
        if (wayKeep.has(entry)) continue;
        fs.rmSync(path.join(wayfernDir, entry), { recursive: true, force: true });
      }
    }
  }

  // Without-kernel / wrong-platform packages should not retain empty husks.
  if (!shipAiBrowser) {
    for (const name of ['macos-x64', 'aibrowser']) {
      const p = path.join(kernelsDir, name);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  if (!shipWayfern) {
    for (const name of ['windows-x64', 'macos-arm64', 'wayfern']) {
      const p = path.join(kernelsDir, name);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }

  try {
    if (fs.existsSync(kernelsDir) && fs.readdirSync(kernelsDir).length === 0) {
      fs.rmSync(kernelsDir, { recursive: true, force: true });
    }
  } catch (_) {}
}

const OPENBROWSER_148_REL = path.join(
  'kernels',
  'macos-x64',
  'chrome_148',
  'aibrowser_148',
  'AiBrowser.app',
  'Contents',
  'MacOS',
  'AiBrowser'
);
const OPENBROWSER_148_LEGACY_REL = path.join(
  'kernels',
  'aibrowser',
  'chrome_148',
  'aibrowser_148',
  'AiBrowser.app',
  'Contents',
  'MacOS',
  'AiBrowser'
);

/**
 * Hard assert after copy: integrated kernels only, correct platform seed, no remote staging tree.
 */
function assertKernelPackagePolicy(resourceApp) {
  const shipAiBrowser = shouldShipAiBrowser148Kernel();
  const shipWayfern = shouldShipIntegratedWayfern();
  const kernelsDir = path.join(resourceApp, 'kernels');
  const aiBrowserBin = fs.existsSync(path.join(resourceApp, OPENBROWSER_148_REL))
    ? path.join(resourceApp, OPENBROWSER_148_REL)
    : path.join(resourceApp, OPENBROWSER_148_LEGACY_REL);
  const integrated = findBundledWayfernKernel([resourceApp, path.join(resourceApp, 'kernels')]);
  const firefoxReverse = path.join(resourceApp, 'kernels', 'firefox-reverse', 'firefox.exe');
  if (fs.existsSync(path.join(resourceApp, 'bundled-kernels'))) {
    throw new Error('[package] FATAL: legacy bundled-kernels/ must not ship (use kernels/{platform} seeds)');
  }
  if (shipAiBrowser) {
    if (!fs.existsSync(aiBrowserBin)) {
      throw new Error(
        '[package] FATAL: macOS x86_64 package missing aibrowser-148 binary under kernels/macos-x64: '
        + aiBrowserBin
      );
    }
    for (const foreign of ['windows-x64', 'macos-arm64']) {
      if (fs.existsSync(path.join(kernelsDir, foreign))) {
        throw new Error(`[package] FATAL: macOS x86_64 package must not include kernels/${foreign}`);
      }
    }
  } else {
    for (const name of ['macos-x64', 'aibrowser']) {
      if (fs.existsSync(path.join(kernelsDir, name))) {
        throw new Error(
          `[package] FATAL: ${name} present but this SKU is not macOS x86_64`
          + ' (platform=' + process.platform + ' arch=' + packageArch + ')'
        );
      }
    }
  }
  if (shipWayfern) {
    const expected = process.platform === 'win32' ? 'windows-x64' : 'macos-arm64';
    if (!integrated && !fs.existsSync(path.join(kernelsDir, expected))) {
      throw new Error(`[package] FATAL: missing integrated kernel seed under kernels/${expected}`);
    }
    if (!integrated) {
      throw new Error(`[package] FATAL: kernel binary not discovered under kernels/${expected}`);
    }
    // Fail packaging if companion library CDP readiness markers are missing.
    if (!isIntegratedKernelCdpReady({ path: integrated.binary || integrated.path, source: 'donut-wayfern' })) {
      const lib = companionLibraryForKernelBinary(integrated.binary || integrated.path);
      throw new Error(
        '[package] FATAL: integrated kernel is not CDP-ready for RPA/Local API'
        + ` (seed=${expected} companion=${lib || 'missing'})`
      );
    }
  } else {
    for (const name of ['windows-x64', 'macos-arm64', 'wayfern']) {
      if (fs.existsSync(path.join(kernelsDir, name))) {
        throw new Error(`[package] FATAL: kernels/${name} present on unsupported/without-kernel package`);
      }
    }
  }
  if (process.platform === 'win32' && !fs.existsSync(firefoxReverse)) {
    throw new Error('[package] FATAL: missing bundled Firefox-Reverse kernel: ' + firefoxReverse);
  }
}

function copyAppResources(resourceApp) {
  const excluded = appResourceExcludes();
  fs.mkdirSync(resourceApp, { recursive: true });
  for (const entry of fs.readdirSync(appRoot)) {
    if (excluded.has(entry) || isGeneratedPackageEntry(entry)) continue;
    copyRecursive(path.join(appRoot, entry), path.join(resourceApp, entry));
  }
  pruneForeignKernelSeeds(resourceApp);
  // Never ship local-only kernel notes / backups / private markers
  (function stripLocalKernelNotes(root) {
    const fs = require('fs');
    const path = require('path');
    const kernels = path.join(root, 'kernels');
    if (!fs.existsSync(kernels)) return;
    const kill = (file) => { try { fs.rmSync(file, { recursive: true, force: true }); } catch (_) {} };
    kill(path.join(kernels, 'README.md'));
    const walk = (dir) => {
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/readme\.md$/i.test(ent.name) || /\.(?:orig|log)$/i.test(ent.name) || /unlock/i.test(ent.name) || /^OPENBROWSER_/i.test(ent.name)) kill(full);
      }
    };
    walk(kernels);
  })(resourceApp);

  console.log('[package] kernel policy: aibrowser-148=' + shouldShipAiBrowser148Kernel()
    + ' integrated-kernel=' + shouldShipIntegratedWayfern()
    + ' auto-download=false'
    + ' arch=' + packageArch + ' platform=' + process.platform);
  assertKernelPackagePolicy(resourceApp);
}

function copyProductionDependencies(resourceApp) {
  const source = path.join(appRoot, 'node_modules');
  const destination = path.join(resourceApp, 'node_modules');
  if (!fs.existsSync(source)) throw new Error('Source node_modules is missing: ' + source);
  for (const manifest of ['package.json', 'package-lock.json']) {
    const from = path.join(appRoot, manifest);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(resourceApp, manifest));
  }
  removeIfExists(destination);
  copyRecursive(source, destination);

  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(npmCli)) throw new Error('npm CLI is required to prune production dependencies: ' + npmCli);
  run(process.execPath, [
    npmCli,
    'prune',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], { cwd: resourceApp, env: packageBuildEnvironment() });

  for (const name of ['adm-zip', 'exceljs', 'yaml']) {
    if (!fs.existsSync(path.join(destination, name))) {
      throw new Error('Production dependency was not staged: ' + name);
    }
  }
  for (const name of ['desktop-shell', 'rcedit']) {
    if (fs.existsSync(path.join(destination, name))) {
      throw new Error('Development dependency leaked into runtime: ' + name);
    }
  }
}

function nsisPath(value) {
  return String(value).replace(/"/g, '$\\"');
}

function nsisGlob(value) {
  return nsisPath(path.join(value, '*'));
}

function packageBuildEnvironment() {
  const temp = path.resolve(appRoot, '..', '.cache', 'package-temp');
  fs.mkdirSync(temp, { recursive: true });
  return { ...process.env, TEMP: temp, TMP: temp };
}

function createPackagedAppBootstrap(runtimeRoot) {
  const resources = path.join(runtimeRoot, 'resources');
  const bootstrapRoot = path.join(distRoot, '.aibrowser-bootstrap');
  const output = path.join(resources, 'app.asar');
  const asarCli = path.join(appRoot, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');
  if (!fs.existsSync(asarCli)) throw new Error('Missing @electron/asar build dependency: ' + asarCli);
  removeIfExists(bootstrapRoot);
  removeIfExists(output);
  writeText(path.join(bootstrapRoot, 'package.json'), JSON.stringify({
    name: 'aibrowser-bootstrap',
    version: appVersion,
    main: 'main.js',
  }, null, 2));
  writeText(path.join(bootstrapRoot, 'main.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const logDir = path.join(path.dirname(process.execPath), 'browser-data', 'logs');",
    "try {",
    "  fs.mkdirSync(logDir, { recursive: true });",
    "  require(path.join(process.resourcesPath, 'app', 'main.js'));",
    "} catch (error) {",
    "  try { fs.appendFileSync(path.join(logDir, 'bootstrap-error.log'), `${new Date().toISOString()} ${error.stack || error.message}\\n`); } catch (_) {}",
    "  throw error;",
    "}",
    '',
  ].join('\n'));
  run(process.execPath, [asarCli, 'pack', bootstrapRoot, output], { env: packageBuildEnvironment() });
  removeIfExists(bootstrapRoot);
  if (!fs.existsSync(output)) throw new Error('Packaged app bootstrap was not generated: ' + output);
}

function packageWindowsZip(packageRoot) {
  const zip = path.join(distRoot, `${packageArtifactStem()}.zip`);
  removeIfExists(zip);
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -LiteralPath '${packageRoot.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`,
  ], { env: packageBuildEnvironment() });
  console.log('Windows portable ZIP: ' + zip);
}

function packageWindowsInstaller(packageRoot) {
  const output = path.join(distRoot, `${packageArtifactStem()}-Setup.exe`);
  const script = path.join(distRoot, 'AiBrowser-Windows-installer.nsi');
  const installSource = nsisGlob(packageRoot);
  const packageIcon = nsisPath(path.join(appRoot, 'assets', 'logo.ico'));
  const installDir = '$LOCALAPPDATA\\Programs\\AiBrowser';
  writeText(script, [
    '!include "MUI2.nsh"',
    '!include "FileFunc.nsh"',
    '!include "Sections.nsh"',
    `!define MUI_ICON "${packageIcon}"`,
    `!define MUI_UNICON "${packageIcon}"`,
    'Name "AiBrowser"',
    'Caption "AiBrowser Setup"',
    `OutFile "${nsisPath(output)}"`,
    `Icon "${packageIcon}"`,
    `UninstallIcon "${packageIcon}"`,
    `VIProductVersion "${windowsFileVersion}"`,
    'VIAddVersionKey /LANG=1033 "ProductName" "AiBrowser"',
    `VIAddVersionKey /LANG=1033 "ProductVersion" "${appVersion}"`,
    `VIAddVersionKey /LANG=1033 "FileVersion" "${appVersion}"`,
    'VIAddVersionKey /LANG=1033 "FileDescription" "AiBrowser Installer"',
    'VIAddVersionKey /LANG=1033 "LegalCopyright" "AGPL-3.0-or-later"',
    `InstallDir "${installDir}"`,
    'InstallDirRegKey HKCU "Software\\AiBrowser" "InstallDir"',
    'RequestExecutionLevel user',
    'Unicode true',
    'SetCompressor zlib',
    '!define MUI_ABORTWARNING',
    '!insertmacro MUI_PAGE_WELCOME',
    '!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipDirectoryPage',
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!undef MUI_PAGE_CUSTOMFUNCTION_PRE',
    '!insertmacro MUI_PAGE_COMPONENTS',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_PAGE_FINISH',
    '!insertmacro MUI_LANGUAGE "English"',
    'Var ExistingInstall',
    'Function .onInit',
    '  StrCpy $ExistingInstall "0"',
    '  ${GetParameters} $0',
    '  ClearErrors',
    '  ${GetOptions} $0 "/UPDATEPATH=" $1',
    '  IfErrors TryRegistry 0',
    '  IfFileExists "$1\\AiBrowser.exe" UseExisting TryRegistry',
    'TryRegistry:',
    '  ReadRegStr $1 HKCU "Software\\AiBrowser" "InstallDir"',
    '  StrCmp $1 "" TryRunningProcess 0',
    '  IfFileExists "$1\\AiBrowser.exe" UseExisting TryRunningProcess',
    'TryRunningProcess:',
    '  nsExec::ExecToStack \'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "$$p=(Get-Process -Name AiBrowser -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path); if($$p){[Console]::Write($$p)}"\'',
    '  Pop $0',
    '  Pop $1',
    '  StrCmp $0 "0" 0 InitDone',
    '  ${GetParent} "$1" $2',
    '  IfFileExists "$2\\AiBrowser.exe" 0 InitDone',
    '  StrCpy $1 $2',
    'UseExisting:',
    '  StrCpy $INSTDIR $1',
    '  StrCpy $ExistingInstall "1"',
    'InitDone:',
    '  StrCmp $ExistingInstall "1" ExistingDesktopOption 0',
    '  SectionSetFlags 1 ${SF_SELECTED}',
    '  Goto DesktopOptionDone',
    'ExistingDesktopOption:',
    '  IfFileExists "$DESKTOP\\AiBrowser.lnk" 0 NoDesktopOption',
    '  SectionSetFlags 1 ${SF_SELECTED}',
    '  Goto DesktopOptionDone',
    'NoDesktopOption:',
    '  SectionSetFlags 1 0',
    'DesktopOptionDone:',
    'FunctionEnd',
    'Function SkipDirectoryPage',
    '  StrCmp $ExistingInstall "1" 0 ShowDirectoryPage',
    '  Abort',
    'ShowDirectoryPage:',
    'FunctionEnd',
    'Section "AiBrowser" SEC_MAIN',
    '  SectionIn RO',
    '  StrCmp $ExistingInstall "1" 0 CopyApplicationFiles',
    '  nsExec::ExecToStack \'taskkill.exe /F /IM AiBrowser.exe\'',
    '  Pop $0',
    '  Pop $1',
    '  Sleep 1200',
    'CopyApplicationFiles:',
    '  RMDir /r "$INSTDIR\\runtime"',
    '  RMDir /r "$INSTDIR\\resources\\app"',
    '  Delete "$INSTDIR\\resources\\app.asar"',
    '  Delete "$INSTDIR\\START.cmd"',
    '  SetOutPath "$INSTDIR"',
    `  File /r "${installSource}"`,
    '  CreateDirectory "$SMPROGRAMS\\AiBrowser"',
    '  CreateShortCut "$SMPROGRAMS\\AiBrowser\\AiBrowser.lnk" "$INSTDIR\\AiBrowser.exe" "" "$INSTDIR\\AiBrowser.exe" 0',
    '  SectionGetFlags 1 $0',
    '  IntOp $0 $0 & ${SF_SELECTED}',
    '  StrCmp $0 ${SF_SELECTED} CreateDesktopLink RemoveDesktopLink',
    'CreateDesktopLink:',
    '  CreateShortCut "$DESKTOP\\AiBrowser.lnk" "$INSTDIR\\AiBrowser.exe" "" "$INSTDIR\\AiBrowser.exe" 0',
    '  Goto DesktopLinkDone',
    'RemoveDesktopLink:',
    '  Delete "$DESKTOP\\AiBrowser.lnk"',
    'DesktopLinkDone:',
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    '  WriteRegStr HKCU "Software\\AiBrowser" "InstallDir" "$INSTDIR"',
    `  WriteRegStr HKCU "Software\\AiBrowser" "Version" "${appVersion}"`,
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AiBrowser" "DisplayName" "AiBrowser"',
    `  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AiBrowser" "DisplayVersion" "${appVersion}"`,
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AiBrowser" "InstallLocation" "$INSTDIR"',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AiBrowser" "DisplayIcon" "$INSTDIR\\AiBrowser.exe"',
    '  WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AiBrowser" "UninstallString" \'"$INSTDIR\\Uninstall.exe"\'',
    '  StrCmp $ExistingInstall "1" 0 InstallDone',
    '  Exec \'"$INSTDIR\\AiBrowser.exe"\'',
    'InstallDone:',
    'SectionEnd',
    'Section /o "Create desktop shortcut"',
    'SectionEnd',
    'Section "Uninstall"',
    '  Delete "$SMPROGRAMS\\AiBrowser\\AiBrowser.lnk"',
    '  RMDir "$SMPROGRAMS\\AiBrowser"',
    '  Delete "$DESKTOP\\AiBrowser.lnk"',
    '  DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\AiBrowser"',
    '  DeleteRegKey HKCU "Software\\AiBrowser"',
    '  RMDir /r "$INSTDIR"',
    'SectionEnd',
    '',
  ].join('\r\n'));
  try {
    run(resolveMakeNsis(), ['/V2', script], { env: packageBuildEnvironment() });
  } catch (error) {
    removeIfExists(script);
    throw new Error(`NSIS 安装程序生成失败。请安装 NSIS 并确保 makensis 在 PATH 中：${error.message}`);
  }
  removeIfExists(script);
  if (!fs.existsSync(output)) throw new Error('NSIS 未生成 Windows 安装程序：' + output);
  console.log('Windows 安装程序：' + output);
}

function resolveMakeNsis() {
  const configured = String(process.env.OPENBROWSER_MAKENSIS || '').trim();
  const candidates = [
    configured,
    path.join(appRoot, 'tools', 'nsis', 'makensis.exe'),
    path.join(appRoot, 'tools', 'nsis', 'nsis-3.12', 'makensis.exe'),
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
  }
  return 'makensis';
}

function packageWindowsPortableExe(packageRoot) {
  const output = path.join(distRoot, `${packageArtifactStem()}-Portable.exe`);
  const script = path.join(distRoot, 'AiBrowser-Windows-portable.nsi');
  const installSource = nsisGlob(packageRoot);
  const packageIcon = nsisPath(path.join(appRoot, 'assets', 'logo.ico'));
  writeText(script, [
    '!include "MUI2.nsh"',
    `!define MUI_ICON "${packageIcon}"`,
    'Name "AiBrowser Portable"',
    'Caption "AiBrowser Portable - Extracting"',
    `OutFile "${nsisPath(output)}"`,
    `Icon "${packageIcon}"`,
    `VIProductVersion "${windowsFileVersion}"`,
    'VIAddVersionKey /LANG=1033 "ProductName" "AiBrowser Portable"',
    `VIAddVersionKey /LANG=1033 "ProductVersion" "${appVersion}"`,
    `VIAddVersionKey /LANG=1033 "FileVersion" "${appVersion}"`,
    'VIAddVersionKey /LANG=1033 "FileDescription" "AiBrowser Portable Launcher"',
    'VIAddVersionKey /LANG=1033 "LegalCopyright" "AGPL-3.0-or-later"',
    'RequestExecutionLevel user',
    'Unicode true',
    'AutoCloseWindow true',
    'ShowInstDetails nevershow',
    'SetCompressor zlib',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "English"',
    'Section',
    '  StrCpy $0 "$EXEDIR\\AiBrowser-Portable"',
    '  RMDir /r "$0\\runtime"',
    '  Delete "$0\\START.cmd"',
    '  SetOutPath "$0"',
    `  File /r "${installSource}"`,
    "  Exec '\"$0\\AiBrowser.exe\"'",
    'SectionEnd',
    '',
  ].join('\r\n'));
  try {
    run(resolveMakeNsis(), ['/V2', script], { env: packageBuildEnvironment() });
  } catch (error) {
    removeIfExists(script);
    throw new Error(`NSIS 便携版生成失败：${error.message}`);
  }
  removeIfExists(script);
  if (!fs.existsSync(output)) throw new Error('NSIS 未生成 Windows 便携版：' + output);
  console.log('单文件便携版：' + output);
}

function ensureResolvedHostDist() {
  if (!hostDist) {
    ensureHostRuntime(appRoot);
    hostDist = resolveHostDist(appRoot);
  }
  return hostDist;
}

function packageWindows() {
  const resolvedHostDist = ensureResolvedHostDist();
  const hostExe = findHostWindowsExe(resolvedHostDist);
  const packageRoot = path.join(distRoot, packageArtifactStem());

  if (process.argv.includes('--runtime-only')) {
    const runtimeRoot = packageRoot;
    const resourceApp = path.join(runtimeRoot, 'resources', 'app');
    if (!fs.existsSync(path.join(runtimeRoot, 'AiBrowser.exe'))) {
      throw new Error('Cannot update package runtime; AiBrowser.exe is missing: ' + packageRoot);
    }
    removeIfExists(path.join(runtimeRoot, 'resources', 'default_app.asar'));
    createPackagedAppBootstrap(runtimeRoot);
    copyProductionDependencies(resourceApp);
    return;
  }

  if (process.argv.includes('--bootstrap-only')) {
    if (!fs.existsSync(path.join(packageRoot, 'AiBrowser.exe'))) {
      throw new Error('Cannot update package bootstrap; AiBrowser.exe is missing: ' + packageRoot);
    }
    removeIfExists(path.join(packageRoot, 'resources', 'default_app.asar'));
    createPackagedAppBootstrap(packageRoot);
    return;
  }

  if (process.argv.includes('--artifacts-only')) {
    if (!fs.existsSync(path.join(packageRoot, 'AiBrowser.exe'))) {
      throw new Error('Cannot reuse package directory; AiBrowser.exe is missing: ' + packageRoot);
    }
    // Runtime smoke tests may have created portable state beside runtime/.
    // Distribution artifacts must always start with an empty data root.
    removeIfExists(path.join(packageRoot, 'browser-data'));
    removeIfExists(path.join(packageRoot, '.cache'));
    removeIfExists(path.join(packageRoot, 'resources', 'default_app.asar'));
    createPackagedAppBootstrap(packageRoot);
    packageWindowsZip(packageRoot);
    packageWindowsPortableExe(packageRoot);
    packageWindowsInstaller(packageRoot);
    return;
  }

  run(process.execPath, [path.join(__dirname, 'patch-windows-kernel.js')]);
  run(process.execPath, [path.join(__dirname, 'prepare-bundled-kernel.js')]);
  run(process.execPath, [path.join(__dirname, 'build-native.js'), appRoot]);

  const runtimeRoot = packageRoot;
  const resourceApp = path.join(runtimeRoot, 'resources', 'app');
  removeIfExists(packageRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  copyRecursive(resolvedHostDist, runtimeRoot);
  // Electron's unpacked developer runtime contains a fallback app. If it is
  // left beside resources/app it can launch the default shell instead of
  // AiBrowser, leaving a headless process with no portable userData.
  removeIfExists(path.join(runtimeRoot, 'resources', 'default_app.asar'));
  createPackagedAppBootstrap(runtimeRoot);

  const mainExe = path.join(runtimeRoot, 'AiBrowser.exe');
  const copiedHostExe = path.join(runtimeRoot, path.basename(hostExe));
  fs.renameSync(copiedHostExe, mainExe);
  run(process.execPath, [path.join(__dirname, 'brand-exe.mjs'), mainExe, path.join(appRoot, 'assets', 'logo.ico')]);

  copyAppResources(resourceApp);
  copyProductionDependencies(resourceApp);

  const repoRoot = path.resolve(appRoot, '..');
  for (const document of ['README.md', 'DISCLAIMER.md', 'LICENSE']) {
    const source = path.join(repoRoot, document);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageRoot, document));
  }
  const notice = path.join(appRoot, 'THIRD-PARTY-NOTICES.md');
  if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(packageRoot, 'THIRD-PARTY-NOTICES.md'));

  writeText(path.join(packageRoot, '运行说明.txt'), [
    'AiBrowser Windows 便携版',
    '',
    '1. 解压完整压缩包，不要只复制单个 EXE。',
    '2. 双击本目录的 AiBrowser.exe 启动；可直接将该 EXE 固定到任务栏。',
    '3. AiBrowser.exe 是带正式图标的桌面程序，Chromium 组件位于本目录，不需要 CMD 启动器。',
    bundleKernelVariantEnabled()
      ? '4. 本 Windows x64 包已内置独立内核（kernels/windows-x64）；运行时不再自动下载内核。默认不会回退本机浏览器，如需回退请在“本地设置”手动选择并开启。'
      : '4. 本 Windows x64 包未启用内核变体；请使用包含内置内核的正式安装包，或在“本地设置”选择自定义 Chromium。运行时不会自动下载内核。',
    '5. 环境数据、缓存、日志、崩溃转储、插件和下载内容均保存在本便携包目录内，不写入系统 AppData。',
    '6. 请勿把 Cookies、代理密码或浏览器 Profile 上传到 GitHub。',
    '',
    '本便携包不包含任何第三方商业浏览器二进制。',
    '',
  ].join('\r\n'));

  const zip = path.join(distRoot, `${packageArtifactStem()}.zip`);
  removeIfExists(zip);
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${packageRoot.replace(/'/g, "''")}' -DestinationPath '${zip.replace(/'/g, "''")}' -CompressionLevel Optimal`]);
  console.log('便携版压缩包：' + zip);
  packageWindowsPortableExe(packageRoot);
  packageWindowsInstaller(packageRoot);
  console.log('便携版目录：' + packageRoot);
}

function packageMac() {
  const resolvedHostDist = ensureResolvedHostDist();
  const hostApp = findHostAppBundle(resolvedHostDist);

  run(process.execPath, [path.join(__dirname, 'build-native.js'), appRoot]);

  const packageRoot = path.join(distRoot, packageArtifactStem());
  const appBundle = path.join(packageRoot, 'AiBrowser.app');
  const contents = path.join(appBundle, 'Contents');
  const macosDir = path.join(contents, 'MacOS');
  const resourcesDir = path.join(contents, 'Resources');
  const resourceApp = path.join(resourcesDir, 'app');

  removeIfExists(packageRoot);
  fs.mkdirSync(packageRoot, { recursive: true });
  copyRecursive(hostApp, appBundle);

  const hostBinary = findMacBinary(macosDir);
  const appBinary = path.join(macosDir, 'AiBrowser');
  if (path.basename(hostBinary) !== 'AiBrowser' && fs.existsSync(hostBinary)) {
    fs.renameSync(hostBinary, appBinary);
  }

  const infoPlist = path.join(contents, 'Info.plist');
  if (fs.existsSync(infoPlist)) {
    let plist = fs.readFileSync(infoPlist, 'utf8');
    plist = plist
      .replace(/<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleDisplayName</key>\n\t<string>AiBrowser</string>')
      .replace(/<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleName</key>\n\t<string>AiBrowser</string>')
      .replace(/<key>CFBundleExecutable<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleExecutable</key>\n\t<string>AiBrowser</string>')
      .replace(/<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIdentifier</key>\n\t<string>com.aibrowser.app</string>')
      .replace(/<key>CFBundleIconFile<\/key>\s*<string>[^<]*<\/string>/, '<key>CFBundleIconFile</key>\n\t<string>logo</string>');
    if (!plist.includes('CFBundleIconFile')) {
      plist = plist.replace('</dict>\n</plist>', '\t<key>CFBundleIconFile</key>\n\t<string>logo</string>\n</dict>\n</plist>');
    }
    fs.writeFileSync(infoPlist, plist, 'utf8');
  }
  // App icon for Dock / Finder
  const icnsSrc = path.join(appRoot, 'assets', 'logo.icns');
  if (fs.existsSync(icnsSrc)) {
    fs.copyFileSync(icnsSrc, path.join(resourcesDir, 'logo.icns'));
    for (const name of fs.readdirSync(resourcesDir)) {
      if (name.endsWith('.icns') && name !== 'logo.icns') {
        fs.copyFileSync(icnsSrc, path.join(resourcesDir, name));
      }
    }
  }

  removeIfExists(resourceApp);
  copyAppResources(resourceApp);

  const repoRoot = path.resolve(appRoot, '..');
  for (const document of ['README.md', 'DISCLAIMER.md', 'LICENSE']) {
    const source = path.join(repoRoot, document);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(packageRoot, document));
  }
  const notice = path.join(appRoot, 'THIRD-PARTY-NOTICES.md');
  if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(packageRoot, 'THIRD-PARTY-NOTICES.md'));

  writeText(path.join(packageRoot, '启动.command'), [
    '#!/bin/bash',
    'cd "$(dirname "$0")"',
    'open "./AiBrowser.app"',
    '',
  ].join('\n'));
  fs.chmodSync(path.join(packageRoot, '启动.command'), 0o755);
  if (fs.existsSync(appBinary)) fs.chmodSync(appBinary, 0o755);

  const kernelNote = packageArch === 'x86_64'
    ? '3. 本包（macOS x86_64 / Intel）已内置 AiBrowser 148 独立内核（kernels/macos-x64）；运行时不再自动下载内核。'
    : bundleKernelVariantEnabled()
      ? '3. 本包（macOS arm64）已内置独立内核（kernels/macos-arm64）；运行时不再自动下载内核。'
      : '3. 本包（macOS arm64）未启用内核变体；请使用包含内置内核的正式安装包，或在“本地设置”选择自定义 Chromium。运行时不会自动下载内核。';
  writeText(path.join(packageRoot, '运行说明.txt'), [
    'AiBrowser macOS 版（' + packageArch + '）',
    '',
    '1. 双击“启动.command”，或直接打开“AiBrowser.app”。',
    '2. 首次打开若被 Gatekeeper 拦截，请到“系统设置 > 隐私与安全性”允许运行，或执行：',
    '   xattr -dr com.apple.quarantine "AiBrowser.app"',
    kernelNote,
    '4. 默认不会自动回退到本机浏览器；如需回退，请在“本地设置”手动选择浏览器并开启。',
    '5. 环境数据默认保存在 ~/Library/Application Support/aibrowser。',
    '6. 窗口同步在 macOS 使用 CDP 页面同步 + 全局快捷键；Chrome 原生 UI（地址栏/标签栏）的原生输入镜像仅 Windows 可用。',
    '7. 请勿把 Cookies、代理密码或浏览器 Profile 上传到 GitHub。',
    '',
  ].join('\n'));

  const dmg = path.join(distRoot, `${packageArtifactStem()}.dmg`);
  removeIfExists(dmg);
  const dmgFormat = String(process.env.OPENBROWSER_MAC_DMG_FORMAT || 'UDZO').trim().toUpperCase();
  if (!['UDZO', 'ULMO'].includes(dmgFormat)) {
    throw new Error(`Unsupported macOS DMG format: ${dmgFormat}`);
  }
  run('hdiutil', ['create', '-volname', 'AiBrowser', '-srcfolder', packageRoot, '-ov', '-format', dmgFormat, dmg]);
  console.log('macOS 安装映像：' + dmg);
  console.log('macOS 打包目录：' + packageRoot);
  console.log('主机：' + os.platform() + ' ' + os.arch());
}

if (process.platform === 'win32') packageWindows();
else if (process.platform === 'darwin') packageMac();
else {
  console.error('当前平台暂不支持 package:portable：' + process.platform);
  process.exit(1);
}
