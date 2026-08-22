'use strict';
/**
 * 设置管理模块
 * 
 * 用法:
 *   const settings = require('./modules/settings');
 *   const appSettings = settings.init(app);  // 返回可变的 appSettings 对象引用
 *   settings.saveSettings(appSettings);
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_SETTINGS = {
  closeAction: 'minimize',   // 'minimize' | 'exit'
  trayExit: true,            // 托盘右键退出直接退出程序
  autoStart: false,          // 开机自启动
  silentStart: false,        // 隐藏界面启动
theme: 'sky-blue',        // 主题ID
mode: 'light',              // 显示模式 dark/dusk/dawn/twilight/warm/mist/light
  phoneNotes: {},            // 手机备注 { "pin|name": "备注" }
  cloudServer: '',           // 云中转服务器地址
  cloudEnabled: false,       // 是否启用云中转
  cloudServers: []           // 多云服务器列表
};

let _SETTINGS_FILE = null;

function getSettingsFile(app) {
  if (!_SETTINGS_FILE) {
    try {
      _SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
    } catch (e) {
      return '';
    }
  }
  return _SETTINGS_FILE;
}

function loadSettings(app) {
  try {
    const f = getSettingsFile(app);
    if (fs.existsSync(f)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings, app) {
  try {
    fs.writeFileSync(getSettingsFile(app), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {}
}

/**
 * 初始化设置模块，返回应用设置对象
 * 包含向后兼容检查和修复
 */
function init(app) {
  const appSettings = loadSettings(app);

  // 同步 cloudServer 到 cloudServers（向后兼容）
  if (appSettings.cloudServer && (!Array.isArray(appSettings.cloudServers) || appSettings.cloudServers.length === 0)) {
    appSettings.cloudServers = [appSettings.cloudServer];
    console.log("[云端] 从 cloudServer 同步到 cloudServers: " + appSettings.cloudServer);
  }

  // 如果 cloudEnabled 为 true 但实际没有配置服务器，自动清除标志
  const hasConfiguredServers = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0;
  if (appSettings.cloudEnabled && !hasConfiguredServers) {
    console.log("[云端] cloudEnabled=true 但没有配置服务器，清除标志");
    appSettings.cloudEnabled = false;
  }

  saveSettings(appSettings, app);

  return appSettings;
}

/**
 * 云端地址标准化 — 纯 IP:PORT 自动补协议
 */
function normalizeCloudUrl(addr) {
  if (!addr) return '';
  const clean = (addr || '').trim().replace(/^(https?|wss?):\/\//i, '');
  if (/^ws:\/\//i.test(addr)) return addr;
  if (/^wss:\/\//i.test(addr)) return addr;
  return 'ws://' + clean;
}

module.exports = {
  DEFAULT_SETTINGS,
  init,
  loadSettings,
  saveSettings,
  normalizeCloudUrl
};
