'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const crypto = require('crypto');

// ==================== v6 文件日志系统 ====================
// 格式: [时间] [级别] [模块] [PIN] 内容
let _LOG_DIR = null;
function _getLogDir() {
  if (!_LOG_DIR) {
    try {
      _LOG_DIR = path.join(app.getPath('userData'), 'autodial-logs');
      fs.mkdirSync(_LOG_DIR, { recursive: true });
    } catch (e) {
      // app 尚未就绪时返回空，调用方 (fileLog) 有兜底逻辑
      return '';
    }
  }
  return _LOG_DIR;
}
const LOG_DIR = null;  // v6修复: 延迟初始化，等 app.whenReady() 后再通过 _getLogDir() 获取
const MAX_LOG_SIZE = 10 * 1024 * 1024;  // 10MB
const MAX_LOG_DAYS = 7;
const LOG_FALLBACK_BUFFER = [];          // 内存降级环形缓冲区
const LOG_FALLBACK_MAX = 1000;
let _logFailCount = 0;

function _getLogFilePath() {
    const dateStr = new Date().toISOString().slice(0, 10);
    return path.join(_getLogDir(), `autodial-pc-${dateStr}.log`);
}

function fileLog(level, module, pin, msg) {
    try {
        const now = new Date();
        const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
        const pinStr = pin ? `[${pin}]` : '[----]';
        const line = `${ts} [${level}] [${module}] ${pinStr} ${msg}\n`;

        const logFile = _getLogFilePath();
        // 10MB 滚动
        if (fs.existsSync(logFile)) {
            const stat = fs.statSync(logFile);
            if (stat.size >= MAX_LOG_SIZE) {
                const extIdx = logFile.lastIndexOf('.log');
                const altFile = logFile.slice(0, extIdx) + '.1' + logFile.slice(extIdx);
                try { fs.renameSync(logFile, altFile); } catch (_) {}
            }
        }
        fs.appendFileSync(logFile, line, 'utf8');
        _logFailCount = 0;

        // 控制台输出
        if (level === 'E') console.error(`[${module}]${pinStr} ${msg}`);
        else if (level === 'W') console.warn(`[${module}]${pinStr} ${msg}`);
    } catch (_e) {
        _logFailCount++;
        if (_logFailCount >= 3) {
            LOG_FALLBACK_BUFFER.push(`${new Date().toISOString()} [${level}] [${module}] ${msg}`);
            if (LOG_FALLBACK_BUFFER.length > LOG_FALLBACK_MAX) LOG_FALLBACK_BUFFER.shift();
        }
    }
}

function logMessage(direction, pin, msgType, content) {
    const truncated = content.length > 500 ? content.substring(0, 500) + '...(truncated)' : content;
    fileLog('I', direction, pin, `[${msgType}] ${truncated}`);
}

function cleanOldLogs() {
    try {
        const logDir = _getLogDir();
        if (!logDir) return;
        const files = fs.readdirSync(logDir);
        const cutoff = Date.now() - MAX_LOG_DAYS * 24 * 60 * 60 * 1000;
        for (const file of files) {
            if (file.endsWith('.log')) {
                const filePath = path.join(logDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.mtimeMs < cutoff) fs.unlinkSync(filePath);
                } catch (_) {}
            }
        }
    } catch (_) {}
}

setInterval(cleanOldLogs, 6 * 60 * 60 * 1000);

// ==================== 设置管理 ====================
let _SETTINGS_FILE = null;
function _getSettingsFile() {
  if (!_SETTINGS_FILE) {
    try {
      _SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
    } catch (e) {
      // app 尚未就绪时返回空，调用方有兜底逻辑
      return '';
    }
  }
  return _SETTINGS_FILE;
}
const DEFAULT_SETTINGS = {
  closeAction: 'minimize',   // 'minimize' | 'exit'
  trayExit: true,            // 托盘右键退出直接退出程序
  autoStart: false,          // 开机自启动
  silentStart: false,        // 隐藏界面启动
  theme: 'dark-gold',        // 主题ID
  mode: 'dark',              // 显示模式 dark/dusk/dawn/twilight/warm/mist/light
  phoneNotes: {},            // 手机备注 { "ip|name": "备注" }
  cloudServer: '',           // 云中转服务器地址，如 wss://relay.example.com:35430
  cloudEnabled: false,       // 是否启用云中转
  cloudServers: []           // 多云服务器列表，如 ["1.2.3.4:35430", "5.6.7.8:35430"]
};

function loadSettings() {
  try {
    const f = _getSettingsFile();
    if (fs.existsSync(f)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    }
  } catch (e) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(_getSettingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {}
}

let appSettings = loadSettings();

// 修复：同步 cloudServer 到 cloudServers（向后兼容）
if (appSettings.cloudServer && (!Array.isArray(appSettings.cloudServers) || appSettings.cloudServers.length === 0)) {
  appSettings.cloudServers = [appSettings.cloudServer];
  console.log("[云端] 从 cloudServer 同步到 cloudServers: " + appSettings.cloudServer);
}

// 修复：如果 cloudEnabled 为 true 但实际没有配置服务器，自动清除标志
const hasConfiguredServers = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0;
if (appSettings.cloudEnabled && !hasConfiguredServers) {
  console.log("[云端] cloudEnabled=true 但没有配置服务器，清除标志");
  appSettings.cloudEnabled = false;
}

// 保存修正后的配置
saveSettings(appSettings);


const { clipboard } = require('electron');

// ==================== 日志系统 ====================
const _logBuffer = [];

function _pushLog(level, text) {
  const entry = { level, text, ts: Date.now() };
  _logBuffer.push(entry);
  if (_logBuffer.length > 200) _logBuffer.shift();
  // 广播给所有渲染进程（与其他广播函数保持一致）
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
console.log = (...args) => { const t = args.join(' '); _origLog(t); _pushLog('info', t); };
console.error = (...args) => { const t = args.join(' '); _origError(t); _pushLog('error', t); };
console.warn = (...args) => { const t = args.join(' '); _origWarn(t); _pushLog('warn', t); };

// ==================== 常量与工具函数 ====================
// v6: 多网络适配器过滤关键词
const ADAPTER_EXCLUDE_KEYWORDS = ['virtual', 'vmware', 'docker', 'hyper', 'bluetooth', 'loopback', 'nodebabylink'];
const ADAPTER_ETHERNET_KEYWORDS = ['eth', 'en', '以太', 'ethernet', 'pci'];
const ADAPTER_WIFI_KEYWORDS = ['wlan', 'wl', '无线', 'wifi'];

function generatePinCode() {
  const mac = getMacAddress();
  const hash = crypto.createHash('sha256').update(mac).digest('hex');
  const num = parseInt(hash.substring(0, 8), 16);
  return String(num % 9000 + 1000);
}

function getMacAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return os.hostname();
}

/** v6: 多网络适配器过滤 - 获取所有可用网络接口 */
function getAllUsableInterfaces() {
  const interfaces = os.networkInterfaces();
  const result = [];
  for (const name of Object.keys(interfaces)) {
    const lower = name.toLowerCase();
    // 排除虚拟适配器
    if (ADAPTER_EXCLUDE_KEYWORDS.some(k => lower.includes(k))) continue;
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        result.push({ name, address: iface.address, adapterName: name.toLowerCase() });
      }
    }
  }
  // 优先级排序：有线 > WiFi > 其他
  result.sort((a, b) => {
    const aEth = ADAPTER_ETHERNET_KEYWORDS.some(k => a.adapterName.includes(k)) ? 0 : 1;
    const aWifi = ADAPTER_WIFI_KEYWORDS.some(k => a.adapterName.includes(k)) ? 1 : 2;
    const bEth = ADAPTER_ETHERNET_KEYWORDS.some(k => b.adapterName.includes(k)) ? 0 : 1;
    const bWifi = ADAPTER_WIFI_KEYWORDS.some(k => b.adapterName.includes(k)) ? 1 : 2;
    const aRank = Math.min(aEth, aWifi);
    const bRank = Math.min(bEth, bWifi);
    if (aRank !== bRank) return aRank - bRank;
    // 同优先级按 IP 排序
    return a.address.localeCompare(b.address);
  });
  return result;
}

function getLocalIP() {
  const all = getAllUsableInterfaces();
  const preferred = all.find(c => c.address.startsWith('192.168') || c.address.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(c.address));
  return preferred ? preferred.address : (all[0] ? all[0].address : '127.0.0.1');
}

function getLocalIPs() {
  return getAllUsableInterfaces().map(i => i.address);
}

function getSubnet() {
  const ip = getLocalIP();
  const parts = ip.split('.');
  return parts[0] + '.' + parts[1] + '.' + parts[2] + '.';
}

const PIN_CODE = generatePinCode();
const LOCAL_IP = getLocalIP();
const SUBNET = getSubnet();
const PORT = 35432;
const DISCOVERY_PORT = 35433;

// ==================== v6 手机连接管理 ====================
const PhoneConnectionManager = require('./phone-connection-manager');
PhoneConnectionManager.onUpdate = _notifyPhonesUpdate;

// v6: 以 PIN 为键，不再需要 UUID
const phoneDevices = PhoneConnectionManager.devices;
let activePhoneId = null;
let pluginSocket = null;

function getActivePhone() {
  const active = PhoneConnectionManager.getActiveDevice();
  if (!active) return null;
  const dev = PhoneConnectionManager.devices.get(active.pin);
  if (!dev) return null;
  dev.pin = active.pin;
  return dev;
}

function sendToPhone(pinOrObj, msg) {
  const pin = typeof pinOrObj === 'string' ? pinOrObj : (pinOrObj && pinOrObj.pin);
  if (!pin) return false;
  return PhoneConnectionManager.sendToPhone(pin, msg);
}

function getPhoneList() {
  return PhoneConnectionManager.getDeviceList();
}

// v6: 备注持久化 key 改为 "pin|name"
function getPhoneNoteKey(pin, name) {
  return pin + '|' + name;
}
function loadPhoneNote(pin, name) {
  const notes = appSettings.phoneNotes || {};
  return notes[getPhoneNoteKey(pin, name)] || '';
}
function savePhoneNote(pin, name, note) {
  if (!appSettings.phoneNotes) appSettings.phoneNotes = {};
  appSettings.phoneNotes[getPhoneNoteKey(pin, name)] = note;
  saveSettings(appSettings);
}
let mainWindow = null;
let floatBarWindow = null;
let settingsWindow = null;
let smsWindow = null;
let tray = null;
let floatBarScale = 1.0;
const FLOATBAR_MIN_SCALE = 0.7;
const FLOATBAR_MAX_SCALE = 1.5;
const FLOATBAR_MIN_W = 280;  // 最小宽度，防止内容挤压

// 开机自启动（注册表方式，无需管理员权限）
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

// ==================== 窗口创建 ====================

// 创建托盘图标
function createTray() {
  // 程序化生成 16x16 金色电话图标 PNG
  function createTrayIconPNG() {
    // 简单的 16x16 金色电话机位图，用 RGBA 手动编码
    // 背景: 透明, 电话听筒: 金色 (#C9A84C)
    // 16x16 像素, 每行16像素, RGBA每像素4字节
    const W = 16, H = 16;
    const pixels = Buffer.alloc(W * H * 4, 0); // 全透明

    function setPixel(x, y, r, g, b, a) {
      if (x < 0 || x >= W || y < 0 || y >= H) return;
      const i = (y * W + x) * 4;
      pixels[i] = r; pixels[i+1] = g; pixels[i+2] = b; pixels[i+3] = a;
    }

    // 绘制金色电话听筒（简化的电话图标）
    const GOLD = [201, 168, 76, 255];
    const DARK = [139, 105, 20, 255];

    // 听筒主体 - 上半部分
    for (let y = 3; y <= 8; y++) {
      for (let x = 4; x <= 11; x++) {
        setPixel(x, y, ...GOLD);
      }
    }
    // 听筒耳机部分 - 左上
    for (let y = 2; y <= 5; y++) {
      for (let x = 3; x <= 5; x++) {
        setPixel(x, y, ...DARK);
      }
    }
    // 听筒耳机部分 - 右上
    for (let y = 2; y <= 5; y++) {
      for (let x = 10; x <= 12; x++) {
        setPixel(x, y, ...DARK);
      }
    }
    // 听筒底部弧线
    for (let x = 5; x <= 10; x++) {
      setPixel(x, 9, ...GOLD);
    }
    for (let x = 6; x <= 9; x++) {
      setPixel(x, 10, ...GOLD);
    }
    setPixel(7, 11, ...GOLD);
    setPixel(8, 11, ...GOLD);
    // 底座
    for (let x = 4; x <= 11; x++) {
      setPixel(x, 12, ...DARK);
      setPixel(x, 13, ...DARK);
    }

    // 编码为 PNG（最小有效PNG）
    const { createHash } = require('crypto');
    const zlib = require('zlib');

    // 构造原始图像数据（每行前加filter byte 0）
    const rawData = Buffer.alloc(H * (1 + W * 4));
    for (let y = 0; y < H; y++) {
      rawData[y * (1 + W * 4)] = 0; // filter: None
      pixels.copy(rawData, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
    }
    const compressed = zlib.deflateSync(rawData);

    // PNG 文件结构
    function crc32(buf) {
      const table = new Int32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c;
      }
      let crc = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function chunk(type, data) {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      const typeAndData = Buffer.concat([Buffer.from(type), data]);
      const crcBuf = Buffer.alloc(4);
      crcBuf.writeUInt32BE(crc32(typeAndData));
      return Buffer.concat([len, typeAndData, crcBuf]);
    }

    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 6;  // color type: RGBA
    ihdr[10] = 0; // compression
    ihdr[11] = 0; // filter
    ihdr[12] = 0; // interlace

    return nativeImage.createFromBuffer(
      Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]),
      { width: W, height: H }
    );
  }

  const trayIcon = createTrayIconPNG();
  tray = new Tray(trayIcon);
  tray.setToolTip('AutoDial 一键拨号');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { type: 'separator' },
    { label: '显示悬浮条', click: () => { if (floatBarWindow) floatBarWindow.show(); } },
    { label: '隐藏悬浮条', click: () => { if (floatBarWindow) floatBarWindow.hide(); } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; if (tray) { tray.destroy(); tray = null; } app.quit(); } }
  ]));

  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 780,
    minWidth: 210,
    minHeight: 350,
    frame: false,           // 无边框
    transparent: false,
    backgroundColor: '#111318',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      if (appSettings.closeAction === 'exit') {
        // 用户设置关闭即退出
        if (tray) { tray.destroy(); tray = null; }
        return; // 允许关闭
      }
      // 默认：最小化到托盘
      e.preventDefault();
      mainWindow.hide();
      console.log('[托盘] 主窗口已最小化到托盘');
    }
  });

  // 补发历史日志 + 主动推送 info
  mainWindow.webContents.on('did-finish-load', () => {
    _flushLogBuffer(mainWindow);
    try {
      mainWindow.webContents.send('info-push', {
        ip: LOCAL_IP,
        ips: getLocalIPs(),
        pin: PIN_CODE,
        port: PORT,
        cloudEnabled: appSettings.cloudEnabled,
        cloudServer: appSettings.cloudServer,
        cloudConnected: cloudConnected
      });
      if (phoneDevices.size > 0) {
        mainWindow.webContents.send('phones-update', { phones: getPhoneList(), activeId: activePhoneId });
      }
      mainWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
    } catch (e) {}
  });
}

function createFloatBarWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = primaryDisplay.workAreaSize;

  // 悬浮条初始位置：紧贴主界面右边，垂直与主界面状态栏的悬浮条开关平齐
  const mainW = 420, mainH = 780;
  const barW = 440, barH = 48;
  const mainX = Math.round((screenW - mainW) / 2);
  const mainY = Math.round((screenH - mainH) / 2);
  const initialX = mainX + mainW + 8; // 主界面右边，间距 8px
  const initialY = mainY + 36 + 8; // 标题栏(36px) + 间距 8px，与状态栏开关行平齐

  floatBarWindow = new BrowserWindow({
    width: barW,
    height: barH,
    x: initialX,
    y: initialY,
    frame: false,
    transparent: true,
    resizable: true,        // 必须 true，否则 setSize 无法缩小窗口
    minimizable: false,     // 禁止最小化按钮（悬浮条不需要）
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,   // 必须为 true，否则鼠标事件无法触发（拖拽失效）
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  floatBarWindow.loadFile(path.join(__dirname, 'renderer', 'floatbar.html'));
  floatBarWindow.setIgnoreMouseEvents(false);
  floatBarWindow.setVisibleOnAllWorkspaces(true);

  floatBarWindow.on('closed', () => {
    floatBarWindow = null;
  });

  floatBarWindow.webContents.on('did-finish-load', () => {
    _flushLogBuffer(floatBarWindow);
    // 推送当前主题设置
    try {
      floatBarWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
    } catch (e) {}
  });
}

// ==================== IPC 处理 ====================

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
  // 广播给所有窗口
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
      // 跳过 rgba 颜色（毛玻璃等），Electron backgroundColor 不支持透明
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
  settingsWindow = new BrowserWindow({
    width: 380,
    height: 420,
    minWidth: 320,
    minHeight: 350,
    frame: false,
    transparent: false,
    backgroundColor: '#111318',
    resizable: true,
    modal: true,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.on('closed', () => { settingsWindow = null; });
  // 推送当前主题设置
  settingsWindow.webContents.on('did-finish-load', () => {
    try {
      settingsWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
    } catch (e) {}
  });
});

// 关闭设置窗口
ipcMain.on('close-settings', () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

// 获取服务器信息（v6: 返回本地 PIN）
ipcMain.handle('get-info', async () => {
  return {
    pin: PIN_CODE,
    ip: LOCAL_IP,
    ips: getLocalIPs(),
    port: PORT,
    connected: phoneDevices.size > 0,
    phoneCount: phoneDevices.size,
    hostname: os.hostname(),
    firewall: firewallWarning ? 'warning' : 'ok',
    cloudEnabled: appSettings.cloudEnabled,
    cloudServer: appSettings.cloudServer,
    cloudConnected: cloudConnected
  };
});

// 读取系统剪贴板
ipcMain.handle('read-clipboard', async () => {
  try {
    const text = (clipboard.readText() || '').trim();
    return { text: text || '' };
  } catch (e) {
    return { text: '' };
  }
});

// OCR 功能已移除（tesseract.js 已卸载）

// 拨号指令（v6: 使用 PIN, 自动唤醒手机）
ipcMain.on('dial', (event, number) => {
  const active = getActivePhone();
  if (active) {
    // 手机在线 → 直接发送
    const pin = active.pin;
    console.log('[拨号] ' + number + ' → ' + (active.alias || active.name) + ' (PIN=' + pin + ')');
    PhoneConnectionManager.sendToPhoneWithAck(pin, { type: 'dial', number }).then(acked => {
      if (acked) console.log('[拨号] ACK已确认: ' + number);
      else console.log('[拨号] ACK超时: ' + number);
    });
    [mainWindow, floatBarWindow].forEach(win => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('dial-sent', { number, phoneId: activePhoneId }); } catch (e) {}
      }
    });
    return;
  }

  // v6: 手机不在线 → 尝试唤醒 + 加入待发队列
  const targetPin = PhoneConnectionManager.activePin;
  if (!targetPin) {
    _sendError(event, '手机未连接');
    return;
  }

  fileLog('I', 'Dial', targetPin, `手机不在线，触发唤醒 → 排队拨号: ${number}`);
  console.log('[拨号-唤醒] ' + number + ' → 正在唤醒手机(PIN=' + targetPin + ')...');

  // 自动唤醒：优先云端，回退UDP
  const wakeSent = _tryWakePhone(targetPin);
  if (!wakeSent) {
    // 双路都不可用 → 立即通知
    if (event && event.sender) {
      try { event.sender.send('dial-wake-failed', { number, pin: targetPin, reason: '云端未连接且设备不在局域网' }); } catch (_) {}
    }
  }

  // 加入待发队列
  PhoneConnectionManager.queueDial(targetPin, number, () => {
    if (event && event.sender) {
      try { event.sender.send('dial-waking', { number, pin: targetPin }); } catch (_) {}
    }
  }).then(acked => {
    if (acked) {
      console.log('[拨号-补发] ACK已确认: ' + number);
    } else {
      console.log('[拨号-补发] 超时/失败: ' + number);
      if (event && event.sender) {
        try { event.sender.send('dial-timeout', { number }); } catch (_) {}
      }
    }
  });
});

// 挂断指令（v6: 使用 PIN）
ipcMain.on('hangup', (event) => {
  const active = getActivePhone();
  if (!active) {
    _sendError(event, '手机未连接');
    return;
  }
  const pin = active.pin;
  console.log('[挂断] → ' + (active.alias || active.name) + ' (PIN=' + pin + ')');
  PhoneConnectionManager.sendToPhoneWithAck(pin, { type: 'hangup' }).then(acked => {
    if (acked) console.log('[挂断] ACK已确认');
    else console.log('[挂断] ACK超时');
  });
  [mainWindow, floatBarWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('hangup-sent'); } catch (e) {}
    }
  });
});

// 发送短信指令（v6: 使用 PIN）
ipcMain.on('send-sms', (event, data) => {
  const active = getActivePhone();
  if (!active) {
    _sendError(event, '手机未连接');
    return;
  }
  const pin = active.pin;
  console.log('[短信] → ' + (active.alias || active.name) + ' (PIN=' + pin + ') 号码=' + data.number + ' 内容长度=' + data.content.length);
  PhoneConnectionManager.sendToPhoneWithAck(pin, { type: 'sms', number: data.number, content: data.content }).then(acked => {
    if (acked) console.log('[短信] ACK已确认: ' + data.number);
    else console.log('[短信] ACK超时: ' + data.number);
  });
});

// 打开短信编辑窗口
// payload 可以是字符串（仅号码）或对象 {number, content}
ipcMain.on('open-sms', (event, payload) => {
  const number  = typeof payload === 'object' ? (payload.number  || '') : (payload || '');
  const content = typeof payload === 'object' ? (payload.content || '') : '';

  if (smsWindow && !smsWindow.isDestroyed()) {
    smsWindow.show();
    smsWindow.focus();
    // 传号码+内容+连接状态给短信窗口
    try { smsWindow.webContents.send('sms-number', number); } catch (e) {}
    if (content) {
      try { smsWindow.webContents.send('sms-content', content); } catch (e) {}
    }
    try { smsWindow.webContents.send('status-update', { connected: phoneDevices.size > 0, phoneIP: null }); } catch (e) {}
    return;
  }
  smsWindow = new BrowserWindow({
    width: 400,
    height: 580,
    minWidth: 320,
    minHeight: 480,
    frame: false,
    transparent: false,
    backgroundColor: '#111318',
    resizable: true,
    modal: false,
    parent: mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  smsWindow.loadFile(path.join(__dirname, 'renderer', 'sms.html'));
  smsWindow.setMenuBarVisibility(false);
  smsWindow.on('closed', () => { smsWindow = null; });
  smsWindow.webContents.on('did-finish-load', () => {
    try {
      smsWindow.webContents.send('theme-changed', { theme: appSettings.theme, mode: appSettings.mode });
      smsWindow.webContents.send('sms-number', number);
      if (content) smsWindow.webContents.send('sms-content', content);
      // 同步手机连接状态
      smsWindow.webContents.send('status-update', { connected: phoneDevices.size > 0, phoneIP: null });
    } catch (e) {}
  });
});

// 窗口置顶
ipcMain.on('set-topmost', (event, enable) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(enable);
  }
  console.log('[置顶] ' + (enable ? '已开启' : '已关闭'));
});

// 悬浮横条显示/隐藏
ipcMain.on('toggle-floatbar', (event, show) => {
  if (!floatBarWindow) return;
  if (show) {
    floatBarWindow.show();
    console.log('[悬浮条] 已显示');
  } else {
    floatBarWindow.hide();
    console.log('[悬浮条] 已隐藏');
  }
  // 通知主界面更新开关状态
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('floatbar-visible-changed', show); } catch (e) {}
  }
});

// 悬浮横条显示主窗口
ipcMain.on('floatbar-show-main', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// 窗口控制（最小化/关闭）
ipcMain.on('window-control', (event, action) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'close') mainWindow.close();  // 触发 close 事件，弹出选择框
});

// 悬浮横条位置反馈
ipcMain.on('floatbar-position', (event, rect) => {
  // 可用于保存位置，后续扩展
});

// 悬浮横条拖拽移动
ipcMain.on('floatbar-move', (event, pos) => {
  if (floatBarWindow && !floatBarWindow.isDestroyed()) {
    floatBarWindow.setPosition(Math.round(pos.x), Math.round(pos.y));
  }
});

// 悬浮横条请求获取位置
ipcMain.on('floatbar-get-position', (event) => {
  if (floatBarWindow && !floatBarWindow.isDestroyed()) {
    const bounds = floatBarWindow.getBounds();
    try { event.sender.send('floatbar-position-reply', { x: bounds.x, y: bounds.y }); } catch (e) {}
  }
});

// 悬浮横条缩放（拖拽控制 - 右下角手柄）
ipcMain.on('floatbar-resize', (event, delta) => {
  if (!floatBarWindow || floatBarWindow.isDestroyed()) return;
  const oldScale = floatBarScale;
  floatBarScale = Math.round((floatBarScale + delta * 0.1) * 10) / 10;
  floatBarScale = Math.max(FLOATBAR_MIN_SCALE, Math.min(FLOATBAR_MAX_SCALE, floatBarScale));
  if (floatBarScale === oldScale) return;

  const baseW = 440, baseH = 48;
  const newW = Math.max(FLOATBAR_MIN_W, Math.round(baseW * floatBarScale));
  const newH = Math.round(baseH * floatBarScale);
  floatBarWindow.setSize(newW, newH);
});

// 悬浮横条精确尺寸调整（右键菜单展开/收起用）
ipcMain.on('floatbar-resize-to', (event, size) => {
  if (!floatBarWindow || floatBarWindow.isDestroyed()) return;
  if (size && size.width && size.height) {
    floatBarWindow.setSize(Math.round(size.width), Math.round(size.height));
  }
});

// 悬浮横条右键原生菜单
ipcMain.on('floatbar-context-menu', (event, { x, y, number }) => {
  if (!floatBarWindow || floatBarWindow.isDestroyed()) return;
  const template = [
    {
      label: '🏠 显示主窗口',
      click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } }
    },
    {
      label: '⚙ 打开设置',
      click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('open-settings-tab'); } }
    },
    { type: 'separator' },
    {
      label: number ? '📞 拨打 ' + number : '📞 拨打号码',
      click: () => { floatBarWindow.webContents.send('menu-dial'); }
    },
    {
      label: '📵 挂断通话',
      click: () => { floatBarWindow.webContents.send('menu-hangup'); }
    },
    {
      label: '💬 发送短信',
      click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('open-sms-tab'); } }
    },
    { type: 'separator' },
    {
      label: '🌵 隐藏悬浮条',
      click: () => { floatBarWindow.hide(); }
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  menu.popup(floatBarWindow, { x: 0, y: 48 });
});

// 获取当前缩放值
ipcMain.handle('floatbar-get-scale', () => {
  return floatBarScale;
});

// 选择活跃手机（v6: 使用 PIN）
ipcMain.on('select-phone', (event, pin) => {
  if (!phoneDevices.has(pin)) return;
  PhoneConnectionManager.setActiveDevice(pin);
  activePhoneId = PhoneConnectionManager.activePin;
  const dev = phoneDevices.get(pin);
  console.log('[切换] 活跃手机: ' + (dev.alias || dev.name) + ' (PIN=' + pin + ')');
  _notifyPhonesUpdate();
});

// 修改手机备注（v6: 使用 PIN）
ipcMain.on('rename-phone', (event, { id, pin, note }) => {
  const devicePin = pin || id;  // 兼容旧格式
  const dev = phoneDevices.get(devicePin);
  if (!dev) return;
  dev.alias = note;
  savePhoneNote(devicePin, dev.name, note);
  console.log('[备注] PIN=' + devicePin + ' → ' + note);
  _notifyPhonesUpdate();
});

// 云端配置更新
ipcMain.on('update-cloud-config', (event, { enabled, server, servers }) => {
  appSettings.cloudEnabled = !!enabled;
  if (server !== undefined) appSettings.cloudServer = server;
  if (servers !== undefined) appSettings.cloudServers = servers;
  // 同步：如果有多个服务器，cloudServer 保存第一个（向后兼容）
  if (Array.isArray(servers) && servers.length > 0 && !server) {
    appSettings.cloudServer = servers[0];
  }
  saveSettings(appSettings);
  console.log('[云端] 配置更新: enabled=' + appSettings.cloudEnabled + ' servers=' + JSON.stringify(appSettings.cloudServers) + ' server=' + appSettings.cloudServer);

  if (appSettings.cloudEnabled) {
    const serverList = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
      ? appSettings.cloudServers
      : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
    if (serverList.length > 0) {
      connectCloudServersFromList(serverList, 0);
    }
  } else {
    disconnectCloudServer();
  }
});

// 获取云端状态
ipcMain.handle('get-cloud-status', async () => {
  return {
    enabled: appSettings.cloudEnabled,
    server: appSettings.cloudServer,
    servers: appSettings.cloudServers || [],
    connected: cloudConnected
  };
});

// v6: 强制重连（通过云端中继唤醒手机）
ipcMain.on('force-reconnect', (event, pin) => {
  const targetPin = pin || PhoneConnectionManager.activePin;
  if (!targetPin) {
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: false, error: '没有选中设备' }); } catch (_) {}
    }
    return;
  }
  const device = PhoneConnectionManager.devices.get(targetPin);
  if (!device) {
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: false, error: '设备不存在' }); } catch (_) {}
    }
    return;
  }
  fileLog('I', 'Reconn', targetPin, `用户触发强制重连: ${device.alias || device.name}`);

  // 优先通过云端中继发送 reconnect_request
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    const sent = PhoneConnectionManager.sendForceReconnectViaCloud(targetPin, cloudWs);
    if (event.sender) {
      try { event.sender.send('force-reconnect-result', { success: sent, error: sent ? null : '云端未连接' }); } catch (_) {}
    }
    return;
  }

  // 纯局域网场景：v6 规范2.4 - 从邻居表取出手机 IP，定向发送 UDP wake_connect
  const phoneIP = device.ip;
  if (!phoneIP || phoneIP === 'cloud') {
    fileLog('W', 'Reconn', targetPin, '无可用局域网 IP，无法发送 UDP wake_connect');
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

// v6: 自动唤醒手机（拨号请求触发）
// @returns {boolean} true=唤醒指令已发出, false=双路都不可用
function _tryWakePhone(targetPin) {
  // 优先通过云端中继
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    PhoneConnectionManager.sendForceReconnectViaCloud(targetPin, cloudWs);
    return true;
  }
  // 纯局域网：UDP wake_connect
  const device = PhoneConnectionManager.devices.get(targetPin);
  if (device && device.ip && device.ip !== 'cloud') {
    try {
      const wakeMsg = JSON.stringify({ type: 'wake_connect', pin: targetPin, ip: LOCAL_IP, port: PORT });
      udpSocket.send(wakeMsg, DISCOVERY_PORT, device.ip);
      fileLog('I', 'Dial', targetPin, `自动唤醒: UDP wake_connect → ${device.ip}`);
      return true;
    } catch (e) {
      fileLog('E', 'Dial', targetPin, `自动唤醒UDP失败: ${e.message}`);
    }
  }
  // v7: IP 未知或IP=cloud（手机可能在局域网但之前通过云端注册）
  // 改发 UDP 广播到 255.255.255.255，局域网内所有手机都能收到
  try {
    const broadcastMsg = JSON.stringify({ type: 'wake_connect', pin: targetPin, ip: LOCAL_IP, port: PORT });
    udpSocket.send(broadcastMsg, DISCOVERY_PORT, '255.255.255.255');
    fileLog('I', 'Dial', targetPin, `自动唤醒: UDP 广播(broadcast) 尝试发现局域网手机`);
    return true;
  } catch (e) {
    fileLog('E', 'Dial', targetPin, `自动唤醒UDP广播失败: ${e.message}`);
  }
  // 双路都不可用
  fileLog('W', 'Dial', targetPin, '自动唤醒失败: 云端未连接且UDP广播也失败');
  return false;
}

// v6: 重启 PC 端软件（退出后自动重新打开）
ipcMain.on('restart-app', () => {
  fileLog('I', 'App', null, '用户触发重启');
  app.relaunch();
  app.exit(0);
});

// v6: 轻量云端重连（只重建云端通道，不重启整个软件）
ipcMain.on('restart-cloud', () => {
  fileLog('I', 'Cloud', null, '用户触发云端重连');
  cloudReconnectAttempt = 0;
  if (cloudWs) {
    try {
      if (cloudWs._pingTimer) clearInterval(cloudWs._pingTimer);
      cloudWs.close();
    } catch (e) {}
    cloudWs = null;
  }
  const serverList = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
    ? appSettings.cloudServers
    : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
  if (serverList.length > 0) {
    connectCloudServersFromList(serverList, 0);
  }
});

// v6: 拨号失败时自动云端重连（拨号超时触发的轻量恢复）
ipcMain.on('dial-failed-trigger-recovery', () => {
  fileLog('I', 'Cloud', null, '拨号超时, 触发云端轻量恢复');
  // 只重建云端通道，不重建 LAN
  if (appSettings.cloudEnabled) {
    // v6修复: 无论当前cloudConnected状态如何都重置计数，防止TCP半开连接导致计数器不归零
    cloudReconnectAttempt = 0;
    if (!cloudConnected) {
      if (cloudWs) {
        try {
          if (cloudWs._pingTimer) clearInterval(cloudWs._pingTimer);
          cloudWs.close();
        } catch (e) {}
        cloudWs = null;
      }
    }
    const serverList = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
      ? appSettings.cloudServers
      : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
    if (serverList.length > 0) {
      connectCloudServersFromList(serverList, 0);
    }
  }
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
          sock.destroy();  // D7修复: error 时也要 destroy，防止 socket 句柄泄漏
          resolve({ ok: false, ms: 0, error: '不可连接' });
        });
        sock.connect(port, host);
      });
      results.push({ addr, ok: result.ok, ms: result.ms, error: result.error });  // E6修复: 使用 Promise 内计算的 ms
    } catch (e) {
      results.push({ addr, ok: false, ms: 0, error: e.message });
    }
  }
  return results;
});

// 连接到指定云端服务器（手动切换）
ipcMain.on('connect-cloud-specific', (event, serverUrl) => {
  if (!serverUrl || !appSettings.cloudEnabled) return;
  appSettings.cloudServer = serverUrl;
  saveSettings(appSettings);
  connectCloudServer(serverUrl);
});

function _sendError(event, message) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('error', { message }); } catch (e) {}
  }
}

// ==================== HTTP/WebSocket 服务器 ====================
const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'invalid url' }));
    return;
  }

  // 所有请求统一加 CORS 头（允许浏览器插件跨域访问）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  
  // 云服务器列表接口 - 手机端同步PC配置
  if (url.pathname === '/cloud-servers') {
    const list = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
        ? appSettings.cloudServers
        : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ servers: list }));
    return;
  }

  // HTTP拨号接口 - 插件调用
  if (url.pathname.includes('dial') && url.searchParams.has('number')) {
    const number = url.searchParams.get('number');
    
    // 验证号码格式（允许中国大陆手机号、固话、国际号码、400/800）
    if (!/^(\+?[\d\s\-\(\)]{4,20})$/.test(number.replace(/\s/g, ''))) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: '无效的号码格式' }));
      return;
    }
    
    // v6: 转发给活跃手机端拨号（PIN 标识，自动唤醒）
    const active = getActivePhone();
    if (active) {
      const pin = active.pin;
      const cleanNumber = number.replace(/[\s\-\(\)]/g, '');
      PhoneConnectionManager.sendToPhoneWithAck(pin, { type: 'dial', number: cleanNumber }).then(acked => {
        fileLog('I', 'HTTP', pin, `拨号 ${cleanNumber} ${acked ? 'ACK已确认' : 'ACK超时'}`);
      });

      // 同时将号码写入剪贴板
      try { clipboard.writeText(number); } catch (e) {}

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, number: number }));
      console.log('[HTTP拨号] ' + number + ' (来自浏览器插件，已写入剪贴板)');
      return;
    }

    // v6: 手机不在线 → 自动唤醒 + 排队
    const targetPin = PhoneConnectionManager.activePin;
    if (!targetPin) {
      // v6: 无任何注册设备 → 尝试云端重连 + 局域网广播唤醒
      const cloudTriggered = _triggerCloudRecovery();
      _broadcastLanWake();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        success: false,
        error: '手机未连接',
        recovery: { cloud: cloudTriggered, lanBroadcast: true }
      }));
      fileLog('W', 'HTTP', null, `拨号失败：无设备, 已触发云端重连=${cloudTriggered}+局域网唤醒`);
      return;
    }

    const cleanNumber = number.replace(/[\s\-\(\)]/g, '');
    fileLog('I', 'HTTP', targetPin, `手机不在线，触发唤醒 → 排队拨号: ${cleanNumber}`);
    const wakeSent = _tryWakePhone(targetPin);
    try { clipboard.writeText(number); } catch (e) {}

    PhoneConnectionManager.queueDial(targetPin, cleanNumber).then(acked => {
      fileLog('I', 'HTTP', targetPin, `排队拨号 ${cleanNumber} ${acked ? '已补发' : '超时'}`);
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, number: number, waking: true, wakeSent }));
    return;
  }
  
  // 打开主窗口接口 - 浏览器插件调用
  if (url.pathname === '/open') {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      console.log('[HTTP] 插件请求打开主窗口');
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 切换悬浮横条显示/隐藏 - 浏览器插件调用
  if (url.pathname === '/toggle-floatbar') {
    const show = url.searchParams.get('show'); // 'true'/'false'，不传则切换
    if (!floatBarWindow) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: '悬浮窗未创建' }));
      return;
    }
    let targetShow;
    if (show === 'true') targetShow = true;
    else if (show === 'false') targetShow = false;
    else targetShow = !floatBarWindow.isVisible();

    if (targetShow) floatBarWindow.show();
    else floatBarWindow.hide();

    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('floatbar-visible-changed', targetShow); } catch (e) {}
    }
    console.log('[HTTP] 插件切换悬浮窗:', targetShow ? '显示' : '隐藏');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true, visible: targetShow }));
    return;
  }

  // 打开短信窗口 - 浏览器插件调用
  if (url.pathname === '/sms') {
    const number = url.searchParams.get('number') || '';
    const content = url.searchParams.get('content') || '';
    if (number) {
      // 触发 open-sms IPC，复用现有短信窗口逻辑
      ipcMain.emit('open-sms', { sender: { send: () => {} } }, { number, content });
      console.log('[HTTP] 插件请求发送短信:', number);
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: !!number, number }));
    return;
  }

  // 挂断电话 - 浏览器插件调用
  if (url.pathname === '/hangup') {
    const active = getActivePhone();
    if (!active) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: false, error: '手机未连接' }));
      console.log('[HTTP挂断] 失败：手机未连接');
      return;
    }
    // v6: 挂断
    const hangupPin = active.pin;
    PhoneConnectionManager.sendToPhoneWithAck(hangupPin, { type: 'hangup' }).then(acked => {
      fileLog('I', 'HTTP', hangupPin, `挂断 ${acked ? 'ACK已确认' : 'ACK超时'}`);
    });
    [mainWindow, floatBarWindow].forEach(win => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('hangup-sent'); } catch (e) {}
      }
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 默认：返回状态信息
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    pin: PIN_CODE,
    ip: LOCAL_IP,
    ips: getLocalIPs(),
    port: PORT,
    connected: phoneDevices.size > 0,
    phoneCount: phoneDevices.size,
    phones: getPhoneList()
  }));
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const clientIP = req.socket.remoteAddress.replace('::ffff:', '');
  console.log('[连接] 新客户端: ' + clientIP);
  fileLog('I', 'ConnMgr', null, `新WS连接: ${clientIP}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // v6: 手机端握手 - 以 PIN 为标识
      if (msg.type === 'phone_hello') {
        if (msg.pin !== PIN_CODE) {
          ws.send(JSON.stringify({ type: 'auth_fail', reason: '配对码错误' }));
          ws.close();
          fileLog('W', 'LAN', null, `配对码错误: ${msg.pin}`);
          return;
        }
        const pin = msg.pin; // v6: 直接使用 PIN 作为设备标识
        const deviceName = msg.deviceName || ('手机');
        fileLog('I', 'LAN', pin, `phone_hello: name=${deviceName} ip=${clientIP}`);

        // 清理同 PIN 的旧 LAN 连接
        const existing = PhoneConnectionManager.devices.get(pin);
        if (existing && existing.ws && existing.ws !== ws) {
          fileLog('I', 'LAN', pin, '关闭旧 LAN 连接');
          try { existing.ws.close(); } catch (_) {}
        }

        const savedAlias = loadPhoneNote(pin, deviceName);

        ws.isPhone = true;
        ws.devicePin = pin;

        PhoneConnectionManager.registerDevice(pin, {
          ip: clientIP,
          name: deviceName,
          alias: savedAlias,
          ws,
          isCloud: false
        });

        activePhoneId = PhoneConnectionManager.activePin;

        ws.send(JSON.stringify({ type: 'auth_ok', message: '配对成功！', pin }));
        fileLog('I', 'LAN', pin, `配对成功: ${deviceName} (${clientIP})`);
        // v6: 连接成功后补发待发拨号
        if (PhoneConnectionManager.hasQueuedDial(pin)) {
          fileLog('I', 'LAN', pin, '检测到待发拨号，立即补发');
          PhoneConnectionManager.flushDialQueue(pin);
        }
        return;
      }

      // v6: ACK 处理
      if (msg.type === 'ack') {
        const pin = ws.devicePin;
        if (pin) PhoneConnectionManager.updateHeartbeat(pin);
        PhoneConnectionManager.handleAck(msg);
        if (pin) logMessage('RECV-LAN', pin, 'ack', `messageId=${msg.messageId} originalType=${msg.originalType}`);
        return;
      }

      // 手机回报拨号结果
      if (msg.type === 'dial_result') {
        const pin = ws.devicePin;
        if (pin) PhoneConnectionManager.updateHeartbeat(pin);
        fileLog('I', 'LAN', pin, `拨号结果: ${msg.number} → ${msg.status}`);
        [mainWindow, floatBarWindow].forEach(win => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('dial-result', msg); } catch (e) {}
          }
        });
        return;
      }

      // 手机回报短信结果
      if (msg.type === 'sms_result') {
        const pin = ws.devicePin;
        if (pin) PhoneConnectionManager.updateHeartbeat(pin);
        fileLog('I', 'LAN', pin, `短信结果: ${msg.number} → ${msg.status}`);
        [mainWindow, floatBarWindow, smsWindow].forEach(win => {
          if (win && !win.isDestroyed()) {
            try { win.webContents.send('sms-result', msg); } catch (e) {}
          }
        });
        return;
      }

      // 心跳
      if (msg.type === 'ping') {
        const pin = ws.devicePin;
        if (pin) PhoneConnectionManager.updateHeartbeat(pin);
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // 上传协议消息
      if (msg.type === 'file_upload_start' || msg.type === 'file_chunk' ||
          msg.type === 'file_upload_complete' || msg.type === 'file_upload_error') {
        const pin = ws.devicePin;
        if (pin) PhoneConnectionManager.updateHeartbeat(pin);
        const handler = {
          'file_upload_start': 'onFileUploadStart',
          'file_chunk': 'onFileChunk',
          'file_upload_complete': 'onFileUploadComplete',
          'file_upload_error': 'onFileUploadError'
        }[msg.type];
        if (handler) PhoneConnectionManager[handler](pin, msg);
        return;
      }

      // 插件端连接（无需验证 PIN）
      if (msg.type === 'plugin_hello') {
        pluginSocket = ws;
        ws.isPlugin = true;
        ws.send(JSON.stringify({ type: 'plugin_ok', message: '插件已连接', phoneConnected: PhoneConnectionManager.devices.size > 0 }));
        fileLog('I', 'Plugin', null, '浏览器插件连接成功');
        return;
      }

      // 插件发送拨号命令 (v6: 手机不在线时触发自动唤醒)
      if (msg.type === 'dial' && ws.isPlugin) {
        const active = PhoneConnectionManager.getActiveDevice();
        if (active) {
          fileLog('I', 'Plugin', active.pin, `插件拨号: ${msg.number} → ${active.alias || active.name}`);
          PhoneConnectionManager.sendToPhoneWithAck(active.pin, { type: 'dial', number: msg.number }).then(acked => {
            fileLog('I', 'Plugin', active.pin, `插件拨号结果: ${msg.number} ${acked ? 'ACK已确认' : 'ACK超时'}`);
          });
          ws.send(JSON.stringify({ type: 'dial_sent', number: msg.number }));
          return;
        }

        // v6: 手机不在线 → 尝试唤醒
        const targetPin = PhoneConnectionManager.activePin;
        if (targetPin) {
          fileLog('I', 'Plugin', targetPin, `插件拨号 ${msg.number} → 手机不在线，触发唤醒`);
          _tryWakePhone(targetPin);
          PhoneConnectionManager.queueDial(targetPin, msg.number);
          ws.send(JSON.stringify({ type: 'dial_waking', number: msg.number, pin: targetPin }));
          return;
        }

        // 无任何设备 → 触发恢复
        _triggerCloudRecovery();
        _broadcastLanWake();
        ws.send(JSON.stringify({ type: 'dial_fail', reason: '手机未连接，已尝试唤醒', recovery: true }));
        fileLog('W', 'Plugin', null, '插件拨号失败：手机未连接，已触发唤醒');
        return;
      }

      // 其他消息记录
      if (ws.devicePin) {
        logMessage('RECV-LAN', ws.devicePin, msg.type || '?', data.toString());
      }

    } catch (e) {
      console.error('[错误] 解析消息失败:', e.message);
      fileLog('E', 'WS', null, `消息解析失败: ${e.message}`);
    }
  });

  ws.on('close', () => {
    if (ws.isPhone && ws.devicePin) {
      PhoneConnectionManager.removeDevice(ws.devicePin, 'lan');
      activePhoneId = PhoneConnectionManager.activePin;
      fileLog('I', 'LAN', ws.devicePin, 'LAN 连接关闭');
    }
    if (ws.isPlugin) {
      pluginSocket = null;
      fileLog('I', 'Plugin', null, '浏览器插件断开连接');
    }
  });

  ws.on('error', (err) => {
    fileLog('E', 'WS', ws.devicePin || null, `错误: ${err.message}`);
  });
});

function _notifyPhonesUpdate() {
  activePhoneId = PhoneConnectionManager.activePin;
  // v8修复: 检查是否有真正活跃的设备，而非仅 device.size > 0
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

global._notifyPhonesUpdate = _notifyPhonesUpdate;

// v6: 心跳检查间隔改为 15s（心跳超时 45s / 3）
setInterval(() => PhoneConnectionManager.checkHeartbeats(), 15000);
// v6: 邻居表 TTL 清理 (规范3.4: TTL 30s, 15s 巡检)
setInterval(() => PhoneConnectionManager.cleanupStaleDevices(), 15000);

// ==================== v6 UDP 广播发现服务 ====================
// 多网卡适配器：对所有可用接口发送 UDP 广播
const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

udpSocket.on('error', (err) => {
  fileLog('E', 'Discovery', null, `UDP错误: ${err.message}`);
});

udpSocket.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());
    if (data.type === 'discover' && data.pin === PIN_CODE) {
      const reply = JSON.stringify({
        type: 'found',
        pin: PIN_CODE,
        ip: LOCAL_IP,
        port: PORT
      });
      udpSocket.send(reply, rinfo.port, rinfo.address);
      fileLog('I', 'Discovery', null, `回复发现请求: ${rinfo.address}`);
    }
  } catch (e) {}
});

udpSocket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
  udpSocket.setBroadcast(true);
  fileLog('I', 'Discovery', null, `UDP广播服务已启动, 端口: ${DISCOVERY_PORT}`);
});

// v6: 多网卡广播 - 通过所有可用接口发送
function startBroadcast() {
  const msg = JSON.stringify({
    type: 'announce',
    pin: PIN_CODE,
    ip: LOCAL_IP,
    port: PORT
  });
  const allIps = getLocalIPs();
  fileLog('I', 'Discovery', null, `可用IP列表: ${allIps.join(', ')}`);

  // v6: 保活间隔 10s（规范要求）
  setInterval(() => {
    try {
      udpSocket.send(msg, DISCOVERY_PORT, '255.255.255.255');
    } catch (e) {}
  }, 10000);
}

// ==================== v6 云中转连接管理 ====================
let cloudWs = null;
let cloudReconnectTimer = null;
let cloudReconnectAttempt = 0;
let cloudConnected = false;
let _cloudTraversalGeneration = 0;

function connectCloudServer(targetServerUrl, onResult) {
  let serverUrl = targetServerUrl || appSettings.cloudServer;
  if (!serverUrl || !appSettings.cloudEnabled) {
    fileLog('I', 'Cloud', null, '云中转未启用或未配置服务器地址');
    return;
  }
  if (!serverUrl.startsWith('ws://') && !serverUrl.startsWith('wss://')) {
    serverUrl = 'ws://' + serverUrl;
  }

  fileLog('I', 'Cloud', null, `正在连接云中转: ${serverUrl}`);

  try {
    // v6: 先创建新WebSocket再关闭旧的，消灭cloudWs=null窗口
    const newWs = new WebSocket(serverUrl);
    _cloudTraversalGeneration++;
    newWs._generation = _cloudTraversalGeneration;

    // v7: 开启TCP keepalive — 底层快速检测断线
    if (newWs._socket) {
      newWs._socket.setKeepAlive(true, 10000);  // 10s间隔，3次重试=30s检测
    }

    // 关闭旧连接
    if (cloudWs) {
      try { cloudWs.close(); } catch (e) {}
    }
    cloudWs = newWs;

    // v7: 云端 pong 超时检测
    newWs._lastPong = Date.now();
    const PONG_TIMEOUT = 20000; // 20s 无pong判死（必须 > PING_INTERVAL，否则第一个 ping 还没发就超时）
    const PING_INTERVAL = 15000; // 15s 发一次ping

    newWs.on('open', () => {
      fileLog('I', 'Cloud', null, 'WebSocket 已连接，发送 pc_hello');
      newWs.send(JSON.stringify({
        type: 'pc_hello',
        pin: PIN_CODE,
        hostname: os.hostname()
      }));
    });

    newWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'pc_auth_ok') {
          cloudConnected = true;
          cloudReconnectAttempt = 0;
          newWs._established = true;  // v6: 标记连接已建立，断开时走 _scheduleCloudReconnect
          appSettings.cloudServer = serverUrl;
          saveSettings(appSettings);
          fileLog('I', 'Cloud', null, `认证成功 PIN=${msg.pin} 在线手机数=${msg.phoneCount}`);
          // v6修复: 云端重连后更新所有已注册设备的cloudWs引用
          PhoneConnectionManager.devices.forEach((dev, pin) => {
            if (dev.isCloud) dev.cloudWs = newWs;
          });
          _notifyCloudStatus();
          if (typeof onResult === 'function') onResult(true, serverUrl);
        }

        if (msg.type === 'pc_auth_fail') {
          cloudConnected = false;
          fileLog('E', 'Cloud', null, `认证失败: ${msg.reason || ''}`);
          _notifyCloudStatus();
          if (typeof onResult === 'function') onResult(false, serverUrl);
        }

        // v6: 手机通过云端连接（以 PIN 为标识）
        if (msg.type === 'phone_hello') {
          const pin = msg.pin;
          const deviceName = msg.deviceName || '云端手机';
          fileLog('I', 'Cloud', pin, `phone_hello: device=${deviceName}`);

          PhoneConnectionManager.registerDevice(pin, {
            ip: 'cloud',
            name: deviceName,
            alias: loadPhoneNote(pin, deviceName),
            cloudWs: newWs,
            isCloud: true
          });

          activePhoneId = PhoneConnectionManager.activePin;

          newWs.send(JSON.stringify({
            type: 'auth_ok',
            message: '配对成功！',
            pin,
            targetDevice: msg.deviceName
          }));

          fileLog('I', 'Cloud', pin, `云端配对成功: ${deviceName}`);
          // v6: 连接成功后补发待发拨号
          if (PhoneConnectionManager.hasQueuedDial(pin)) {
            fileLog('I', 'Cloud', pin, '检测到待发拨号，立即补发');
            PhoneConnectionManager.flushDialQueue(pin);
          }
          return;
        }

        // v6: ACK
        if (msg.type === 'ack') {
          logMessage('RECV-CLOUD', null, 'ack', `messageId=${msg.messageId} originalType=${msg.originalType}`);
          PhoneConnectionManager.updateHeartbeatByName(msg.deviceName);
          PhoneConnectionManager.handleAck(msg);
          return;
        }

        // 云端拨号结果
        if (msg.type === 'dial_result') {
          fileLog('I', 'Cloud', null, `拨号结果: ${msg.number} → ${msg.status}`);
          [mainWindow, floatBarWindow].forEach(win => {
            if (win && !win.isDestroyed()) {
              try { win.webContents.send('dial-result', msg); } catch (e) {}
            }
          });
          return;
        }

        // 云端短信结果
        if (msg.type === 'sms_result') {
          [mainWindow, floatBarWindow, smsWindow].forEach(win => {
            if (win && !win.isDestroyed()) {
              try { win.webContents.send('sms-result', msg); } catch (e) {}
            }
          });
          return;
        }

        if (msg.type === 'ping') {
          PhoneConnectionManager.updateHeartbeatByName(msg.deviceName);
          return;
        }

        if (msg.type === 'pong' || msg.type === 'error') {
          // v7: 记录 pong 时间用于超时检测
          if (msg.type === 'pong') newWs._lastPong = Date.now();
          return;
        }

      } catch (e) {
        fileLog('E', 'Cloud', null, `消息解析失败: ${e.message}`);
      }
    });

    newWs.on('close', (code, reason) => {
      if (newWs._cleanedUp) return;
      newWs._cleanedUp = true;
      // v6 稳定性: 旧连接的事件不处理，防止覆盖新连接状态
      if (newWs._generation !== _cloudTraversalGeneration) {
        fileLog('W', 'Cloud', null, `旧连接(generation=${newWs._generation})的close事件, 当前generation=${_cloudTraversalGeneration}, 忽略`);
        return;
      }
      cloudConnected = false;
      if (newWs._pingTimer) { clearInterval(newWs._pingTimer); newWs._pingTimer = null; }
      fileLog('W', 'Cloud', null, `连接断开 code=${code}`);
      // 移除所有云端通道
      PhoneConnectionManager.devices.forEach((dev, pin) => {
        if (dev.isCloud) PhoneConnectionManager.removeDevice(pin, 'cloud');
      });
      activePhoneId = PhoneConnectionManager.activePin;
      _notifyCloudStatus();
      _notifyPhonesUpdate();
      // v6: 已建立过的连接断开时走 _scheduleCloudReconnect，不再回调 onResult
      if (newWs._established) {
        _scheduleCloudReconnect();
      } else if (typeof onResult === 'function') {
        onResult(false, serverUrl);
      }
    });

    newWs.on('error', (err) => {
      if (newWs._cleanedUp) return;
      newWs._cleanedUp = true;
      // v6 稳定性: 旧连接的事件不处理
      if (newWs._generation !== _cloudTraversalGeneration) {
        fileLog('W', 'Cloud', null, `旧连接(generation=${newWs._generation})的error事件, 忽略`);
        return;
      }
      cloudConnected = false;
      if (newWs._pingTimer) { clearInterval(newWs._pingTimer); newWs._pingTimer = null; }
      fileLog('E', 'Cloud', null, `连接错误: ${err.message}`);
      _removeCloudPhones();
      _notifyCloudStatus();
      _notifyPhonesUpdate();  // v6: 补UI刷新
      if (typeof onResult === 'function') onResult(false, serverUrl);
    });

    // v7: 定期发送心跳 + pong超时检测
    newWs._pingTimer = setInterval(() => {
      if (newWs && newWs.readyState === WebSocket.OPEN) {
        // 检查上次pong是否超时
        const sinceLastPong = Date.now() - newWs._lastPong;
        if (sinceLastPong > PONG_TIMEOUT) {
          fileLog('W', 'Cloud', null, `pong超时(${Math.round(sinceLastPong/1000)}s), 判定云端断线`);
          try { newWs.close(4000, 'pong_timeout'); } catch (e) {}
          return;
        }
        try { newWs.send(JSON.stringify({ type: 'ping' })); } catch (e) {}
      }
    }, PING_INTERVAL);

  } catch (e) {
    fileLog('E', 'Cloud', null, `创建连接失败: ${e.message}`);
    if (typeof onResult === 'function') onResult(false, serverUrl);
  }
}

/**
 * 从云服务器列表中遍历尝试连接，成功一个即停止
 * @param {string[]} servers 服务器列表
 * @param {number} startIndex 开始尝试的索引
 */
function connectCloudServersFromList(servers, startIndex) {
  if (!Array.isArray(servers) || servers.length === 0) return;

  const thisGeneration = ++_cloudTraversalGeneration;

  function tryNext(index) {
    if (thisGeneration !== _cloudTraversalGeneration) {
      console.log('[云端] 遍历已被新连接取代，停止当前遍历');
      return;
    }
    if (index >= servers.length) {
      console.log('[云端] 所有云服务器连接失败');
      return;
    }

    const server = servers[index];
    console.log('[云端] 尝试服务器 ' + (index + 1) + '/' + servers.length + ': ' + server);

    connectCloudServer(server, function(success, url) {
      if (thisGeneration !== _cloudTraversalGeneration) return;
      if (success) {
        console.log('[云端] 服务器连接成功: ' + url);
      } else {
        console.log('[云端] 服务器连接失败: ' + url + '，尝试下一个');
        tryNext(index + 1);
      }
    });
  }

  tryNext(startIndex || 0);
}

function _scheduleCloudReconnect() {
  if (cloudReconnectTimer) clearTimeout(cloudReconnectTimer);
  if (!appSettings.cloudEnabled) return;

  // v6: 阶梯降频策略 + 30次上限
  const MAX_CLOUD_RETRY = 30;
  if (cloudReconnectAttempt >= MAX_CLOUD_RETRY) {
    fileLog('W', 'Cloud', null, `云端重连达到上限(${MAX_CLOUD_RETRY}次), 停止自动重连, 等待手动触发`);
    return;
  }

  const nextAttempt = cloudReconnectAttempt + 1;
  const delay = _getCloudReconnectDelay(nextAttempt);
  fileLog('I', 'Cloud', null, `云端重连(第${nextAttempt}次), 等待${delay / 1000}s`);
  cloudReconnectTimer = setTimeout(() => {
    cloudReconnectAttempt = nextAttempt;
    const serverList = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
      ? appSettings.cloudServers
      : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
    if (serverList.length > 0) {
      connectCloudServersFromList(serverList, 0);
    }
  }, delay);
}

/** v6: 阶梯降频延迟计算（与规范5.1一致） */
function _getCloudReconnectDelay(attempt) {
  if (attempt === 1)  return 0;
  if (attempt === 2)  return 1000;
  if (attempt === 3)  return 3000;
  if (attempt <= 6)   return 5000;
  if (attempt <= 10)  return 10000;
  if (attempt <= 15)  return 30000;
  if (attempt <= 20)  return 60000;
  return 300000;
}

// v6: HTTP拨号失败时触发云端重连（3秒防抖）
let _lastCloudTriggerTime = 0;
function _triggerCloudRecovery() {
  const now = Date.now();
  if (now - _lastCloudTriggerTime < 3000) {
    return false;
  }
  if (!appSettings.cloudEnabled) {
    fileLog('W', 'Cloud', null, '云端未启用, 跳过自动重连');
    return false;
  }
  _lastCloudTriggerTime = now;

  // 云端已连接 → 不重建，只刷新心跳
  if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
    fileLog('I', 'Cloud', null, '云端已连接, 无需重建');
    return false;
  }

  fileLog('I', 'Cloud', null, 'HTTP拨号失败, 触发云端重连');

  // v6: 取消旧重连定时器，防止竞态
  if (cloudReconnectTimer) { clearTimeout(cloudReconnectTimer); cloudReconnectTimer = null; }

  // 断开旧连接（如果存在）
  if (cloudWs) {
    try {
      if (cloudWs._pingTimer) clearInterval(cloudWs._pingTimer);
      cloudWs.close();
    } catch (e) {}
    cloudWs = null;
  }

  // 从第1次开始重连
  cloudReconnectAttempt = 0;
  const serverList = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
    ? appSettings.cloudServers
    : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
  if (serverList.length > 0) {
    connectCloudServersFromList(serverList, 0);
    return true;
  }
  return false;
}

// v7: HTTP拨号失败时尝试局域网 UDP 唤醒（向所有注册过 LAN IP 的设备发送 + 广播兜底）
function _broadcastLanWake() {
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
  // v7: 兜底—UDP广播，覆盖IP未知的手机
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

function _removeCloudPhones() {
  const toRemove = [];
  PhoneConnectionManager.devices.forEach((dev, pin) => {
    if (dev.isCloud) toRemove.push(pin);
  });
  toRemove.forEach(pin => PhoneConnectionManager.removeDevice(pin, 'cloud'));
  activePhoneId = PhoneConnectionManager.activePin;
}

function disconnectCloudServer() {
  if (cloudReconnectTimer) clearTimeout(cloudReconnectTimer);
  cloudReconnectTimer = null;
  if (cloudWs) {
    try {
      if (cloudWs._pingTimer) clearInterval(cloudWs._pingTimer);
      cloudWs.close();
    } catch (e) {}
    cloudWs = null;
  }
  cloudConnected = false;
  _removeCloudPhones();
  _notifyCloudStatus();
  _notifyPhonesUpdate();
  fileLog('I', 'Cloud', null, '已断开云中转连接');
}

// 向后兼容
function sendToCloudPhone(phone, msg) {
  if (!phone || !phone.pin) return false;
  return PhoneConnectionManager.sendToPhone(phone.pin, msg);
}

function _notifyCloudStatus() {
  const status = {
    enabled: appSettings.cloudEnabled,
    server: appSettings.cloudServer,
    servers: appSettings.cloudServers || [],
    connected: cloudConnected
  };
  [mainWindow, floatBarWindow, settingsWindow].forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('cloud-status', status); } catch (e) {}
    }
  });
}

// ==================== 防火墙检查 ====================
let firewallWarning = false;

function tryAddFirewallRule() {
  exec(
    'netsh advfirewall firewall add rule name="AutoDial" dir=in action=allow protocol=TCP localport=' + PORT + ' profile=any description=AutoDial一键拨号 2>nul & ' +
    'netsh advfirewall firewall add rule name="AutoDial UDP" dir=in action=allow protocol=UDP localport=' + DISCOVERY_PORT + ' profile=any description=AutoDial一键拨号 2>nul',
    (err) => {
      if (err) {
        console.log('[防火墙] 自动添加失败（需要管理员权限）');
        firewallWarning = true;
      } else {
        console.log('[防火墙] 入站规则已添加');
      }
    }
  );
}

// ==================== 启动 ====================
app.whenReady().then(() => {
  tryAddFirewallRule();
  cleanOldLogs();  // v6修复: 等 app ready 后再清理旧日志

  // v6修复: 推迟到 app ready 后执行（app.getPath 在此之前不可用）
  fileLog('I', 'Logger', null, '=== AutoDial PC v6 日志系统启动 ===');
  fileLog('I', 'Logger', null, `日志目录: ${_getLogDir()}`);
  saveSettings(appSettings);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('[错误] 端口 ' + PORT + ' 已被占用，请关闭其他 AutoDial 实例');
      // 使用 dialog 替代 mshta
      const { dialog } = require('electron');
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
    console.log('  配对码:   ' + PIN_CODE);
    console.log('  端口:     ' + PORT);
    console.log('  连接上限: ' + PhoneConnectionManager.MAX_CONNECTIONS + ' 台手机');
    console.log('========================================');

    startBroadcast();
    createTray();
    createMainWindow();
    createFloatBarWindow();

    // 云中转：如果已配置并启用，自动连接
    if (appSettings.cloudEnabled) {
      const serverList = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
        ? appSettings.cloudServers
        : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
      if (serverList.length > 0) {
        connectCloudServersFromList(serverList, 0);
      }
    }

    // 隐藏界面启动：启动后立即隐藏主窗口
    if (appSettings.silentStart) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
        console.log('[启动] 隐藏界面启动模式');
      }
    }

    // 同步开机自启动状态
    if (appSettings.autoStart) {
      setAutoStart(true);
    }
  });
});

app.on('window-all-closed', () => {
  // 有托盘且未标记退出，保持程序运行
  if (tray && !app.isQuitting) return;
  app.quit();
});

// 全局异常捕获
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err.message);
  try { fileLog('E', 'Fatal', null, `未捕获异常: ${err.message}\n${err.stack}`); } catch (_) {}
  // 严重错误后尝试优雅退出（保留最后日志）
  try { saveSettings(appSettings); } catch (_) {}
  app.isQuitting = true;
  app.quit();
});

process.on('unhandledRejection', (reason) => {
  console.error('[未处理Promise拒绝]', reason);
  try { fileLog('E', 'Fatal', null, `未处理Promise拒绝: ${reason}`); } catch (_) {}
});
