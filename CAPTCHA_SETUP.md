# Local PaddleOCR CAPTCHA recognition

## What is installed

The relay uses a persistent local PaddleOCR worker with the
`PP-OCRv5_mobile_rec` model. Recognition is fully local and no external CAPTCHA
service or API key is used.

The isolated Python environment is stored in `.venv-paddle/`, and downloaded
models are stored in `.paddlex/`. Nothing needs to be installed globally.

To recreate the environment later:

```powershell
python -m venv .venv-paddle
.\.venv-paddle\Scripts\python.exe -m pip install -r requirements-paddle.txt
```

## Settings

Optional `.env` settings:

```dotenv
CAPTCHA_RELAY_PORT=3210
CAPTCHA_AUTO_SUBMIT=false
PADDLE_OCR_ENABLED=true
PADDLE_OCR_MIN_CONFIDENCE=0
PADDLE_OCR_VERBOSE=false
```

## Start

Double-click `start-captcha-relay.cmd` and leave its console window open. One
relay process serves all browser profiles.

Health check:

```text
http://127.0.0.1:3210/health
```

Copy `script.js` into Tampermonkey in each browser profile. Allow its request to
connect to `127.0.0.1` if the browser asks.

The userscript sends each four-character CAPTCHA to the local relay. PaddleOCR
fills the input; verification mode leaves final submission to you unless
`CAPTCHA_AUTO_SUBMIT=true` is explicitly enabled.

When the automatic cycle is started with `Ctrl+Shift+V`, a recognized CAPTCHA
is submitted automatically even when the global auto-submit setting is off.
The script then fills the service, location and applicant-count fields, waits
without a fixed timeout for either date options or an explicit site error, and
selects a matching or the first available date. An explicit no-slots/load error
starts a fresh `Wiza krajowa` cycle.

Hotkeys:

- `Ctrl+Shift+V` — start or resume automatic mode with the loaded preset.
- `Ctrl+Shift+Z` — immediately restart from `Wiza krajowa`.
- `Ctrl+Shift+X` — stop automatic retries.

## Dataset rule

Pressing Enter or clicking `Dalej` only stages a candidate sample. It is written
to `captcha-dataset/` only after the CAPTCHA disappears and the site actually
shows the service-selection page containing both `Rodzaj usługi` and
`Lokalizacja`. Rejected answers therefore do not enter the successful dataset.

## Stop

Close the relay console or press `Ctrl+C` in it.
