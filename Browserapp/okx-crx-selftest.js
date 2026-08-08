const fs = require('fs/promises');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { addChromeStoreExtension, crxDetails } = require('./store-extension');
const { BrowserEngine } = require('./engine');
const { ensureKernelReadyForLaunch } = require('./automation/browser-kernel');

function run(file, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, env });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (value) => { stdout += value; });
    child.stderr?.on('data', (value) => { stderr += value; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`CRX pack exited ${code}: ${stderr || stdout}`)));
  });
}

async function main() {
  const root = path.join(__dirname, '..', 'okx-crx-selftest-data');
  const fixtureRoot = path.join(__dirname, '..', 'okx-crx-fixture-data');
  const source = path.join(fixtureRoot, 'okx-wallet-import-probe');
  const crxFile = source + '.crx';
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  try {
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'OKX Wallet CRX Import Probe', version: '1.0.0', action: {} }, null, 2));
    const engine = new BrowserEngine({ getPath: () => fixtureRoot });
    const browser = engine.chooseBrowser();
    await ensureKernelReadyForLaunch({ path: browser.path }, '', { userDataPath: fixtureRoot });
    const portableTemp = path.join(fixtureRoot, 'cache', 'temp');
    const portableAppData = process.platform === 'win32' ? path.join(portableTemp, 'AppData', 'Roaming') : path.join(fixtureRoot, 'wayfern-appdata');
    await run(browser.path, [`--pack-extension=${source}`, '--no-message-box'], { ...process.env, APPDATA: portableAppData, TEMP: portableTemp, TMP: portableTemp });
    await fs.access(crxFile);
    const crx = await fs.readFile(crxFile);
    const signedStoreId = crxDetails(crx).extensionId;
    let mismatchRejected = false;
    try {
      await addChromeStoreExtension('https://chromewebstore.google.com/detail/okx-wallet/mcohilncbfahbmgdjkbpemcciiolgcge', root, async () => ({}), () => crx);
    } catch (error) {
      mismatchRejected = /签名 ID.+与商店 ID.+不一致/.test(String(error?.message || error));
    }
    assert(mismatchRejected, 'CRX signed by a non-OKX key must be rejected for the OKX store ID');
    const extension = await addChromeStoreExtension(`https://chromewebstore.google.com/detail/crx-import-probe/${signedStoreId}`, root, async (directory) => { const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); return { id: 'temporary', name: manifest.name, version: manifest.version, path: directory, manifestVersion: manifest.manifest_version }; }, () => crx);
    const manifest = JSON.parse(await fs.readFile(path.join(extension.path, 'manifest.json'), 'utf8'));
    process.stdout.write(JSON.stringify({ success: true, fixture: 'project-local CRX3', okxStoreId: 'mcohilncbfahbmgdjkbpemcciiolgcge', signedStoreId, mismatchRejected, installedStoreId: extension.storeId, name: manifest.name, version: manifest.version, manifestVersion: manifest.manifest_version, files: (await fs.readdir(extension.path)).length }, null, 2));
  } finally { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); await fs.rm(fixtureRoot, { recursive: true, force: true }).catch(() => {}); }
}
main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
