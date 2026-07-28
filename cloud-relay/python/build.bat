@echo off
echo ========================================
echo   AutoDial Cloud Relay - 编译 EXE
echo ========================================
echo.

:: 检测 Python (优先使用 PATH 中的 python)
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.9+
    pause
    exit /b 1
)

echo [1/3] 安装编译依赖...
python -m pip install -q pyinstaller Pillow pystray websockets aiohttp 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
)

echo [2/3] 清理旧的编译产物...
if exist build rmdir /s /q build
if exist dist rmdir /s /q dist

echo [3/3] 开始编译...
python -m PyInstaller ^
  --onefile ^
  --windowed ^
  --name "AutoDial-Cloud-Relay" ^
  --add-data "dashboard.html;." ^
  --hidden-import pystray._win32 ^
  --hidden-import PIL._imaging ^
  --hidden-import aiohttp ^
  --hidden-import websockets ^
  --clean ^
  cloud_relay_v2.py

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo   编译成功！
    echo   输出文件: dist\AutoDial-Cloud-Relay.exe
    echo ========================================
    echo.
    echo 使用方法: 双击运行，系统托盘会出现绿色圆点图标
    echo           右键图标可打开 Web 管理界面
    echo.
) else (
    echo.
    echo [错误] 编译失败，请检查上方错误信息
)

pause
