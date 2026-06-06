@echo off
chcp 65001 >nul
title AutoDial Cloud Relay v2

REM === Get current directory ===
set "EXE_DIR=%~dp0"
cd /d "%EXE_DIR%"

REM === Check python ===
set "PYTHON="
for /f "delims=" %%p in ('where python 2^>nul') do set "PYTHON=%%p"
if "%PYTHON%"=="" (
    for /f "delims=" %%p in ('where python3 2^>nul') do set "PYTHON=%%p"
)
if "%PYTHON%"=="" (
    echo [Error] Python not found. Please install Python 3.8+ and add to PATH.
    echo Visit: https://www.python.org/downloads/
    pause
    exit /b 1
)

REM === Check cloud_relay.py ===
if not exist "%EXE_DIR%\python\cloud_relay.py" (
    echo [Error] python\cloud_relay.py not found.
    pause
    exit /b 1
)

REM === Parse args ===
set PORT=35430
:parse_args
if "%~1"=="" goto :start
if "%~1"=="--port" (
    set PORT=%~2
    shift
    shift
    goto :parse_args
)
if "%~1"=="-p" (
    set PORT=%~2
    shift
    shift
    goto :parse_args
)
shift
goto :parse_args

:start
REM === Start server (no console output — quiet mode) ===
set PYTHONUNBUFFERED=1
"%PYTHON%" -B "%EXE_DIR%\python\cloud_relay.py" --port %PORT%

REM If python exits unexpectedly, pause for error reading
pause
