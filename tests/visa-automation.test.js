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
  const observers = [];
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    disconnect() {}
    observe() {}
  }
  const sandbox = {
    console,
    clearInterval() {},
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    GM_xmlhttpRequest(options) {
      requests.push(options);
    },
    MutationObserver,
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
    observers,
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
    assert.equal(bot.isNoSlotsOrLoadError('Błąd komunikacji z serwerem'), true);
    assert.equal(bot.isNoSlotsOrLoadError('Wybrany termin jest już niedostępny'), true);
    assert.equal(bot.isNoSlotsOrLoadError('Termin nie jest już dostępny. Wybierz inny termin.'), true);
    assert.equal(bot.isNoSlotsOrLoadError('Termin został zarezerwowany'), false);

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

    nodes = [{
      nodeValue: 'Błąd komunikacji z serwerem',
      parentElement: {
        closest: () => null,
        offsetParent: {},
      },
    }];
    assert.equal(bot.findReservationError(), 'Błąd komunikacji z serwerem');

    nodes = [{
      nodeValue: 'Termin nie jest już dostępny. Wybierz inny termin.',
      parentElement: {
        closest: () => null,
        offsetParent: {},
      },
    }];
    assert.equal(bot.findReservationError(), 'Wybrany termin jest już niedostępny');
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

  test(`${userscriptPath}: post-reservation success requires a usable follow-up form`, () => {
    const { VisaAutomationUI, document } = loadUserscript(userscriptPath);
    const input = {
      disabled: false,
      getAttribute: () => null,
      isConnected: true,
      offsetParent: {},
    };
    let fields = [];
    const form = {
      closest: () => null,
      isConnected: true,
      offsetParent: {},
      querySelectorAll(selector) {
        if (selector.includes('Weryfikacja')) return [];
        if (selector.includes('input:not')) return fields;
        return [];
      },
    };
    document.querySelectorAll = selector => selector === 'form' ? [form] : [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      getServiceSelectionForm: () => null,
    });

    assert.equal(bot.getPostReservationForm(), null);
    fields = [input];
    assert.equal(bot.getPostReservationForm(), form);
  });

  test(`${userscriptPath}: panel logs use one persisted tab session`, () => {
    const { VisaAutomationUI, requests, storage } = loadUserscript(userscriptPath);
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      logRelayRetryAfter: 0,
    });
    const sessionId = bot.getOrCreateLogSessionId();
    assert.match(sessionId, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[a-z0-9]{6}$/);
    assert.equal(bot.getOrCreateLogSessionId(), sessionId);
    assert.equal(storage.get('visaLogSessionId'), sessionId);
    assert.equal(storage.get('visaLogFormatVersion'), 'compact-v1');

    bot.logSessionId = sessionId;
    bot.persistLogEntry(new Date('2026-08-21T17:35:51.000Z'), '19:35:51', 'Шаг 4/4: Выбор даты...');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:3210/log');
    const body = JSON.parse(requests[0].data);
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.displayTime, '19:35:51');
    assert.equal(body.message, 'Шаг 4/4: Выбор даты...');
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
      captchaReloadPending: false,
      captchaStabilityTimer: null,
      domWaiters: new Set(),
      log: message => messages.push(message),
      manuallyStopped: false,
      preset: { rodzajUslugi: 'test' },
      restartPending: false,
      restartSourceForm: null,
      restartWatchdogTimer: null,
      restartAttemptInFlight: false,
      stopWaiting: false,
    });

    bot.stopAutomation('stop', true);
    bot.restartAutomationCycle('manual Z');

    assert.equal(bot.automationEnabled, false);
    assert.equal(bot.manuallyStopped, true);
    assert.equal(bot.restartAttemptInFlight, false);
    assert.equal(storage.get('visaAutomationManuallyStopped'), 'true');
    assert.equal(timers.length, 0);
    assert.equal(messages.at(-1), 'cycle.restart_ignored reason=stopped');

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
    assert.equal(messages[0], 'submit.cancelled reason=stopped');
  });

  test(`${userscriptPath}: CAPTCHA Dalej clicks as soon as the enabled button exists`, async () => {
    const { VisaAutomationUI, document, timers } = loadUserscript(userscriptPath);
    let clicked = 0;
    let staged = 0;
    const button = {
      disabled: false,
      getAttribute: () => null,
      isConnected: true,
      offsetParent: {},
      textContent: 'Dalej',
      click: () => { clicked += 1; },
    };
    document.querySelectorAll = selector => selector === 'button[mat-button]' ? [button] : [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      domWaiters: new Set(),
      isElementVisible: element => Boolean(element?.offsetParent),
      log() {},
      manuallyStopped: false,
      stageCaptchaFeedback: () => { staged += 1; },
    });

    await bot.submitCaptcha();
    assert.equal(clicked, 1);
    assert.equal(staged, 1);
    assert.equal(timers.every(timer => timer.cancelled), true);
  });

  test(`${userscriptPath}: server communication error rejects a picked Termin`, async () => {
    const { VisaAutomationUI, document } = loadUserscript(userscriptPath);
    let communicationError = null;
    let clicked = 0;
    const form = { isConnected: true, offsetParent: {} };
    const termin = { isConnected: true, offsetParent: {} };
    const button = {
      disabled: false,
      getAttribute: () => null,
      isConnected: true,
      offsetParent: {},
      textContent: 'Dalej',
      click() {
        clicked += 1;
        communicationError = 'Błąd komunikacji z serwerem';
      },
    };
    document.querySelectorAll = selector => selector === 'button[mat-button]' ? [button] : [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      domWaiters: new Set(),
      findReservationError: () => communicationError,
      getServiceSelectionForm: () => form,
      isElementVisible: element => Boolean(element?.offsetParent),
      log() {},
      manuallyStopped: false,
      retryMode: 'interval',
      stopWaiting: false,
    });

    await assert.rejects(
      () => bot.clickDalejButton(termin),
      /Termin не подтверждён сервером: Błąd komunikacji z serwerem/,
    );
    assert.equal(clicked, 1);
    assert.equal(bot.automationEnabled, true);
  });

  test(`${userscriptPath}: automated restart confirms the cancellation dialog with Tak`, () => {
    const { VisaAutomationUI, document } = loadUserscript(userscriptPath);
    let noClicks = 0;
    let yesClicks = 0;
    const button = (textContent, click) => ({
      disabled: false,
      getAttribute: () => null,
      isConnected: true,
      offsetParent: {},
      textContent,
      click,
    });
    const noButton = button('Nie', () => { noClicks += 1; });
    const yesButton = button('Tak', () => { yesClicks += 1; });
    const dialog = {
      isConnected: true,
      offsetParent: {},
      textContent: 'Czy na pewno chcesz anulować uzupełnianie formularza? Niezapisane dane zostaną usunięte.',
      querySelectorAll: () => [noButton, yesButton],
    };
    document.querySelectorAll = selector => selector.includes('mat-dialog-container') ? [dialog] : [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      log() {},
      manuallyStopped: false,
      restartConfirmationPending: true,
    });

    assert.equal(bot.confirmRestartDialogIfPresent(), true);
    assert.equal(noClicks, 0);
    assert.equal(yesClicks, 1);
    assert.equal(bot.restartConfirmationPending, false);

    bot.manuallyStopped = true;
    bot.restartConfirmationPending = true;
    assert.equal(bot.confirmRestartDialogIfPresent(), false);
    assert.equal(yesClicks, 1);
  });

  test(`${userscriptPath}: select advances on applied DOM state, not a fixed wait`, async () => {
    const { VisaAutomationUI, document, observers, timers } = loadUserscript(userscriptPath);
    let expanded = false;
    const matSelect = {
      disabled: false,
      getAttribute(name) {
        if (name === 'aria-expanded') return expanded ? 'true' : 'false';
        return null;
      },
      isConnected: true,
      offsetParent: {},
      textContent: '',
      click() { expanded = true; },
    };
    const option = {
      isConnected: true,
      textContent: 'Warszawa',
      click() {
        expanded = false;
        matSelect.textContent = 'Warszawa';
        this.isConnected = false;
        observers.at(-1).callback();
      },
    };
    document.querySelectorAll = selector => {
      if (selector === 'mat-select') return [matSelect];
      if (selector === 'mat-option[role="option"]') return [option];
      return [];
    };
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      domWaiters: new Set(),
      findReservationError: () => null,
      isElementVisible: element => Boolean(element?.offsetParent),
      manuallyStopped: false,
      stopWaiting: false,
    });

    assert.equal(await bot.selectByIndex(0, 'Warszawa'), true);
    assert.equal(timers.every(timer => timer.cancelled), true);
  });

  test(`${userscriptPath}: interval mode waits for a delayed Termin control`, async () => {
    const { VisaAutomationUI, document, observers, timers } = loadUserscript(userscriptPath);
    let selects = [];
    let receivedTermin = null;
    const termin = {
      disabled: false,
      getAttribute: () => null,
      isConnected: true,
      offsetParent: {},
    };
    document.querySelectorAll = selector => selector === 'mat-select' ? selects : [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      domWaiters: new Set(),
      findReservationError: () => null,
      log() {},
      manuallyStopped: false,
      preset: { data: '' },
      retryMode: 'interval',
      stopWaiting: false,
      waitForDateOptions: async value => {
        receivedTermin = value;
        return [];
      },
    });

    const selection = bot.selectDate();
    assert.equal(timers.length, 0);
    assert.equal(receivedTermin, null);
    selects = [{}, {}, {}, termin];
    observers.at(-1).callback();
    assert.equal(await selection, false);
    assert.equal(receivedTermin, termin);
  });

  test(`${userscriptPath}: retries an ignored Termin click after loading`, async () => {
    const { VisaAutomationUI, document, timers } = loadUserscript(userscriptPath);
    let clickCount = 0;
    let options = [];
    let expanded = 'false';
    const dateOption = {
      getAttribute: () => null,
      textContent: '01.09.2026',
    };
    const termin = {
      disabled: false,
      getAttribute(name) {
        if (name === 'aria-expanded') return expanded;
        return null;
      },
      isConnected: true,
      offsetParent: {},
      click() {
        clickCount += 1;
        if (clickCount === 2) {
          expanded = 'true';
          options = [dateOption];
        }
      },
    };
    document.querySelectorAll = selector =>
      selector === 'mat-option[role="option"]' ? options : [];
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      domWaiters: new Set(),
      findReservationError: () => null,
      log() {},
      manuallyStopped: false,
      stopWaiting: false,
    });

    const waiting = bot.waitForDateOptions(termin);
    assert.equal(clickCount, 1);
    assert.equal(timers[0].milliseconds, 500);
    timers[0].callback();
    await Promise.resolve();
    const foundOptions = await waiting;
    assert.equal(foundOptions.length, 1);
    assert.equal(foundOptions[0], dateOption);
    assert.equal(clickCount, 2);
  });

  test(`${userscriptPath}: interval retry waits only after the website result`, () => {
    const { VisaAutomationUI, timers } = loadUserscript(userscriptPath);
    let restarts = 0;
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      attemptStartedAt: Date.now(),
      automationEnabled: true,
      log() {},
      manuallyStopped: false,
      restartAutomationCycle: () => { restarts += 1; },
      retryDelayTimer: null,
      retryIntervalSeconds: 60,
      retryMode: 'interval',
      stopWaiting: false,
    });

    bot.scheduleAutomationRetry('no slots');
    assert.equal(restarts, 0);
    assert.equal(timers.length, 1);
    assert.ok(timers[0].milliseconds > 59000 && timers[0].milliseconds <= 60000);
    timers[0].callback();
    assert.equal(restarts, 1);

    bot.attemptStartedAt = Date.now() - 61000;
    bot.scheduleAutomationRetry('no slots');
    assert.equal(restarts, 2);
    assert.equal(timers.length, 1);
  });

  test(`${userscriptPath}: active no-slot retry clicks Wiza as soon as it is ready`, async () => {
    const { VisaAutomationUI, document, timers } = loadUserscript(userscriptPath);
    let clicked = 0;
    const link = { isConnected: true, offsetParent: {}, click: () => { clicked += 1; } };
    document.querySelector = selector => selector === 'a[href$="/wiza-krajowa"]' ? link : null;
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      captchaCandidateSince: 10,
      captchaCandidateSource: 'old',
      domWaiters: new Set(),
      getServiceSelectionForm: () => null,
      log() {},
      manuallyStopped: false,
      preset: { rodzajUslugi: 'test' },
      restartPending: false,
      restartSourceForm: null,
      restartWatchdogTimer: null,
      restartAttemptInFlight: false,
      stopWaiting: false,
    });

    await bot.restartAutomationCycle('no slots');
    assert.equal(clicked, 1);
    assert.equal(timers.length, 0);
  });

  test(`${userscriptPath}: missing Wiza link is clicked when it appears`, async () => {
    const { VisaAutomationUI, document, observers, timers } = loadUserscript(userscriptPath);
    let link = null;
    let clicked = 0;
    document.querySelector = selector => selector === 'a[href$="/wiza-krajowa"]' ? link : null;
    const bot = Object.assign(Object.create(VisaAutomationUI.prototype), {
      automationEnabled: true,
      captchaCandidateSince: 10,
      captchaCandidateSource: 'old',
      domWaiters: new Set(),
      getServiceSelectionForm: () => null,
      log() {},
      manuallyStopped: false,
      preset: { rodzajUslugi: 'test' },
      restartPending: false,
      restartSourceForm: null,
      restartWatchdogTimer: null,
      restartAttemptInFlight: false,
      stopWaiting: false,
    });

    const restart = bot.restartAutomationCycle('no slots');
    assert.equal(clicked, 0);
    assert.equal(timers.length, 0);
    link = { isConnected: true, offsetParent: {}, click: () => { clicked += 1; } };
    observers.at(-1).callback();
    await restart;
    assert.equal(clicked, 1);
  });
}
