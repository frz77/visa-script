# Local PaddleOCR CAPTCHA recognition

## What is installed

The relay uses a persistent local PaddleOCR worker with the
`PP-OCRv5_mobile_rec` model. CapMonster fallback is disabled by default, so
local recognition does not spend account balance.

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
CAPMONSTER_RELAY_PORT=3210
CAPMONSTER_AUTO_SUBMIT=false
PADDLE_OCR_ENABLED=true
PADDLE_OCR_MIN_CONFIDENCE=0
CAPMONSTER_FALLBACK_ENABLED=false
```

`CAPMONSTER_API` is not required while the fallback is disabled. Keep
`CAPMONSTER_FALLBACK_ENABLED=false` during local testing to guarantee that no
paid task is created.

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
`CAPMONSTER_AUTO_SUBMIT=true` is explicitly enabled.

## Dataset rule

Pressing Enter or clicking `Dalej` only stages a candidate sample. It is written
to `captcha-dataset/` only after the CAPTCHA disappears and the site actually
shows the service-selection page containing both `Rodzaj usługi` and
`Lokalizacja`. Rejected answers therefore do not enter the successful dataset.

## Stop

Close the relay console or press `Ctrl+C` in it.
