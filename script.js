// ==UserScript==
// @name         e-konsulat Visa Automation
// @namespace    http://tampermonkey.net/
// @version      3.7
// @description  Быстрая автоматизация заполнения формы визы с импортом JSON пресета
// @author       VisaBot
// @match        *://secure.e-konsulat.gov.pl/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      127.0.0.1
// @run-at       document-end
// ==/UserScript==

(function() {
  'use strict';

  class VisaAutomationUI {
    constructor() {
      this.preset = null;
      this.isRunning = false;
      this.stopWaiting = false;
      this.skipReload = false;
      this.lastCaptchaSource = null;
      this.captchaSolveInFlight = false;
      this.currentCaptchaSample = null;
      this.reportedCaptchaSources = new Set();
      this.captchaSuccessCandidateKey = null;
      this.captchaSuccessCandidateTimer = null;
      this.automationEnabled = sessionStorage.getItem('visaAutomationEnabled') === 'true';
      this.manuallyStopped = sessionStorage.getItem('visaAutomationManuallyStopped') === 'true';
      this.automationWaitState = null;
      this.domWaiters = new Set();
      this.restartAttemptInFlight = false;
      this.retryDelayTimer = null;
      this.attemptStartedAt = 0;
      this.retryMode = sessionStorage.getItem('visaRetryMode') === 'interval' ? 'interval' : 'fast';
      this.retryIntervalSeconds = this.normalizeRetryInterval(
        sessionStorage.getItem('visaRetryIntervalSeconds') || 60
      );
      this.logSessionId = this.getOrCreateLogSessionId();
      this.logRelayRetryAfter = 0;
      this.restartWatchdogTimer = null;
      this.restartPending = false;
      this.restartConfirmationPending = false;
      this.restartSourceForm = null;
      this.lastAutoSubmittedCaptcha = null;
      this.captchaCandidateSource = null;
      this.captchaCandidateSince = 0;
      this.captchaStabilityTimer = null;
      this.captchaReloadPending = false;
      this.audioContext = null;
      console.log('🔧 VisaAutomationUI constructor started');

      try {
        this.createUI();
        this.setupHotkey();
        console.log('✅ Visa Automation loaded. Press Ctrl+Shift+V to run');
      } catch (e) {
        console.error('❌ Error in VisaAutomationUI:', e);
      }
    }

    createUI() {
      console.log('📝 Creating UI...');

      // Компактная панель в правом нижнем углу
      const container = document.createElement('div');
      container.id = 'visa-automation-panel';
      container.style.cssText = `
        position: fixed !important;
        top: auto !important;
        right: 20px !important;
        bottom: 20px !important;
        left: auto !important;
        transform: none !important;
        width: 340px !important;
        max-height: 72vh !important;
        background: white !important;
        border-radius: 8px !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2) !important;
        z-index: 999998 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: column !important;
      `;

      const headerHTML = `
        <div style="background: #667eea; color: white; padding: 10px 12px; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center;">
          <span>🇵🇱 Visa Bot</span>
          <button id="visa-minimize-btn" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px;">−</button>
        </div>

          <div id="visa-progress" style="display: none; padding: 10px; background: #e3f2fd; border-radius: 4px; border-left: 3px solid #2196f3; margin-bottom: 10px;">
            <div style="font-size: 12px; color: #1565c0; font-weight: 600;">⏳ ВЫПОЛНЕНИЕ...</div>
            <div id="visa-progress-text" style="font-size: 11px; color: #0d47a1; margin-top: 4px;"></div>
          </div>

        <div id="visa-content" style="padding: 10px; overflow-y: auto; max-height: calc(72vh - 42px); font-size: 12px;">
          <div id="visa-captcha-panel" style="display: none; margin-bottom: 15px; padding: 12px; background: #fff3e0; border-radius: 6px; border: 1px solid #ffb74d;">
            <div style="margin-bottom: 10px; text-align: center; background: white; padding: 8px; border-radius: 4px;">
              <img id="visa-captcha-image" src="" alt="Captcha" style="max-width: 100%; max-height: 90px; display: none;">
              <div id="visa-captcha-loading" style="color: #ff9800; font-size: 11px;">⏳ Загрузка</div>
            </div>
            <button id="visa-captcha-focus-btn" style="width: 100%; padding: 10px; background: #ff9800; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;">✏️ Ввести капчу</button>
          </div>

          <div style="margin-bottom: 12px;">
            <label style="display: block; font-size: 11px; font-weight: 600; margin-bottom: 6px;">📥 Пресет (JSON)</label>
            <input type="file" id="visa-file-input" accept=".json" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 11px; box-sizing: border-box;">
          </div>

          <div id="visa-preset-status" style="margin-bottom: 12px; padding: 10px; background: #e8f5e9; border-radius: 4px; font-size: 11px; color: #1b5e20; display: none; border: 1px solid #4caf50;">
            <div id="visa-preset-details"></div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 95px; gap: 8px; margin-bottom: 10px;">
            <label style="font-size: 11px; font-weight: 600;">
              Режим повторов
              <select id="visa-retry-mode" style="width: 100%; margin-top: 5px; padding: 7px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
                <option value="fast">Быстро</option>
                <option value="interval">Каждые X сек.</option>
              </select>
            </label>
            <label style="font-size: 11px; font-weight: 600;">
              X секунд
              <input id="visa-retry-interval" type="number" min="1" step="1" style="width: 100%; margin-top: 5px; padding: 7px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;">
            </label>
          </div>

          <div style="display: flex; gap: 8px; margin-bottom: 10px;">
            <button id="visa-run-btn" style="flex: 1; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;">▶️ ЗАПУСК</button>
            <button id="visa-clear-btn" style="flex: 1; padding: 10px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;">✕ ОЧИСТИТЬ</button>
          </div>

          <div id="visa-log" style="font-size: 10px; color: #666; max-height: 80px; overflow-y: auto; padding: 6px; background: #fafafa; border-radius: 4px; border: 1px solid #e0e0e0;"></div>
        </div>
      `;

      container.innerHTML = headerHTML;
      document.body.appendChild(container);
      this.syncRetryControls();

      console.log('✅ UI container added to DOM');
      console.log('Container element:', document.getElementById('visa-automation-panel'));

      this.setupEventListeners();
      this.loadPresetFromStorage();
      this.watchForCaptcha();
      this.watchForCaptchaSuccess();
      this.watchForAutomationPage();
    }

    setupEventListeners() {
      // Загрузка файла
      document.getElementById('visa-file-input').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            this.preset = JSON.parse(event.target.result);
            this.savePresetToStorage();
            this.showPresetStatus();
            this.log('preset.loaded');
          } catch (error) {
            this.log(`preset.invalid error="${error.message}"`);
          }
        };
        reader.readAsText(file);
      });

      // Запуск
      document.getElementById('visa-run-btn').addEventListener('click', () => {
        if (!this.preset) {
          this.log('preset.required');
          return;
        }
        this.startAutomation();
      });

      // Очистка
      document.getElementById('visa-clear-btn').addEventListener('click', () => {
        this.preset = null;
        document.getElementById('visa-file-input').value = '';
        document.getElementById('visa-preset-status').style.display = 'none';
        sessionStorage.removeItem('visaBotPreset');
        this.stopAutomation('preset_cleared');
        this.log('preset.cleared');
      });

      // Минимизация
      document.getElementById('visa-minimize-btn').addEventListener('click', () => {
        const container = document.getElementById('visa-automation-panel');
        container.style.display = 'none';

        // Создаем маленькую иконку в правом нижнем углу
        const miniIcon = document.createElement('div');
        miniIcon.id = 'visa-mini-icon';
        miniIcon.style.cssText = `
          position: fixed !important;
          bottom: 20px !important;
          right: 20px !important;
          width: 45px !important;
          height: 45px !important;
          background: #667eea !important;
          border-radius: 50% !important;
          cursor: pointer !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          font-size: 22px !important;
          z-index: 999998 !important;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15) !important;
          user-select: none !important;
        `;
        miniIcon.textContent = '🇵🇱';
        miniIcon.addEventListener('click', () => {
          container.style.display = 'flex';
          miniIcon.remove();
        });
        document.body.appendChild(miniIcon);
      });

      // Кнопка на ввод капчи
      document.getElementById('visa-captcha-focus-btn').addEventListener('click', () => {
        this.focusCaptchaInput();
      });

      document.getElementById('visa-retry-mode').addEventListener('change', (e) => {
        this.retryMode = e.target.value === 'interval' ? 'interval' : 'fast';
        this.saveRetrySettings();
        this.syncRetryControls();
        this.log(this.retryMode === 'interval'
          ? `retry.mode mode=interval seconds=${this.retryIntervalSeconds}`
          : 'retry.mode mode=fast');
      });

      document.getElementById('visa-retry-interval').addEventListener('change', (e) => {
        this.retryIntervalSeconds = this.normalizeRetryInterval(e.target.value);
        this.saveRetrySettings();
        this.syncRetryControls();
        this.log(`retry.interval seconds=${this.retryIntervalSeconds}`);
      });

      // Капча - Enter отправляет
      document.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && document.getElementById('visa-captcha-panel').style.display !== 'none') {
          // Проверяем, в фокусе ли поле капчи на сайте
          const captchaImage = document.querySelector('img[alt="Weryfikacja obrazkowa"]') || document.querySelector('img[alt*="Weryfikacja"]');
          if (captchaImage) {
            const form = captchaImage.closest('form') || captchaImage.parentElement.parentElement;
            if (form) {
              const captchaInput = form.querySelector('input[type="text"]');
              if (captchaInput && document.activeElement === captchaInput) {
                e.preventDefault();
                // Нажимаем Dalej при Enter
                this.submitCaptcha();
              }
            }
          }
        }
      });

      document.addEventListener('click', (e) => {
        const button = e.target.closest && e.target.closest('button');
        if (button && button.textContent.includes('Dalej')) {
          this.stageCaptchaFeedback();
        }
      }, true);
    }

    setupHotkey() {
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'v' && !this.isRunning) {
          e.preventDefault();
          if (this.preset) {
            this.startAutomation();
          } else {
            this.log('preset.required');
          }
        }

        // Ctrl+Shift+Z — немедленно начать новый цикл
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          this.restartAutomationCycle('manual');
        }

        // Ctrl+Shift+X — полностью остановить автоматизацию до нового Ctrl+Shift+V
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
          e.preventDefault();
          this.stopAutomation('manual', true);
        }

        // Ctrl+Shift+Enter для отправки капчи
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
          e.preventDefault();
          this.submitCaptcha();
        }
      });
    }

    normalizeRetryInterval(value) {
      const seconds = Math.floor(Number(value));
      return Number.isFinite(seconds) && seconds >= 1 ? seconds : 60;
    }

    saveRetrySettings() {
      sessionStorage.setItem('visaRetryMode', this.retryMode);
      sessionStorage.setItem('visaRetryIntervalSeconds', String(this.retryIntervalSeconds));
    }

    syncRetryControls() {
      const modeSelect = document.getElementById('visa-retry-mode');
      const intervalInput = document.getElementById('visa-retry-interval');
      if (modeSelect) modeSelect.value = this.retryMode;
      if (intervalInput) {
        intervalInput.value = String(this.retryIntervalSeconds);
        intervalInput.disabled = this.retryMode !== 'interval';
      }
    }

    isIntervalRetryMode() {
      return this.retryMode === 'interval';
    }

    getAutomationWaitTimeout() {
      return this.isIntervalRetryMode() ? 0 : 5000;
    }

    showPresetStatus() {
      const status = document.getElementById('visa-preset-status');
      const details = document.getElementById('visa-preset-details');

      const lines = [
        `👤 Услуга: ${this.preset.rodzajUslugi || '—'}`,
        `📍 Локация: ${this.preset.lokalizacja || '—'}`,
        `👥 Люди: ${this.preset.ludzie || '—'}`,
        `📅 Дата: ${this.preset.data ? (Array.isArray(this.preset.data) ? this.preset.data.join(', ') : this.preset.data) : '(автоматически)'}`
      ];

      details.innerHTML = lines.map(line => `<div>${line}</div>`).join('');
      status.style.display = 'block';
    }

    savePresentToStorage() {
      if (this.preset) {
        sessionStorage.setItem('visaBotPreset', JSON.stringify(this.preset));
        this.log('preset.saved');
      }
    }

    savePresetToStorage() {
      if (this.preset) {
        sessionStorage.setItem('visaBotPreset', JSON.stringify(this.preset));
        this.log('preset.saved');
      }
    }

    loadPresetFromStorage() {
      try {
        const saved = sessionStorage.getItem('visaBotPreset');
        if (saved) {
          this.preset = JSON.parse(saved);
          this.showPresetStatus();
          this.log('preset.restored');
          return true;
        }
      } catch (e) {
        this.log('preset.restore_failed');
        sessionStorage.removeItem('visaBotPreset');
      }
      return false;
    }

    log(message) {
      const logDiv = document.getElementById('visa-log');
      const now = new Date();
      const timestamp = now.toLocaleTimeString('ru-RU');
      const entry = document.createElement('div');
      entry.textContent = `[${timestamp}] ${message}`;
      logDiv.appendChild(entry);
      logDiv.scrollTop = logDiv.scrollHeight;
      this.persistLogEntry(now, timestamp, message);
    }

    getOrCreateLogSessionId() {
      const formatVersion = 'compact-v1';
      const saved = sessionStorage.getItem('visaLogSessionId');
      if (saved && sessionStorage.getItem('visaLogFormatVersion') === formatVersion) return saved;
      const now = new Date();
      const pad = value => String(value).padStart(2, '0');
      const sessionId = [
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
      ].join('-') + '_' + [
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
      ].join('-') + '_' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('visaLogSessionId', sessionId);
      sessionStorage.setItem('visaLogFormatVersion', formatVersion);
      return sessionId;
    }

    persistLogEntry(now, displayTime, message) {
      if (Date.now() < this.logRelayRetryAfter) return;
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://127.0.0.1:3210/log',
        headers: {
          'Content-Type': 'application/json',
          'X-Visa-Captcha-Relay': '1'
        },
        data: JSON.stringify({
          sessionId: this.logSessionId,
          timestamp: now.toISOString(),
          displayTime,
          message: String(message || '')
        }),
        timeout: 2000,
        onload: response => {
          if (response.status < 200 || response.status >= 300) {
            this.logRelayRetryAfter = Date.now() + 5000;
          }
        },
        onerror: () => {
          this.logRelayRetryAfter = Date.now() + 5000;
        },
        ontimeout: () => {
          this.logRelayRetryAfter = Date.now() + 5000;
        }
      });
    }

    startAutomation() {
      if (!this.preset) {
        this.log('preset.required');
        return;
      }
      this.manuallyStopped = false;
      this.automationEnabled = true;
      this.stopWaiting = false;
      if (this.retryDelayTimer) {
        clearTimeout(this.retryDelayTimer);
        this.retryDelayTimer = null;
      }
      sessionStorage.removeItem('visaAutomationManuallyStopped');
      sessionStorage.setItem('visaAutomationEnabled', 'true');
      this.armSuccessSound();
      this.log(this.isIntervalRetryMode()
        ? `automation.start mode=interval seconds=${this.retryIntervalSeconds}`
        : 'automation.start mode=fast');
      this.resumeAutomation();
    }

    stopAutomation(message, manual = false) {
      this.manuallyStopped = manual;
      this.automationEnabled = false;
      this.stopWaiting = true;
      this.restartPending = false;
      this.restartConfirmationPending = false;
      this.restartSourceForm = null;
      sessionStorage.removeItem('visaAutomationEnabled');
      if (manual) sessionStorage.setItem('visaAutomationManuallyStopped', 'true');
      else sessionStorage.removeItem('visaAutomationManuallyStopped');
      this.restartAttemptInFlight = false;
      this.captchaReloadPending = false;
      if (this.retryDelayTimer) {
        clearTimeout(this.retryDelayTimer);
        this.retryDelayTimer = null;
      }
      if (this.captchaStabilityTimer) {
        clearTimeout(this.captchaStabilityTimer);
        this.captchaStabilityTimer = null;
      }
      if (this.restartWatchdogTimer) {
        clearTimeout(this.restartWatchdogTimer);
        this.restartWatchdogTimer = null;
      }
      for (const cancel of this.domWaiters || []) cancel();
      this.domWaiters?.clear();
      if (message) this.log(`automation.stop reason="${message}"`);
    }

    watchForAutomationPage() {
      const check = () => {
        this.confirmRestartDialogIfPresent();
        this.resumeAutomation();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      check();
    }

    resumeAutomation() {
      if (!this.isAutomationActive() || !this.preset || this.isRunning ||
          this.restartAttemptInFlight || this.retryDelayTimer) return;

      const captchaImage = this.findCaptchaImage();
      if (captchaImage && captchaImage.offsetParent !== null) {
        this.restartConfirmationPending = false;
        this.automationWaitState = 'captcha';
        this.submitFilledCaptchaForAutomation(captchaImage);
        return;
      }

      const serviceForm = this.getServiceSelectionForm();
      if (this.restartPending) {
        if (!serviceForm || serviceForm !== this.restartSourceForm) {
          this.restartPending = false;
          this.restartConfirmationPending = false;
          this.restartSourceForm = null;
          this.stopWaiting = false;
          if (this.restartWatchdogTimer) {
            clearTimeout(this.restartWatchdogTimer);
            this.restartWatchdogTimer = null;
          }
        } else {
          return;
        }
      }

      if (serviceForm) {
        this.restartConfirmationPending = false;
        this.automationWaitState = 'service';
        this.run();
      }
    }

    findCaptchaImage() {
      return document.querySelector('img[alt="Weryfikacja obrazkowa"]') ||
        document.querySelector('img[alt*="Weryfikacja"]');
    }

    isElementVisible(element) {
      return Boolean(element && element.isConnected !== false && element.offsetParent !== null);
    }

    findVisibleCaptchaImage() {
      return [...document.querySelectorAll(
        'img[alt="Weryfikacja obrazkowa"], img[alt*="Weryfikacja"]'
      )].find(image => this.isElementVisible(image)) || null;
    }

    getServiceSelectionForm() {
      const forms = document.querySelectorAll(
        'app-visa-reservation-appointment-form form, form'
      );
      for (const form of forms) {
        if (!this.isElementVisible(form)) continue;
        const labels = [...form.querySelectorAll('mat-label')]
          .filter(label => this.isElementVisible(label))
          .map(label => String(label.textContent || '').trim().toLowerCase());
        const visibleSelects = [...form.querySelectorAll('mat-select')]
          .filter(select => this.isElementVisible(select) && select.getAttribute('aria-disabled') !== 'true');
        if (labels.some(label => label.includes('rodzaj usługi')) &&
            labels.some(label => label.includes('lokalizacja')) &&
            visibleSelects.length >= 2) {
          return form;
        }
      }
      return null;
    }

    submitFilledCaptchaForAutomation(captchaImage) {
      const source = captchaImage.src;
      if (!source || source === this.lastAutoSubmittedCaptcha) return;
      const form = captchaImage.closest('form') || captchaImage.closest('[role="form"]') || captchaImage.parentElement?.parentElement;
      const input = form && form.querySelector('input[type="text"]');
      const value = String(input && input.value || '').trim();
      const sample = this.currentCaptchaSample;
      if (!sample || sample.image !== source || sample.predicted !== value || value.length !== 4) return;
      this.lastAutoSubmittedCaptcha = source;
      this.submitCaptcha();
    }

    async restartAutomationCycle(reason = 'retry') {
      if (!this.preset) {
        this.log('preset.required');
        return;
      }
      if (!this.isAutomationActive()) {
        this.log('cycle.restart_ignored reason=stopped');
        return;
      }
      if (this.retryDelayTimer) {
        clearTimeout(this.retryDelayTimer);
        this.retryDelayTimer = null;
      }
      this.stopWaiting = true;
      if (this.restartAttemptInFlight) return;
      if (this.restartWatchdogTimer) {
        clearTimeout(this.restartWatchdogTimer);
        this.restartWatchdogTimer = null;
      }
      this.log(`cycle.restart reason="${reason}"`);
      this.restartAttemptInFlight = true;
      const link = await this.waitForDomState(() => {
        const candidate = document.querySelector('a[href$="/wiza-krajowa"]');
        return this.isElementVisible(candidate) ? candidate : null;
      });
      this.restartAttemptInFlight = false;
      if (!link || !this.isAutomationActive()) return;

      this.captchaCandidateSource = null;
      this.captchaCandidateSince = 0;
      this.restartSourceForm = this.getServiceSelectionForm();
      this.restartPending = Boolean(this.restartSourceForm);
      this.stopWaiting = true;
      this.skipReload = true;
      this.restartConfirmationPending = true;
      this.log('cycle.open');
      link.click();
      this.confirmRestartDialogIfPresent();

      if (!this.restartPending) {
        this.stopWaiting = false;
        return;
      }
      this.restartWatchdogTimer = setTimeout(() => {
        this.restartWatchdogTimer = null;
        if (!this.isAutomationActive()) return;
        if (this.restartPending && this.getServiceSelectionForm() === this.restartSourceForm) {
          this.restartPending = false;
          this.restartSourceForm = null;
          this.stopWaiting = false;
          this.restartAutomationCycle('navigation_stalled');
        }
      }, 3500);
    }

    scheduleAutomationRetry(reason) {
      if (!this.isAutomationActive()) return;
      if (!this.isIntervalRetryMode()) {
        this.restartAutomationCycle(reason);
        return;
      }

      const intervalMs = this.retryIntervalSeconds * 1000;
      const elapsedMs = Math.max(0, Date.now() - this.attemptStartedAt);
      const remainingMs = Math.max(0, intervalMs - elapsedMs);
      if (remainingMs === 0) {
        this.log(`retry.due seconds=${this.retryIntervalSeconds}`);
        this.restartAutomationCycle(reason);
        return;
      }

      this.stopWaiting = true;
      this.log(`retry.wait seconds=${Math.ceil(remainingMs / 1000)} reason="${reason}"`);
      this.retryDelayTimer = setTimeout(() => {
        this.retryDelayTimer = null;
        if (!this.isAutomationActive()) return;
        this.restartAutomationCycle(reason);
      }, remainingMs);
    }

    reloadAfterCaptchaError(reason) {
      if (this.captchaReloadPending || !this.isAutomationActive()) return;
      this.captchaReloadPending = true;
      this.log(`page.reload reason="${reason}"`);
      window.location.reload();
    }

    isAutomationActive() {
      return this.automationEnabled && !this.manuallyStopped;
    }

    async run() {
      if (this.isRunning) return;
      this.isRunning = true;
      this.attemptStartedAt = Date.now();

      document.getElementById('visa-progress').style.display = 'block';
      document.getElementById('visa-run-btn').disabled = true;

      try {
        this.updateProgress('Шаг 1/4: Выбор услуги...', 'step.service');
        if (!await this.selectByIndex(0, this.preset.rodzajUslugi)) {
          throw new Error('Не удалось выбрать услугу');
        }

        this.updateProgress('Шаг 2/4: Выбор локации...', 'step.location');
        if (!await this.selectByIndex(1, this.preset.lokalizacja)) {
          throw new Error('Не удалось выбрать локацию');
        }

        this.updateProgress('Шаг 3/4: Выбор количества...', 'step.people');
        if (!await this.selectByIndex(2, this.preset.ludzie)) {
          throw new Error('Не удалось выбрать количество');
        }

        this.updateProgress('Шаг 4/4: Выбор даты...', 'step.date');
        if (!await this.selectDate()) {
          throw new Error('Не удалось выбрать дату');
        }

        this.log('slot.confirmed');
        this.playSuccessSound();
        this.showNotification('🎯 Свободный слот найден!', 'success');
        if (typeof GM_notification === 'function') {
          GM_notification({
            title: 'Visa Bot — слот пойман',
            text: 'Термин выбран и кнопка Dalej нажата. Продолжайте заполнение вручную.',
            timeout: 0
          });
        }
        this.stopAutomation();
      } catch (error) {
        if (this.isAutomationActive()) {
          this.scheduleAutomationRetry(error.message);
        } else {
          this.log(`error message="${error.message}"`);
          this.showNotification('❌ ' + error.message, 'error');
        }
      } finally {
        this.isRunning = false;
        document.getElementById('visa-progress').style.display = 'none';
        document.getElementById('visa-run-btn').disabled = false;
      }
    }

    updateProgress(text, event = text) {
      document.getElementById('visa-progress-text').textContent = text;
      this.log(event);
    }

    async selectByIndex(selectIndex, searchValue) {
      const matSelect = await this.waitForDomState(() => {
        if (this.stopWaiting || !this.isAutomationActive()) return null;
        const loadError = this.findReservationError();
        if (loadError) throw new Error(`форма не загрузилась: ${loadError}`);
        const candidate = document.querySelectorAll('mat-select')[selectIndex];
        return this.isElementReady(candidate) ? candidate : null;
      }, this.getAutomationWaitTimeout());
      if (!matSelect) return false;
      matSelect.click();
      const options = await this.waitForDomState(() => {
        if (this.stopWaiting || !this.isAutomationActive()) return null;
        const loadError = this.findReservationError();
        if (loadError) throw new Error(`форма не загрузилась: ${loadError}`);
        const available = [...document.querySelectorAll('mat-option[role="option"]')];
        return available.length ? available : null;
      }, this.getAutomationWaitTimeout());
      if (!options) return false;

      for (const option of options) {
        if (!this.isAutomationActive()) return false;
        const optionText = option.textContent.trim();
        if (optionText.toLowerCase().includes(searchValue.toLowerCase())) {
          const applied = this.waitForSelectionApplied(matSelect, option, optionText);
          option.click();
          return Boolean(await applied);
        }
      }

      return false;
    }

    async selectDate() {
      let terminSelect = document.querySelectorAll('mat-select')[3];

      if (this.isIntervalRetryMode()) {
        terminSelect = await this.waitForDomState(() => {
          if (this.stopWaiting || !this.isAutomationActive()) return null;
          const loadError = this.findReservationError();
          if (loadError) throw new Error(`слоты не получены: ${loadError}`);
          const candidate = document.querySelectorAll('mat-select')[3];
          return this.isElementReady(candidate) ? candidate : null;
        });
      }

      if (!terminSelect) {
        return false;
      }

      const options = await this.waitForDateOptions(terminSelect);

      if (!options || options.length === 0) {
        this.log('date.options_missing');
        return false;
      }

      // Если дата указана в пресете - искать её
      if (this.preset.data) {
        // Поддержка массива дат (приоритет по порядку)
        const datesToTry = Array.isArray(this.preset.data)
          ? this.preset.data
          : [this.preset.data];

        for (const dateToFind of datesToTry) {
          for (const option of options) {
            const optionText = option.textContent.trim();
            if (optionText.includes(dateToFind)) {
              const applied = this.waitForSelectionApplied(terminSelect, option, optionText);
              option.click();
              if (!await applied) return false;
              this.log(`date.selected value="${optionText}"`);
              return await this.clickDalejButton(terminSelect);
            }
          }
        }

        const dateList = Array.isArray(this.preset.data)
          ? this.preset.data.join(', ')
          : this.preset.data;
        this.log(`date.preferred_missing values="${dateList}"`);
      }

      // Если даты нет в пресете или не найдена - выбрать первую
      if (options.length > 0) {
        const firstOption = options[0];
        const optionText = firstOption.textContent.trim();
        const applied = this.waitForSelectionApplied(terminSelect, firstOption, optionText);
        firstOption.click();
        if (!await applied) return false;
        this.log(`date.selected value="${optionText}" source=first`);
        return await this.clickDalejButton(terminSelect);
      }

      return false;
    }

    async clickDalejButton(terminSelect) {
      if (!this.isAutomationActive()) return false;
      const button = await this.waitForDomState(() => {
        const loadError = this.findReservationError();
        if (loadError) throw new Error(`слот не подтверждён: ${loadError}`);
        return this.findReadyDalejButton();
      }, this.getAutomationWaitTimeout());
      if (!button || !this.isAutomationActive()) return false;
      this.log('dalej.click');
      button.click();
      return await this.waitForReservationSubmission(terminSelect);
    }

    async waitForReservationSubmission(terminSelect) {
      this.log('reservation.verify');
      let successCandidateSince = 0;

      while (this.isAutomationActive() && !this.stopWaiting) {
        const loadError = this.findReservationError();
        if (loadError) {
          throw new Error(`Termin не подтверждён сервером: ${loadError}`);
        }

        const postReservationForm = this.getPostReservationForm();
        if (!this.isElementVisible(terminSelect) && postReservationForm) {
          if (!successCandidateSince) successCandidateSince = Date.now();
          if (Date.now() - successCandidateSince >= 800) {
            this.log('reservation.accepted');
            return true;
          }
        } else {
          successCandidateSince = 0;
        }

        await this.waitForDomState(() => {
          if (this.stopWaiting || !this.isAutomationActive()) return true;
          const currentError = this.findReservationError();
          if (currentError) {
            throw new Error(`Termin не подтверждён сервером: ${currentError}`);
          }
          return null;
        }, 200);
      }

      return false;
    }

    isUsableCaptchaImage(captchaImage) {
      if (!captchaImage || !captchaImage.complete || captchaImage.naturalWidth < 1) return false;
      const source = String(captchaImage.src || '');
      const match = source.match(/^data:image\/(?:png|jpe?g|gif);base64,([A-Za-z0-9+/=\s]+)$/i);
      if (!match) return false;
      try {
        return atob(match[1].replace(/\s+/g, '')).length >= 100;
      } catch {
        return false;
      }
    }

    isCaptchaStableForOcr(captchaImage) {
      if (!this.isUsableCaptchaImage(captchaImage)) {
        this.captchaCandidateSource = null;
        this.captchaCandidateSince = 0;
        return false;
      }

      const source = captchaImage.src;
      if (source !== this.captchaCandidateSource) {
        this.captchaCandidateSource = source;
        this.captchaCandidateSince = Date.now();
        if (this.captchaStabilityTimer) clearTimeout(this.captchaStabilityTimer);
        this.captchaStabilityTimer = setTimeout(() => {
          this.captchaStabilityTimer = null;
          this.checkForCaptcha();
        }, 750);
        return false;
      }

      return Date.now() - this.captchaCandidateSince >= 750;
    }

    watchForCaptcha() {
      const check = () => this.checkForCaptcha();
      const observer = new MutationObserver(mutations => {
        if (mutations.every(mutation => mutation.target.closest?.('#visa-automation-panel'))) return;
        check();
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['src', 'class', 'style', 'aria-hidden'],
        childList: true,
        subtree: true,
      });
      document.addEventListener('load', check, true);
      check();
    }

    checkForCaptcha() {
      const captchaImage = this.findCaptchaImage();

      let captchaInputField = document.querySelector('input[placeholder*="znaki"], input[placeholder*="obrazka"], input[placeholder*="capcha"], input[placeholder*="weryfi"]');

      // Если не нашли поле - ищем input рядом с картинкой капчи
      if (!captchaInputField && captchaImage) {
        const form = captchaImage.closest('form') || captchaImage.closest('[role="form"]') || captchaImage.parentElement.parentElement;
        if (form) {
          captchaInputField = form.querySelector('input[type="text"]');
        }
      }

      // Если все еще не нашли - ищем любой text input после картинки
      if (!captchaInputField && captchaImage) {
        const allInputs = document.querySelectorAll('input[type="text"]');
        for (const input of allInputs) {
          if (input.offsetParent !== null) {
            captchaInputField = input;
            break;
          }
        }
      }

      const panel = document.getElementById('visa-captcha-panel');

      if (captchaImage && captchaImage.src) {
        const isVisible = captchaImage.offsetParent !== null;

        if (isVisible && panel) {
          panel.style.display = 'block';

          const captchaImageElement = document.getElementById('visa-captcha-image');
          const loadingElement = document.getElementById('visa-captcha-loading');

          captchaImageElement.src = captchaImage.src;
          captchaImageElement.style.display = 'block';
          loadingElement.style.display = 'none';

          if (captchaInputField &&
              !this.manuallyStopped &&
              this.isCaptchaStableForOcr(captchaImage) &&
              captchaImage.src !== this.lastCaptchaSource &&
              !this.captchaSolveInFlight) {
            this.lastCaptchaSource = captchaImage.src;
            this.solveCaptchaAutomatically(captchaImage, captchaInputField);
          }
        } else if (!isVisible && panel) {
          panel.style.display = 'none';
          document.getElementById('visa-captcha-image').src = '';
          document.getElementById('visa-captcha-image').style.display = 'none';
          document.getElementById('visa-captcha-loading').style.display = 'block';
        }
      }
    }

    async solveCaptchaAutomatically(captchaImage, captchaInputField) {
      this.captchaSolveInFlight = true;
      const source = captchaImage.src;
      const loadingElement = document.getElementById('visa-captcha-loading');
      const focusButton = document.getElementById('visa-captcha-focus-btn');

      if (loadingElement) {
        loadingElement.textContent = '⏳ Автоматическое распознавание...';
        loadingElement.style.display = 'block';
      }
      if (focusButton) focusButton.disabled = true;

      try {
        this.log('captcha.ocr_request');
        this.currentCaptchaSample = { image: source, predicted: '', taskId: null };
        const result = await this.requestCaptchaSolution(source);

        if (this.manuallyStopped) {
          this.log('captcha.ocr_discarded reason=stopped');
          return;
        }
        if (!captchaImage.isConnected || captchaImage.src !== source || captchaImage.offsetParent === null) {
          this.log('captcha.ocr_discarded reason=stale');
          return;
        }

        const answer = String(result.text || '').trim();
        this.currentCaptchaSample.predicted = answer;
        this.currentCaptchaSample.taskId = result.taskId || null;
        if (answer.length !== 4) {
          throw new Error(`Получен ответ длиной ${answer.length}, ожидалось 4`);
        }

        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        valueSetter.call(captchaInputField, answer);
        captchaInputField.dispatchEvent(new Event('input', { bubbles: true }));
        captchaInputField.dispatchEvent(new Event('change', { bubbles: true }));
        captchaInputField.focus();

        if (this.isAutomationActive() || (result.autoSubmit && !this.manuallyStopped)) {
          this.log('captcha.ocr_ok');
          this.lastAutoSubmittedCaptcha = source;
          await this.submitCaptcha();
        } else {
          this.log('captcha.manual_submit');
        }
      } catch (error) {
        this.log(`captcha.ocr_failed error="${error.message}"`);
        if (this.isAutomationActive()) {
          this.reloadAfterCaptchaError('captcha_failed');
        } else {
          this.log('captcha.manual_required');
          captchaInputField.focus();
        }
      } finally {
        this.captchaSolveInFlight = false;
        if (loadingElement) {
          loadingElement.textContent = '⏳ Загрузка';
          loadingElement.style.display = 'none';
        }
        if (focusButton) focusButton.disabled = false;
      }
    }

    requestCaptchaSolution(image) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'POST',
          url: 'http://127.0.0.1:3210/solve',
          headers: {
            'Content-Type': 'application/json',
            'X-Visa-Captcha-Relay': '1'
          },
          data: JSON.stringify({ image, expectedLength: 4 }),
          timeout: 15000,
          onload: (response) => {
            let payload;
            try {
              payload = JSON.parse(response.responseText);
            } catch {
              reject(new Error('Relay вернул некорректный JSON'));
              return;
            }

            if (response.status < 200 || response.status >= 300 || !payload.ok) {
              reject(new Error(payload.error || `Relay HTTP ${response.status}`));
              return;
            }
            resolve(payload);
          },
          onerror: () => reject(new Error('Локальный relay недоступен')),
          ontimeout: () => reject(new Error('Таймаут локального relay'))
        });
      });
    }

    stageCaptchaFeedback() {
      const sample = this.currentCaptchaSample;
      if (!sample) return;

      const captchaImage = document.querySelector('img[alt="Weryfikacja obrazkowa"]') ||
        document.querySelector('img[alt*="Weryfikacja"]');
      const form = captchaImage &&
        (captchaImage.closest('form') || captchaImage.closest('[role="form"]') || captchaImage.parentElement.parentElement);
      const input = form && form.querySelector('input[type="text"]');
      const actual = String(input && input.value || '').trim();
      if (actual.length !== 4) return;

      sessionStorage.setItem('visaPendingCaptchaFeedback', JSON.stringify({
        image: sample.image,
        predicted: sample.predicted,
        actual,
        taskId: sample.taskId,
        submittedAt: Date.now()
      }));
      this.log('captcha.submitted');
    }

    watchForCaptchaSuccess() {
      const check = () => this.confirmCaptchaFeedbackIfSuccessful();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      check();
    }

    resetCaptchaSuccessCandidate() {
      this.captchaSuccessCandidateKey = null;
      if (this.captchaSuccessCandidateTimer) {
        clearTimeout(this.captchaSuccessCandidateTimer);
        this.captchaSuccessCandidateTimer = null;
      }
    }

    confirmCaptchaFeedbackIfSuccessful() {
      const raw = sessionStorage.getItem('visaPendingCaptchaFeedback');
      if (!raw) {
        this.resetCaptchaSuccessCandidate();
        return;
      }

      let sample;
      try {
        sample = JSON.parse(raw);
      } catch {
        sessionStorage.removeItem('visaPendingCaptchaFeedback');
        this.resetCaptchaSuccessCandidate();
        return;
      }
      if (!sample.submittedAt || Date.now() - sample.submittedAt > 10 * 60 * 1000) {
        sessionStorage.removeItem('visaPendingCaptchaFeedback');
        this.resetCaptchaSuccessCandidate();
        return;
      }

      const captchaImage = this.findVisibleCaptchaImage();
      if (this.isElementVisible(captchaImage)) {
        this.resetCaptchaSuccessCandidate();
        if (captchaImage.src && captchaImage.src !== sample.image) {
          sessionStorage.removeItem('visaPendingCaptchaFeedback');
          this.reportedCaptchaSources.delete(sample.image);
          this.log('captcha.rejected');
        }
        return;
      }

      const serviceForm = this.getServiceSelectionForm();
      if (!serviceForm) {
        this.resetCaptchaSuccessCandidate();
        return;
      }
      if (this.reportedCaptchaSources.has(sample.image)) return;

      const candidateKey = `${sample.image}:${sample.submittedAt}`;
      if (this.captchaSuccessCandidateKey !== candidateKey) {
        this.resetCaptchaSuccessCandidate();
        this.captchaSuccessCandidateKey = candidateKey;
        this.captchaSuccessCandidateTimer = setTimeout(() => {
          this.captchaSuccessCandidateTimer = null;
          this.confirmCaptchaFeedbackIfSuccessful();
        }, 800);
        return;
      }

      this.reportedCaptchaSources.add(sample.image);
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'http://127.0.0.1:3210/feedback',
        headers: {
          'Content-Type': 'application/json',
          'X-Visa-Captcha-Relay': '1'
        },
        data: JSON.stringify({
          image: sample.image,
          predicted: sample.predicted,
          actual: sample.actual,
          taskId: sample.taskId
        }),
        timeout: 3000,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            sessionStorage.removeItem('visaPendingCaptchaFeedback');
            this.resetCaptchaSuccessCandidate();
            this.log('captcha.accepted');
          } else {
            this.reportedCaptchaSources.delete(sample.image);
          }
        },
        onerror: () => this.reportedCaptchaSources.delete(sample.image),
        ontimeout: () => this.reportedCaptchaSources.delete(sample.image)
      });
    }

    async submitCaptcha() {
      if (this.manuallyStopped) {
        this.log('submit.cancelled reason=stopped');
        return;
      }
      const button = await this.waitForDomState(
        () => this.findReadyDalejButton(),
        5000,
      );
      if (!button || this.manuallyStopped) {
        if (!this.manuallyStopped) this.log('dalej.not_ready');
        return;
      }
      this.stageCaptchaFeedback();
      this.log('dalej.click');
      button.click();
    }

    focusCaptchaInput() {
      const captchaImage = document.querySelector('img[alt="Weryfikacja obrazkowa"]');
      let captchaInputField = null;

      if (captchaImage) {
        const form = captchaImage.closest('form') || captchaImage.closest('[role="form"]') || captchaImage.parentElement.parentElement;
        if (form) {
          captchaInputField = form.querySelector('input[type="text"]');
        }
      }

      if (!captchaInputField) {
        const allInputs = document.querySelectorAll('input[type="text"]');
        for (const input of allInputs) {
          if (input.offsetParent !== null) {
            captchaInputField = input;
            break;
          }
        }
      }

      if (captchaInputField) {
        captchaInputField.focus();
        this.log('captcha.input_focus');
      } else {
        this.log('captcha.input_missing');
      }
    }

    clickWizaKrajowa() {
      const link = document.querySelector('a[href$="/wiza-krajowa"]');

      if (link) {
        this.stopWaiting = true;
        this.skipReload = true;
        this.log('cycle.open');
        link.click();
        return true;
      } else {
        this.log('cycle.link_missing');
        return false;
      }
    }

    findRestartConfirmationButton() {
      const dialogs = document.querySelectorAll('mat-dialog-container[role="dialog"], mat-dialog-container');
      for (const dialog of dialogs) {
        if (!this.isElementVisible(dialog)) continue;
        const text = String(dialog.textContent || '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[łŁ]/g, 'l')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        const isCancellationDialog = /czy na pewno chcesz anulowac uzupelnianie formularza/.test(text) ||
          /niezapisane dane zostana usuniete/.test(text);
        if (!isCancellationDialog) continue;
        const buttons = dialog.querySelectorAll('button[mat-button], button');
        for (const button of buttons) {
          const label = String(button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
          if (label === 'tak' && this.isElementReady(button)) return button;
        }
      }
      return null;
    }

    confirmRestartDialogIfPresent() {
      if (!this.restartConfirmationPending || !this.isAutomationActive()) return false;
      const button = this.findRestartConfirmationButton();
      if (!button) return false;
      this.restartConfirmationPending = false;
      this.log('cycle.cancel_confirmed');
      button.click();
      return true;
    }

    isNoSlotsOrLoadError(text) {
      const value = String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[łŁ]/g, 'l')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return /brak[^.]{0,50}(?:termin|dat|wolnych miejsc)/.test(value) ||
        /nie (?:ma|znaleziono)[^.]{0,80}(?:termin|dat|wolnych miejsc)/.test(value) ||
        this.isFullyBookedMessage(value) ||
        this.isSlotUnavailableMessage(value) ||
        this.isCommunicationServerError(value) ||
        /nie udalo sie/.test(value) ||
        /wystapil blad/.test(value) ||
        /sprobuj ponownie/.test(value) ||
        /no (?:free|available) (?:dates|appointments|slots)/.test(value) ||
        /an error occurred/.test(value);
    }

    isFullyBookedMessage(text) {
      const value = String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[łŁ]/g, 'l')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return /chwilowo wszystkie udostepnione terminy zostaly zarezerwowane/.test(value) ||
        /wszystkie[^.]{0,80}terminy[^.]{0,80}zarezerwowane/.test(value) ||
        /prosimy sprobowac[^.]{0,80}terminie pozniejszym/.test(value);
    }

    isSlotUnavailableMessage(text) {
      const value = String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[łŁ]/g, 'l')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return /(?:wybrany|ten) termin[^.]{0,80}niedostepn/.test(value) ||
        /termin[^.]{0,80}nie (?:jest )?(?:juz )?dostepn/.test(value) ||
        /termin[^.]{0,80}(?:jest |zostal )?juz (?:zarezerwowan|zajet)/.test(value) ||
        /termin[^.]{0,80}(?:jest |zostal )?zajet/.test(value) ||
        /termin[^.]{0,80}zarezerwowan[^.]{0,40}przez (?:inna|innego)/.test(value) ||
        /nie mozna[^.]{0,80}(?:zarezerwowac|wybrac)[^.]{0,80}termin/.test(value) ||
        /wybierz inny termin/.test(value);
    }

    isCommunicationServerError(text) {
      const value = String(text || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[łŁ]/g, 'l')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return /blad komunikacji z serwerem/.test(value) ||
        /blad polaczenia z serwerem/.test(value);
    }

    findReservationError() {
      const candidates = document.querySelectorAll(
        '[role="alert"], mat-error, mat-option, .mat-snack-bar-container, .alert, [class*="error"]'
      );
      for (const element of candidates) {
        if (element.offsetParent === null) continue;
        const text = String(element.textContent || '').trim();
        if (this.isNoSlotsOrLoadError(text)) return text;
      }
      const visibleText = [];
      const walker = document.createTreeWalker(document.body, 4);
      let node;
      while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        if (!parent || parent.closest('#visa-automation-panel') || parent.offsetParent === null) continue;
        const text = String(node.nodeValue || '').trim();
        if (text) visibleText.push(text);
      }
      const pageText = visibleText.join(' ');
      if (this.isCommunicationServerError(pageText)) {
        return 'Błąd komunikacji z serwerem';
      }
      if (this.isSlotUnavailableMessage(pageText)) {
        return 'Wybrany termin jest już niedostępny';
      }
      if (this.isFullyBookedMessage(pageText)) {
        return 'Chwilowo wszystkie udostępnione terminy zostały zarezerwowane';
      }
      return null;
    }

    getAvailableDateOptions() {
      return [...document.querySelectorAll('mat-option[role="option"]')].filter(option => {
        const text = String(option.textContent || '').trim();
        return option.getAttribute('aria-disabled') !== 'true' && !this.isNoSlotsOrLoadError(text);
      });
    }

    async waitForDateOptions(terminSelect) {
      this.log('slots.wait');
      while (this.isAutomationActive() && !this.stopWaiting) {
        const loadError = this.findReservationError();
        if (loadError) {
          throw new Error(`слоты не получены: ${loadError}`);
        }

        const options = this.getAvailableDateOptions();
        if (options.length > 0) {
          this.log(`slots.available count=${options.length}`);
          return options;
        }

        if (this.isElementReady(terminSelect) &&
            terminSelect.getAttribute('aria-expanded') !== 'true') {
          terminSelect.click();
        }

        const observedOptions = await this.waitForDomState(() => {
          if (this.stopWaiting || !this.isAutomationActive()) return true;
          const currentError = this.findReservationError();
          if (currentError) throw new Error(`слоты не получены: ${currentError}`);
          const currentOptions = this.getAvailableDateOptions();
          return currentOptions.length > 0 ? currentOptions : null;
        }, 500);

        if (Array.isArray(observedOptions)) {
          this.log(`slots.available count=${observedOptions.length}`);
          return observedOptions;
        }
      }

      if (this.stopWaiting || !this.isAutomationActive()) {
        this.log('slots.wait_cancelled');
      }
      return null;
    }

    getPostReservationForm() {
      if (this.getServiceSelectionForm()) return null;
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        if (!this.isElementVisible(form) || form.closest?.('#visa-automation-panel')) continue;
        const hasVisibleCaptcha = [...form.querySelectorAll(
          'img[alt="Weryfikacja obrazkowa"], img[alt*="Weryfikacja"]'
        )].some(image => this.isElementVisible(image));
        if (hasVisibleCaptcha) continue;
        const usableFields = [...form.querySelectorAll(
          'input:not([type="hidden"]), textarea, mat-select'
        )].filter(field => this.isElementReady(field));
        if (usableFields.length > 0) return form;
      }
      return null;
    }

    isElementReady(element) {
      return this.isElementVisible(element) &&
        element.disabled !== true &&
        element.getAttribute?.('disabled') === null &&
        element.getAttribute?.('aria-disabled') !== 'true';
    }

    isSelectionApplied(matSelect, option, optionText) {
      if (matSelect.getAttribute('aria-expanded') === 'true') return null;
      const selectedText = String(matSelect.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const expectedText = String(optionText || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return option.isConnected === false && selectedText.includes(expectedText) ? true : null;
    }

    waitForSelectionApplied(matSelect, option, optionText) {
      return this.waitForDomState(() => {
        const loadError = this.findReservationError();
        if (loadError) throw new Error(`выбор не применён: ${loadError}`);
        return this.isSelectionApplied(matSelect, option, optionText);
      }, this.getAutomationWaitTimeout());
    }

    findReadyDalejButton(root = document) {
      return [...root.querySelectorAll('button[mat-button]')]
        .find(button => button.textContent.includes('Dalej') && this.isElementReady(button)) || null;
    }

    waitForDomState(check, timeoutMs = 0) {
      return new Promise((resolve, reject) => {
        let observer = null;
        let timeout = null;
        let settled = false;

        const finish = (value, error = null) => {
          if (settled) return;
          settled = true;
          observer?.disconnect();
          if (timeout) clearTimeout(timeout);
          this.domWaiters?.delete(cancel);
          if (error) reject(error);
          else resolve(value);
        };
        const cancel = () => finish(null);
        const evaluate = () => {
          try {
            const value = check();
            if (value) finish(value);
          } catch (error) {
            finish(null, error);
          }
        };

        this.domWaiters ??= new Set();
        this.domWaiters.add(cancel);
        observer = new MutationObserver(evaluate);
        observer.observe(document.body, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
        if (timeoutMs > 0) timeout = setTimeout(cancel, timeoutMs);
        evaluate();
      });
    }

    armSuccessSound() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      try {
        if (!this.audioContext) this.audioContext = new AudioContextClass();
        if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
      } catch {
        this.audioContext = null;
      }
    }

    playSuccessSound() {
      this.armSuccessSound();
      const context = this.audioContext;
      if (!context) return;

      const play = () => {
        const startedAt = context.currentTime + 0.03;
        [659.25, 783.99, 1046.5].forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          const noteStart = startedAt + index * 0.16;
          oscillator.type = 'sine';
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0.0001, noteStart);
          gain.gain.exponentialRampToValueAtTime(0.18, noteStart + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.24);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(noteStart);
          oscillator.stop(noteStart + 0.25);
        });
      };

      if (context.state === 'suspended') context.resume().then(play).catch(() => {});
      else play();
    }

    showNotification(message, type = 'info') {
      const colors = {
        success: '#4caf50',
        error: '#f44336',
        info: '#2196f3'
      };

      const notification = document.createElement('div');
      notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 16px 24px;
        background: ${colors[type] || colors.info};
        color: white;
        border-radius: 4px;
        font-size: 14px;
        font-weight: 500;
        z-index: 10001;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        animation: slideIn 0.3s ease;
      `;
      notification.textContent = message;
      document.body.appendChild(notification);

      setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transition = 'opacity 0.3s ease';
        setTimeout(() => notification.remove(), 300);
      }, 3000);
    }
  }

  // Инициализация при загрузке страницы
  function initVisa() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        window.visaBot = new VisaAutomationUI();
      });
    } else {
      window.visaBot = new VisaAutomationUI();
    }
  }

  initVisa();
})();
