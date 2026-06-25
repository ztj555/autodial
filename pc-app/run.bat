@echo off
cd /d "%~dp0"

set ELECTRON=%USERPROFILE%\Videos\electron-v28.3.3-win32-x64\electron.exe

if not exist "%ELECTRON%" (
    echo [ERROR] Electron not found at %ELECTRON%
    echo Please check the path in run.bat
    pause
    exit /b 1
)

"%ELECTRON%" .

echo.
echo Exit code: %errorlevel%
pause
