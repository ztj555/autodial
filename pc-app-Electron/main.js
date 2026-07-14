'use strict';
/**
 * AutoDial PC v6 — 主入口
 * 
 * 模块化架构:
 *   modules/logger.js        — 文件日志
 *   modules/settings.js      — 设置持久化
 *   modules/network.js       — 网络工具 + PIN_CODE 状态
 *   modules/phone-notes.js   — 手机备注
 *   modules/tray.js          — 系统托盘
 *   modules/windows.js       — 窗口工厂
 *   modules/firewall.js      — 防火墙规则
 *   modules/discovery.js     — UDP 广播发现
 *   modules/cloud.js         — 云中转连接管理
 *   modules/server.js        — HTTP + WebSocket 服务器
 *   phone-connection-manager.js — 设备连接管理（独立模块）
 */

const { app, BrowserWindow, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const WebSocket = require('ws');

// ==================== 模块加载 ====================
const logger = require('./modules/logger');
const settings = require('./modules/settings');
const network = require('./modules/network');
const phoneNotes = require('./modules/phone-notes');
const trayModule = require('./modules/tray');
const windows = require('./modules/windows');
const firewall = require('./modules/firewall');
const discovery = require('./modules/discovery');
const cloudModule = require('./modules/cloud');
const serverModule = require('./modules/server');
const PhoneConnectionManager = require('./phone-connection-manager');

const fileLog = logger.fileLog;
const logMessage = logger.logMessage;
const { PORT, DISCOVERY_PORT, LOCAL_IP } = network;

// ==================== 早期初始化 ====================
// 日志系统（延迟到 app ready 后再正式初始化，但先设回退）
logger.init(app);

// 设置管理
const appSettings = settings.init(app);
const saveSettings = (s) => settings.saveSettings(s, app);

// 从设置恢复 PIN_CODE
if (appSettings.pinCode) {
  network.PIN_CODE = appSettings.pinCode;
}

// ==================== 控制台日志劫持（需在 window 引用之前设置） ====================
const _logBuffer = [];
function _pushLog(level, text) {
  const entry = { level, text, ts: Date.now() };
  _logBuffer.push(entry);
  if (_logBuffer.length > 200) _logBuffer.shift();
  [mainWindow, floatBarWindow, settingsWindow, smsWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('server-log', entry); } catch (e) {}
    }
  });
}
function _flushLogBuffer(win) {
  _logBuffer.forEach(entry => {
    try { win.webContents.send('server-log', entry); } catch (e) {}
  });
}
const _origLog = console.log.bind(console);
const _origError = console.error.bind(console);
const _origWarn = console.warn.bind(console);
console.log = (...args) => { try { const t = args.join(' '); _origLog(t); _pushLog('info', t); } catch(e) { _origLog('[console.log error]', e.message); } };
console.error = (...args) => { try { const t = args.join(' '); _origError(t); _pushLog('error', t); } catch(e) { _origError('[console.error error]', e.message); } };
console.warn = (...args) => { try { const t = args.join(' '); _origWarn(t); _pushLog('warn', t); } catch(e) { _origWarn('[console.warn error]', e.message); } };

// ==================== 全局窗口引用 ====================
let mainWindow = null;
let floatBarWindow = null;
let settingsWindow = null;
let smsWindow = null;
let tray = null;
let pluginSocket = null;
let floatBarScale = 1.0;
const FLOATBAR_MIN_SCALE = 0.7;
const FLOATBAR_MAX_SCALE = 1.5;
const FLOATBAR_MIN_W = 280;

const activePhoneIdRef = { current: null };

// ==================== 开机自启动 ====================
function setAutoStart(enable) {
  const appPath = app.getPath('exe');
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const regName = 'AutoDial';
  if (enable) {
    exec(`reg add "${regKey}" /v "${regName}" /d "${appPath}" /f`, (err) => {
      if (err) console.error('[自启动] 设置失败:', err.message);
      else console.log('[自启动] 已开启');
    });
  } else {
    exec(`reg delete "${regKey}" /v "${regName}" /f`, (err) => {
      if (err) console.error('[自启动] 取消失败:', err.message);
      else console.log('[自启动] 已关闭');
    });
  }
}

// ==================== PhoneConnectionManager 初始化 ====================
PhoneConnectionManager.onUpdate = _notifyPhonesUpdate;

function getActivePhone() {
  const active = PhoneConnectionManager.getActiveDevice();
  if (!active) return null;
  const dev = PhoneConnectionManager.devices.get(active.pin);
  if (!dev) return null;
  dev.pin = active.pin;
  return dev;
}

function getPhoneList() {
  return PhoneConnectionManager.getDeviceList();
}

// ==================== 帮助函数 ====================
function getWindows() {
  const wins = [];
  if (mainWindow && !mainWindow.isDestroyed()) wins.push(mainWindow);
  if (floatBarWindow && !floatBarWindow.isDestroyed()) wins.push(floatBarWindow);
  return wins;
}

function getAllWindows() {
  const wins = getWindows();
  if (settingsWindow && !settingsWindow.isDestroyed()) wins.push(settingsWindow);
  if (smsWindow && !smsWindow.isDestroyed()) wins.push(smsWindow);
  return wins;
}

function _notifyPhonesUpdate() {
  activePhoneIdRef.current = PhoneConnectionManager.activePin;
  const hasActive = Array.from(PhoneConnectionManager.devices.values())
    .some(d => !d.stale && ((d.ws && d.ws.readyState === 1) || (d.cloudWs && d.cloudWs.readyState === 1)));
  const data = {
    phones: PhoneConnectionManager.getDeviceList(),
    activeId: PhoneConnectionManager.activePin,
    connected: hasActive
  };
  const compatData = {
    connected: hasActive,
    phoneIP: PhoneConnectionManager.activePin ? (PhoneConnectionManager.devices.get(PhoneConnectionManager.activePin)?.ip || null) : null
  };
  [mainWindow, floatBarWindow, smsWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('phones-update', data); } catch (e) {}
      try { win.webContents.send('status-update', compatData); } catch (e) {}
    }
  });
}

function _notifyCloudStatus() {
  const status = cloudRelay.getStatus();
  [mainWindow, floatBarWindow, settingsWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('cloud-status', status); } catch (e) {}
    }
  });
}

// ==================== 跨模块工具函数 ====================
// UDP 广播引用（discovery 模块创建后会赋值）
let udpSocket = null;

function _tryWakePhone(targetPin) {
  // 优先通过云端中继
  const cloudWs = cloudRelay.getWs();
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    PhoneConnectionManager.sendForceReconnectViaCloud(targetPin, cloudWs);
    return true;
  }
  // 纯局域网：UDP wake_connect
  const device = PhoneConnectionManager.devices.get(targetPin);
  if (device && device.ip && device.ip !== 'cloud' && udpSocket) {
    try {
      const wakeMsg = JSON.stringify({ type: 'wake_connect', pin: targetPin, ip: LOCAL_IP, port: PORT });
      udpSocket.send(wakeMsg, DISCOVERY_PORT, device.ip);
      fileLog('I', 'Dial', targetPin, `自动唤醒: UDP wake_connect → ${device.ip}`);
      return true;
    } catch (e) {
      fileLog('E', 'Dial', targetPin, `自动唤醒UDP失败: ${e.message}`);
    }
  }
  // 兜底：UDP 广播
  if (udpSocket) {
    try {
      const broadcastMsg = JSON.stringify({ type: 'wake_connect', pin: targetPin, ip: LOCAL_IP, port: PORT });
      udpSocket.send(broadcastMsg, DISCOVERY_PORT, '255.255.255.255');
      fileLog('I', 'Dial', targetPin, `自动唤醒: UDP 广播(broadcast) 尝试发现局域网手机`);
      return true;
    } catch (e) {
      fileLog('E', 'Dial', targetPin, `自动唤醒UDP广播失败: ${e.message}`);
    }
  }
  fileLog('W', 'Dial', targetPin, '自动唤醒失败: 云端未连接且UDP广播也失败');
  return false;
}

function _broadcastLanWake() {
  if (!udpSocket) return;
  let sent = false;
  PhoneConnectionManager.devices.forEach((device, pin) => {
    if (device.ip && device.ip !== 'cloud') {
      try {
        const wakeMsg = JSON.stringify({ type: 'wake_connect', pin, ip: LOCAL_IP, port: PORT });
        udpSocket.send(wakeMsg, DISCOVERY_PORT, device.ip);
        fileLog('I', 'HTTP', pin, `LAN唤醒: UDP wake_connect → ${device.ip}`);
        sent = true;
      } catch (e) {
        fileLog('E', 'HTTP', pin, `LAN唤醒UDP失败: ${e.message}`);
      }
    }
  });
  if (!sent) {
    try {
      const broadcastMsg = JSON.stringify({ type: 'wake_connect', pin: PhoneConnectionManager.activePin || '', ip: LOCAL_IP, port: PORT });
      udpSocket.send(broadcastMsg, DISCOVERY_PORT, '255.255.255.255');
      fileLog('I', 'HTTP', null, 'LAN唤醒: UDP 广播(broadcast) 兜底');
    } catch (e) {
      fileLog('E', 'HTTP', null, `LAN唤醒广播失败: ${e.message}`);
    }
  }
}

// ==================== 云端连接管理 ====================
const cloudRelay = cloudModule.createCloudRelayManager({
  WebSocket,
  appSettings,
  fileLog,
  logMessage,
  PhoneConnectionManager,
  saveSettings,
  onCloudStatusChanged: _notifyCloudStatus,
  onPhonesUpdate: _notifyPhonesUpdate,
  activePhoneIdRef,
  getWindows: getAllWindows,
  getPin: () => network.PIN_CODE
});

// ==================== HTTP + WebSocket 服务器 ====================
const { server, wss } = serverModule.createServer({
  http: require('http'),
  WebSocket,
  clipboard,
  PORT,
  getPin: () => network.PIN_CODE,
  LOCAL_IP,
  getLocalIPs: network.getLocalIPs,
  getPhoneList,
  fileLog,
  logMessage,
  PhoneConnectionManager,
  cloudRelay,
  getActivePhone,
  _tryWakePhone,
  _broadcastLanWake,
  isValidDialNumber: network.isValidDialNumber,
  getWindows: () => [mainWindow, floatBarWindow].filter(w => w && !w.isDestroyed()),
  getFloatBarWindow: () => floatBarWindow,
  getSmsWindow: () => smsWindow,
  activePhoneIdRef,
  loadPhoneNote: (pin, name) => phoneNotes.loadPhoneNote(appSettings, pin, name),
  appSettings,
  saveSettings,
  ipcMain,
  onPluginConnected: (ws) => { pluginSocket = ws; },
  onPluginDisconnected: () => { pluginSocket = null; }
});

// ==================== UDP 发现服务 ====================
udpSocket = discovery.createDiscoveryService({
  DISCOVERY_PORT,
  LOCAL_IP,
  PORT,
  fileLog,
  getLocalIPs: network.getLocalIPs,
  getPin: () => network.PIN_CODE
});

// ==================== IPC 处理器 ====================

// 获取设置
ipcMain.handle('get-settings', async () => {
  return appSettings;
});

// 获取当前主题设置
ipcMain.handle('get-theme-setting', async () => {
  return { theme: appSettings.theme, mode: appSettings.mode };
});

// 切换主题
ipcMain.on('change-theme', (event, data) => {
  if (data.id) appSettings.theme = data.id;
  if (data.mode) appSettings.mode = data.mode;
  saveSettings(appSettings);
  console.log('[主题] ' + appSettings.theme + ' / ' + appSettings.mode);
  [mainWindow, floatBarWindow, settingsWindow, smsWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode }); } catch (e) {}
    }
  });
});

// 更新窗口背景色
ipcMain.on('update-bg-color', (event, color) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    try {
      if (color && !color.startsWith('rgba')) {
        win.setBackgroundColor(color);
      }
    } catch (e) {}
  }
});

// 保存单个设置项
ipcMain.on('save-setting', (event, { key, value }) => {
  appSettings[key] = value;
  saveSettings(appSettings);
  console.log('[设置] ' + key + ' = ' + value);
});

// 设置配对码（11位手机号）
ipcMain.on('set-pin', (event, pin) => {
  if (!pin || typeof pin !== 'string' || !/^1[3-9]\d{9}$/.test(pin)) {
    event.reply('pin-error', '无效的配对码，需为11位手机号');
    return;
  }
  network.PIN_CODE = pin;
  appSettings.pinCode = pin;
  saveSettings(appSettings);
  console.log('[PIN] 已更新: ' + pin);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('info-push', { pin: pin });
  if (floatBarWindow && !floatBarWindow.isDestroyed()) floatBarWindow.webContents.send('info-push', { pin: pin });
  if (smsWindow && !smsWindow.isDestroyed()) smsWindow.webContents.send('info-push', { pin: pin });
});

// 开机自启动
ipcMain.on('set-auto-start', (event, enable) => {
  setAutoStart(enable);
});

// 打开设置窗口
ipcMain.on('open-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const preloadPath = path.join(__dirname, 'preload.js');
  const rendererDir = path.join(__dirname, 'renderer');
  settingsWindow = windows.createSettingsWindow(preloadPath, rendererDir);

  settingsWindow.on('closed', () => { settingsWindow = null; });

  settingsWindow.webContents.on('did-finish-load', () => {
    _flushLogBuffer(settingsWindow);
    try {
      settingsWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
      settingsWindow.webContents.send('cloud-status', cloudRelay.getStatus());
    } catch (e) {}
  });
});

// 切换悬浮条
ipcMain.on('toggle-floatbar', (event, show) => {
  if (!floatBarWindow) return;
  const targetShow = (typeof show === 'boolean') ? show : !floatBarWindow.isVisible();
  if (targetShow) floatBarWindow.show();
  else floatBarWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('floatbar-visible-changed', targetShow); } catch (e) {}
  }
});

// 设置悬浮条缩放
ipcMain.on('set-floatbar-scale', (event, scale) => {
  floatBarScale = Math.max(FLOATBAR_MIN_SCALE, Math.min(FLOATBAR_MAX_SCALE, scale));
});

// 更新悬浮条缩放/尺寸
ipcMain.on('update-floatbar-scale', (event, data) => {
  if (!floatBarWindow || floatBarWindow.isDestroyed()) return;
  if (data && typeof data.scale === 'number') {
    floatBarScale = Math.max(FLOATBAR_MIN_SCALE, Math.min(FLOATBAR_MAX_SCALE, data.scale));
  }
  const currentBounds = floatBarWindow.getBounds();
  const contentBounds = floatBarWindow.getContentBounds();
  const frameW = currentBounds.width - contentBounds.width;
  const frameH = currentBounds.height - contentBounds.height;
  const w = Math.max(FLOATBAR_MIN_W, Math.round(440 * floatBarScale));
  const h = Math.round(48 * floatBarScale) + frameH;
  floatBarWindow.setSize(w, h);
});

// ==================== 悬浮条交互 IPC ====================

// 悬浮条尺寸变化
ipcMain.on('floatbar-resize', (event, delta) => {
  if (!floatBarWindow || floatBarWindow.isDestroyed()) return;
  const bounds = floatBarWindow.getBounds();
  floatBarWindow.setBounds({
    x: bounds.x,
    y: bounds.y,
    width: Math.max(FLOATBAR_MIN_W, bounds.width + (delta || 0)),
    height: bounds.height
  });
});

// 悬浮条拖动
ipcMain.on('floatbar-move', (event, { x, y }) => {
  if (!floatBarWindow || floatBarWindow.isDestroyed()) return;
  floatBarWindow.setPosition(Math.round(x), Math.round(y));
});

// 悬浮条显示主窗口
ipcMain.on('floatbar-show-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// 悬浮条右键菜单
ipcMain.on('floatbar-context-menu', (event, data) => {
  const { Menu } = require('electron');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '固定悬浮条大小', type: 'checkbox', checked: data && data.pinned,
      click: (item) => {
        if (floatBarWindow && !floatBarWindow.isDestroyed()) {
          floatBarWindow.setResizable(!item.checked);
        }
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; if (tray) { tray.destroy(); tray = null; } app.quit(); } }
  ]);
  menu.popup({ window: floatBarWindow });
});

// 主窗口控制
ipcMain.on('window-control', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
});

// 主窗口置顶
ipcMain.on('set-topmost', (event, enabled) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    win.setAlwaysOnTop(!!enabled);
  }
});

// 获取系统信息
ipcMain.handle('get-info', async () => {
  return {
    ip: LOCAL_IP,
    ips: network.getLocalIPs(),
    pin: network.PIN_CODE,
    port: PORT,
    cloudEnabled: appSettings.cloudEnabled,
    cloudServer: appSettings.cloudServer,
    cloudConnected: cloudRelay.isConnected()
  };
});

// 读取剪贴板
ipcMain.handle('read-clipboard', async () => {
  try { return clipboard.readText(); } catch (e) { return ''; }
});

// 关闭设置窗口
ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    settingsWindow = null;
  }
});

// 发送短信
ipcMain.on('send-sms', (event, { number, content }) => {
  if (!number || !content) return;
  const active = getActivePhone();
  if (active) {
    PhoneConnectionManager.sendToPhoneWithAck(active.pin, {
      type: 'sms',
      number: number,
      content: content
    }).then(acked => {
      fileLog('I', 'SMS', active.pin, `发送短信 ${number} ${acked ? 'ACK已确认' : 'ACK超时'}`);
    });
  }
});

// 更新云端配置
ipcMain.on('update-cloud-config', (event, { enabled, servers }) => {
  appSettings.cloudEnabled = enabled;
  if (Array.isArray(servers)) {
    appSettings.cloudServers = servers;
    if (servers.length > 0) appSettings.cloudServer = servers[0];
  }
  saveSettings(appSettings);
  console.log('[云端] 配置已更新: enabled=' + enabled + ', servers=' + JSON.stringify(servers));

  if (enabled) {
    cloudRelay.connectToFirst();
  } else {
    cloudRelay.disconnect();
  }
  _notifyCloudStatus();
});

// ==================== 核心拨号/挂断 IPC ====================

// 前端直接拨号（IPC 通道）
ipcMain.on('dial', (event, number) => {
  if (!number) return;
  const cleanNumber = (number + '').replace(/[\s\-\(\)]/g, '');
  if (!network.isValidDialNumber(cleanNumber)) return;

  const active = getActivePhone();
  if (active) {
    fileLog('I', 'UI', active.pin, `UI拨号: ${cleanNumber}`);
    PhoneConnectionManager.sendToPhoneWithAck(active.pin, { type: 'dial', number: cleanNumber }).then(acked => {
      fileLog('I', 'UI', active.pin, `UI拨号结果: ${cleanNumber} ${acked ? 'ACK已确认' : 'ACK超时'}`);
      // ACK超时 → 通知前端拨号超时
      if (!acked) {
        [mainWindow, floatBarWindow].forEach(win => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('dial-timeout', { number: cleanNumber }); } catch (e) {}
          }
        });
      }
    });
    // 通知前端拨号已发送
    [mainWindow, floatBarWindow].forEach(win => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('dial-sent', { number: cleanNumber }); } catch (e) {}
      }
    });
    return;
  }

  // 手机不在线 → 唤醒 + 排队
  const targetPin = PhoneConnectionManager.activePin;
  if (targetPin) {
    fileLog('I', 'UI', targetPin, `UI拨号 ${cleanNumber} → 手机不在线，触发唤醒`);
    const wakeOk = _tryWakePhone(targetPin);
    PhoneConnectionManager.queueDial(targetPin, cleanNumber).then(acked => {
      if (!acked) {
        [mainWindow, floatBarWindow].forEach(win => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('dial-timeout', { number: cleanNumber }); } catch (e) {}
          }
        });
      }
    });
    [mainWindow, floatBarWindow].forEach(win => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('dial-waking', { number: cleanNumber, pin: targetPin }); } catch (e) {}
      }
    });
    // 唤醒失败通知
    if (!wakeOk) {
      [mainWindow, floatBarWindow].forEach(win => {
        if (win && !win.isDestroyed()) {
          try { win.webContents.send('dial-wake-failed', { number: cleanNumber, reason: '唤醒失败' }); } catch (e) {}
        }
      });
    }
    return;
  }

  // 无任何设备
  _broadcastLanWake();
  fileLog('W', 'UI', null, 'UI拨号失败：无设备');
  [mainWindow, floatBarWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('dial-wake-failed', { number: cleanNumber, reason: '手机未连接' }); } catch (e) {}
    }
  });
});

// 前端挂断（IPC 通道）
ipcMain.on('hangup', (event) => {
  const active = getActivePhone();
  if (!active) return;
  PhoneConnectionManager.sendToPhoneWithAck(active.pin, { type: 'hangup' }).then(acked => {
    fileLog('I', 'Hangup', active.pin, `挂断 ${acked ? 'ACK已确认' : 'ACK超时'}`);
  });
  [mainWindow, floatBarWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('hangup-sent'); } catch (e) {}
    }
  });
});

// 选择手机（前端用 id 字段，映射到 pin）
ipcMain.on('select-phone', (event, id) => {
  PhoneConnectionManager.setActiveDevice(id);
  activePhoneIdRef.current = PhoneConnectionManager.activePin;
  _notifyPhonesUpdate();
});

// 重命名手机（前端用 { id, note }）
ipcMain.on('rename-phone', (event, { id, note }) => {
  const device = PhoneConnectionManager.devices.get(id);
  if (device) {
    phoneNotes.savePhoneNote(appSettings, id, device.name, note || '');
    saveSettings(appSettings);
    device.alias = note || device.name;
    _notifyPhonesUpdate();
  }
});

// 打开短信窗口
ipcMain.on('open-sms', (event, data) => {
  if (smsWindow && !smsWindow.isDestroyed()) {
    smsWindow.show();
    smsWindow.focus();
    const number = (data && data.number) ? String(data.number) : (typeof data === 'string' ? data : '');
    const content = (data && data.content) ? String(data.content) : '';
    try { smsWindow.webContents.send('sms-number', number); } catch (e) {}
    try { smsWindow.webContents.send('sms-content', content); } catch (e) {}
    return;
  }
  const preloadPath = path.join(__dirname, 'preload.js');
  const rendererDir = path.join(__dirname, 'renderer');
  smsWindow = windows.createSmsWindow(preloadPath, rendererDir);

  smsWindow.on('closed', () => { smsWindow = null; });

  smsWindow.webContents.on('did-finish-load', () => {
    _flushLogBuffer(smsWindow);
    const number = (data && data.number) ? String(data.number) : (typeof data === 'string' ? data : '');
    const content = (data && data.content) ? String(data.content) : '';
    try {
      smsWindow.webContents.send('sms-number', number);
      smsWindow.webContents.send('sms-content', content);
      smsWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
    } catch (e) {}
  });
});

// 关闭短信窗口
ipcMain.on('close-sms', () => {
  if (smsWindow && !smsWindow.isDestroyed()) {
    smsWindow.close();
    smsWindow = null;
  }
});

// 保存手机备注
ipcMain.on('save-phone-note', (event, { pin, name, note }) => {
  phoneNotes.savePhoneNote(appSettings, pin, name, note);
  saveSettings(appSettings);
  const device = PhoneConnectionManager.devices.get(pin);
  if (device) device.alias = note || name;
  _notifyPhonesUpdate();
});

// 重命名设备
ipcMain.on('rename-device', (event, { pin, name }) => {
  const device = PhoneConnectionManager.devices.get(pin);
  if (device) {
    device.name = name;
    _notifyPhonesUpdate();
  }
});

// 删除设备
ipcMain.on('delete-device', (event, pin) => {
  PhoneConnectionManager.removeDevice(pin, 'user');
  activePhoneIdRef.current = PhoneConnectionManager.activePin;
  _notifyPhonesUpdate();
});

// 设置活跃手机
ipcMain.on('set-active-phone', (event, pin) => {
  PhoneConnectionManager.setActiveDevice(pin);
  activePhoneIdRef.current = PhoneConnectionManager.activePin;
  _notifyPhonesUpdate();
});

// 一键获取云端服务器
ipcMain.on('fetch-cloud-servers', () => {
  settings.fetchCloudServers(appSettings, app);
});

// 强制重连设备
ipcMain.on('force-reconnect', (event, targetPin) => {
  if (!targetPin) return;
  // 尝试云端中继
  const cloudWs = cloudRelay.getWs();
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    const sent = PhoneConnectionManager.sendForceReconnectViaCloud(targetPin, cloudWs);
    fileLog('I', 'Reconn', targetPin, `云端 force-reconnect ${sent ? '已发送' : '发送失败'}`);
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: sent, error: sent ? null : '云端未连接' }); } catch (_) {}
    }
    return;
  }
  // 纯局域网：UDP wake_connect
  const device = PhoneConnectionManager.devices.get(targetPin);
  const phoneIP = device ? device.ip : null;
  if (!phoneIP || phoneIP === 'cloud') {
    fileLog('W', 'Reconn', targetPin, '无可用局域网 IP');
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: false, error: '设备无局域网IP' }); } catch (_) {}
    }
    return;
  }
  try {
    const wakeMsg = JSON.stringify({ type: 'wake_connect', pin: targetPin, ip: LOCAL_IP, port: PORT });
    udpSocket.send(wakeMsg, DISCOVERY_PORT, phoneIP);
    fileLog('I', 'Reconn', targetPin, `已发送 UDP wake_connect → ${phoneIP}`);
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: true }); } catch (_) {}
    }
  } catch (e) {
    fileLog('E', 'Reconn', targetPin, `UDP wake_connect 发送失败: ${e.message}`);
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: false, error: e.message }); } catch (_) {}
    }
  }
});

// 重启应用
ipcMain.on('restart-app', () => {
  fileLog('I', 'App', null, '用户触发重启');
  app.relaunch();
  app.exit(0);
});

// 云端重连
ipcMain.on('restart-cloud', () => {
  cloudRelay.restartLight();
});

// 拨号失败触发云端恢复
ipcMain.on('dial-failed-trigger-recovery', () => {
  cloudRelay.dialFailedRecovery();
});

// 测试云端服务器连通性
ipcMain.handle('test-cloud-servers', async (event, servers) => {
  const results = [];
  if (!Array.isArray(servers)) return results;
  const net = require('net');
  for (let i = 0; i < servers.length; i++) {
    const addr = servers[i];
    try {
      let url = addr;
      if (!url.startsWith('ws://') && !url.startsWith('wss://')) url = 'ws://' + url;
      const u = new URL(url);
      const host = u.hostname;
      const port = parseInt(u.port) || (url.startsWith('wss://') ? 443 : 80);
      if (!host) {
        results.push({ addr, ok: false, ms: 0, error: '地址格式错误' });
        continue;
      }
      const start = Date.now();
      const result = await new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(3000);
        sock.on('connect', () => {
          const ms = Date.now() - start;
          sock.destroy();
          resolve({ ok: true, ms });
        });
        sock.on('timeout', () => {
          sock.destroy();
          resolve({ ok: false, ms: 0, error: '超时' });
        });
        sock.on('error', () => {
          sock.destroy();
          resolve({ ok: false, ms: 0, error: '不可连接' });
        });
        sock.connect(port, host);
      });
      results.push({ addr, ok: result.ok, ms: result.ms, error: result.error });
    } catch (e) {
      results.push({ addr, ok: false, ms: 0, error: e.message });
    }
  }
  return results;
});

// 连接到指定云端服务器
ipcMain.on('connect-cloud-specific', (event, serverUrl) => {
  if (!serverUrl || !appSettings.cloudEnabled) return;
  appSettings.cloudServer = serverUrl;
  saveSettings(appSettings);
  cloudRelay.connect(serverUrl);
});

// ==================== 应用生命周期 ====================

app.whenReady().then(() => {
  // 防火墙
  firewall.tryAddFirewallRule(PORT, DISCOVERY_PORT, fileLog);

  // 日志清理
  logger.cleanOldLogs();
  logger.startLogCleanup();

  fileLog('I', 'Logger', null, '=== AutoDial PC v6 日志系统启动 ===');
  fileLog('I', 'Logger', null, `日志目录: ${logger.getLogDir()}`);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[错误] 端口 ' + PORT + ' 已被占用，请关闭其他 AutoDial 实例');
      dialog.showErrorBox('AutoDial 错误', '端口 ' + PORT + ' 已被占用，请检查是否已有程序在运行！');
      app.quit();
    }
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('========================================');
    console.log('       AutoDial PC v6 已启动');
    console.log('========================================');
    console.log('  本机IP:   ' + LOCAL_IP);
    console.log('  配对码:   ' + network.PIN_CODE);
    console.log('  端口:     ' + PORT);
    console.log('  连接上限: ' + PhoneConnectionManager.MAX_CONNECTIONS + ' 台手机');
    console.log('========================================');

    // 启动 UDP 广播
    discovery.startBroadcast(udpSocket, {
      PIN_CODE: network.PIN_CODE,
      LOCAL_IP,
      PORT,
      DISCOVERY_PORT,
      getLocalIPs: network.getLocalIPs,
      fileLog,
      getPin: () => network.PIN_CODE
    });

    // 创建系统托盘
    tray = trayModule.createTray(app, mainWindow, floatBarWindow);

    // 创建窗口（事件绑定在创建后）
    const preloadPath = path.join(__dirname, 'preload.js');
    const rendererDir = path.join(__dirname, 'renderer');

    mainWindow = windows.createMainWindow(preloadPath, rendererDir);
    floatBarWindow = windows.createFloatBarWindow(preloadPath, rendererDir);

    // 主窗口事件
    mainWindow.on('close', (e) => {
      if (!app.isQuitting) {
        if (appSettings.closeAction === 'exit') {
          if (tray) { tray.destroy(); tray = null; }
          return;
        }
        e.preventDefault();
        mainWindow.hide();
        console.log('[托盘] 主窗口已最小化到托盘');
      }
    });

    mainWindow.webContents.on('did-finish-load', () => {
      _flushLogBuffer(mainWindow);
      try {
        mainWindow.webContents.send('info-push', {
          ip: LOCAL_IP,
          ips: network.getLocalIPs(),
          pin: network.PIN_CODE,
          port: PORT,
          cloudEnabled: appSettings.cloudEnabled,
          cloudServer: appSettings.cloudServer,
          cloudConnected: cloudRelay.isConnected()
        });
        if (PhoneConnectionManager.devices.size > 0) {
          mainWindow.webContents.send('phones-update', { phones: getPhoneList(), activeId: PhoneConnectionManager.activePin });
        }
        mainWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
      } catch (e) {}
    });

    // 悬浮条事件
    floatBarWindow.on('closed', () => { floatBarWindow = null; });

    floatBarWindow.webContents.on('did-finish-load', () => {
      _flushLogBuffer(floatBarWindow);
      try {
        floatBarWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
      } catch (e) {}
    });

    // 云端连接
    if (appSettings.cloudEnabled) {
      cloudRelay.connectToFirst();
    }

    // 隐藏启动
    if (appSettings.silentStart) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        console.log('[启动] 隐藏界面启动模式');
      }
    }

    // 自启动同步
    if (appSettings.autoStart) {
      setAutoStart(true);
    }
  });
});

app.on('window-all-closed', () => {
  if (tray && !app.isQuitting) return;
  logger.stopLogCleanup();
  app.quit();
});

// 全局异常捕获
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err.message);
  try { fileLog('E', 'Fatal', null, `未捕获异常: ${err.message}\n${err.stack}`); } catch (_) {}
  try { saveSettings(appSettings); } catch (_) {}
  app.isQuitting = true;
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理Promise拒绝]', reason);
  try { fileLog('E', 'Fatal', null, `未处理Promise拒绝: ${reason}`); } catch (_) {}
});

// 心跳检查定时器
setInterval(() => PhoneConnectionManager.checkHeartbeats(), 15000);
setInterval(() => PhoneConnectionManager.cleanupStaleDevices(), 15000);

// 暴露给 phone-connection-manager 的全局引用
global._notifyPhonesUpdate = _notifyPhonesUpdate;
