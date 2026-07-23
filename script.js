// ==UserScript==
// @name         e-konsulat Visa Automation
// @namespace    http://tampermonkey.net/
// @version      2.9
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
      this.automationEnabled = sessionStorage.getItem('visaAutomationEnabled') === 'true';
      this.manuallyStopped = sessionStorage.getItem('visaAutomationManuallyStopped') === 'true';
      this.automationWaitState = null;
      this.retryTimer = null;
      this.restartWatchdogTimer = null;
      this.restartPending = false;
      this.restartSourceForm = null;
      this.lastAutoSubmittedCaptcha = null;
      this.captchaCandidateSource = null;
      this.captchaCandidateSince = 0;
      this.captchaOcrNotBefore = Number(sessionStorage.getItem('visaCaptchaOcrNotBefore') || 0);
      this.captchaReloadTimer = null;
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

      // Основной контейнер - ПО ЦЕНТРУ И БОЛЬШОЙ
      const container = document.createElement('div');
      container.id = 'visa-automation-panel';
      container.style.cssText = `
        position: fixed !important;
        top: 50% !important;
        left: 50% !important;
        transform: translate(-50%, -50%) !important;
        width: 420px !important;
        max-height: 90vh !important;
        background: white !important;
        border-radius: 8px !important;
        box-shadow: 0 4px 16px rgba(0,0,0,0.2) !important;
        z-index: 999998 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        overflow: visible !important;
        display: flex !important;
        flex-direction: column !important;
      `;

      const headerHTML = `
        <div style="background: #667eea; color: white; padding: 15px; font-weight: 600; font-size: 15px; display: flex; justify-content: space-between; align-items: center;">
          <span>🇵🇱 Visa Bot</span>
          <button id="visa-minimize-btn" style="background: none; border: none; color: white; cursor: pointer; font-size: 18px;">−</button>
        </div>

          <div id="visa-progress" style="display: none; padding: 10px; background: #e3f2fd; border-radius: 4px; border-left: 3px solid #2196f3; margin-bottom: 10px;">
            <div style="font-size: 12px; color: #1565c0; font-weight: 600;">⏳ ВЫПОЛНЕНИЕ...</div>
            <div id="visa-progress-text" style="font-size: 11px; color: #0d47a1; margin-top: 4px;"></div>
          </div>

        <div id="visa-content" style="padding: 15px; overflow-y: auto; max-height: 500px; font-size: 13px;">
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

          <div style="display: flex; gap: 8px; margin-bottom: 10px;">
            <button id="visa-run-btn" style="flex: 1; padding: 10px; background: #4CAF50; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;">▶️ ЗАПУСК</button>
            <button id="visa-clear-btn" style="flex: 1; padding: 10px; background: #f44336; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;">✕ ОЧИСТИТЬ</button>
          </div>

          <div id="visa-log" style="font-size: 10px; color: #666; max-height: 120px; overflow-y: auto; padding: 8px; background: #fafafa; border-radius: 4px; border: 1px solid #e0e0e0;"></div>
        </div>
      `;

      container.innerHTML = headerHTML;
      document.body.appendChild(container);

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
            this.log('✅ Пресет загружен');
          } catch (error) {
            this.log('❌ Ошибка при парсинге JSON: ' + error.message);
          }
        };
        reader.readAsText(file);
      });

      // Запуск
      document.getElementById('visa-run-btn').addEventListener('click', () => {
        if (!this.preset) {
          this.log('❌ Сначала загрузите пресет');
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
        this.stopAutomation('Автоматизация остановлена: пресет очищен');
        this.log('🗑️  Пресет очищен');
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
                setTimeout(() => this.submitCaptcha(), 100);
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
            this.log('❌ Загрузите пресет (Ctrl+Shift+V)');
          }
        }

        // Ctrl+Shift+Z — немедленно начать новый цикл
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          this.restartAutomationCycle('ручной перезапуск');
        }

        // Ctrl+Shift+X — полностью остановить автоматизацию до нового Ctrl+Shift+V
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'x') {
          e.preventDefault();
          this.stopAutomation('Автоматизация полностью остановлена. Для нового запуска нажмите Ctrl+Shift+V', true);
        }

        // Ctrl+Shift+Enter для отправки капчи
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'Enter') {
          e.preventDefault();
          this.submitCaptcha();
        }
      });
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
        this.log('💾 Пресет сохранён в памяти вкладки');
      }
    }

    savePresetToStorage() {
      if (this.preset) {
        sessionStorage.setItem('visaBotPreset', JSON.stringify(this.preset));
        this.log('💾 Пресет сохранён в памяти вкладки');
      }
    }

    loadPresetFromStorage() {
      try {
        const saved = sessionStorage.getItem('visaBotPreset');
        if (saved) {
          this.preset = JSON.parse(saved);
          setTimeout(() => {
            this.showPresetStatus();
            this.log('✅ Пресет восстановлен из памяти вкладки');
          }, 100);
          return true;
        }
      } catch (e) {
        this.log('❌ Ошибка при восстановлении пресета');
        sessionStorage.removeItem('visaBotPreset');
      }
      return false;
    }

    log(message) {
      const logDiv = document.getElementById('visa-log');
      const timestamp = new Date().toLocaleTimeString('ru-RU');
      const entry = document.createElement('div');
      entry.textContent = `[${timestamp}] ${message}`;
      logDiv.appendChild(entry);
      logDiv.scrollTop = logDiv.scrollHeight;
    }

    startAutomation() {
      if (!this.preset) {
        this.log('❌ Сначала загрузите пресет');
        return;
      }
      this.manuallyStopped = false;
      this.automationEnabled = true;
      this.stopWaiting = false;
      sessionStorage.removeItem('visaAutomationManuallyStopped');
      sessionStorage.setItem('visaAutomationEnabled', 'true');
      this.armSuccessSound();
      this.log('🚀 Автоматический цикл запущен (Ctrl+Shift+X — остановить)');
      this.resumeAutomation();
    }

    stopAutomation(message, manual = false) {
      this.manuallyStopped = manual;
      this.automationEnabled = false;
      this.stopWaiting = true;
      this.restartPending = false;
      this.restartSourceForm = null;
      sessionStorage.removeItem('visaAutomationEnabled');
      if (manual) sessionStorage.setItem('visaAutomationManuallyStopped', 'true');
      else sessionStorage.removeItem('visaAutomationManuallyStopped');
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (this.captchaReloadTimer) {
        clearTimeout(this.captchaReloadTimer);
        this.captchaReloadTimer = null;
      }
      if (this.restartWatchdogTimer) {
        clearTimeout(this.restartWatchdogTimer);
        this.restartWatchdogTimer = null;
      }
      if (message) this.log(`⏹️ ${message}`);
    }

    watchForAutomationPage() {
      setInterval(() => this.resumeAutomation(), 350);
      setTimeout(() => this.resumeAutomation(), 0);
    }

    resumeAutomation() {
      if (!this.isAutomationActive() || !this.preset || this.isRunning || this.retryTimer) return;

      const captchaImage = this.findCaptchaImage();
      if (captchaImage && captchaImage.offsetParent !== null) {
        this.automationWaitState = 'captcha';
        this.submitFilledCaptchaForAutomation(captchaImage);
        return;
      }

      const serviceForm = this.getServiceSelectionForm();
      if (this.restartPending) {
        if (!serviceForm || serviceForm !== this.restartSourceForm) {
          this.restartPending = false;
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
        this.automationWaitState = 'service';
        this.run();
      }
    }

    findCaptchaImage() {
      return document.querySelector('img[alt="Weryfikacja obrazkowa"]') ||
        document.querySelector('img[alt*="Weryfikacja"]');
    }

    getServiceSelectionForm() {
      const labels = [...document.querySelectorAll('mat-label')]
        .map(label => String(label.textContent || '').trim().toLowerCase());
      if (!labels.some(label => label.includes('rodzaj usługi')) ||
          !labels.some(label => label.includes('lokalizacja'))) {
        return null;
      }
      return document.querySelector('app-visa-reservation-appointment-form form') ||
        document.querySelector('mat-select')?.closest('form') ||
        document.body;
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

    restartAutomationCycle(reason = 'повтор') {
      if (!this.preset) {
        this.log('❌ Сначала загрузите пресет');
        return;
      }
      if (!this.isAutomationActive()) {
        this.log('⏹️ Автоматизация остановлена. Ctrl+Shift+Z игнорируется; для запуска нажмите Ctrl+Shift+V');
        return;
      }
      this.stopWaiting = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      if (this.restartWatchdogTimer) {
        clearTimeout(this.restartWatchdogTimer);
        this.restartWatchdogTimer = null;
      }
      this.log(`🔄 ${reason}: возвращаюсь к началу цикла...`);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.isAutomationActive()) return;
        this.captchaOcrNotBefore = Date.now() + 1000;
        sessionStorage.setItem('visaCaptchaOcrNotBefore', String(this.captchaOcrNotBefore));
        this.captchaCandidateSource = null;
        this.captchaCandidateSince = 0;
        this.restartSourceForm = this.getServiceSelectionForm();
        this.restartPending = Boolean(this.restartSourceForm);
        if (!this.clickWizaKrajowa()) {
          this.restartPending = false;
          this.stopWaiting = false;
          this.log('⚠️ Не удалось найти ссылку Wiza krajowa; повторяю автоматически');
          this.restartAutomationCycle('ссылка Wiza krajowa ещё не готова');
        } else if (!this.restartPending) {
          this.stopWaiting = false;
        } else {
          this.restartWatchdogTimer = setTimeout(() => {
            this.restartWatchdogTimer = null;
            if (!this.isAutomationActive()) return;
            if (this.restartPending && this.getServiceSelectionForm() === this.restartSourceForm) {
              this.restartPending = false;
              this.restartSourceForm = null;
              this.stopWaiting = false;
              this.restartAutomationCycle('переход к новому циклу не завершился');
            }
          }, 3500);
        }
      }, 1100);
    }

    reloadAfterCaptchaError(reason) {
      if (this.captchaReloadTimer || !this.isAutomationActive()) return;
      this.captchaOcrNotBefore = Date.now() + 2500;
      sessionStorage.setItem('visaCaptchaOcrNotBefore', String(this.captchaOcrNotBefore));
      this.log(`🔄 ${reason}; перезагружаю страницу и беру новую капчу...`);
      this.captchaReloadTimer = setTimeout(() => {
        this.captchaReloadTimer = null;
        if (this.isAutomationActive()) window.location.reload();
      }, 900);
    }

    isAutomationActive() {
      return this.automationEnabled && !this.manuallyStopped;
    }

    async run() {
      if (this.isRunning) return;
      this.isRunning = true;

      document.getElementById('visa-progress').style.display = 'block';
      document.getElementById('visa-run-btn').disabled = true;

      try {
        this.updateProgress('Шаг 1/4: Выбор услуги...');
        if (!await this.selectByIndex(0, this.preset.rodzajUslugi)) {
          throw new Error('Не удалось выбрать услугу');
        }

        this.updateProgress('Шаг 2/4: Выбор локации...');
        if (!await this.selectByIndex(1, this.preset.lokalizacja)) {
          throw new Error('Не удалось выбрать локацию');
        }

        this.updateProgress('Шаг 3/4: Выбор количества...');
        if (!await this.selectByIndex(2, this.preset.ludzie)) {
          throw new Error('Не удалось выбрать количество');
        }

        this.updateProgress('Шаг 4/4: Выбор даты...');
        if (!await this.selectDate()) {
          throw new Error('Не удалось выбрать дату');
        }

        this.log('🎯 Свободный слот выбран, автоматические повторы остановлены');
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
          this.restartAutomationCycle(error.message);
        } else {
          this.log('❌ Ошибка: ' + error.message);
          this.showNotification('❌ ' + error.message, 'error');
        }
      } finally {
        this.isRunning = false;
        document.getElementById('visa-progress').style.display = 'none';
        document.getElementById('visa-run-btn').disabled = false;
      }
    }

    updateProgress(text) {
      document.getElementById('visa-progress-text').textContent = text;
      this.log(text);
    }

    async selectByIndex(selectIndex, searchValue) {
      const matSelects = document.querySelectorAll('mat-select');

      if (selectIndex >= matSelects.length) {
        return false;
      }

      const matSelect = matSelects[selectIndex];
      matSelect.click();
      let options = [];
      while (options.length === 0) {
        if (this.stopWaiting || !this.isAutomationActive()) return false;
        const loadError = this.findReservationError();
        if (loadError) throw new Error(`форма не загрузилась: ${loadError}`);
        options = [...document.querySelectorAll('mat-option[role="option"]')];
        if (options.length === 0) await this.delay(80);
      }

      for (const option of options) {
        if (!this.isAutomationActive()) return false;
        const optionText = option.textContent.trim();
        if (optionText.toLowerCase().includes(searchValue.toLowerCase())) {
          option.click();
          await this.delay(110);
          return true;
        }
      }

      return false;
    }

    async selectDate() {
      const matSelects = document.querySelectorAll('mat-select');
      const terminSelect = matSelects[3];

      if (!terminSelect) {
        return false;
      }

      // Ждём загрузки дат
      if (!await this.waitForDateOptions()) {
        return false;
      }

      terminSelect.click();
      await this.delay(200);

      const options = this.getAvailableDateOptions();

      if (options.length === 0) {
        this.log('❌ Даты не загрузились');
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
              option.click();
              await this.delay(110);
              this.log(`📅 Выбрана дата: ${optionText}`);
              return await this.clickDalejButton();
            }
          }
        }

        const dateList = Array.isArray(this.preset.data)
          ? this.preset.data.join(', ')
          : this.preset.data;
        this.log(`⚠️  Даты [${dateList}] не найдены, выбираю первую доступную`);
      }

      // Если даты нет в пресете или не найдена - выбрать первую
      if (options.length > 0) {
        const firstOption = options[0];
        firstOption.click();
        await this.delay(110);
        this.log(`📅 Выбрана первая доступная: ${firstOption.textContent.trim()}`);
        return await this.clickDalejButton();
      }

      return false;
    }

    async clickDalejButton() {
      await this.delay(220);
      if (!this.isAutomationActive()) return false;
      const buttons = document.querySelectorAll('button[mat-button]');
      for (const btn of buttons) {
        if (btn.textContent.includes('Dalej')) {
          this.log('✓ Нажимаю "Dalej"...');
          btn.click();
          await this.delay(400);
          return true;
        }
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
        return false;
      }

      if (Date.now() < this.captchaOcrNotBefore) return false;
      sessionStorage.removeItem('visaCaptchaOcrNotBefore');
      return Date.now() - this.captchaCandidateSince >= 750;
    }

    watchForCaptcha() {
      setInterval(() => {
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
      }, 500);
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
        this.log('🔎 Отправляю новую капчу локальному relay...');
        this.currentCaptchaSample = { image: source, predicted: '', taskId: null };
        const result = await this.requestCaptchaSolution(source);

        if (this.manuallyStopped) {
          this.log('⏹️ Ответ OCR отброшен: автоматизация остановлена');
          return;
        }
        if (!captchaImage.isConnected || captchaImage.src !== source || captchaImage.offsetParent === null) {
          this.log('ℹ️ Капча уже изменилась, старый ответ пропущен');
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
          this.log('✅ Капча распознана, отправляю форму');
          this.lastAutoSubmittedCaptcha = source;
          await this.delay(250);
          await this.submitCaptcha();
        } else {
          this.log('🔎 Капча заполнена — проверьте ответ и нажмите Enter');
        }
      } catch (error) {
        this.log(`⚠️ Автораспознавание не сработало: ${error.message}`);
        if (this.isAutomationActive()) {
          this.reloadAfterCaptchaError('капча не распознана');
        } else {
          this.log('✏️ Можно ввести капчу вручную');
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
      this.log('📚 Капча отправлена; жду подтверждения переходом к выбору услуги');
    }

    watchForCaptchaSuccess() {
      const check = () => this.confirmCaptchaFeedbackIfSuccessful();
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(check, 0);
    }

    confirmCaptchaFeedbackIfSuccessful() {
      const raw = sessionStorage.getItem('visaPendingCaptchaFeedback');
      if (!raw) return;

      let sample;
      try {
        sample = JSON.parse(raw);
      } catch {
        sessionStorage.removeItem('visaPendingCaptchaFeedback');
        return;
      }
      if (!sample.submittedAt || Date.now() - sample.submittedAt > 10 * 60 * 1000) {
        sessionStorage.removeItem('visaPendingCaptchaFeedback');
        return;
      }

      const labels = [...document.querySelectorAll('mat-label')]
        .map(label => String(label.textContent || '').trim().toLowerCase());
      const isServiceSelectionPage =
        !document.querySelector('img[alt="Weryfikacja obrazkowa"], img[alt*="Weryfikacja"]') &&
        labels.some(label => label.includes('rodzaj usługi')) &&
        labels.some(label => label.includes('lokalizacja'));
      if (!isServiceSelectionPage || this.reportedCaptchaSources.has(sample.image)) return;

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
            this.log('📚 Сайт принял капчу — успешный пример сохранён');
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
        this.log('⏹️ Отправка отменена: автоматизация остановлена');
        return;
      }
      this.stageCaptchaFeedback();
      this.log('✓ Отправляю капчу...');
      await this.delay(200);
      if (this.manuallyStopped) return;

      // Нажимаем Dalej
      const buttons = document.querySelectorAll('button[mat-button]');
      for (const btn of buttons) {
        if (btn.textContent.includes('Dalej')) {
          this.log('✓ Нажимаю "Dalej"...');
          btn.click();
          await this.delay(700);
          return;
        }
      }

      this.log('❌ Кнопка "Dalej" не найдена');
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
        this.log('✏️ Фокус на поле капчи');
      } else {
        this.log('❌ Поле капчи не найдено');
      }
    }

    clickWizaKrajowa() {
      const link = document.querySelector('a[href$="/wiza-krajowa"]');

      if (link) {
        this.stopWaiting = true;
        this.skipReload = true;
        this.log('🔗 Открываю Wiza krajowa для нового цикла...');
        link.click();
        return true;
      } else {
        this.log('❌ Ссылка "Wiza krajowa" не найдена');
        return false;
      }
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

    async waitForDateOptions() {
      const matSelects = document.querySelectorAll('mat-select');
      const terminSelect = matSelects[3];

      if (!terminSelect) return false;

      let attempts = 0;
      this.log('⏳ Ожидаю доступные даты без ограничения времени и без перезагрузки...');
      terminSelect.click();
      await this.delay(100);

      while (true) {
        // Проверяем флаг прерывания
        if (this.stopWaiting || !this.isAutomationActive()) {
          this.log('⏹️  Ожидание прервано');
          return false;
        }

        const loadError = this.findReservationError();
        if (loadError) {
          throw new Error(`слоты не получены: ${loadError}`);
        }

        const options = this.getAvailableDateOptions();
        if (options.length > 0) {
          terminSelect.click(); // закрыть после проверки
          await this.delay(100);
          this.log(`✓ Даты загружены (${options.length} вариантов)`);
          return true;
        }

        attempts++;
        if (attempts % 4 === 0 && terminSelect.getAttribute('aria-expanded') !== 'true') {
          terminSelect.click();
        }
        if (attempts % 120 === 0) {
          this.log('⏳ Страница ещё загружается; жду слоты или сообщение об ошибке...');
        }
        await this.delay(180);
      }
    }

    delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
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
        setTimeout(() => {
          window.visaBot = new VisaAutomationUI();
        }, 500);
      });
    } else {
      setTimeout(() => {
        window.visaBot = new VisaAutomationUI();
      }, 500);
    }
  }

  initVisa();
})();
