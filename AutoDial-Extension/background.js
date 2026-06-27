/**
 * AutoDial Background Script v4.0
 * 双模路由：PC直连优先 -> 云端 PIN 兜底
 * 基于 v3.1 稳定版重构，仅将 JWT 替换为 PIN 认证
 */
console.log('[AutoDial BG] v4.0 已加载 (PIN 模式)');

// ==================== 配置 ====================
const PC_BASE = 'http://127.0.0.1:35432';
const PC_PING_TIMEOUT = 500;  // 本地 ping 500ms 足够，超时走云端

// 后台定时探测 PC 状态（每 15 秒），保证拨号时缓存始终有效，不卡顿
async function refreshPcStatus() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), PC_PING_TIMEOUT);
    await fetch(`${PC_BASE}/`, { signal: ctrl.signal });
    pcAvailable = true;
    pcLastCheck = Date.now();
  } catch {
    pcAvailable = false;
    pcLastCheck = Date.now();
  }
}

chrome.alarms.create('pcCheck', { periodInMinutes: 0.25 }); // 15 秒
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pcCheck') refreshPcStatus();
});
refreshPcStatus(); // 启动时立刻探测一次

// 地址标准化：纯 IP:PORT -> http://IP:PORT，已有协议不动
function fixUrl(addr) {
  if (!addr) return 'http://262ao85kz470.vicp.fun:55535';
  if (/^https?:\/\//i.test(addr)) return addr;
  if (/^ws:\/\//i.test(addr)) return addr.replace(/^ws:/i, 'http:');
  if (/^wss:\/\//i.test(addr)) return addr.replace(/^wss:/i, 'https:');
  return 'http://' + addr;
}

async function getCloudApi() {
  // 手动设置的地址优先，其次自动获取的列表
  const stored = await chrome.storage.local.get(['cloud_api', 'cloud_apis_fetched']);
  if (stored.cloud_api) return fixUrl(stored.cloud_api);
  if (stored.cloud_apis_fetched && stored.cloud_apis_fetched.length > 0) {
    return fixUrl(stored.cloud_apis_fetched[0]);
  }
  return 'http://262ao85kz470.vicp.fun:55535';
}

// 一键获取云服务器列表（从 Gist/Gitee）
async function fetchCloudList() {
  const sources = [
    'https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt',
    'https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt'
  ];

  for (const url of sources) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) continue;
      const text = await res.text();

      const servers = [];
      for (let line of text.split('\n')) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        // 跳过 [xxx] 标签
        if (/^\[.+\]$/.test(line)) continue;
        // 清理后缀标签
        line = line.replace(/新云端|老云端/g, '').trim();
        if (!line) continue;
        // 去掉协议前缀（保持纯 IP:PORT）
        line = line.replace(/^(https?|wss?):\/\//i, '');
        // 没有端口默认 35430
        if (!line.includes(':')) line += ':35430';
        servers.push(line);
      }

      if (servers.length > 0) {
        await chrome.storage.local.set({ cloud_apis_fetched: servers });
        console.log('[AutoDial BG] 云端服务器列表已更新:', servers.length, '个');
        return;
      }
    } catch (e) {
      continue;
    }
  }
}

// SW 启动 + 每次 CRM 页面打开时自动刷新服务器列表
fetchCloudList().catch(() => {});

// ==================== 状态 ====================
let pcAvailable = null;
let pcLastCheck = 0;
const tabPhones = {};

// ==================== PIN 管理（替代原 JWT） ====================

async function getPin() {
  const stored = await chrome.storage.local.get(['self_phone', 'pin']);
  return stored.pin || stored.self_phone || null;
}

// ==================== PC 检测（与 v3.1 一致） ====================

async function isPcAlive() {
  // 缓存 35 秒（比后台刷新间隔 15 秒长，保证永远命中缓存）
  if (pcAvailable !== null && (Date.now() - pcLastCheck) < 35000) return pcAvailable;
  // 缓存过期（极少触发）→ 同步探测（500ms 超时）
  await refreshPcStatus();
  return pcAvailable;
}

function resetPcStatus() {
  pcAvailable = null;
  isPcAlive();
}

// ==================== 双模拨号（PIN 版） ====================

async function dial(phone, tabId) {
  // 1) PC 直连优先
  if (await isPcAlive()) {
    try {
      const res = await fetch(`${PC_BASE}/dial?number=${encodeURIComponent(phone)}`);
      if (res.ok) {
        notifyTab(tabId, { type: 'dialResult', ok: true });
        return;
      }
    } catch {}
  }

  // 2) 云端 PIN 兜底
  const pin = await getPin();
  if (!pin) {
    const stored = await chrome.storage.local.get(['self_phone']);
    const err = stored.self_phone
      ? '服务器不可达 (端口35430)'
      : '未检测到坐席手机号，请打开 CRM 页面';
    notifyTab(tabId, { type: 'dialResult', ok: false, err });
    return;
  }

  try {
    const res = await fetch(`${await getCloudApi()}/api/v1/dial?number=${encodeURIComponent(phone)}`, {
      headers: { 'X-AutoDial-PIN': pin }
    });
    const d = await res.json();
    if (d.code === 'PC_CONNECTED') {
      pcAvailable = true;
      notifyTab(tabId, { type: 'dialResult', ok: false, err: 'PC已上线，请重试' });
      return;
    }
    notifyTab(tabId, { type: 'dialResult', ok: d.ok, err: d.message || '' });
  } catch {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: '网络错误，请检查云端服务器' });
  }
}

// ==================== 一键登记（PIN 版） ====================

async function registerVisit(name, phone, tabId) {
  const pin = await getPin();
  if (!pin) {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: 'PIN未设置，请先打开CRM页面检测坐席手机号' });
    return { success: false, error: 'PIN未设置，请先打开CRM页面检测坐席手机号' };
  }

  try {
    const apiUrl = await getCloudApi();
    const params = new URLSearchParams({
      name: name,
      mobile: phone,
      kefu_tel: pin,
      visit_type: '贷款咨询',
      source: 'plugin'
    });
    const res = await fetch(apiUrl + '/api/v1/visit?' + params.toString(), {
      headers: { 'X-AutoDial-PIN': pin }
    });

    const data = await res.json();
    if (data.ok) {
      console.log('[AutoDial BG] 登记成功:', name, phone);
      return { success: true };
    } else {
      return { success: false, error: data.message || '登记失败' };
    }
  } catch (e) {
    console.error('[AutoDial BG] 登记失败:', e);
    if (e.message === 'Failed to fetch' || e.name === 'TypeError') {
      return { success: false, error: '无法连接云端，请先启动云中继服务' };
    }
    return { success: false, error: '网络错误：' + e.message };
  }
}

// ==================== 挂断 + 短信（PIN 版） ====================

async function hangup(tabId) {
  if (await isPcAlive()) {
    try { await fetch(`${PC_BASE}/hangup`); return; } catch {}
  }
  const pin = await getPin();
  if (!pin) return;
  try {
    await fetch(`${await getCloudApi()}/api/v1/hangup`, {
      headers: { 'X-AutoDial-PIN': pin }
    });
  } catch {}
}

async function sendSms(phone, tabId) {
  if (await isPcAlive()) {
    try {
      const r = await fetch(`${PC_BASE}/sms?number=${encodeURIComponent(phone)}`);
      if (r.ok) return;
    } catch {}
  }
  notifyTab(tabId, { type: 'dialResult', ok: false, err: '短信仅支持 PC 直连模式' });
}

// ==================== 辅助函数（与 v3.1 一致） ====================

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
    return resp?.phone || null;
  } catch {
    return null;
  }
}

// ==================== 消息路由（与 v3.1 一致） ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  // 客户手机号检测（子iframe -> 顶层页面转发）
  if (msg.type === 'phoneDetected') {
    if (tabId) {
      tabPhones[tabId] = msg.phone;
      chrome.tabs.sendMessage(tabId, { type: 'updatePhone', phone: msg.phone }, { frameId: 0 }).catch(() => {});
    }
    return;
  }

  if (msg.type === 'dial') { dial(msg.phone, tabId); return true; }
  if (msg.type === 'hangup') { hangup(tabId); return true; }
  if (msg.type === 'sendSms') { sendSms(msg.phone, tabId); return true; }

  // 一键登记
  if (msg.type === 'registerVisit') {
    registerVisit(msg.name, msg.phone, tabId).then(r => sendResponse(r));
    return true;
  }

  // 坐席手机号检测 -> 存为 PIN + 刷新服务器列表
  if (msg.type === 'selfPhoneDetected') {
    chrome.storage.local.set({ self_phone: msg.phone });
    console.log('[AutoDial BG] 坐席手机号已检测:', msg.phone);
    fetchCloudList().catch(() => {}); // 后台刷新，不阻塞
    return;
  }

  // 手动设置 PIN
  if (msg.type === 'setPin') {
    const p = (msg.pin || '').trim();
    if (!p || !/^\d{4}$|^\d{11}$/.test(p)) {
      sendResponse({ success: false, error: 'PIN 格式错误，须为4位或11位数字' });
      return true;
    }
    chrome.storage.local.set({ pin: p, self_phone: p }, () => {
      console.log('[AutoDial BG] PIN 已设置:', p);
      sendResponse({ success: true });
    });
    return true;
  }

  // 获取状态
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
    fetch(`${PC_BASE}/open`)
      .then(r => r.json())
      .then(d => sendResponse({ success: d.success }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (msg.type === 'toggleFloatbar') {
    fetch(`${PC_BASE}/toggle-floatbar`)
      .then(r => r.json())
      .then(d => sendResponse({ success: d.success, visible: d.visible }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (msg.type === 'checkPc') {
    resetPcStatus();
    return;
  }
});

chrome.tabs.onRemoved.addListener(tabId => { delete tabPhones[tabId]; });
