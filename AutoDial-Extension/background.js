/**
 * AutoDial Background Script v4.0
 * 双模路由：PC直连优先 → 云端 PIN 兜底
 * CRM检测到手机号 → 自动存为 PIN（不再自动登录）
 * 服务器地址：点击插件图标设置（存 chrome.storage）
 * 整合版：去 JWT，接 11 位 PIN 全链路强校验
 */
console.log('[AutoDial BG] v4.0 已加载 (PIN 验证模式)');

// ==================== 配置 ====================
const PC_BASE = 'http://127.0.0.1:35432';
const PC_PING_TIMEOUT = 2000;
const PC_CHECK_INTERVAL_MIN = 0.5; // Fix B6: periodic check every 30 seconds

// Fix D1: multiple cloud server support
async function getCloudApiList() {
  const stored = await chrome.storage.local.get(['cloud_api', 'cloud_apis']);
  if (stored.cloud_apis && stored.cloud_apis.length > 0) return stored.cloud_apis;
  const single = stored.cloud_api || 'http://127.0.0.1:35430';
  return [single];
}

async function getCloudApi() {
  const list = await getCloudApiList();
  return list[0];
}

// ==================== 状态 ====================
let pcAvailable = null;
const tabPhones = {};

// ==================== PIN 管理 ====================

async function getPin() {
  // 优先从 content-script 自动检测的坐席手机号
  const stored = await chrome.storage.local.get(['self_phone', 'pin']);
  return stored.pin || stored.self_phone || null;
}

// ==================== PC 检测 ====================

async function checkPcNow() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), PC_PING_TIMEOUT);
    await fetch(`${PC_BASE}/`, { signal: ctrl.signal });
    return true;
  } catch {
    return false;
  }
}

async function isPcAlive() {
  if (pcAvailable !== null) return pcAvailable;
  return await refreshPcStatus();
}

async function refreshPcStatus() {
  pcAvailable = await checkPcNow();
  if (pcAvailable) {
    console.log('[AutoDial BG] PC 在线，使用本地模式');
  } else {
    console.log('[AutoDial BG] PC 离线，使用云端模式');
  }
  return pcAvailable;
}

function resetPcStatus() {
  pcAvailable = null;
  refreshPcStatus();
}

// Fix B6: periodically check PC status via chrome.alarms
// When PC comes online, notify tabs so they can update UI
chrome.alarms.create('checkPc', { periodInMinutes: PC_CHECK_INTERVAL_MIN });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkPc') {
    const wasAlive = pcAvailable;
    await refreshPcStatus();
    if (!wasAlive && pcAvailable === true) {
      // PC just came online — notify all tabs
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        if (tab.id) notifyTab(tab.id, { type: 'pcStatusChange', online: true });
      });
    } else if (wasAlive === true && pcAvailable === false) {
      const tabs = await chrome.tabs.query({});
      tabs.forEach(tab => {
        if (tab.id) notifyTab(tab.id, { type: 'pcStatusChange', online: false });
      });
    }
  }
});

// ==================== 双模拨号 ====================

async function dial(phone, tabId) {
  // 1) PC 直连优先（2秒超时）
  if (await isPcAlive()) {
    try {
      const res = await fetch(`${PC_BASE}/dial?number=${encodeURIComponent(phone)}`,
                              { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        notifyTab(tabId, { type: 'dialResult', ok: true });
        return;
      }
    } catch {
      pcAvailable = null;  // PC 缓存失效，下次拨号重新检测
    }
  }

  // 2) PC 不可达 → 云端兜底 (Fix D1: try all cloud servers)
  const pin = await getPin();
  if (!pin) {
    const stored = await chrome.storage.local.get(['self_phone']);
    const err = stored.self_phone
      ? '服务器不可达 (端口35430)'
      : '未检测到坐席手机号，请打开 CRM 页面';
    notifyTab(tabId, { type: 'dialResult', ok: false, err });
    return;
  }

  const cloudServers = await getCloudApiList();
  for (const cloudApi of cloudServers) {
    try {
      const res = await fetch(`${cloudApi}/api/v1/dial?number=${encodeURIComponent(phone)}`, {
        headers: { 'X-AutoDial-PIN': pin },
        signal: AbortSignal.timeout(5000)
      });
      const d = await res.json();

      if (d.code === 'PC_CONNECTED') {
        pcAvailable = true;
        notifyTab(tabId, { type: 'dialResult', ok: false, err: 'PC已上线，请重试' });
        return;
      }
      notifyTab(tabId, { type: 'dialResult', ok: d.ok, err: d.message || '' });
      return;
    } catch (e) {
      // This server failed, try the next one
      continue;
    }
  }
  // All cloud servers failed
  notifyTab(tabId, { type: 'dialResult', ok: false, err: '所有云服务器不可达 (端口35430)' });
}

// ==================== 挂断 + 短信 ====================

async function hangup(tabId) {
  if (await isPcAlive()) {
    try { await fetch(`${PC_BASE}/hangup`); return; } catch { pcAvailable = null; }
  }
  const pin = await getPin();
  if (!pin) return;
  // Fix D1: try all cloud servers for hangup
  const cloudServers = await getCloudApiList();
  for (const cloudApi of cloudServers) {
    try {
      await fetch(`${cloudApi}/api/v1/hangup`, {
        headers: { 'X-AutoDial-PIN': pin },
        signal: AbortSignal.timeout(5000)
      });
      return;
    } catch { continue; }
  }
}

async function sendSms(phone, tabId) {
  if (await isPcAlive()) {
    try {
      const r = await fetch(`${PC_BASE}/sms?number=${encodeURIComponent(phone)}`);
      if (r.ok) return;
      notifyTab(tabId, { type: 'dialResult', ok: false, err: '短信发送失败（PC端返回错误）' });
      return;
    } catch { pcAvailable = null; }
  }
  // 云端暂不支持 SMS 转发（无对应 REST 端点，且 process_request 不接收 POST body）
  // PC 离线时明确告知用户
  notifyTab(tabId, { type: 'dialResult', ok: false, err: '短信仅支持 PC 直连模式' });
}

// ==================== 辅助函数 ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function notifyTab(tabId, msg) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
  }
}

async function reDetectPhone(tabId) {
  if (!tabId) return null;
  try {
    const resp = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'reDetect' }, { frameId: 0 }, resolve);
    });
    if (resp?.phone) {
      await chrome.storage.local.set({ self_phone: resp.phone });
    }
    return resp?.phone || null;
  } catch {
    return null;
  }
}

// ==================== 消息路由 ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  // content-script 检测到客户手机号
  if (msg.type === 'phoneDetected') {
    if (tabId) {
      tabPhones[tabId] = msg.phone;
      chrome.tabs.sendMessage(tabId, { type: 'updatePhone', phone: msg.phone }, { frameId: 0 }).catch(() => {});
    }
    return;
  }

  // content-script 检测到坐席手机号 → 存为 PIN
  if (msg.type === 'selfPhoneDetected') {
    chrome.storage.local.set({ self_phone: msg.phone });
    console.log('[AutoDial BG] 坐席手机号已检测:', msg.phone);
    return;
  }

  if (msg.type === 'dial') { dial(msg.phone, tabId); return true; }
  if (msg.type === 'hangup') { hangup(tabId); return true; }
  if (msg.type === 'sendSms') { sendSms(msg.phone, tabId); return true; }

  // 设置或手动输入 PIN
  if (msg.type === 'setPin') {
    const p = (msg.pin || '').trim();
    if (!p || !/^1[3-9]\d{9}$/.test(p)) {
      sendResponse({ success: false, error: 'PIN 格式错误' });
      return true;
    }
    chrome.storage.local.set({ pin: p }, () => {
      console.log('[AutoDial BG] PIN 已设置:', p);
      sendResponse({ success: true });
    });
    return true;
  }

  // 获取状态（popup 用）
  if (msg.type === 'getStatus') {
    getPin().then(pin => {
      chrome.storage.local.get(['self_phone'], (s) => {
        sendResponse({
          hasPin: !!pin,
          phone: pin || s.self_phone || '',
          pcAlive: pcAvailable
        });
      });
    });
    return true;
  }

  if (msg.type === 'openDesktop') {
    fetch(`${PC_BASE}/open`).then(r => r.json()).then(d => sendResponse({ success: d.success })).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (msg.type === 'checkPc') {
    resetPcStatus();
    return;
  }
});

chrome.tabs.onRemoved.addListener(tabId => { delete tabPhones[tabId]; });
