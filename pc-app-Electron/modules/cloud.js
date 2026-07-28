'use strict';
/**
 * 云中转连接管理模块
 * 
 * 内部管理连接状态，通过依赖注入接收外部依赖
 * 
 * 用法:
 *   const CloudRelay = require('./modules/cloud');
 *   const cloud = CloudRelay.create({
 *     wsLibrary, appSettings, fileLog, logMessage,
 *     PhoneConnectionManager, os, saveSettings, _notifyCloudStatus, _notifyPhonesUpdate,
 *     activePhoneIdRef, getWindows
 *   });
 *   cloud.connectToFirst();
 *   cloud.disconnect();
 *   cloud.getStatus(); // { enabled, server, servers, connected }
 */

const os = require('os');

function createCloudRelayManager(deps) {
  const {
    WebSocket,            // ws 库
    appSettings,          // 可变设置对象引用
    fileLog,
    logMessage,
    PhoneConnectionManager,
    saveSettings,         // function(settings) 持久化
    onCloudStatusChanged, // function() 通知前端
    onPhonesUpdate,       // function() 通知手机列表更新
    activePhoneIdRef,     // { current: activePhoneId } — 可变引用
    getWindows            // function() → [mainWindow, floatBarWindow, settingsWindow, smsWindow]
  } = deps;

  // ==================== 内部状态 ====================
  let cloudWs = null;
  let cloudReconnectTimer = null;
  let cloudReconnectAttempt = 0;
  let cloudConnected = false;
  let _cloudTraversalGeneration = 0;
  let _lastCloudTriggerTime = 0;

  // ==================== 阶梯降频延迟计算 ====================
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

  // ==================== 通知机制 ====================
  function _notifyCloud() {
    if (onCloudStatusChanged) onCloudStatusChanged(getStatus());
  }

  function _notifyWindows(event, data) {
    const wins = getWindows ? getWindows() : [];
    wins.forEach(win => {
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(event, data); } catch (e) {}
      }
    });
  }

  function _removeCloudPhones() {
    const toRemove = [];
    PhoneConnectionManager.devices.forEach((dev, pin) => {
      if (dev.isCloud) toRemove.push(pin);
    });
    toRemove.forEach(pin => PhoneConnectionManager.removeDevice(pin, 'cloud'));
    activePhoneIdRef.current = PhoneConnectionManager.activePin;
  }

  // ==================== 重连调度 ====================
  function _scheduleCloudReconnect() {
    if (cloudReconnectTimer) clearTimeout(cloudReconnectTimer);
    if (!appSettings.cloudEnabled) return;

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
      connectToFirst();
    }, delay);
  }

  function _getServerList() {
    return Array.isArray(appSettings.cloudServers) && appSettings.cloudServers.length > 0
      ? appSettings.cloudServers
      : (appSettings.cloudServer ? [appSettings.cloudServer] : []);
  }

  // ==================== 主要连接逻辑 ====================
  function connect(serverUrl, onResult) {
    let url = serverUrl || appSettings.cloudServer;
    if (!url || !appSettings.cloudEnabled) {
      fileLog('I', 'Cloud', null, '云中转未启用或未配置服务器地址');
      return;
    }
    if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
      url = 'ws://' + url;
    }

    fileLog('I', 'Cloud', null, `正在连接云中转: ${url}`);

    try {
      const newWs = new WebSocket(url);
      _cloudTraversalGeneration++;
      newWs._generation = _cloudTraversalGeneration;

      // TCP keepalive
      if (newWs._socket) {
        newWs._socket.setKeepAlive(true, 10000);
      }

      // 关闭旧连接
      if (cloudWs) {
        try { cloudWs.close(); } catch (e) {}
      }
      cloudWs = newWs;

      // pong 超时检测
      newWs._lastPong = Date.now();
      const PONG_TIMEOUT = 20000;
      const PING_INTERVAL = 15000;

      newWs.on('open', () => {
        fileLog('I', 'Cloud', null, 'WebSocket 已连接，发送 pc_hello');
        newWs.send(JSON.stringify({
          type: 'pc_hello',
          pin: deps.getPin ? deps.getPin() : '',
          hostname: os.hostname()
        }));
      });

      newWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'pc_auth_ok') {
            cloudConnected = true;
            cloudReconnectAttempt = 0;
            newWs._established = true;
            appSettings.cloudServer = url;
            saveSettings(appSettings);
            fileLog('I', 'Cloud', null, `认证成功 PIN=${msg.pin} 在线手机数=${msg.phoneCount}`);
            PhoneConnectionManager.devices.forEach((dev, pin) => {
              if (dev.isCloud) dev.cloudWs = newWs;
            });
            _notifyCloud();
            if (typeof onResult === 'function') onResult(true, url);
          }

          if (msg.type === 'pc_auth_fail') {
            cloudConnected = false;
            fileLog('E', 'Cloud', null, `认证失败: ${msg.reason || ''}`);
            _notifyCloud();
            if (typeof onResult === 'function') onResult(false, url);
          }

          if (msg.type === 'phone_hello') {
            const pin = msg.pin;
            const deviceName = msg.deviceName || '云端手机';
            fileLog('I', 'Cloud', pin, `phone_hello: device=${deviceName}`);

            const { loadPhoneNote } = require('./phone-notes');
            const savedAlias = loadPhoneNote(appSettings, pin, deviceName);

            PhoneConnectionManager.registerDevice(pin, {
              ip: 'cloud',
              name: deviceName,
              alias: savedAlias,
              cloudWs: newWs,
              isCloud: true
            });

            activePhoneIdRef.current = PhoneConnectionManager.activePin;

            newWs.send(JSON.stringify({
              type: 'auth_ok',
              message: '配对成功！',
              pin,
              targetDevice: msg.deviceName
            }));
            if (msg.messageId) {
              newWs.send(JSON.stringify({ type: 'ack', messageId: msg.messageId, originalType: 'phone_hello' }));
            }

            fileLog('I', 'Cloud', pin, `云端配对成功: ${deviceName}`);
            if (PhoneConnectionManager.hasQueuedDial(pin)) {
              fileLog('I', 'Cloud', pin, '检测到待发拨号，立即补发');
              PhoneConnectionManager.flushDialQueue(pin);
            }
            return;
          }

          if (msg.type === 'ack') {
            logMessage('RECV-CLOUD', null, 'ack', `messageId=${msg.messageId} originalType=${msg.originalType}`);
            PhoneConnectionManager.updateHeartbeatByName(msg.deviceName);
            PhoneConnectionManager.handleAck(msg);
            return;
          }

          if (msg.type === 'dial_result') {
            fileLog('I', 'Cloud', null, `拨号结果: ${msg.number} → ${msg.status}`);
            _notifyWindows('dial-result', msg);
            return;
          }

          if (msg.type === 'sms_result') {
            _notifyWindows('sms-result', msg);
            return;
          }

          if (msg.type === 'ping') {
            PhoneConnectionManager.updateHeartbeatByName(msg.deviceName);
            return;
          }

          if (msg.type === 'pong' || msg.type === 'error') {
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
        if (newWs._generation !== _cloudTraversalGeneration) {
          fileLog('W', 'Cloud', null, `旧连接(generation=${newWs._generation})的close事件, 当前generation=${_cloudTraversalGeneration}, 忽略`);
          return;
        }
        cloudConnected = false;
        if (newWs._pingTimer) { clearInterval(newWs._pingTimer); newWs._pingTimer = null; }
        fileLog('W', 'Cloud', null, `连接断开 code=${code}`);
        PhoneConnectionManager.devices.forEach((dev, pin) => {
          if (dev.isCloud) PhoneConnectionManager.removeDevice(pin, 'cloud');
        });
        activePhoneIdRef.current = PhoneConnectionManager.activePin;
        _notifyCloud();
        if (onPhonesUpdate) onPhonesUpdate();
        if (newWs._established) {
          _scheduleCloudReconnect();
        } else if (typeof onResult === 'function') {
          onResult(false, url);
        }
      });

      newWs.on('error', (err) => {
        if (newWs._cleanedUp) return;
        newWs._cleanedUp = true;
        if (newWs._generation !== _cloudTraversalGeneration) {
          fileLog('W', 'Cloud', null, `旧连接(generation=${newWs._generation})的error事件, 忽略`);
          return;
        }
        cloudConnected = false;
        if (newWs._pingTimer) { clearInterval(newWs._pingTimer); newWs._pingTimer = null; }
        fileLog('E', 'Cloud', null, `连接错误: ${err.message}`);
        _removeCloudPhones();
        _notifyCloud();
        if (onPhonesUpdate) onPhonesUpdate();
        if (typeof onResult === 'function') onResult(false, url);
      });

      // 定期心跳
      newWs._pingTimer = setInterval(() => {
        if (newWs && newWs.readyState === WebSocket.OPEN) {
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
      if (typeof onResult === 'function') onResult(false, url);
    }
  }

  /**
   * 从服务器列表中遍历尝试连接，成功一个即停止
   */
  function connectFromList(servers, startIndex) {
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

      connect(server, function(success, url) {
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

  function connectToFirst() {
    const list = _getServerList();
    if (list.length > 0) {
      connectFromList(list, 0);
    }
  }

  function disconnect() {
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
    _notifyCloud();
    if (onPhonesUpdate) onPhonesUpdate();
    fileLog('I', 'Cloud', null, '已断开云中转连接');
  }

  /**
   * HTTP拨号失败时触发云端重连（3秒防抖）
   * @returns {boolean} true=已触发重连
   */
  function triggerRecovery() {
    const now = Date.now();
    if (now - _lastCloudTriggerTime < 3000) {
      return false;
    }
    if (!appSettings.cloudEnabled) {
      fileLog('W', 'Cloud', null, '云端未启用, 跳过自动重连');
      return false;
    }
    _lastCloudTriggerTime = now;

    if (cloudWs && cloudWs.readyState === WebSocket.OPEN) {
      fileLog('I', 'Cloud', null, '云端已连接, 无需重建');
      return false;
    }

    fileLog('I', 'Cloud', null, 'HTTP拨号失败, 触发云端重连');

    if (cloudReconnectTimer) { clearTimeout(cloudReconnectTimer); cloudReconnectTimer = null; }

    if (cloudWs) {
      try {
        if (cloudWs._pingTimer) clearInterval(cloudWs._pingTimer);
        cloudWs.close();
      } catch (e) {}
      cloudWs = null;
    }

    cloudReconnectAttempt = 0;
    connectToFirst();
    return true;
  }

  /**
   * 轻量云端重连（IPC 触发）
   */
  function restartLight() {
    fileLog('I', 'Cloud', null, '用户触发云端重连');
    cloudReconnectAttempt = 0;
    if (cloudWs) {
      try {
        if (cloudWs._pingTimer) clearInterval(cloudWs._pingTimer);
        cloudWs.close();
      } catch (e) {}
      cloudWs = null;
    }
    connectToFirst();
  }

  /**
   * 拨号超时触发的云端恢复（IPC 触发）
   */
  function dialFailedRecovery() {
    fileLog('I', 'Cloud', null, '拨号超时, 触发云端轻量恢复');
    if (!appSettings.cloudEnabled) return;
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
    connectToFirst();
  }

  function getStatus() {
    return {
      enabled: appSettings.cloudEnabled,
      server: appSettings.cloudServer,
      servers: appSettings.cloudServers || [],
      connected: cloudConnected
    };
  }

  function getWs() {
    return cloudWs;
  }

  function isConnected() {
    return cloudConnected;
  }

  function getGeneration() {
    return _cloudTraversalGeneration;
  }

  function incrementGeneration() {
    return ++_cloudTraversalGeneration;
  }

  return {
    // 主要操作
    connect,
    connectFromList,
    connectToFirst,
    disconnect,
    triggerRecovery,
    restartLight,
    dialFailedRecovery,

    // 查询
    getStatus,
    getWs,
    isConnected,
    getGeneration,
    incrementGeneration,

    // 内部状态暴露（给 server.js 的 HTTP 路由使用）
    get cloudWs() { return cloudWs; },
    get cloudConnected() { return cloudConnected; }
  };
}

module.exports = {
  createCloudRelayManager
};
