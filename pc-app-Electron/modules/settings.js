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
  theme: 'dark-gold',        // 主题ID
  mode: 'dark',              // 显示模式 dark/dusk/dawn/twilight/warm/mist/light
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

/**
 * 一键获取云服务器列表（从 Gist/Gitee）
 */
function fetchCloudServers(appSettings, app) {
  const https = require('https');
  const sources = [
    'https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt',
    'https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt'
  ];
  for (const url of sources) {
    try {
      https.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) return;
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          const servers = [];
          for (let line of body.split('\n')) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            if (/^\[.+\]$/.test(line)) continue;
            line = line.replace(/新云端|老云端/g, '').trim();
            if (!line) continue;
            line = line.replace(/^(https?|wss?):\/\//i, '');
            if (!line.includes(':')) line += ':35430';
            servers.push(line);
          }
          if (servers.length > 0) {
            appSettings.cloudServers = servers;
            appSettings.cloudServer = servers[0];
            saveSettings(appSettings, app);
            console.log('[云端] 一键获取到 ' + servers.length + ' 个服务器: ' + servers.join(', '));
          }
        });
      }).on('error', () => {});
      return;
    } catch (e) {}
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  init,
  loadSettings,
  saveSettings,
  normalizeCloudUrl,
  fetchCloudServers
};
