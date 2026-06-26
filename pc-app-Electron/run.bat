@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   AutoDial PC v4 (Electron)
echo ========================================

:: Check node_modules exists
if not exist "node_modules\electron\dist\electron.exe" (
    echo [ERROR] Electron not found at node_modules\electron\dist\electron.exe
    echo Please run: npm install
    pause
    exit /b 1
)

:: Kill any existing instance (prevents "single instance" lock)
taskkill /f /im AutoDial.exe >nul 2>&1
taskkill /f /im electron.exe >nul 2>&1
timeout /t 1 /nobreak >nul

echo [INFO] Starting Electron...
start "" "node_modules\electron\dist\electron.exe" .

echo [INFO] AutoDial launcher started in background.
exit /b 0
