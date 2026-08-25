@echo off
setlocal
cd /d "%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the current Node.js LTS release and run this file again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

set "PYTHON_CMD=python"
where python.exe >nul 2>nul
if errorlevel 1 (
  where py.exe >nul 2>nul
  if errorlevel 1 (
    echo Python is not installed. Install 64-bit Python 3.11 and run this file again.
    echo https://www.python.org/downloads/windows/
    pause
    exit /b 1
  )
  set "PYTHON_CMD=py -3.11"
)

if not exist ".venv-paddle\Scripts\python.exe" (
  echo Creating the local Python environment...
  %PYTHON_CMD% -m venv .venv-paddle
  if errorlevel 1 goto :failed
)

echo Installing PaddleOCR locally. This can take several minutes...
".venv-paddle\Scripts\python.exe" -m pip install -r requirements-paddle.txt
if errorlevel 1 goto :failed

echo.
echo Installation complete.
echo Next: run start-captcha-relay.cmd and add script.js to Tampermonkey.
pause
exit /b 0

:failed
echo.
echo Installation failed. Review the error above, then run install.cmd again.
pause
exit /b 1
