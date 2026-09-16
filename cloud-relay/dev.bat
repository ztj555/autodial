@echo off
REM =====================================================================
REM  AutoDial Cloud Relay - local development launcher
REM  See devwatch.py for details (auto restart on file change).
REM
REM  NOTE: keep this file pure ASCII. cmd.exe mis-parses batch files that
REM  contain multi-byte (Chinese) characters, which corrupts line parsing
REM  and breaks "set"/"goto". All Chinese messages live in devwatch.py.
REM =====================================================================
chcp 65001 >nul
setlocal enabledelayedexpansion
title AutoDial Cloud Relay - DEV

cd /d "%~dp0"

set "VENV_PY=%~dp0.venv\Scripts\python.exe"

if not exist "%VENV_PY%" goto bootstrap
"%VENV_PY%" -c "import websockets" >nul 2>nul
if errorlevel 1 goto deps
goto run

:bootstrap
echo.
echo   [dev] First run: preparing local environment (about 30 seconds) ...
echo.
set "BASEPY="
where py >nul 2>nul
if not errorlevel 1 set "BASEPY=py"
if not defined BASEPY (
    where python >nul 2>nul
    if not errorlevel 1 set "BASEPY=python"
)
if not defined BASEPY (
    echo   [x] Python not found. Install Python 3.9+ and tick "Add Python to PATH"
    echo       https://www.python.org/downloads/
    echo.
    pause
    exit /b 1
)
echo   [dev] Creating virtualenv .venv with "!BASEPY!" ...
!BASEPY! -m venv "%~dp0.venv"
if errorlevel 1 (
    echo   [x] Failed to create virtualenv
    pause
    exit /b 1
)

:deps
echo   [dev] Installing dependency: websockets ...
"%VENV_PY%" -m pip install --quiet --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
"%VENV_PY%" -m pip install "websockets>=12,<14" -i https://pypi.tuna.tsinghua.edu.cn/simple
if errorlevel 1 (
    echo   [x] pip install failed, please check your network
    pause
    exit /b 1
)

:run
set "PYTHONUTF8=1"
"%VENV_PY%" "%~dp0devwatch.py" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
    echo.
    echo   [dev] exit code %RC%
    pause
)
exit /b %RC%
