# e-Konsulat Visa Automation

Локальный помощник для поиска свободного визового слота на e-Konsulat:

- Tampermonkey заполняет параметры записи и постоянно повторяет поиск;
- PaddleOCR локально распознаёт четырёхсимвольную CAPTCHA;
- после выбора даты скрипт нажимает `Dalej`, подаёт сигнал и останавливается;
- дальнейшее заполнение анкеты остаётся ручным.

Внешние CAPTCHA-сервисы и API-ключи не используются.

## Структура

```text
script.js                 основной userscript для Tampermonkey
captcha-relay.js          локальный HTTP relay
paddle-ocr-worker.py      постоянный процесс PaddleOCR
start-captcha-relay.cmd   запуск relay двойным кликом
presets/                  JSON-пресеты
tests/                    автоматические тесты userscript
captcha-dataset/          локальные подтверждённые CAPTCHA (не в Git)
```

## Установка

Relay использует постоянный локальный worker с моделью
`PP-OCRv5_mobile_rec`.

Изолированное Python-окружение хранится в `.venv-paddle/`, загруженные модели —
в `.paddlex/`. Глобальная установка пакетов не требуется.

Чтобы пересоздать окружение:

```powershell
python -m venv .venv-paddle
.\.venv-paddle\Scripts\python.exe -m pip install -r requirements-paddle.txt
```

## Настройки

Необязательные параметры `.env`:

```dotenv
CAPTCHA_RELAY_PORT=3210
CAPTCHA_AUTO_SUBMIT=false
PADDLE_OCR_ENABLED=true
PADDLE_OCR_MIN_CONFIDENCE=0
PADDLE_OCR_VERBOSE=false
```

## Запуск

Запустите `start-captcha-relay.cmd` и оставьте консоль открытой. Один relay
обслуживает все профили браузера.

Проверка состояния:

```text
http://127.0.0.1:3210/health
```

Скопируйте `script.js` в Tampermonkey каждого профиля. Если браузер спросит
разрешение на обращение к `127.0.0.1`, разрешите его.

Загрузите нужный JSON из `presets/` через панель userscript и нажмите
`Ctrl+Shift+V`.

В автоматическом режиме распознанная CAPTCHA отправляется независимо от
глобального `CAPTCHA_AUTO_SUBMIT`. Скрипт выбирает услугу, город и число людей,
ждёт даты и выбирает заданную или первую доступную. Сообщение
`Chwilowo wszystkie udostępnione terminy zostały zarezerwowane` автоматически
начинает новый цикл через `Wiza krajowa`.

## Горячие клавиши

- `Ctrl+Shift+V` — запустить автоматический режим с загруженным пресетом.
- `Ctrl+Shift+Z` — начать новый цикл через `Wiza krajowa`, пока режим активен.
- `Ctrl+Shift+X` — полностью остановить автоматизацию. После этого
  `Ctrl+Shift+Z` игнорируется; новый запуск выполняется через `Ctrl+Shift+V`.

## Набор CAPTCHA

При отправке CAPTCHA изображение сначала считается кандидатом. Оно записывается
в `captcha-dataset/` только после появления реальной видимой формы выбора услуги:
видимых полей `Rodzaj usługi`, `Lokalizacja` и активных списков выбора. Если сайт
показывает новую CAPTCHA, предыдущий ответ считается отклонённым и не
сохраняется. Форма должна оставаться доступной не менее 800 мс, поэтому
кратковременное исчезновение неправильной CAPTCHA также не считается успехом.

## Проверка

```powershell
npm test
```

Для оценки PaddleOCR на накопленных примерах:

```powershell
.\.venv-paddle\Scripts\python.exe benchmark-paddle.py
```

## Остановка

В браузере нажмите `Ctrl+Shift+X`. Relay останавливается через `Ctrl+C` в его
консоли.
