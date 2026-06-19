/**
 * AutoDial Background Script v3.0
 * 双模路由：PC直连优先 → 云端兜底
 * JWT认证 + 自动续期 + 自动登录
 * 服务器地址：点击插件图标 → 设置服务器URL（存chrome.storage）
 */
console.log('[AutoDial BG] v3.0 已加载');

// ==================== 配置 ====================
const PC_BASE = 'http://127.0.0.1:35432';
const PC_PING_TIMEOUT = 2000;
const PC_FAIL_THRESHOLD = 3;
const PC_RECHECK_MS = 15000;

// 云端地址从 chrome.storage 读取（用户在 popup 设置）
async function getCloudApi() {
  const stored = await chrome.storage.local.get(['cloud_api']);
  return stored.cloud_api || 'http://127.0.0.1:35441';  // 默认本机测试
}

// ==================== 状态 ====================
let pcAvailable = null;
let pcFailCount = 0;
let pcCheckTimer = null;
let loginPromise = null;
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

  // 尝试续期
  if (stored.refresh_token) {
    try {
      const res = await fetch(``${await getCloudApi()}/api/v1/auth/refresh`, {
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

// ==================== PC 检测 ====================

async function isPcAlive() {
  if (pcAvailable === true) {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), PC_PING_TIMEOUT);
      await fetch(`${PC_BASE}/`, { signal: ctrl.signal });
      pcFailCount = 0;
      return true;
    } catch {
      pcFailCount++;
      if (pcFailCount >= PC_FAIL_THRESHOLD) {
        pcAvailable = false;
        startPcRecheck();
      }
      return false;
    }
  }

  if (pcAvailable === false) return false;

  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), PC_PING_TIMEOUT);
    await fetch(`${PC_BASE}/`, { signal: ctrl.signal });
    pcAvailable = true;
    pcFailCount = 0;
  } catch {
    pcAvailable = false;
  }
  return pcAvailable;
}

function startPcRecheck() {
  if (pcCheckTimer) return;
  console.log('[AutoDial BG] PC 离线，每 15s 重试');
  pcCheckTimer = setInterval(async () => {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 2000);
      await fetch(`${PC_BASE}/`, { signal: ctrl.signal });
      pcAvailable = true;
      pcFailCount = 0;
      clearInterval(pcCheckTimer);
      pcCheckTimer = null;
      console.log('[AutoDial BG] PC 已恢复，切回本地模式');
    } catch {}
  }, PC_RECHECK_MS);
}

// ==================== 登录 ====================

async function manualLogin(phone, password) {
  loginPromise = (async () => {
    try {
      const res = await fetch(``${await getCloudApi()}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      });
      const d = await res.json();
      if (d.ok) {
        await saveToken(d.data.token, d.data.refresh_token, phone);
        console.log('[AutoDial BG] 登录成功:', phone);
        return d.data.token;
      }
      console.error('[AutoDial BG] 登录失败:', d.error);
      return null;
    } catch (e) {
      console.error('[AutoDial BG] 登录网络错误:', e);
      return null;
    }
  })();
  return loginPromise;
}

// ===== 注册（独立，注册成功自动登录） =====
async function manualRegister(phone, password) {
  loginPromise = (async () => {
    try {
      const api = await getCloudApi();
      const res = await fetch(`${api}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password })
      });
      const d = await res.json();
      if (d.ok && d.data.token) {
        await saveToken(d.data.token, d.data.refresh_token, phone);
        console.log('[AutoDial BG] 注册成功:', phone);
        return { success: true };
      }
      return { success: false, error: d.error || '注册失败' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  })();
  return loginPromise;
}

// ===== 自动登录：CRM检测到手机号 → 静默续期 =====
async function autoLoginIfPhoneMatch(phone) {
  const stored = await chrome.storage.local.get(['jwt_phone']);
  if (stored.jwt_phone === phone) {
    const token = await getToken();
    if (token) {
      console.log('[AutoDial BG] 自动登录续期成功:', phone);
      return true;
    }
  }
  return false;
}

async function logout() {
  jwtToken = null;
  loginPromise = null;
  await chrome.storage.local.remove(['jwt', 'refresh_token', 'jwt_phone']);
  console.log('[AutoDial BG] 已退出登录');
}

// ==================== 双模拨号 ====================

async function dial(phone, tabId) {
  let token = await getToken();
  if (!token && loginPromise) token = await loginPromise;

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
  if (!token) {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: '请先登录。点击插件图标输入账号密码。' });
    return;
  }
  try {
    const res = await fetch(``${await getCloudApi()}/api/v1/dial`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ phone })
    });
    const d = await res.json();
    if (d.ok && d.data.req_id) {
      // 等待拨号结果
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
      const res = await fetch(``${await getCloudApi()}/api/v1/dial/result?req_id=${reqId}`, {
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

// ==================== 挂断 + 短信 ====================

async function hangup(tabId) {
  if (await isPcAlive()) {
    try { await fetch(`${PC_BASE}/hangup`); return; } catch {}
  }
  const token = await getToken();
  if (!token) return;
  await fetch(``${await getCloudApi()}/api/v1/hangup`, {
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
  const token = await getToken();
  if (!token) {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: '请先登录' });
    return;
  }
  await fetch(``${await getCloudApi()}/api/v1/sms`, {
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

  if (msg.type === 'manualLogin') {
    manualLogin(msg.phone, msg.password).then(token => sendResponse({ success: !!token }));
    return true;
  }

  if (msg.type === 'manualRegister') {
    manualRegister(msg.phone, msg.password).then(result => sendResponse(result));
    return true;
  }

  if (msg.type === 'selfPhoneDetected') {
    // CRM检测到手机号 → 尝试静默续期
    autoLoginIfPhoneMatch(msg.phone);
    return;
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
});

chrome.tabs.onRemoved.addListener(tabId => { delete tabPhones[tabId]; });

// 启动时检测 PC 状态
isPcAlive().then(alive => {
  console.log(`[AutoDial BG] PC ${alive ? '在线' : '离线'}，走${alive ? '本地' : '云端'}模式`);
});
