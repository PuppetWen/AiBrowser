const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const { BrowserEngine } = require('./engine');
const { LiveSyncController } = require('./live-sync-v5');

function run(file, args, attempt = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) return resolve(stdout);
      if (code === 4 && attempt < 1) return setTimeout(() => run(file, args, attempt + 1).then(resolve, reject), 400);
      reject(new Error(`driver exited ${code}: ${stdout}\n${stderr}`));
    });
  });
}

async function main() {
  const root = path.join(__dirname, '..', 'native-omnibox-selftest-data');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const engine = new BrowserEngine({ getPath: (name) => name === 'userData' ? root : '' });
  const profiles = Array.from({ length: 4 }, (_, index) => ({
    id: index === 0 ? 'omnibox-master' : 'omnibox-slave-' + index,
    name: index === 0 ? 'Omnibox Master' : 'Omnibox Slave ' + index,
    browser: 'Google Chrome', proxy: 'Direct',
  }));
  let sync; const events = [];
  try {
    await engine.init(null); engine.syncProfiles(profiles);
    const sessions = [];
    for (const profile of profiles) sessions.push(await engine.start(profile));
    const master = sessions[0];
    sync = new LiveSyncController(engine, (event) => events.push(event));
    const started = await sync.start(profiles.map((profile) => profile.id));
    if (!started.nativeReady && !await sync.waitForNativeReady(5000)) throw new Error('native omnibox input bridge did not become ready');
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!sync.nativeInputMirror || sync.nativeInputMirror.exitCode !== null) throw new Error('input bridge not running: ' + JSON.stringify({ exitCode: sync.nativeInputMirror?.exitCode, events }));
    const expected = ['first-copy-1111', 'second-paste-2222'];
    const outputs = [];
    for (const text of expected) {
      outputs.push((await run(path.join(__dirname, 'native-omnibox-driver.exe'), [String(master.pid), text, ...sessions.slice(1).map((session) => String(session.pid))])).trim().split(/\r?\n/));
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.stdout.write(JSON.stringify({ success: true, expected, runs: outputs }, null, 2));
  } finally {
    await (sync?.stop?.() ?? Promise.resolve());
    await engine.stopAll().catch(() => {}); await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });
