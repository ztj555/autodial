/**
 * AutoDial Background Script v4.0
 * 双模路由：PC直连优先 -> 云端 PIN 兜底
 * 基于 v3.1 稳定版重构，仅将 JWT 替换为 PIN 认证
 */
console.log('[AutoDial BG] v4.0 已加载 (PIN 模式)');

// ==================== 配置 ====================
const PC_BASE = 'http://127.0.0.1:35432';
const PC_PING_TIMEOUT = 500;  // 本地 ping 500ms 足够，超时走云端

// v4.15: 统一带超时的 fetch。此前拨号/挂断/短信等 PC 请求无超时，
// PC 端假死（端口还监听但不回包）时请求会挂起数分钟，业务员毫无反馈。
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

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
flushCloudVisits().catch(() => {}); // v4.17: SW 启动时补推暂存的云端登记

// ==================== 设备授权轮询 ====================
// v4.21: 轮询从 5 秒放宽到 30 秒，并对 429 退避加倍。
// 20 人共用同一出口 IP 时，5 秒/台 ≈ 240 次/分钟，会把云端按 IP 的限流桶打爆，
// 连带 /api/v1/visit（上门登记）等业务请求被 429 拦截（线上已实际发生）。
// 授权请求在云端保留 120 秒，30 秒轮询最坏 30 秒内弹窗，体验可接受。
let _authPollTimer = null;
let _crmPageActive = false;
const AUTH_POLL_INTERVAL_MS = 30000;
let _authPollBackoff = 1; // 429 退避倍数（1 = 正常；被限流后 2、4…封顶 8）

// 检测是否有 CRM 页面在打开状态
async function checkCrmPageStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://guwen.zhudaicms.com/*', '*://*.zhudaicms.com/*', '*://*.rxhcrm.com/*', '*://*.rongxinhui.com/*'] });
    _crmPageActive = tabs && tabs.length > 0;
  } catch(e) {
    _crmPageActive = false;
  }
}

async function pollAuthRequests() {
  await checkCrmPageStatus();
  if (!_crmPageActive) return;
  try {
    const pin = await getPin();
    if (!pin) return;
    const api = await getCloudApi();
    const url = api + '/api/v1/auth/pending?pin=' + encodeURIComponent(pin);
    const r = await fetch(url);
    if (r.status === 429) {
      // 被限流：退避加倍（封顶 8 倍 ≈ 最长 4 分钟），恢复后逐次回落
      applyAuthPollBackoff(_authPollBackoff * 2);
      console.warn('[AutoDial BG] auth poll 429, backoff x' + _authPollBackoff);
      return;
    }
    applyAuthPollBackoff(1);
    const d = await r.json();
    if (!d.ok || !d.pending || d.pending.length === 0) {
      return;
    }
    // 取出第一个待授权请求（通常只有一个）
    const req = d.pending[0];
    // 防止同一请求重复弹窗
    const key = 'auth_popup_' + req.request_id;
    const shown = await chrome.storage.local.get([key]);
    if (shown[key]) return;
    await chrome.storage.local.set({ [key]: true });
    // 弹出授权窗口
    showAuthDialog(req, api);
  } catch(e) { /* 静默失败，下次轮询重试 */ }
}

function startAuthPolling() {
  if (_authPollTimer) clearInterval(_authPollTimer);
  // 注意：setInterval 的间隔在"创建那一刻"就固定了，之后改 _authPollBackoff
  // 不会影响已存在的定时器 —— 这正是 v4.21 退避成为死代码的原因
  // （429 时只改了个没人再读的变量，实际仍固定 30 秒硬撞云端限流桶）。
  _authPollTimer = setInterval(pollAuthRequests, AUTH_POLL_INTERVAL_MS * _authPollBackoff);
}

// 变更退避倍数：必须清掉旧定时器、用新间隔重建，退避才会真正生效
function applyAuthPollBackoff(nextBackoff) {
  const clamped = Math.min(Math.max(nextBackoff, 1), 8);
  if (clamped === _authPollBackoff) return;
  _authPollBackoff = clamped;
  startAuthPolling();
}

function stopAuthPolling() {
  if (_authPollTimer) { clearInterval(_authPollTimer); _authPollTimer = null; }
}

// PIN 变化时重启轮询
chrome.storage.onChanged.addListener((changes) => {
  if (changes.pin || changes.self_phone) {
    stopAuthPolling();
    startAuthPolling();
  }
});

startAuthPolling(); // 启动时立即开始

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

// ==================== PIN 管理（替代原 JWT） ====================

async function getPin() {
  // pin 是权威值（仅由"精确识别"或手动设置写入）。
  // self_phone 只作兜底，且被明确标记为非精确识别时不得使用——此前无条件兜底，
  // 而 self_phone 会被 TreeWalker 的猜测结果覆盖，一旦误判（例如读到客户手机号），
  // 错误号码会直接变成生效 PIN 并打到云端（拨给错误的人 / 错账号登记）。
  const stored = await chrome.storage.local.get(['pin', 'self_phone', 'self_phone_precise']);
  if (stored.pin) return stored.pin;
  if (stored.self_phone && stored.self_phone_precise !== false) return stored.self_phone;
  return null;
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
  // 1) PC 直连优先（v4.15: 3 秒超时，PC 假死时快速转云端，不再永久挂起）
  //    v4.21: 不再只看 HTTP 状态码——PC 在手机未连接时也返回 200 {success:false}，
  //    必须读 body；失败时不再直接报成功，继续走云端兜底。
  if (await isPcAlive()) {
    try {
      const res = await fetchWithTimeout(`${PC_BASE}/dial?number=${encodeURIComponent(phone)}`, {}, 3000);
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.success === false) {
          // PC 明确失败（如"手机未连接"）→ 落入云端兜底，不再误报"已拨出"。
          // 同时复位 pcAvailable：否则 35 秒缓存窗口内每次拨号都要先白等 3 秒超时。
          pcAvailable = false;
          pcLastCheck = Date.now();
          console.warn('[AutoDial BG] PC dial rejected:', body.error);
        } else {
          notifyTab(tabId, { type: 'dialResult', ok: true });
          return { success: true };
        }
      }
    } catch {}
  }

  // 2) 云端 PIN 兜底
  const pin = await getPin();
  if (!pin) {
    const stored = await chrome.storage.local.get(['self_phone']);
    const err = stored.self_phone
      ? '无法连接云端服务器，请联系管理员'
      : '未检测到坐席手机号，请打开 CRM 页面';
    notifyTab(tabId, { type: 'dialResult', ok: false, err });
    return { success: false, error: err };
  }

  try {
    const res = await fetchWithTimeout(`${await getCloudApi()}/api/v1/dial?number=${encodeURIComponent(phone)}`, {
      headers: { 'X-AutoDial-PIN': pin }
    }, 8000);
    const d = await res.json();
    if (d.code === 'PC_CONNECTED') {
      pcAvailable = true;
      notifyTab(tabId, { type: 'dialResult', ok: false, err: 'PC已上线，请重试' });
      return { success: false, error: 'PC已上线，请重试' };
    }
    notifyTab(tabId, { type: 'dialResult', ok: d.ok, err: d.message || '' });
    return { success: d.ok, error: d.message || '' };
  } catch {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: '无法连接云端服务器，请联系管理员' });
    return { success: false, error: '网络错误' };
  }
}

// ==================== 一键登记（PIN 版） ====================

async function registerVisit(name, phone, tabId, managerName) {
  const pin = await getPin();
  if (!pin) {
    notifyTab(tabId, { type: 'dialResult', ok: false, err: 'PIN未设置，请先打开CRM页面检测坐席手机号' });
    return { success: false, error: 'PIN未设置，请先打开CRM页面检测坐席手机号' };
  }

  // 获取经理姓名：优先使用弹窗传入的，否则从 storage 读取
  let finalManagerName = managerName;
  if (!finalManagerName) {
    const stored = await chrome.storage.local.get(['manager_name']);
    finalManagerName = stored.manager_name || pin; // 兜底：没有姓名时用 PIN
  }

  // === 1) 直接提交到 CRM（姓名→kid→POST，不依赖云中继） ===
  let crmOk = false, crmErr = '';
  try {
    const kid = await lookupKidFromCrm(finalManagerName);
    if (kid) {
      const crmParams = new URLSearchParams({
        brand: '1833',
        name: name,
        mobile: phone,
        kid: kid,
        visit_type: '贷款咨询'
      });
      const crmRes = await fetchWithTimeout('https://guwen.zhudaicms.com/bserve/saoma_indb.html', {
        method: 'POST',
        // credentials:'include' 是 CRM 请求能否带登录态的关键：扩展页面是
        // chrome-extension:// 源，默认 same-origin 不会附带 Cookie，CRM 会当成
        // 未登录返回登录页（表现为"CRM 登录已过期"）。
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Origin / Referer 属浏览器禁改头，设置会被忽略（保留仅为标注来源）
          'Origin': 'https://guwen.zhudaicms.com',
          'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=1833'
        },
        body: crmParams.toString()
      }, 8000);
      // v4.17: HTTP 非 2xx（401/302 登录过期、5xx）不再继续当作成功解析
      if (!crmRes.ok) {
        const st = crmRes.status;
        crmErr = (st === 401 || st === 403 || st === 302)
          ? 'CRM 登录已过期，请重新登录 CRM 后再登记'
          : ('CRM 提交失败 (HTTP ' + st + ')');
        console.warn('[AutoDial BG] CRM HTTP', st, '- treating as FAIL');
      } else {
      let crmData = null, jsonOk = false;
      try { crmData = await crmRes.json(); jsonOk = true; } catch (_) {}
      if (jsonOk) {
        // v4.17: 严格校验 code——此前 code 缺失也算成功，CRM 会话过期时静默丢数据
        const code = crmData.code;
        if (code === 1 || code === 0) {
          crmOk = true;
          console.log('[AutoDial BG] CRM direct OK:', name, 'kid:', kid, 'code=', code);
        } else if (code == null) {
          crmErr = 'CRM 返回异常（无 code），请人工核对是否已写入 CRM';
          console.warn('[AutoDial BG] CRM response has no code:', JSON.stringify(crmData).slice(0, 200));
        } else {
          crmErr = crmData.msg || ('CRM code=' + code);
          console.warn('[AutoDial BG] CRM direct FAIL code=', code, 'msg=', crmData.msg, 'raw=', JSON.stringify(crmData));
        }
      } else {
        // v4.17: 返回非 JSON（多为登录页 HTML/错误页）→ 不再视为成功
        crmErr = 'CRM 登录可能已过期，请重新登录 CRM 后再登记';
        console.warn('[AutoDial BG] CRM returned non-JSON (likely login page), treating as FAIL');
      }
      } // end crmRes.ok
    } else {
      crmErr = '未找到顾问「' + finalManagerName + '」，请确认姓名与CRM一致';
    }
  } catch (e) {
    crmErr = 'CRM 网络错误: ' + (e.message || '');
    console.warn('[AutoDial BG] CRM direct error:', e.message);
  }

  // === 2) 同步到云中继（本地记录 + 手机推送） ===
  let cloudOk = false;
  // v4.17: 唯一 id——重发/补推时云端按 crm_id 去重，同一物理来访只入一次库
  const crmId = 'ext-' + pin + '-' + Date.now();
  const cloudParams = {
    name: name,
    mobile: phone,
    kefu_tel: finalManagerName,
    visit_type: '贷款咨询',
    source: 'plugin',
    crm_id: crmId
  };
  try {
    const apiUrl = await getCloudApi();
    const res = await fetchWithTimeout(apiUrl + '/api/v1/visit?' + new URLSearchParams(cloudParams).toString(), {
      headers: { 'X-AutoDial-PIN': pin }
    }, 8000);
    const data = await res.json().catch(() => null);
    cloudOk = !!(data && data.ok);
    if (cloudOk) {
      // 顺路补推此前因断网欠下的登记
      flushCloudVisits().catch(() => {});
    } else {
      console.warn('[AutoDial BG] Cloud relay returned error:', data && data.code);
      queueCloudVisit(cloudParams, pin);
    }
  } catch (e) {
    console.warn('[AutoDial BG] Cloud relay unreachable:', e.message);
    queueCloudVisit(cloudParams, pin);
  }

  // CRM 写入成功即为登记成功，云端同步失败已入暂存队列（重连/下次登记时自动补推）
  if (crmOk) {
    if (!cloudOk) console.warn('[AutoDial BG] Cloud sync deferred to pending queue, CRM OK');
    return { success: true };
  }
  if (cloudOk) {
    return { success: false, error: crmErr || 'CRM 提交失败，记录已存云端与手机端' };
  }
  return { success: false, error: crmErr || '登记失败' };
}

// ==================== v4.17: 云端登记暂存队列 ====================
// CRM 成功但云端不可达时入队；SW 启动/下次登记成功时自动补推（crm_id 保证云端去重）
async function queueCloudVisit(paramsObj, pin) {
  try {
    const s = await chrome.storage.local.get(['pending_cloud_visits']);
    const arr = s.pending_cloud_visits || [];
    arr.push({ params: paramsObj, pin: pin, at: Date.now() });
    while (arr.length > 500) arr.shift(); // 上限 500 条，丢最旧
    await chrome.storage.local.set({ pending_cloud_visits: arr });
    console.log('[AutoDial BG] visit queued for retry, total:', arr.length);
  } catch (e) {
    console.warn('[AutoDial BG] queue visit failed:', e);
  }
}

async function flushCloudVisits() {
  try {
    const s = await chrome.storage.local.get(['pending_cloud_visits']);
    const arr = s.pending_cloud_visits || [];
    if (!arr.length) return;
    const remain = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      try {
        const qs = new URLSearchParams(item.params).toString();
        const res = await fetchWithTimeout(`${await getCloudApi()}/api/v1/visit?${qs}`, {
          headers: { 'X-AutoDial-PIN': item.pin }
        }, 5000);
        if (res.status === 429) {
          // 被限流：剩下的全部留到下次，不再无间隔重放把限流桶继续打爆
          remain.push(...arr.slice(i));
          console.warn('[AutoDial BG] flush hit 429, deferring', arr.length - i, 'visits');
          break;
        }
        const d = await res.json().catch(() => null);
        if (!d || !d.ok) remain.push(item);
      } catch (_) {
        remain.push(item);
      }
      // 逐条之间留出间隔：暂存上限 500 条，一次性无间隔重放会打满云端限流与线程池
      if (i < arr.length - 1) await new Promise(r => setTimeout(r, 150));
    }
    await chrome.storage.local.set({ pending_cloud_visits: remain });
    if (remain.length < arr.length) {
      console.log('[AutoDial BG] flushed', arr.length - remain.length, 'pending visits,', remain.length, 'left');
    }
  } catch (e) {
    console.warn('[AutoDial BG] flush visits failed:', e);
  }
}

/**
 * 调用 CRM search 接口，将顾问姓名转换为 kid（内部ID）。
 */
async function lookupKidFromCrm(managerName) {
  try {
    const params = new URLSearchParams({ keyword: managerName, brand: '1833' });
    const res = await fetchWithTimeout('https://guwen.zhudaicms.com/bserve/search', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://guwen.zhudaicms.com',
        'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=1833'
      },
      body: params.toString()
    }, 8000);
    const data = await res.json();
    if (data.code === 1 && data.data && data.data.length) {
      // 精确匹配优先
      for (const item of data.data) {
        if (item.name === managerName) return String(item.id);
      }
      // v4.17: 移除"兜底取第一个"——会把客户挂到同名/相似顾问名下，交给上层明确报错
      console.warn('[AutoDial BG] kid lookup: no exact match for', managerName,
        'candidates:', data.data.slice(0, 5).map(x => x.name).join(','));
    }
  } catch (e) {
    console.warn('[AutoDial BG] lookupKid failed:', e.message);
  }
  return null;
}

/**
 * 从 CRM 拉取全部顾问列表（用于一键登记弹窗下拉框）
 */
async function getConsultantList() {
  try {
    const params = new URLSearchParams({ keyword: '', brand: '1833' });
    const res = await fetchWithTimeout('https://guwen.zhudaicms.com/bserve/search', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://guwen.zhudaicms.com',
        'Referer': 'https://guwen.zhudaicms.com/bserve/saoma.html?brand=1833'
      },
      body: params.toString()
    }, 8000);
    const data = await res.json();
    if (data.code === 1 && data.data && data.data.length) {
      return data.data.map(item => ({ id: String(item.id), name: item.name }));
    }
  } catch (e) {
    console.warn('[AutoDial BG] getConsultantList failed:', e.message);
  }
  return [];
}

// ==================== 挂断 + 短信（PIN 版） ====================

async function hangup(tabId) {
  if (await isPcAlive()) {
    try {
      const r = await fetchWithTimeout(`${PC_BASE}/hangup`, {}, 2000);
      // v4.21: 读 body——PC 在手机未连接时返回 200 {success:false}，不能当"已挂断"
      if (r.ok) {
        const body = await r.json().catch(() => null);
        if (body && body.success === false) {
          return { success: false, error: body.error || '手机未连接，挂断失败' };
        }
        return { success: true };
      }
      return { success: false, error: 'PC 端返回异常' };
    } catch {}
  }
  const pin = await getPin();
  if (!pin) return { success: false, error: 'PIN 未设置' };
  try {
    // v4.15: 解析云端真实返回——此前不读响应体一律报"已挂断"，
    // 手机离线/权限不足时业务员以为挂断了，实际通话还在继续
    const res = await fetchWithTimeout(`${await getCloudApi()}/api/v1/hangup`, {
      headers: { 'X-AutoDial-PIN': pin }
    }, 3000);
    const d = await res.json().catch(() => null);
    if (d && d.ok) return { success: true };
    return { success: false, error: (d && (d.message || d.code)) || '手机未连接，挂断失败' };
  } catch {
    return { success: false, error: '挂断请求失败' };
  }
}

async function sendSms(phone, tabId) {
  if (await isPcAlive()) {
    try {
      const r = await fetchWithTimeout(`${PC_BASE}/sms?number=${encodeURIComponent(phone)}`, {}, 2000);
      // v4.21: 同 dial/hangup——PC 的 200 响应体可能带 success:false
      if (r.ok) {
        const body = await r.json().catch(() => null);
        if (body && body.success === false) {
          return { success: false, error: body.error || '手机未连接' };
        }
        return { success: true };
      }
      return { success: false, error: 'PC 端返回异常' };
    } catch {}
  }
  notifyTab(tabId, { type: 'dialResult', ok: false, err: '短信仅支持 PC 直连模式' });
  return { success: false, error: '短信仅支持 PC 直连模式' };
}

// ==================== 辅助函数（与 v3.1 一致） ====================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function notifyTab(tabId, msg) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
  }
}

// v4.15: 换人使用电脑时同步切换 PIN。
// 仅信任 CSS 选择器精确命中（precise=true）——TreeWalker 兜底检测可能误判，
// 与已设 PIN 冲突时只警示不切换，避免把拨号路由到错误的号码。
async function maybeSwitchPin(newPhone, precise, tabId) {
  try {
    if (!newPhone) return;
    const s = await chrome.storage.local.get(['pin']);
    const oldPin = s.pin || '';
    if (newPhone === oldPin) return;
    if (precise) {
      chrome.storage.local.set({ pin: newPhone });
      console.log('[AutoDial BG] 坐席已切换:', oldPin, '→', newPhone);
      if (oldPin && tabId) {
        notifyTab(tabId, { type: 'pinNotice', text: '坐席号已切换为 ' + newPhone, warn: false });
      }
    } else if (oldPin && tabId) {
      notifyTab(tabId, { type: 'pinNotice', text: '检测到坐席号 ' + newPhone + ' 与已设置 PIN ' + oldPin + ' 不一致，请核对', warn: true });
    }
  } catch (e) {
    console.warn('[AutoDial BG] PIN switch check failed:', e);
  }
}

// ==================== 消息路由（与 v3.1 一致） ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  // 客户手机号检测（子iframe -> 顶层页面转发）
  if (msg.type === 'phoneDetected') {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'updatePhone', phone: msg.phone }, { frameId: 0 }).catch(() => {});
    }
    return;
  }

  if (msg.type === 'dial') { dial(msg.phone, tabId).then(sendResponse); return true; }
  if (msg.type === 'hangup') { hangup(tabId).then(sendResponse); return true; }
  if (msg.type === 'sendSms') { sendSms(msg.phone, tabId).then(sendResponse); return true; }

  // 一键登记
  if (msg.type === 'registerVisit') {
    registerVisit(msg.name, msg.phone, tabId, msg.managerName).then(r => sendResponse(r));
    return true;
  }

  // 获取顾问列表（用于一键登记下拉框）
  if (msg.type === 'getConsultantList') {
    getConsultantList().then(list => sendResponse({ list: list || [] }));
    return true;
  }

  // 坐席手机号检测 -> 存为 PIN + 刷新服务器列表 + 上传姓名到云端
  if (msg.type === 'selfPhoneDetected') {
    // 同时记录是否为精确识别：非精确（TreeWalker 猜测）的结果只用于界面展示与提醒，
    // 不参与 getPin() 的 PIN 兜底（见 getPin 注释）
    chrome.storage.local.set({ self_phone: msg.phone, self_phone_precise: !!msg.precise });
    console.log('[AutoDial BG] 坐席手机号已检测:', msg.phone, msg.precise ? '(精确)' : '(非精确)');
    // v4.15: 换人使用时同步切换 PIN，防止"电话打给上一任坐席"（异步执行，不阻塞监听器）
    maybeSwitchPin(msg.phone, !!msg.precise, tabId);
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
    chrome.storage.local.set({ pin: p, self_phone: p, self_phone_precise: true }, () => {
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
    fetchWithTimeout(`${PC_BASE}/open`)
      .then(r => r.json())
      .then(d => sendResponse({ success: d.success }))
      .catch(() => sendResponse({ success: false }));
    return true;
  }

  if (msg.type === 'toggleFloatbar') {
    fetchWithTimeout(`${PC_BASE}/toggle-floatbar`)
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

// ==================== 右键菜单：同步登记列表 ====================

chrome.contextMenus.removeAll(() => {
  // 1) 一键同步（任意 CRM 页面右键 → 自动跳转列表页并同步）
  chrome.contextMenus.create({
    id: 'oneClickSync',
    title: '🔁 一键同步上门数据',
    contexts: ['page'],
    documentUrlPatterns: ['*://guwen.zhudaicms.com/*']
  });

  // 2) 同步当前页（仅在列表页显示，手动控制范围）
  chrome.contextMenus.create({
    id: 'syncVisitList',
    title: '同步登记列表（当前页）',
    contexts: ['page'],
    documentUrlPatterns: ['*://guwen.zhudaicms.com/manage/kefu_reportformlist/*']
  });

  // 3) 扩展图标右键菜单
  chrome.contextMenus.create({
    id: 'oneClickSyncAction',
    title: '🔁 一键同步上门数据',
    contexts: ['action']
  });
});

const VISIT_LIST_URL = 'https://guwen.zhudaicms.com/manage/kefu_reportformlist/list_user_visit.html';

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = info.menuItemId;

  // 一键同步：自动找到/打开列表页 → 触发 syncVisitList
  if (menuId === 'oneClickSync' || menuId === 'oneClickSyncAction') {
    chrome.tabs.query({ url: '*://guwen.zhudaicms.com/*' }, (tabs) => {
      const target = tabs.find(t => t.url && t.url.includes('list_user_visit'));
      if (target) {
        chrome.tabs.update(target.id, { active: true });
        chrome.tabs.sendMessage(target.id, { type: 'syncVisitList' });
        return;
      }
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { url: VISIT_LIST_URL, active: true });
      } else {
        chrome.tabs.create({ url: VISIT_LIST_URL });
      }
    });
    return;
  }

  // 同步当前页（仅在列表页可用）
  if (menuId === 'syncVisitList') {
    chrome.tabs.sendMessage(tab.id, { type: 'syncVisitList' });
  }
});

// 管理员检查 + 同步处理
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 批量同步登记记录到云端
  if (msg.type === 'batchSyncVisits') {
    const pin = msg.pin;
    const visits = msg.visits; // array of visit objects
    getCloudApi().then(apiUrl => {
      // 逐条提交（简单可靠）
      let synced = 0;
      let skipped = 0;
      let failed = 0;
      const promises = visits.map(v => {
        const params = new URLSearchParams({
          name: v.name, mobile: v.mobile,
          kefu_tel: v.advisor_name || pin,
          visit_type: v.visit_type || '贷款咨询',
          visit_time: v.visit_time || '',
          source: 'crm_sync',
          // 必须带 crm_id：云端按 crm_id 唯一去重（同一物理来访只入一次库）。
          // 此前批量同步漏传 → 重复点"同步"会把同一条来访反复写进云端。
          crm_id: v.crm_id || ''
        });
        return fetch(`${apiUrl}/api/v1/visit?${params.toString()}`, {
          headers: { 'X-AutoDial-PIN': pin }
        }).then(r => r.json()).then(d => {
          if (d.skipped) { skipped++; }
          else if (d.ok) { synced++; }
          else { failed++; }
        }).catch(() => { failed++; });
      });
      return Promise.all(promises).then(() => ({ synced, skipped, failed, total: visits.length }));
    }).then(r => {
      sendResponse({ ok: true, synced: r.synced, skipped: r.skipped, failed: r.failed, total: r.total });
    }).catch(e => {
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }

  // popup 点击"同步登记列表"按钮 → 找到 CRM tab 并发送消息
  if (msg.type === 'triggerSync') {
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

// ==================== 设备授权弹窗 ====================
function showAuthDialog(req, apiUrl) {
  const w = 400, h = 320;
  chrome.windows.getCurrent({}, (win) => {
    const left = win ? Math.round((win.width - w) / 2 + win.left) : 100;
    const top = win ? Math.round((win.height - h) / 2 + win.top) : 100;
    chrome.windows.create({
      url: 'auth.html?request_id=' + encodeURIComponent(req.request_id) +
           '&device=' + encodeURIComponent(req.device_name) +
           '&pin=' + encodeURIComponent(req.pin) +
           '&default_pin=' + encodeURIComponent(req.default_pin) +
           '&api=' + encodeURIComponent(apiUrl),
      type: 'popup',
      width: w, height: h, left: left, top: top,
      focused: true
    });
  });
}

// 授权弹窗响应（auth.html 调用）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'respondAuth') {
    (async () => {
      try {
        const api = msg.api || await getCloudApi();
        // X1修复: 携带征询方 PIN，配合云中继 auth/respond 的归属校验（防越权批准/拒绝）
        const url = api + '/api/v1/auth/respond?request_id=' + encodeURIComponent(msg.request_id) +
                    '&allow=' + (msg.allow ? '1' : '0') +
                    '&pin=' + encodeURIComponent(msg.pin || '');
        const r = await fetch(url);
        const d = await r.json();
        sendResponse({ ok: d.ok, allow: msg.allow });
      } catch(e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
