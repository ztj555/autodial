@echo off
chcp 65001 >nul
cd /d "%~dp0"

set ELECTRON=%USERPROFILE%\Videos\electron-v28.3.3-win32-x64\electron.exe

if not exist "%ELECTRON%" (
    echo [ERROR] Electron not found: %ELECTRON%
    pause
    exit /b 1
)

echo ========================================
echo   AutoDial PC v4 - Electron
echo ========================================

:: Kill any existing instance
taskkill /f /im AutoDial.exe >nul 2>&1
taskkill /f /im electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [INFO] Starting Electron...
start "" "%ELECTRON%" .

echo [INFO] Launcher exited.
exit /b 0
