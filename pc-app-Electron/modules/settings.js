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
let _lastLoadError = null;

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
  _lastLoadError = null;
  try {
    const f = getSettingsFile(app);
    if (fs.existsSync(f)) {
      const raw = fs.readFileSync(f, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return { ...DEFAULT_SETTINGS, ...parsed };
        }
      } catch (parseErr) {
        // P-9 修复：解析失败绝不能静默丢弃用户配置。先把损坏文件另存备份
        // （用户仍可人工从备份里找回配对码 / 云服务器 / 备注），再回退默认值。
        _lastLoadError = parseErr;
        try {
          const bak = f + '.corrupt-' + Date.now();
          fs.copyFileSync(f, bak);
          console.error('[设置] settings.json 解析失败，原文件已备份至: ' + bak + ' | ' + parseErr.message);
        } catch (e2) {
          console.error('[设置] settings.json 解析失败且备份失败: ' + (e2 && e2.message));
        }
      }
    }
  } catch (e) {
    _lastLoadError = e;
    console.error('[设置] 读取 settings.json 失败: ' + (e && e.message));
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings, app) {
  // P-9 修复：
  //   1) 原子写——先写同目录临时文件再 rename，避免断电/崩溃把原文件写成半个 JSON；
  //   2) 不再静默吞错——失败返回 false 并打日志，调用方有机会提示用户。
  const f = getSettingsFile(app);
  if (!f) return false;
  const tmp = f + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, f);   // 同分区 rename 是原子的；失败则原文件不受影响
    return true;
  } catch (e) {
    console.error('[设置] 保存失败: ' + (e && e.message));
    try { fs.unlinkSync(tmp); } catch (e2) {}
    return false;
  }
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

  // P-9 修复：只在"加载成功"或"文件本就不存在"时才写回。
  // 若刚才是解析失败（已备份），绝不写回——否则会用默认值覆盖掉唯一一份现场，
  // 用户再也无法从文件里找回自己的配对码与配置。
  if (_lastLoadError) {
    console.warn('[设置] 本次启动使用默认设置，且不覆盖原文件（原文件已备份，请人工检查）');
  } else {
    saveSettings(appSettings, app);
  }

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
