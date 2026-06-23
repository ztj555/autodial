@echo off
cd /d "%~dp0"

node_modules\electron\dist\electron.exe .

echo.
echo Exit code: %errorlevel%
pause
