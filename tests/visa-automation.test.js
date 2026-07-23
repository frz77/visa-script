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
  const requests = [];
  const sandbox = {
    console,
    clearInterval() {},
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    GM_xmlhttpRequest(options) {
      requests.push(options);
    },
    document: {
      body: {},
      querySelector() { return null; },
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
    requests,
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

  test(`${userscriptPath}: service selection must be a visible usable form`, () => {
    const { VisaAutomationUI, document } = loadUserscript(userscriptPath);
    const bot = Object.create(VisaAutomationUI.prototype);
    const label = text => ({ textContent: text, isConnected: true, offsetParent: {} });
    const select = { isConnected: true, offsetParent: {}, getAttribute: () => 'false' };
    const form = {
      isConnected: true,
      offsetParent: null,
      querySelectorAll(selector) {
        if (selector === 'mat-label') return [label('Rodzaj usługi'), label('Lokalizacja')];
        if (selector === 'mat-select') return [select, select];
        return [];
      },
    };
    document.querySelectorAll = () => [form];

    assert.equal(bot.getServiceSelectionForm(), null);
    form.offsetParent = {};
    assert.equal(bot.getServiceSelectionForm(), form);
  });

  test(`${userscriptPath}: CAPTCHA feedback waits for the real service form`, () => {
    const { VisaAutomationUI, document, requests, storage, timers } = loadUserscript(userscriptPath);
    const sample = {
      image: 'data:image/png;base64,old',
      predicted: 'aB12',
      actual: 'aB12',
      submittedAt: Date.now(),
    };
    let visibleCaptcha = null;
    storage.set('visaPendingCaptchaFeedback', JSON.stringify(sample));
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      findVisibleCaptchaImage: () => visibleCaptcha,
      getServiceSelectionForm: () => null,
      isElementVisible: element => Boolean(element?.visible),
      log() {},
      captchaSuccessCandidateKey: null,
      captchaSuccessCandidateTimer: null,
      reportedCaptchaSources: new Set(),
    });
    bot.confirmCaptchaFeedbackIfSuccessful();
    assert.equal(requests.length, 0);
    assert.equal(storage.has('visaPendingCaptchaFeedback'), true);

    bot.getServiceSelectionForm = () => ({ visible: true });
    bot.confirmCaptchaFeedbackIfSuccessful();
    const transientTimer = timers.at(-1);
    assert.equal(transientTimer.milliseconds, 800);

    visibleCaptcha = { visible: true, src: 'data:image/png;base64,new' };
    bot.confirmCaptchaFeedbackIfSuccessful();
    assert.equal(transientTimer.cancelled, true);
    assert.equal(storage.has('visaPendingCaptchaFeedback'), false);

    storage.set('visaPendingCaptchaFeedback', JSON.stringify(sample));
    visibleCaptcha = null;
    bot.confirmCaptchaFeedbackIfSuccessful();
    assert.equal(requests.length, 0);
    assert.equal(timers.at(-1).milliseconds, 800);
    timers.at(-1).callback();
    assert.equal(requests.length, 1);
    requests[0].onload({ status: 200 });
    assert.equal(storage.has('visaPendingCaptchaFeedback'), false);
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
