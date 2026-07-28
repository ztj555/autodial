'use strict';
/**
 * 窗口管理模块 — 纯工厂函数，不包含事件处理
 * 事件绑定由 main.js 负责
 */

const { BrowserWindow, screen } = require('electron');
const path = require('path');

/**
 * 创建主窗口
 */
function createMainWindow(preloadPath, rendererDir) {
  const win = new BrowserWindow({
    width: 420,
    height: 780,
    minWidth: 210,
    minHeight: 350,
    frame: false,
    transparent: false,
    backgroundColor: '#111318',
    resizable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(rendererDir, 'index.html'));
  win.setMenuBarVisibility(false);
  return win;
}

/**
 * 创建悬浮条窗口
 */
function createFloatBarWindow(preloadPath, rendererDir) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  const mainW = 420, mainH = 780;
  const barW = 440, barH = 48;
  const mainX = Math.round((screenW - mainW) / 2);
  const mainY = Math.round((screenH - mainH) / 2);
  const initialX = mainX + mainW + 8;
  const initialY = mainY + 36 + 8;

  const win = new BrowserWindow({
    width: barW,
    height: barH,
    x: initialX,
    y: initialY,
    frame: false,
    transparent: true,
    resizable: true,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(rendererDir, 'floatbar.html'));
  win.setIgnoreMouseEvents(false);
  win.setVisibleOnAllWorkspaces(true);
  return win;
}

/**
 * 创建设置窗口
 */
function createSettingsWindow(preloadPath, rendererDir) {
  const win = new BrowserWindow({
    width: 380,
    height: 420,
    minWidth: 320,
    minHeight: 350,
    frame: false,
    transparent: false,
    resizable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(rendererDir, 'settings.html'));
  win.setMenuBarVisibility(false);
  return win;
}

/**
 * 创建短信窗口
 */
function createSmsWindow(preloadPath, rendererDir) {
  const win = new BrowserWindow({
    width: 420,
    height: 680,
    minWidth: 320,
    minHeight: 400,
    frame: false,
    transparent: false,
    resizable: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(rendererDir, 'sms.html'));
  win.setMenuBarVisibility(false);
  return win;
}

module.exports = {
  createMainWindow,
  createFloatBarWindow,
  createSettingsWindow,
  createSmsWindow
};
