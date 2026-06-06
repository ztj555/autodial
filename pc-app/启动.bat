@echo off
chcp 65001 >nul 2>&1
title AutoDial 电脑端
echo ============================================
echo    AutoDial 电脑端 - 一键启动
echo ============================================
echo.

cd /d "%~dp0"

:: 检查 node_modules
if not exist "node_modules" (
    echo [安装] 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络连接
        pause
        exit /b 1
    )
    echo [完成] 依赖安装成功
    echo.
)

:: 启动 Electron
echo [启动] AutoDial 电脑端...
echo.
call npx electron .
