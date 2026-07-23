const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadUserscript(relativePath) {
  const sourcePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const exposed = source.replace(
    /\n\s*initVisa\(\);\s*\n\}\)\(\);\s*$/,
    '\n  globalThis.VisaAutomationUI = VisaAutomationUI;\n})();',
  );
  assert.notEqual(exposed, source, `Could not expose VisaAutomationUI from ${relativePath}`);

  const values = new Map();
  const timers = [];
  const sandbox = {
    console,
    clearInterval() {},
    clearTimeout() {},
    document: {
      body: {},
      querySelectorAll() { return []; },
    },
    sessionStorage: {
      getItem(key) { return values.has(key) ? values.get(key) : null; },
      removeItem(key) { values.delete(key); },
      setItem(key, value) { values.set(key, String(value)); },
    },
    setInterval() { return 1; },
    setTimeout(callback, milliseconds) {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    window: {},
  };
  vm.runInNewContext(exposed, sandbox, { filename: sourcePath });
  return {
    VisaAutomationUI: sandbox.VisaAutomationUI,
    document: sandbox.document,
    storage: values,
    timers,
  };
}

for (const userscriptPath of ['script.js']) {
  test(`${userscriptPath}: detects the exact fully-booked message`, () => {
    const { VisaAutomationUI, document } = loadUserscript(userscriptPath);
    const bot = Object.create(VisaAutomationUI.prototype);
    assert.equal(
      bot.isNoSlotsOrLoadError(
        'Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym.',
      ),
      true,
    );
    assert.equal(bot.isNoSlotsOrLoadError('Wybierz termin wizyty'), false);

    const message = 'Chwilowo wszystkie udostępnione terminy zostały zarezerwowane, prosimy spróbować umówić wizytę w terminie późniejszym.';
    const botLogNode = {
      nodeValue: message,
      parentElement: {
        closest: selector => selector === '#visa-automation-panel' ? {} : null,
        offsetParent: {},
      },
    };
    let nodes = [botLogNode];
    document.createTreeWalker = () => ({
      nextNode: () => nodes.shift() || null,
    });
    assert.equal(bot.findReservationError(), null);

    nodes = [{
      nodeValue: message,
      parentElement: {
        closest: () => null,
        offsetParent: {},
      },
    }];
    assert.match(bot.findReservationError(), /Chwilowo wszystkie/);
  });

  test(`${userscriptPath}: Ctrl+Shift+X latch blocks restart until a fresh start`, () => {
    const { VisaAutomationUI, storage, timers } = loadUserscript(userscriptPath);
    const messages = [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      captchaReloadTimer: null,
      log: message => messages.push(message),
      manuallyStopped: false,
      preset: { rodzajUslugi: 'test' },
      restartPending: false,
      restartSourceForm: null,
      restartWatchdogTimer: null,
      retryTimer: null,
      stopWaiting: false,
    });

    bot.stopAutomation('stop', true);
    bot.restartAutomationCycle('manual Z');

    assert.equal(bot.automationEnabled, false);
    assert.equal(bot.manuallyStopped, true);
    assert.equal(bot.retryTimer, null);
    assert.equal(storage.get('visaAutomationManuallyStopped'), 'true');
    assert.equal(timers.length, 0);
    assert.match(messages.at(-1), /Ctrl\+Shift\+Z.*игнорируется/);

    let resumed = 0;
    bot.armSuccessSound = () => {};
    bot.resumeAutomation = () => { resumed += 1; };
    bot.startAutomation();
    assert.equal(bot.automationEnabled, true);
    assert.equal(bot.manuallyStopped, false);
    assert.equal(storage.has('visaAutomationManuallyStopped'), false);
    assert.equal(resumed, 1);
  });

  test(`${userscriptPath}: manual stop blocks delayed CAPTCHA submission`, async () => {
    const { VisaAutomationUI } = loadUserscript(userscriptPath);
    let staged = 0;
    const messages = [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      log: message => messages.push(message),
      manuallyStopped: true,
      stageCaptchaFeedback: () => { staged += 1; },
    });
    await bot.submitCaptcha();
    assert.equal(staged, 0);
    assert.match(messages[0], /отменена/);
  });

  test(`${userscriptPath}: active no-slot retry schedules a new cycle`, () => {
    const { VisaAutomationUI, timers } = loadUserscript(userscriptPath);
    let clicked = 0;
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      captchaCandidateSince: 10,
      captchaCandidateSource: 'old',
      clickWizaKrajowa: () => {
        clicked += 1;
        return true;
      },
      getServiceSelectionForm: () => null,
      log() {},
      manuallyStopped: false,
      preset: { rodzajUslugi: 'test' },
      restartPending: false,
      restartSourceForm: null,
      restartWatchdogTimer: null,
      retryTimer: null,
      stopWaiting: false,
    });

    bot.restartAutomationCycle('no slots');
    assert.equal(timers[0].milliseconds, 1100);
    timers[0].callback();
    assert.equal(clicked, 1);
  });

  test(`${userscriptPath}: missing Wiza link retries without manual Z`, () => {
    const { VisaAutomationUI, timers } = loadUserscript(userscriptPath);
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      captchaCandidateSince: 10,
      captchaCandidateSource: 'old',
      clickWizaKrajowa: () => false,
      getServiceSelectionForm: () => null,
      log() {},
      manuallyStopped: false,
      preset: { rodzajUslugi: 'test' },
      restartPending: false,
      restartSourceForm: null,
      restartWatchdogTimer: null,
      retryTimer: null,
      stopWaiting: false,
    });

    bot.restartAutomationCycle('no slots');
    timers[0].callback();
    assert.equal(timers.length, 2);
    assert.equal(timers[1].milliseconds, 1100);
  });
}
