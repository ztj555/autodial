@echo off
echo Building AutoDial Cloud Relay EXE...
echo.

"C:\Users\EDY\.workbuddy\binaries\python\versions\3.11.9\Scripts\pyinstaller.exe" ^
  --onefile ^
  --windowed ^
  --name "AutoDial-Cloud-Relay" ^
  cloud_relay_v2.py

echo.
echo Build complete! Output: dist\AutoDial-Cloud-Relay.exe
echo.
echo Usage: AutoDial-Cloud-Relay.exe [--port PORT]
echo Default port: 35430
echo.
pause
