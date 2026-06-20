/**
 * AutoDial Background Script v3.1
 * 双模路由：PC直连优先 → 云端兜底
 * CRM检测到手机号 → 自动登录（无需密码，手机号即账号）
 * 服务器地址：点击插件图标设置（存chrome.storage）
 */
console.log('[AutoDial BG] v3.1 已加载');

// ==================== 配置 ====================
const PC_BASE = 'http://127.0.0.1:35432';
const PC_PING_TIMEOUT = 2000;

async function getCloudApi() {
  const stored = await chrome.storage.local.get(['cloud_api']);
  return stored.cloud_api || 'http://127.0.0.1:35441';
}

// ==================== 状态 ====================
let pcAvailable = null;
let jwtToken = null;
const tabPhones = {};

// ==================== JWT 管理 ====================

async function getToken() {
  if (jwtToken && !isTokenExpired(jwtToken)) return jwtToken;

  const stored = await chrome.storage.local.get(['jwt', 'refresh_token', 'jwt_phone']);
  if (stored.jwt && !isTokenExpired(stored.jwt)) {
    jwtToken = stored.jwt;
    return jwtToken;
  }

  if (stored.refresh_token) {
    try {
      const res = await fetch(`${await getCloudApi()}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: stored.refresh_token })
      });
      const d = await res.json();
      if (d.ok) {
        await saveToken(d.data.token, d.data.refresh_token, stored.jwt_phone);
        return d.data.token;
      }
    } catch (e) {
      console.warn('[AutoDial BG] refresh 失败:', e.message);
    }
  }
  return null;
}

function isTokenExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch { return true; }
}

async function saveToken(token, refresh_token, phone) {
  jwtToken = token;
  await chrome.storage.local.set({
    jwt: token,
    refresh_token: refresh_token || '',
    jwt_phone: phone || ''
  });
}

// ==================== 自动登录：CRM检测到手机号 → 直接登录 ====================

async function autoLogin(phone) {
  // 已登录且同号 → 跳过
  const stored = await chrome.storage.local.get(['jwt_phone']);
  if (stored.jwt_phone === phone) {
    const token = await getToken();
    if (token) {
      console.log('[AutoDial BG] 已登录，跳过:', phone);
      return true;
    }
  }

  // 调用云端 auto-login（首次自动创号）
  try {
    const res = await fetch(`${await getCloudApi()}/api/v1/auth/auto-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const d = await res.json();
    if (d.ok) {
      await saveToken(d.data.token, d.data.refresh_token, phone);
      console.log('[AutoDial BG] 自动登录成功:', phone, d.data.new_user ? '(新用户)' : '');
      return true;
    }
    console.error('[AutoDial BG] 自动登录失败:', d.error);
  } catch (e) {
    console.error('[AutoDial BG] 自动登录网络错误:', e.message);
  }
  return false;
}

async function logout() {
  jwtToken = null;
  await chrome.storage.local.remove(['jwt', 'refresh_token', 'jwt_phone']);
  console.log('[AutoDial BG] 已退出登录');
}

// ==================== PC 检测 ====================
// 页面加载时检测一次，结果缓存到下次刷新

async function isPcAlive() {
  // 已有缓存，直接返回，不反复ping
  if (pcAvailable !== null) return pcAvailable;

  // 首次检测
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), PC_PING_TIMEOUT);
    await fetch(`${PC_BASE}/`, { signal: ctrl.signal });
    pcAvailable = true;
    console.log('[AutoDial BG] PC 在线，使用本地模式');
  } catch {
    pcAvailable = false;
    console.log('[AutoDial BG] PC 离线，使用云端模式');
  }
  return pcAvailable;
}

// content-script 页面加载时触发一次PC检测，之后不再ping
function resetPcStatus() {
  pcAvailable = null;
  isPcAlive(); // 后台异步检测
}

// ==================== 双模拨号 ====================

async function dial(phone, tabId) {
  // 优先 PC 直连
  if (await isPcAlive()) {
    try {
      const res = await fetch(`${PC_BASE}/dial?number=${encodeURIComponent(phone)}`);
      if (res.ok) {
        notifyTab(tabId, { type: 'dialResult', ok: true });
        return;
      }
    } catch {}
  }

  // 云端兜底
  let token = await getToken();
  if (!token) {
    // Token过期或从未登录 → 尝试自动续期
    const stored = await chrome.storage.local.get(['jwt_phone']);
    if (stored.jwt_phone) {
      await autoLogin(stored.jwt_phone);
      token = await getToken();
    } else {
      // 从未登录过 → 让 content-script 重新扫描手机号
      const phone = await reDetectPhone(tabId);
      if (phone) {
        await autoLogin(phone);
        token = await getToken();
      }
    }
  }
  if (!token) {
    // 区分：从未检测到手机号 vs 服务器不可达
    const stored = await chrome.storage.local.get(['jwt_phone', 'self_phone']);
    const anyPhone = stored.jwt_phone || stored.self_phone;
    const err = anyPhone
      ? '服务器不可达 (端口35441)'
      : '未登录，请右键菜单登录';
    notifyTab(tabId, { type: 'dialResult', ok: false, err });
    return;
  }
  try {
    const res = await fetch(`${await getCloudApi()}/api/v1/dial`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ phone })
    });
    const d = await res.json();
    if (d.ok && d.data.req_id) {
      const result = await pollDialResult(d.data.req_id, 3000, token);
      notifyTab(tabId, { type: 'dialResult', ok: result.status === 'ok', err: result.error || '' });
    } else {
      notifyTab(tabId, { type: 'dialResult', ok: false, err: d.error || '拨号失败' });
    }
  } catch (err) {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: '网络错误，请检查云端服务器是否运行' });
  }
}

async function pollDialResult(reqId, timeoutMs, token) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    try {
      const res = await fetch(`${await getCloudApi()}/api/v1/dial/result?req_id=${reqId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const d = await res.json();
      if (d.ok && d.data && d.data.status !== 'pending') return d.data;
    } catch {}
  }
  return { status: 'timeout', error: '手机未响应' };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function notifyTab(tabId, msg) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
  }
}

// 让 content-script 重新扫描手机号（用户点拨号时触发）
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

// ==================== 挂断 + 短信 ====================

async function hangup(tabId) {
  if (await isPcAlive()) {
    try { await fetch(`${PC_BASE}/hangup`); return; } catch {}
  }
  let token = await getToken();
  if (!token) {
    const stored = await chrome.storage.local.get(['jwt_phone']);
    if (stored.jwt_phone) { await autoLogin(stored.jwt_phone); token = await getToken(); }
  }
  if (!token) return;
  await fetch(`${await getCloudApi()}/api/v1/hangup`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  }).catch(() => {});
}

async function sendSms(phone, tabId) {
  if (await isPcAlive()) {
    try {
      const r = await fetch(`${PC_BASE}/sms?number=${encodeURIComponent(phone)}`);
      if (r.ok) return;
    } catch {}
  }
  let token = await getToken();
  if (!token) {
    const stored = await chrome.storage.local.get(['jwt_phone']);
    if (stored.jwt_phone) { await autoLogin(stored.jwt_phone); token = await getToken(); }
  }
  if (!token) {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: '请先打开CRM页面完成自动登录' });
    return;
  }
  await fetch(`${await getCloudApi()}/api/v1/sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ phone })
  }).catch(() => {});
}

// ==================== 消息路由 ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

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

  if (msg.type === 'selfPhoneDetected') {
    // CRM检测到坐席手机号 → 自动登录
    autoLogin(msg.phone);
    return;
  }

  if (msg.type === 'manualLogin') {
    // 手动输入手机号上传到云端（自动检测失败时的备选）
    autoLogin(msg.phone).then(success => {
      sendResponse({ success, error: success ? '' : '无法连接服务器' });
    });
    return true;
  }

  if (msg.type === 'logout') {
    logout().then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === 'getStatus') {
    getToken().then(token => {
      chrome.storage.local.get(['jwt_phone'], (stored) => {
        sendResponse({
          loggedIn: !!token,
          phone: stored.jwt_phone || '',
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
