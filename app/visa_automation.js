/**
 * Скрипт автоматизации заполнения формы визы на e-konsulat
 * Запустить в консоли браузера (F12 -> Console)
 *
 * Hotkey: Ctrl+Shift+V для запуска автоматизации
 *
 * Конфигурация:
 * window.visaBot.config.datePresets - массив дат для поиска
 * window.visaBot.config.selections - значения для выбора
 */

const CONFIG = {
  // Пресеты доступных дат (будет выбрана первая найденная)
  datePresets: [
    '2026-04-29', '2026-04-28'
  ],
  // Значения для выбора (названия опций из списков)
  selections: {
    visaType: 'Wiza krajowa - korzystanie z uprawnień wynikających z posiadania Karty Polaka',  // будет найдена опция содержащая это слово
    city: 'Moskwa',             // город
    people: '1 osob',          // количество людей
  }
};

class VisaAutomation {
  constructor() {
    this.isRunning = false;
    this.config = CONFIG;
    this.setupHotkey();
  }

  setupHotkey() {
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      const v = e.key.toLowerCase() === 'v';

      if (ctrl && shift && v && !this.isRunning) {
        e.preventDefault();
        this.run();
      }
    });
    console.log('✅ Visa automation готов. Нажмите Ctrl+Shift+V для запуска');
    console.log('⚙️  Конфигурация доступна в window.visaBot.config');
  }

  async run() {
    this.isRunning = true;
    console.log('🚀 Запуск автоматизации...\n');

    try {
      // Шаг 1: Выбрать тип визы
      console.log('📋 Шаг 1/4: Выбор типа визы (Karty Polaka)...');
      if (!await this.selectByIndex(0, this.config.selections.visaType)) {
        throw new Error('Не удалось выбрать тип визы');
      }

      // Шаг 2: Выбрать город
      await this.delay(600);
      console.log('🏙️  Шаг 2/4: Выбор города (Moskwa)...');
      if (!await this.selectByIndex(1, this.config.selections.city)) {
        throw new Error('Не удалось выбрать город');
      }

      // Шаг 3: Выбрать количество людей
      await this.delay(600);
      console.log('👥 Шаг 3/4: Выбор количества людей (1 osoba)...');
      if (!await this.selectByIndex(2, this.config.selections.people)) {
        throw new Error('Не удалось выбрать количество людей');
      }

      // Шаг 4: Выбрать дату
      await this.delay(600);
      console.log('📅 Шаг 4/4: Выбор даты из пресетов...');
      if (!await this.selectDate()) {
        throw new Error('Доступные даты не найдены в пресетах');
      }

      console.log('\n✅ Все параметры успешно выбраны!');
      this.showNotification('✅ Автоматизация завершена!', 'success');

    } catch (error) {
      console.error(`\n❌ Ошибка: ${error.message}`);
      this.showNotification(`❌ Ошибка: ${error.message}`, 'error');
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Выбрать опцию из N-го селекта на странице
   * @param {number} selectIndex - индекс селекта (0 = первый, 1 = второй и т.д.)
   * @param {string} searchValue - текст для поиска в опциях
   */
  async selectByIndex(selectIndex, searchValue) {
    try {
      // Найти все mat-select элементы
      const matSelects = document.querySelectorAll('mat-select');

      if (selectIndex >= matSelects.length) {
        console.error(`❌ Селект с индексом ${selectIndex} не найден`);
        return false;
      }

      const matSelect = matSelects[selectIndex];
      console.log(`  → Открыт селект #${selectIndex + 1}`);

      // Клик на селект для открытия
      matSelect.click();
      await this.delay(400);

      // Найти опции в открытом панели
      const options = document.querySelectorAll('mat-option[role="option"]');
      console.log(`  → Найдено опций: ${options.length}`);

      // Найти и выбрать опцию содержащую searchValue
      let found = false;
      for (const option of options) {
        const optionText = option.textContent.trim();
        if (optionText.toLowerCase().includes(searchValue.toLowerCase())) {
          console.log(`  ✓ Выбрана: "${optionText}"`);
          option.click();
          await this.delay(300);
          found = true;
          break;
        }
      }

      if (!found) {
        console.warn(`  ⚠️  Опция содержащая "${searchValue}" не найдена`);
        console.log(`  Доступные опции:`);
        for (let i = 0; i < options.length; i++) {
          console.log(`    ${i + 1}. ${options[i].textContent.trim()}`);
        }
        return false;
      }

      return true;

    } catch (error) {
      console.error(`  ❌ Ошибка при выборе: ${error.message}`);
      return false;
    }
  }

  /**
   * Выбрать дату из "Termin" селекта
   */
  async selectDate() {
    try {
      // Найти все mat-select элементы (4-й селект - это "Termin")
      const matSelects = document.querySelectorAll('mat-select');
      const terminSelect = matSelects[3];

      if (!terminSelect) {
        console.warn('  ⚠️  Селект "Termin" не найден');
        return false;
      }

      console.log(`  → Открыт селект "Termin"`);

      // Открыть селект
      terminSelect.click();
      await this.delay(400);

      // Получить все доступные даты
      const options = document.querySelectorAll('mat-option[role="option"]');
      console.log(`  → Доступно дат: ${options.length}`);

      // Попытаться выбрать дату из пресетов
      for (const preset of this.config.datePresets) {
        for (const option of options) {
          const optionText = option.textContent.trim();
          if (optionText.includes(preset)) {
            console.log(`  ✓ Выбрана дата: "${optionText}"`);
            option.click();
            await this.delay(300);
            return true;
          }
        }
      }

      // Если ничего не найдено, показать доступные даты
      console.warn(`  ⚠️  Даты из пресетов не найдены`);
      console.log(`  Доступные даты:`);
      for (let i = 0; i < Math.min(5, options.length); i++) {
        console.log(`    ${i + 1}. ${options[i].textContent.trim()}`);
      }
      if (options.length > 5) {
        console.log(`    ... и ещё ${options.length - 5} дат`);
      }

      return false;

    } catch (error) {
      console.error(`  ❌ Ошибка при выборе даты: ${error.message}`);
      return false;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
      z-index: 10000;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: slideIn 0.3s ease;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);

    setTimeout(() => {
      notification.style.opacity = '0';
      notification.style.transition = 'opacity 0.3s ease';
      setTimeout(() => notification.remove(), 300);
    }, 3500);
  }
}

// Инициализация
if (!window.visaBot) {
  window.visaBot = new VisaAutomation();
  console.log('\n💡 Команды:');
  console.log('  window.visaBot.run()              - запустить сейчас');
  console.log('  window.visaBot.config.selections  - изменить значения для выбора');
  console.log('  window.visaBot.config.datePresets - изменить пресеты дат\n');
} else {
  console.log('ℹ️  Visa automation уже загружена');
}
