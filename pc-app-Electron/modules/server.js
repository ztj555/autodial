'use strict';
/**
 * HTTP + WebSocket 服务器模块
 * 
 * 用法:
 *   const serverModule = require('./modules/server');
 *   const { server, wss } = serverModule.createServer(deps);
 *   server.listen(PORT, '0.0.0.0', () => { ... });
 * 
 * deps 对象包含:
 *   http, WebSocket, clipboard, PORT, getPin, LOCAL_IP, getLocalIPs, getPhoneList,
 *   fileLog, logMessage, PhoneConnectionManager, cloudRelay, 
 *   getActivePhone, _tryWakePhone, _broadcastLanWake, isValidDialNumber,
 *   getWindows, getMainWindow, getFloatBarWindow, getSmsWindow,
 *   activePhoneIdRef, loadPhoneNote, appSettings, saveSettings,
 *   ipcMain (可选，用于 /sms 路由触发的 IPC)
 */

const path = require('path');

function createServer(deps) {
  const {
    http,
    WebSocket,
    clipboard,          // electron clipboard
    PORT,
    getPin,             // () => PIN_CODE (延迟读取)
    LOCAL_IP,
    getLocalIPs,
    getPhoneList,
    fileLog,
    logMessage,
    PhoneConnectionManager,
    cloudRelay,
    getActivePhone,
    _tryWakePhone,
    _broadcastLanWake,
    isValidDialNumber,
    getWindows,
    getFloatBarWindow,
    getSmsWindow,
    activePhoneIdRef,
    loadPhoneNote,
    appSettings,
    saveSettings,
    ipcMain            // 可选
  } = deps;

  // ==================== HTTP 服务器 ====================
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'invalid url' }));
      return;
    }

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 云服务器列表接口
    if (url.pathname === '/cloud-servers') {
      const list = Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
        ? appSettings.cloudServers
        : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ servers: list }));
      return;
    }

    // HTTP 拨号接口
    if (url.pathname.includes('dial') && url.searchParams.has('number')) {
      const number = url.searchParams.get('number');

      if (!isValidDialNumber(number)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '无效的号码格式' }));
        return;
      }

      const active = getActivePhone();
      if (active) {
        const pin = active.pin;
        const cleanNumber = number.replace(/[\s\-\(\)]/g, '');
        PhoneConnectionManager.sendToPhoneWithAck(pin, { type: 'dial', number: cleanNumber }).then(acked => {
          fileLog('I', 'HTTP', pin, `拨号 ${cleanNumber} ${acked ? 'ACK已确认' : 'ACK超时'}`);
        });

        try { clipboard.writeText(number); } catch (e) {}

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, number: number }));
        console.log('[HTTP拨号] ' + number + ' (来自浏览器插件，已写入剪贴板)');
        return;
      }

      // 手机不在线 → 自动唤醒 + 排队
      const targetPin = PhoneConnectionManager.activePin;
      if (!targetPin) {
        const cloudTriggered = cloudRelay.triggerRecovery();
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

    // 打开主窗口
    if (url.pathname === '/open') {
      const mainWin = getWindows()[0];
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.show();
        mainWin.focus();
        console.log('[HTTP] 插件请求打开主窗口');
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 切换悬浮横条
    if (url.pathname === '/toggle-floatbar') {
      const floatBarWin = getFloatBarWindow();
      const mainWin = getWindows()[0];
      if (!floatBarWin) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: '悬浮窗未创建' }));
        return;
      }
      const show = url.searchParams.get('show');
      let targetShow;
      if (show === 'true') targetShow = true;
      else if (show === 'false') targetShow = false;
      else targetShow = !floatBarWin.isVisible();

      if (targetShow) floatBarWin.show();
      else floatBarWin.hide();

      if (mainWin && !mainWin.isDestroyed()) {
        try { mainWin.webContents.send('floatbar-visible-changed', targetShow); } catch (e) {}
      }
      console.log('[HTTP] 插件切换悬浮窗:', targetShow ? '显示' : '隐藏');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, visible: targetShow }));
      return;
    }

    // 打开短信窗口
    if (url.pathname === '/sms') {
      const number = url.searchParams.get('number') || '';
      const content = url.searchParams.get('content') || '';
      if (number && ipcMain) {
        // 触发 open-sms IPC
        ipcMain.emit('open-sms', { sender: { send: () => {} } }, { number, content });
        console.log('[HTTP] 插件请求发送短信:', number);
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !!number, number }));
      return;
    }

    // 挂断电话
    if (url.pathname === '/hangup') {
      const active = getActivePhone();
      if (!active) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: false, error: '手机未连接' }));
        console.log('[HTTP挂断] 失败：手机未连接');
        return;
      }
      const hangupPin = active.pin;
      PhoneConnectionManager.sendToPhoneWithAck(hangupPin, { type: 'hangup' }).then(acked => {
        fileLog('I', 'HTTP', hangupPin, `挂断 ${acked ? 'ACK已确认' : 'ACK超时'}`);
      });
      getWindows().forEach(win => {
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
      pin: getPin(),
      ip: LOCAL_IP,
      ips: getLocalIPs(),
      port: PORT,
      connected: PhoneConnectionManager.devices.size > 0,
      phoneCount: PhoneConnectionManager.devices.size,
      phones: getPhoneList()
    }));
  });

  // ==================== WebSocket 服务器 ====================
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress.replace('::ffff:', '');
    console.log('[连接] 新客户端: ' + clientIP);
    fileLog('I', 'ConnMgr', null, `新WS连接: ${clientIP}`);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);

        // 手机端握手 (LAN)
        if (msg.type === 'phone_hello') {
          const currentPin = getPin();
          if (msg.pin !== currentPin) {
            ws.send(JSON.stringify({ type: 'auth_fail', reason: '配对码错误' }));
            ws.close();
            fileLog('W', 'LAN', null, `配对码错误: ${msg.pin}`);
            return;
          }
          const pin = msg.pin;
          const deviceName = msg.deviceName || ('手机');
          fileLog('I', 'LAN', pin, `phone_hello: name=${deviceName} ip=${clientIP}`);

          // 清理同 PIN 的旧 LAN 连接
          const existing = PhoneConnectionManager.devices.get(pin);
          if (existing && existing.ws && existing.ws !== ws) {
            fileLog('I', 'LAN', pin, '关闭旧 LAN 连接');
            try { existing.ws.close(); } catch (_) {}
          }

          const savedAlias = loadPhoneNote ? loadPhoneNote(pin, deviceName) : '';

          ws.isPhone = true;
          ws.devicePin = pin;

          PhoneConnectionManager.registerDevice(pin, {
            ip: clientIP,
            name: deviceName,
            alias: savedAlias,
            ws,
            isCloud: false
          });

          activePhoneIdRef.current = PhoneConnectionManager.activePin;

          ws.send(JSON.stringify({ type: 'auth_ok', message: '配对成功！', pin }));
          if (msg.messageId) {
            ws.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, originalType: 'phone_hello' }));
          }
          fileLog('I', 'LAN', pin, `配对成功: ${deviceName} (${clientIP})`);
          if (PhoneConnectionManager.hasQueuedDial(pin)) {
            fileLog('I', 'LAN', pin, '检测到待发拨号，立即补发');
            PhoneConnectionManager.flushDialQueue(pin);
          }
          return;
        }

        // ACK
        if (msg.type === 'ack') {
          const pin = ws.devicePin;
          if (pin) PhoneConnectionManager.updateHeartbeat(pin);
          PhoneConnectionManager.handleAck(msg);
          if (pin) logMessage('RECV-LAN', pin, 'ack', `messageId=${msg.messageId} originalType=${msg.originalType}`);
          return;
        }

        // 拨号结果
        if (msg.type === 'dial_result') {
          const pin = ws.devicePin;
          if (pin) PhoneConnectionManager.updateHeartbeat(pin);
          fileLog('I', 'LAN', pin, `拨号结果: ${msg.number} → ${msg.status}`);
          getWindows().forEach(win => {
            if (win && !win.isDestroyed()) {
              try { win.webContents.send('dial-result', msg); } catch (e) {}
            }
          });
          return;
        }

        // 短信结果
        if (msg.type === 'sms_result') {
          const pin = ws.devicePin;
          if (pin) PhoneConnectionManager.updateHeartbeat(pin);
          fileLog('I', 'LAN', pin, `短信结果: ${msg.number} → ${msg.status}`);
          const smsWin = getSmsWindow ? getSmsWindow() : null;
          const allWins = [...getWindows()];
          if (smsWin && !allWins.includes(smsWin)) allWins.push(smsWin);
          allWins.forEach(win => {
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

        // 文件上传协议消息
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

        // 插件端连接
        if (msg.type === 'plugin_hello') {
          // pluginSocket 由 main.js 管理
          ws.isPlugin = true;
          ws.send(JSON.stringify({ type: 'plugin_ok', message: '插件已连接', phoneConnected: PhoneConnectionManager.devices.size > 0 }));
          fileLog('I', 'Plugin', null, '浏览器插件连接成功');
          if (deps.onPluginConnected) deps.onPluginConnected(ws);
          return;
        }

        // 插件发送拨号命令
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

          const targetPin = PhoneConnectionManager.activePin;
          if (targetPin) {
            fileLog('I', 'Plugin', targetPin, `插件拨号 ${msg.number} → 手机不在线，触发唤醒`);
            _tryWakePhone(targetPin);
            PhoneConnectionManager.queueDial(targetPin, msg.number);
            ws.send(JSON.stringify({ type: 'dial_waking', number: msg.number, pin: targetPin }));
            return;
          }

          cloudRelay.triggerRecovery();
          _broadcastLanWake();
          ws.send(JSON.stringify({ type: 'dial_fail', reason: '手机未连接，已尝试唤醒', recovery: true }));
          fileLog('W', 'Plugin', null, '插件拨号失败：手机未连接，已触发唤醒');
          return;
        }

        // 其他消息
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
        activePhoneIdRef.current = PhoneConnectionManager.activePin;
        fileLog('I', 'LAN', ws.devicePin, 'LAN 连接关闭');
      }
      if (ws.isPlugin) {
        if (deps.onPluginDisconnected) deps.onPluginDisconnected();
        fileLog('I', 'Plugin', null, '浏览器插件断开连接');
      }
    });

    ws.on('error', (err) => {
      fileLog('E', 'WS', ws.devicePin || null, `错误: ${err.message}`);
    });
  });

  return { server, wss };
}

module.exports = { createServer };
