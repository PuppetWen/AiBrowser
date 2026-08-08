'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');
const cdp = require('./cdp');
const { RpaEngine } = require('./automation/rpa-engine');
const { RpaStore } = require('./automation/rpa-store');

async function main() {
  const work = path.join(__dirname, 'rpa-output', '.marketplace-selftest-' + process.pid);
  await fs.mkdir(work, { recursive: true });
  try {
    const store = new RpaStore(path.join(work, 'rpa-store.json'));
    await store.load();
    const installed = await store.installTemplate('catalog-83');
    assert(installed.plan.variable_definitions.some((item) => item.key === 'outlookPath'));
    assert.strictEqual(installed.plan.variables.outlookPath, '');
    const keyboardTypes = [];
    const collectKeyboardTypes = (steps) => {
      for (const step of steps || []) {
        if (step.type === 'keyboard') keyboardTypes.push(step.params?.type || step.params?.key || '');
        collectKeyboardTypes(step.children);
        collectKeyboardTypes(step.elseChildren);
      }
    };
    collectKeyboardTypes(installed.plan.steps);
    assert(keyboardTypes.includes('ArrowDown'));
    assert(keyboardTypes.includes('Enter'));

    const flattened = [];
    const collectSteps = (steps) => {
      for (const step of steps || []) {
        flattened.push(step);
        collectSteps(step.children);
        collectSteps(step.elseChildren);
      }
    };
    collectSteps(installed.plan.steps);
    const firstNameStep = flattened.find((step) => String(step.params?.selector || '').includes('firstNameInput'));
    const lastNameStep = flattened.find((step) => String(step.params?.selector || '').includes('lastNameInput'));
    const birthYearStep = flattened.find((step) => /BirthYear/.test(String(step.params?.selector || '')));
    const primaryButtonSteps = flattened.filter((step) => String(step.params?.selector || '').includes('primaryButton'));
    const emailStep = flattened.find((step) => step.type === 'inputContent' && String(step.params?.selector || '').includes('input[name="email"]'));
    const passwordStep = flattened.find((step) => step.type === 'inputContent' && String(step.params?.selector || '').includes('input[name="newPassword"]'));
    assert(firstNameStep.params.selector.includes('autocomplete="given-name"'));
    assert.strictEqual(firstNameStep.params.randomContent, '${first_name}');
    assert(lastNameStep.params.selector.includes('autocomplete="family-name"'));
    assert.strictEqual(lastNameStep.params.randomContent, '${last_name}');
    assert.strictEqual(birthYearStep.params.isClear, '1');
    assert(primaryButtonSteps.length >= 2, 'legacy #nextButton selectors should support Microsoft Fluent UI');
    assert.strictEqual(emailStep.params.isClear, '1');
    assert.strictEqual(passwordStep.params.isClear, '1');
    const pacingSteps = flattened.filter((step) => step.params?.aibrowserPacing === true);
    assert(pacingSteps.length >= 5, 'Microsoft signup inputs should have explicit pacing waits');
    assert(pacingSteps.every((step) => step.params.timeoutMin === 1200 && step.params.timeoutMax === 3200));

    const engine = new RpaEngine({ store, engine: {} });
    assert.throws(
      () => engine.validateRequiredPlanVariables(installed.plan, installed.plan.variables),
      /outlookPath/
    );
    assert.strictEqual(engine.evaluateCondition({ condition: ['missingValue'], relation: 'notExist' }, {}), true);
    assert.strictEqual(engine.evaluateCondition({ condition: ['ready'], relation: 'exist' }, { ready: { selector: '#x' } }), true);

    const workbookPath = path.join(work, 'accounts.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('accounts');
    sheet.addRow(['outlook_name', 'outlook_password', 'outlook_birth', 'first_name', 'last_name']);
    sheet.addRow(['aibrowser-test', 'not-a-real-password', '2000-01-02', 'Test', 'User']);
    await workbook.xlsx.writeFile(workbookPath);
    const context = { variables: { outlookPath: workbookPath }, remarks: [], log: async () => {} };
    await engine.executeStep(0, {
      type: 'useExcel',
      params: { path: '${outlookPath}', variable: 'rows' },
    }, context);
    assert.strictEqual(context.variables.rows.length, 1);
    assert.strictEqual(context.variables.outlook_name, 'aibrowser-test');
    context.variables.outlook_birth = '2000/01/02';
    await engine.executeStep(0, {
      type: 'javaScript',
      params: {
        params: ['outlook_birth'],
        content: 'const parts=outlook_birth.split("/"); return {year:Number(parts[0]),month:Number(parts[1]),day:Number(parts[2])};',
        variable: 'birth',
      },
    }, context);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(context.variables.birth)),
      { year: 2000, month: 1, day: 2 }
    );
    context.variables.birth_arr_js = context.variables.birth;
    await engine.executeStep(0, {
      type: 'toJson',
      params: { content: 'birth_arr_js', variable: 'birth_arr' },
    }, context);
    await engine.executeStep(0, {
      type: 'extractKey',
      params: { content: 'birth_arr', key: 'year', variable: 'birth_year' },
    }, context);
    assert.strictEqual(context.variables.birth_year, 2000);

    const originalWithPage = engine.withPage.bind(engine);
    const originalBridge = engine.selectorBridgeAction.bind(engine);
    engine.withPage = async (_port, action) => action('ws://selftest');
    engine.selectorBridgeAction = async (_ws, payload) => ({
      handled: true,
      success: payload.action === 'selectOption' && payload.optionIndex === 3,
    });
    const birthContext = { variables: { birth_month: 3 }, remarks: [], log: async () => {} };
    await engine.executeStep(1, {
      type: 'click',
      params: { selector: 'button[name="BirthMonth"]', selectorRadio: 'CSS' },
    }, birthContext);
    await engine.executeStep(1, {
      type: 'forTimes',
      params: { times: '${birth_month}' },
      children: [{ type: 'unsupported-test-step' }],
    }, birthContext);
    await engine.executeStep(1, { type: 'keyboard', params: { type: 'Enter' } }, birthContext);
    assert.strictEqual(birthContext.variables.__aibrowserSkipBirthEnter, 0);
    engine.withPage = originalWithPage;
    engine.selectorBridgeAction = originalBridge;

    const originalTabs = cdp.tabs;
    try {
      cdp.tabs = async () => [{
        url: 'https://signup.live.com/signup?lic=1',
        webSocketDebuggerUrl: 'ws://selftest',
      }];
      engine.selectorBridgeAction = async (_ws, payload) => ({
        handled: true,
        success: payload.action === 'click' && payload.selector.includes('primaryButton'),
      });
      assert.strictEqual(await engine.acceptMicrosoftConsentGate(1), true);
      cdp.tabs = async () => [{
        url: 'https://example.com/?lic=1',
        webSocketDebuggerUrl: 'ws://selftest',
      }];
      assert.strictEqual(await engine.acceptMicrosoftConsentGate(1), false);
    } finally {
      cdp.tabs = originalTabs;
    }

    console.log('rpa-marketplace-flow-selftest: ok');
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
