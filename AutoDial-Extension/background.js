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
  if (!addr) return 'http://101.34.65.254:35430';
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
  return 'http://101.34.65.254:35430';
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
        // 去掉行末别名（格式: "IP:PORT 别名"）
        line = line.split(' ')[0];
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

// ==================== 上传顾问姓名到云中继 ====================

async function uploadAdvisorName(pin, name) {
  try {
    const apiUrl = await getCloudApi();
    const encodedName = encodeURIComponent(name);
    const encodedPin = encodeURIComponent(pin);
    const res = await fetch(`${apiUrl}/api/v1/advisor/register?pin=${encodedPin}&name=${encodedName}`);
    const data = await res.json();
    if (data.ok) {
      console.log('[AutoDial BG] 顾问姓名已上传云端:', pin, '→', name);
    } else {
      console.warn('[AutoDial BG] 上传顾问姓名失败:', data.code);
    }
  } catch (e) {
    // 静默失败，云端不可达时不影响本地使用
  }
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

  // 获取经理姓名（从存储中读取，与网页版对接）
  const stored = await chrome.storage.local.get(['manager_name']);
  const managerName = stored.manager_name || pin; // 兜底：没有姓名时用 PIN

  // === 1) 直接提交到 CRM（姓名→kid→POST，不依赖云中继） ===
  let crmOk = false, crmErr = '';
  try {
    const kid = await lookupKidFromCrm(managerName);
    if (kid) {
      const crmParams = new URLSearchParams({
        brand: '1833',
        name: name,
        mobile: phone,
        kid: kid,
        visit_type: '贷款咨询'
      });
      const crmRes = await fetch('https://guwen.zhudaicms.com/bserve/saoma_indb.html', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://guwen.zhudaicms.com',
          'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=1833'
        },
        body: crmParams.toString()
      });
      const crmData = await crmRes.json();
      if (crmData.code === 1) {
        crmOk = true;
        console.log('[AutoDial BG] CRM direct OK:', name, 'kid:', kid);
      } else {
        crmErr = crmData.msg || 'CRM 返回失败';
        console.warn('[AutoDial BG] CRM direct FAIL:', crmErr);
      }
    } else {
      crmErr = '未找到顾问「' + managerName + '」，请确认姓名与CRM一致';
    }
  } catch (e) {
    crmErr = 'CRM 网络错误: ' + (e.message || '');
    console.warn('[AutoDial BG] CRM direct error:', e.message);
  }

  // === 2) 同步到云中继（本地记录 + 手机推送） ===
  let cloudOk = false;
  try {
    const apiUrl = await getCloudApi();
    const params = new URLSearchParams({
      name: name,
      mobile: phone,
      kefu_tel: managerName,
      visit_type: '贷款咨询',
      source: 'plugin'
    });
    const res = await fetch(apiUrl + '/api/v1/visit?' + params.toString(), {
      headers: { 'X-AutoDial-PIN': pin }
    });
    const data = await res.json();
    cloudOk = !!data.ok;
    if (!cloudOk) {
      console.warn('[AutoDial BG] Cloud relay returned error:', data.code);
    }
  } catch (e) {
    console.warn('[AutoDial BG] Cloud relay unreachable:', e.message);
  }

  // CRM 写入 + 云端记录，两者都成功才算成功
  if (crmOk && cloudOk) {
    return { success: true };
  }
  if (crmOk && !cloudOk) {
    return { success: false, error: '云端服务器同步失败' };
  }
  if (!crmOk && cloudOk) {
    return { success: false, error: 'CRM 提交失败，云端已暂存' };
  }
  return { success: false, error: crmErr || '登记失败' };
}

/**
 * 调用 CRM search 接口，将顾问姓名转换为 kid（内部ID）。
 */
async function lookupKidFromCrm(managerName) {
  try {
    const params = new URLSearchParams({ keyword: managerName, brand: '1833' });
    const res = await fetch('https://guwen.zhudaicms.com/bserve/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://guwen.zhudaicms.com',
        'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=1833'
      },
      body: params.toString()
    });
    const data = await res.json();
    if (data.code === 1 && data.data && data.data.length) {
      // 精确匹配优先
      for (const item of data.data) {
        if (item.name === managerName) return String(item.id);
      }
      // 兜底取第一个
      return String(data.data[0].id);
    }
  } catch (e) {
    console.warn('[AutoDial BG] lookupKid failed:', e.message);
  }
  return null;
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

  // 坐席手机号检测 -> 存为 PIN + 刷新服务器列表 + 上传姓名到云端
  if (msg.type === 'selfPhoneDetected') {
    chrome.storage.local.set({ self_phone: msg.phone });
    console.log('[AutoDial BG] 坐席手机号已检测:', msg.phone);
    if (msg.name) {
      chrome.storage.local.set({ manager_name: msg.name });
      // 上传到云中继，让手机端能按 PIN 查到姓名
      uploadAdvisorName(msg.phone, msg.name);
    }
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

  // 设置经理姓名
  if (msg.type === 'setManagerName') {
    const n = (msg.name || '').trim();
    if (!n) {
      sendResponse({ success: false, error: '姓名不能为空' });
      return true;
    }
    chrome.storage.local.set({ manager_name: n }, () => {
      console.log('[AutoDial BG] 经理姓名已设置:', n);
      sendResponse({ success: true });
    });
    return true;
  }

  // 获取 PIN
  if (msg.type === 'getPin') {
    getPin().then(p => sendResponse({ pin: p }));
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

// ==================== 右键菜单：同步登记列表 ====================

chrome.contextMenus.create({
  id: 'syncVisitList',
  title: '同步登记列表',
  contexts: ['page'],
  documentUrlPatterns: ['*://guwen.zhudaicms.com/*']
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'syncVisitList') return;
  chrome.tabs.sendMessage(tab.id, { type: 'syncVisitList' }, (resp) => {
    // 通过 content-script 弹出 toast 显示结果
    // 如果 content-script 已自行处理 toast，此处无需额外操作
  });
});

// 管理员检查 + 同步处理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 检查是否为管理员
  if (msg.type === 'checkIsAdmin') {
    const pin = msg.pin;
    if (!pin) { sendResponse({ ok: false }); return true; }
    getCloudApi().then(apiUrl => {
      return fetch(`${apiUrl}/api/v1/advisor/is_admin?pin=${encodeURIComponent(pin)}`);
    }).then(r => r.json()).then(d => {
      sendResponse({ ok: d.ok, is_admin: d.is_admin });
    }).catch(() => {
      sendResponse({ ok: false });
    });
    return true;
  }

  // 批量同步登记记录到云端
  if (msg.type === 'batchSyncVisits') {
    const pin = msg.pin;
    const visits = msg.visits; // array of visit objects
    getCloudApi().then(apiUrl => {
      // 逐条提交（简单可靠）
      let count = 0;
      const promises = visits.map(v => {
        const params = new URLSearchParams({
          name: v.name, mobile: v.mobile,
          kefu_tel: v.advisor_name || pin,
          visit_type: v.visit_type || '贷款咨询',
          source: 'crm_sync'
        });
        return fetch(`${apiUrl}/api/v1/visit?${params.toString()}`, {
          headers: { 'X-AutoDial-PIN': pin }
        }).then(r => r.json()).then(d => { if (d.ok) count++; });
      });
      return Promise.all(promises).then(() => count);
    }).then(count => {
      sendResponse({ ok: true, synced: count, total: visits.length });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  // popup 点击"同步登记列表"按钮 → 找到 CRM tab 并发送消息
  if (msg.type === 'triggerSync') {
    const VISIT_LIST_URL = 'https://guwen.zhudaicms.com/manage/kefu_reportformlist/list_user_visit.html';
    chrome.tabs.query({ url: '*://guwen.zhudaicms.com/*' }, (tabs) => {
      // 1) 没有 CRM 页面 → 打开新标签页到登记列表
      if (tabs.length === 0) {
        chrome.tabs.create({ url: VISIT_LIST_URL }, () => {
          sendResponse({ ok: false, result: '已打开登记列表页，加载完成后请重新点击同步按钮' });
        });
        return;
      }
      // 2) 已有 CRM 页面，找是否在来访列表页
      let target = tabs.find(t => t.url && t.url.includes('list_user_visit'));
      if (target) {
        // 已在列表页 → 直接同步
        chrome.tabs.sendMessage(target.id, { type: 'syncVisitList' }, (resp) => {
          if (resp && resp.ok) {
            sendResponse({ ok: true, result: '✅ 已同步 ' + resp.synced + '/' + resp.total + ' 条' });
          } else if (resp && resp.error) {
            sendResponse({ ok: false, result: resp.error });
          } else {
            sendResponse({ ok: false, result: '同步失败，请刷新页面后重试' });
          }
        });
      } else {
        // 3) 在 CRM 但不在列表页 → 自动跳转
        chrome.tabs.update(tabs[0].id, { url: VISIT_LIST_URL, active: true }, () => {
          sendResponse({ ok: false, result: '正在跳转到登记列表页，加载完成后请重新点击同步' });
        });
      }
    });
    return true;
  }
});
