'use strict';
/**
 * 文件日志系统模块
 * 
 * 用法:
 *   const logger = require('./modules/logger');
 *   logger.init(app);  // 在 app.whenReady() 后调用
 *   logger.fileLog('I', 'Module', '12345678901', '一些内容');
 *   logger.logMessage('SEND', '12345678901', 'dial', '{"number":"139..."}');
 *   logger.cleanOldLogs();
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// ==================== 内部状态 ====================
let _LOG_DIR = null;
const MAX_LOG_SIZE = 10 * 1024 * 1024;  // 10MB
const MAX_LOG_DAYS = 7;
const LOG_FALLBACK_BUFFER = [];
const LOG_FALLBACK_MAX = 1000;
let _logFailCount = 0;
let _app = null;

// ==================== 公开 API ====================

function init(app) {
  _app = app;
  try {
    _LOG_DIR = path.join(app.getPath('userData'), 'autodial-logs');
    fs.mkdirSync(_LOG_DIR, { recursive: true });
  } catch (e) {
    const fallback = process.env.APPDATA || os.homedir();
    _LOG_DIR = path.join(fallback, 'autodial-pc', 'autodial-logs');
  }
}

function getLogDir() {
  if (!_LOG_DIR && _app) {
    init(_app);
  }
  if (!_LOG_DIR) {
    const fallback = process.env.APPDATA || os.homedir();
    return path.join(fallback, 'autodial-pc', 'autodial-logs');
  }
  return _LOG_DIR;
}

function getLogFilePath() {
  const dateStr = new Date().toISOString().slice(0, 10);
  return path.join(getLogDir(), `autodial-pc-${dateStr}.log`);
}

function fileLog(level, module, pin, msg) {
  try {
    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}.${String(now.getMilliseconds()).padStart(3,'0')}`;
    const pinStr = pin ? `[${pin}]` : '[----]';
    const line = `${ts} [${level}] [${module}] ${pinStr} ${msg}\n`;

    const logFile = getLogFilePath();
    // 5级编号轮转（.1 → .2 → ... → .5），不再覆盖旧备份
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile);
      if (stat.size >= MAX_LOG_SIZE) {
        const MAX_BACKUPS = 5;
        const extIdx = logFile.lastIndexOf('.log');
        for (let i = MAX_BACKUPS; i >= 1; i--) {
          const oldFile = logFile.slice(0, extIdx) + '.' + i + logFile.slice(extIdx);
          if (i === MAX_BACKUPS) {
            try { fs.unlinkSync(oldFile); } catch (_) {}
          } else {
            const olderFile = logFile.slice(0, extIdx) + '.' + (i + 1) + logFile.slice(extIdx);
            try { fs.renameSync(olderFile, oldFile); } catch (_) {}
          }
        }
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
    const logDir = getLogDir();
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

// ==================== 日志缓冲区（广播到渲染进程） ====================
const _logBuffer = [];

function pushLog(level, text) {
  const entry = { level, text, ts: Date.now() };
  _logBuffer.push(entry);
  if (_logBuffer.length > 200) _logBuffer.shift();
  return entry;
}

function flushLogBuffer(win) {
  _logBuffer.forEach(entry => {
    try { win.webContents.send('server-log', entry); } catch (e) {}
  });
}

function broadcastLog(entry, windows) {
  const allWindows = Array.isArray(windows) ? windows : [windows];
  allWindows.forEach(win => {
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('server-log', entry); } catch (e) {}
    }
  });
}

// 初始化日志清理定时器
let _logCleanupTimer = null;
function startLogCleanup() {
  if (_logCleanupTimer) return;
  _logCleanupTimer = setInterval(cleanOldLogs, 6 * 60 * 60 * 1000);
}

function stopLogCleanup() {
  if (_logCleanupTimer) {
    clearInterval(_logCleanupTimer);
    _logCleanupTimer = null;
  }
}

module.exports = {
  init,
  getLogDir,
  getLogFilePath,
  fileLog,
  logMessage,
  cleanOldLogs,
  pushLog,
  flushLogBuffer,
  broadcastLog,
  startLogCleanup,
  stopLogCleanup
};
