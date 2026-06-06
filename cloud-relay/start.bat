@echo off
chcp 65001 >nul
title AutoDial 云中转服务器

REM === 获取当前目录 ===
set "EXE_DIR=%~dp0"
cd /d "%EXE_DIR%"

REM === 检查 node.exe ===
if not exist "%EXE_DIR%\node.exe" (
    echo [错误] 未找到 node.exe！
    echo.
    echo 请按照以下步骤操作：
    echo 1. 访问 https://nodejs.org/dist/v18.20.0/
    echo 2. 下载 node-v18.20.0-win-x64.zip
    echo 3. 解压后将 node.exe 放到此目录下
    echo.
    pause
    start https://nodejs.org/dist/v18.20.0/
    exit /b 1
)

REM === 检查 server.js ===
if not exist "%EXE_DIR%\server.js" (
    echo [错误] 未找到 server.js！
    pause
    exit /b 1
)

REM === 解析命令行参数 ===
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
REM === 显示启动信息 ===
echo.
echo ================================
echo  AutoDial 云中转服务器
echo ================================
echo.
echo  监听端口：%PORT%
echo.
echo  请确保防火墙已放行此端口
echo  按 Ctrl+C 停止服务器
echo.
echo ================================
echo.

REM === 启动服务器 ===
"%EXE_DIR%\node.exe" "%EXE_DIR%\server.js" --port %PORT%

pause
