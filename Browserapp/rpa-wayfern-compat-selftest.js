'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');
const { BrowserEngine } = require('./engine');
const { RpaEngine } = require('./automation/rpa-engine');
const { RpaStore } = require('./automation/rpa-store');
const cdp = require('./cdp');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const portableDataRoot = path.resolve(__dirname, '..', 'browser-data');
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aibrowser-rpa-wayfern-'));
  const profileDataRoot = path.join(testRoot, 'profiles');
  const profileId = `rpa-compat-${process.pid}`;
  const app = {
    getPath(name) {
      if (name === 'userData') return portableDataRoot;
      throw new Error('Unsupported app path: ' + name);
    },
  };
  const engine = new BrowserEngine(app, { profileDataRoot });
  const store = new RpaStore(path.join(testRoot, 'rpa-store.json'));
  let fixtureServer = null;
  try {
    fixtureServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>birth-fixture</title>
        <form id="birth-form">
          <button type="button" role="combobox" name="BirthMonth" value="">month</button>
          <button type="button" role="combobox" name="BirthDay" value="">day</button>
          <input name="BirthYear" type="number">
          <button type="submit">submit</button>
        </form><div id="portal"></div>
        <script>
          function attach(name, count) {
            const button = document.querySelector('button[name="' + name + '"]');
            button.addEventListener('click', () => {
              const portal = document.getElementById('portal');
              portal.replaceChildren();
              const list = document.createElement('div');
              list.id = name + '-listbox';
              list.setAttribute('role', 'listbox');
              button.setAttribute('aria-controls', list.id);
              for (let index = 1; index <= count; index += 1) {
                const option = document.createElement('button');
                option.type = 'button';
                option.setAttribute('role', 'option');
                option.textContent = String(index);
                option.addEventListener('click', () => {
                  button.value = String(index);
                  button.setAttribute('value', String(index));
                  button.textContent = String(index);
                  portal.replaceChildren();
                });
                list.appendChild(option);
              }
              portal.appendChild(list);
            });
          }
          attach('BirthMonth', 12);
          attach('BirthDay', 31);
          document.getElementById('birth-form').addEventListener('submit', (event) => {
            event.preventDefault();
            const month = document.querySelector('[name="BirthMonth"]').value;
            const day = document.querySelector('[name="BirthDay"]').value;
            const year = document.querySelector('[name="BirthYear"]').value;
            location.hash = 'birth=' + month + '-' + day + '-' + year;
          });
        </script>`);
    });
    await new Promise((resolve, reject) => {
      fixtureServer.once('error', reject);
      fixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/`;

    await engine.init(null);
    await store.load();
    const bundledExtension = await engine.readExtension(path.join(__dirname, 'bundled-extension'), true);
    engine.extensions.set(bundledExtension.id, bundledExtension);
    const profile = engine.sanitizeProfile({
      id: profileId,
      number: 999,
      name: 'RPA Wayfern compatibility selftest',
      browser: 'Google Chrome',
      networkMode: 'direct',
      proxy: 'Direct',
      advanced: { tabMode: 'new', restoreSession: false },
    });
    engine.profiles.set(profile.id, profile);
    engine.assignments.set(profile.id, new Set([bundledExtension.id]));
    const running = await engine.start(profile);
    assert.ok(running.port, 'temporary Wayfern environment has a CDP port');

    const task = await store.createTask({
      profile_id: profile.id,
      process_name: 'Wayfern CSS input/click compatibility',
      variables: { birth_month: 3, birth_day: 12, birth_year: 1994 },
      steps: [
        { type: 'gotoUrl', url: fixtureUrl },
        { type: 'waitTime', timeout: 800 },
        { type: 'click', selector: 'button[name="BirthMonth"]' },
        {
          type: 'forTimes', times: '${birth_month}',
          children: [{ type: 'keyboard', key: 'ArrowDown' }],
        },
        { type: 'keyboard', key: 'Enter' },
        { type: 'click', selector: 'button[name="BirthDay"]' },
        {
          type: 'forTimes', times: '${birth_day}',
          children: [{ type: 'keyboard', key: 'ArrowDown' }],
        },
        { type: 'keyboard', key: 'Enter' },
        { type: 'inputContent', selector: 'input[name="BirthYear"]', content: '${birth_year}', isClear: true },
        { type: 'click', selector: 'button[type="submit"]' },
        { type: 'waitTime', timeout: 400 },
      ],
    });
    const rpa = new RpaEngine({ engine, store, userDataPath: testRoot });
    const result = await rpa.runTask(task.id);
    assert.strictEqual(result.success, true, JSON.stringify(result));
    await wait(500);
    const pages = (await cdp.tabs(running.port)).filter((tab) => tab.type === 'page');
    const birthPage = pages.find((tab) => /#birth=3-12-1994$/.test(String(tab.url || '')));
    assert.ok(birthPage, 'Fluent-style month/day dropdown options were selected through the Wayfern bridge');
    const resultUrl = String(running.url || birthPage.url || '');
    console.log(JSON.stringify({ success: true, steps: task.steps.length, resultUrl, birthUrl: birthPage.url, kernel: running.executable }, null, 2));
  } finally {
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    await engine.stopAll().catch(() => {});
    await engine.startPageServer?.stop?.().catch(() => {});
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.join(portableDataRoot, 'env-markers', profileId), { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
