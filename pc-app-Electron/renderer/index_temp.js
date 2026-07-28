
/* window.api 通过 preload.js contextBridge 注入，不能再用 const api 声明（会冲突） */

let isConnected = false;
let lastDialPin = null;   // v6: 上一次拨号的手机 PIN（重连优先级最高）
let activePin = null;     // v6: 当前活跃手机 PIN
let lastClipboard = '';
let clipboardTimer = null;
let logOpen = false;
let currentPhones = [];  // 当前手机列表
let currentActiveId = null;  // 当前活跃手机ID

// ==================== 标题栏按钮 ====================
document.getElementById('btnSettings').addEventListener('click', () => {
  window.api.send('open-settings');
});
document.getElementById('btnMinimize').addEventListener('click', () => {
  window.api.send('window-control', 'minimize');
});
document.getElementById('btnClose').addEventListener('click', () => {
  window.api.send('window-control', 'close');
});

// ==================== 置顶开关 ====================
document.getElementById('topmostToggle').addEventListener('change', function() {
  window.api.send('set-topmost', this.checked);
});

// ==================== 悬浮横条开关 ====================
document.getElementById('floatbarToggle').addEventListener('change', function() {
  window.api.send('toggle-floatbar', this.checked);
});

// ==================== 拨号盘事件 ====================
document.querySelectorAll('.dial-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    if (key === 'del') {
      deleteLast();
    } else {
      pressKey(key);
    }
  });
});

document.getElementById('btnClear').addEventListener('click', clearNumber);
document.getElementById('callBtn').addEventListener('click', dial);
document.getElementById('hangupBtn').addEventListener('click', hangup);
document.getElementById('logToggle').addEventListener('click', toggleLog);
// ==================== 拨号盘展开/收起 ====================
document.getElementById('dialpadToggle').addEventListener('click', () => {
  const toggle = document.getElementById('dialpadToggle');
  const pad = document.getElementById('dialpad');
  const isOpen = pad.classList.toggle('show');
  toggle.classList.toggle('expanded', isOpen);
});

document.getElementById('smsBtn').addEventListener('click', () => {
  const number = document.getElementById('numberInput').value.trim().replace(/\s/g, '');
  window.api.send('open-sms', number || '');
});

// ==================== 按钮状态文字 ====================
function updateCallBtnText() {
  const btn = document.getElementById('callBtn');
  btn.style.pointerEvents = '';  // v6: 始终恢复可点击性
  if (btn.disabled) {
    btn.textContent = '\uD83D\uDD0D 请输入号码';
  } else if (!isConnected) {
    // v6: 未连接 → 重连按钮
    btn.textContent = '\uD83D\uDD04 重连手机';
  } else {
    btn.innerHTML = '\uD83D\uDCDE \u62E8\u53F7';
  }
}
function updateHangupBtnText() {
  const btn = document.getElementById('hangupBtn');
  if (btn.disabled) {
    btn.textContent = '\uD83D\uDCF1 请连接手机';
  } else {
    btn.innerHTML = '\uD83D\uDD0E \u6302\u65AD';
  }
}
const callBtn = document.getElementById('callBtn');
const hangupBtn = document.getElementById('hangupBtn');
new MutationObserver(updateCallBtnText).observe(callBtn, { attributes: true, attributeFilter: ['disabled'] });
new MutationObserver(updateHangupBtnText).observe(hangupBtn, { attributes: true, attributeFilter: ['disabled'] });
updateCallBtnText();
updateHangupBtnText();

// 输入框变化时更新拨打按钮 disabled 状态
document.getElementById('numberInput').addEventListener('input', function() {
  // v6: 未连接时不禁用，作为重连按钮使用
  document.getElementById('callBtn').disabled = isConnected && !this.value.trim();
  updateCallBtnText();
});

// ==================== 初始化 ====================
async function init() {
  // 重试拿初始信息，最多5次
  let info = null;
  for (let i = 0; i < 5; i++) {
    try {
      info = await window.api.invoke('get-info');
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (info) {
    document.getElementById('localIP').textContent = info.ip || '--';
    document.getElementById('pinCode').textContent = info.pin || '----';
    if (info.connected) setPhoneConnected(true, null);
    if (info.firewall === 'warning') addLog('error', '防火墙可能拦截连接，请以管理员运行');
  } else {
    document.getElementById('localIP').textContent = '获取失败';
  }

  pollClipboard();

  // v6修复: 收集所有IPC事件监听器的清理函数，窗口重载时统一清理
  const _ipcCleanupFns = [];

  // IPC 事件监听
  _ipcCleanupFns.push(window.api.on('status-update', (data) => setPhoneConnected(data.connected, data.phoneIP)));
  _ipcCleanupFns.push(window.api.on('phones-update', (data) => {
    activePin = data.activeId;  // v6: 同步活跃手机 PIN
    updatePhoneSelector(data.phones, data.activeId);
    updateCallBtnText();  // v6: 手机列表变化时恢复按钮状态（防止卡"正在唤醒"）
  });
  // v6: 强制重连结果
  _ipcCleanupFns.push(window.api.on('force-reconnect-result', (data) => {
    // 恢复 phone-tag 上的小按钮
    const list = document.getElementById('phoneList');
    list.querySelectorAll('.phone-reconnect-btn').forEach(btn => {
      btn.classList.remove('spinning');
      btn.textContent = '🔄';
    });
    // 恢复主拨号按钮
    const callBtn = document.getElementById('callBtn');
    callBtn.style.pointerEvents = '';
    updateCallBtnText();
    if (!data.success) {
      showToast(data.error || '唤醒手机失败', 'error');
    }
  }));
  _ipcCleanupFns.push(window.api.on('info-push', (data) => {
    document.getElementById('localIP').textContent = data.ip || '--';
    document.getElementById('pinCode').textContent = data.pin || '----';
  }));
  _ipcCleanupFns.push(window.api.on('floatbar-visible-changed', (visible) => {
    document.getElementById('floatbarToggle').checked = visible;
  }));
  _ipcCleanupFns.push(window.api.on('dial-result', (data) => {
    addLog(data.status === 'ok' ? 'success' : 'error', data.number + ' ' + (data.status === 'ok' ? '&#x2713;' : '&#x2717;'));
  }));
  _ipcCleanupFns.push(window.api.on('dial-sent', (data) => {
    addLog('success', '\uD83D\uDCDE 已发送: ' + data.number);
    // v6: 记录拨号时的活跃手机 PIN，用于重连优先
    if (data.phoneId) lastDialPin = data.phoneId;
  }));
  // v6: 拨号请求触发自动唤醒时的反馈
  _ipcCleanupFns.push(window.api.on('dial-waking', (data) => {
    addLog('info', '\u23F3 正在唤醒手机(PIN=' + data.pin + ')...拨号排队中');
    if (data.number) showToast('正在唤醒手机，将自动拨号 ' + data.number);
  }));
  // v6: 排队拨号超时
  _ipcCleanupFns.push(window.api.on('dial-timeout', (data) => {
    addLog('error', '\u274C 拨号超时: ' + data.number + ' (30s未响应)');
    showToast('拨号超时，正在尝试云端恢复...', 'error');
    updateCallBtnText();
    // v6: 拨号超时自动触发云端轻量恢复
    window.api.send('dial-failed-trigger-recovery');
  }));

  // v6: 重启图标点击
  document.getElementById('restartCloudIcon').addEventListener('click', () => {
    const icon = document.getElementById('restartCloudIcon');
    icon.classList.add('spinning');
    window.api.send('restart-cloud');
    setTimeout(() => icon.classList.remove('spinning'), 3000);
    addLog('info', '云端重连已触发');
  });
  document.getElementById('restartAppIcon').addEventListener('click', () => {
    if (confirm('确定要重启 AutoDial 吗？\n\n重启后会自动恢复，约需 3-5 秒。')) {
      window.api.send('restart-app');
    }
  });

  _ipcCleanupFns.push(window.api.on('hangup-sent', () => {
    addLog('info', '已发送挂断');
  }));
  _ipcCleanupFns.push(window.api.on('server-log', (data) => {
    const lvl = data.level === 'error' ? 'error' : data.level === 'warn' ? 'error' : 'info';
    addLog(lvl, '&#x1F5A5; ' + data.text);
  }));
  _ipcCleanupFns.push(window.api.on('error', (data) => {
    showToast(data.message, 'error');
    addLog('error', data.message);
  }));

  // v6修复: 窗口卸载时清理所有IPC监听器，防止内存泄漏
  window.addEventListener('beforeunload', () => {
    _ipcCleanupFns.forEach(fn => { try { fn(); } catch(e) {} });
  });
}

function setPhoneConnected(connected, phoneIP) {
  isConnected = connected;
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const banner = document.getElementById('banner');
  const callBtn = document.getElementById('callBtn');
  const hasNumber = document.getElementById('numberInput').value.trim();
  const statusIcon = document.getElementById('statusIcon');
  const statusTextLarge = document.getElementById('statusTextLarge');
  const statusSubtext = document.getElementById('statusSubtext');
  
  callBtn.disabled = connected && !hasNumber;  // v6: 未连接时不禁用(重连按钮)
  document.getElementById('hangupBtn').disabled = !connected;
  
  if (connected) {
    // 方案3：优化连接状态显示
    statusIcon.textContent = '✅';
    statusIcon.className = 'status-icon connected';
    statusTextLarge.textContent = '手机已连接';
    statusSubtext.textContent = phoneIP ? '手机IP: ' + phoneIP : '可以拨号了';
    
    dot.className = 'status-dot on';
    txt.textContent = phoneIP ? phoneIP : '已连接';
    banner.className = 'banner show';
  } else {
    // 方案3：优化连接状态显示
    statusIcon.textContent = '📵';
    statusIcon.className = 'status-icon';
    statusTextLarge.textContent = '等待连接';
    statusSubtext.textContent = '请确保手机和电脑在同一局域网';
    
    dot.className = 'status-dot';
    txt.textContent = '等待连接';
    banner.className = 'banner';
  }
}

// ==================== 多手机选择器 ====================
function updatePhoneSelector(phones, activeId) {
  currentPhones = phones || [];
  currentActiveId = activeId;
  const selector = document.getElementById('phoneSelector');
  const list = document.getElementById('phoneList');
  const banner = document.getElementById('banner');
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');

  if (currentPhones.length === 0) {
    selector.className = 'phone-selector';
    isConnected = false;
    dot.className = 'status-dot';
    txt.textContent = '等待连接';
    banner.className = 'banner';
    // v6: 未连接时不禁用拨号按钮，作为重连按钮
    document.getElementById('callBtn').disabled = false;
    document.getElementById('hangupBtn').disabled = true;
    updateCallBtnText();
    updateHangupBtnText();
    return;
  }

  isConnected = true;
  dot.className = 'status-dot on';
  selector.className = 'phone-selector show';

  // 多手机时 banner 显示数量
  if (currentPhones.length > 1) {
    banner.className = 'banner show';
    banner.innerHTML = '&#x2705; ' + currentPhones.length + '部手机已连接';
  } else {
    banner.className = 'banner show';
    banner.innerHTML = '&#x2705; 手机已连接，可以拨号';
  }

  // 更新状态栏文字
  const activePhone = currentPhones.find(p => p.id === activeId);
  if (activePhone) {
    const display = activePhone.note || activePhone.name;
    txt.textContent = display;
  }

  // 渲染手机标签
  list.innerHTML = '';
  currentPhones.forEach(phone => {
    const tag = document.createElement('div');
    tag.className = 'phone-tag' + (phone.id === activeId ? ' active' : '');
    tag.__phoneId = phone.id;  // v6修复: 创建时即标记，确保 startRename 首次双击可用

    const dotEl = document.createElement('span');
    dotEl.className = 'phone-dot';
    tag.appendChild(dotEl);

    const nameEl = document.createElement('span');
    nameEl.className = 'phone-name';
    nameEl.textContent = phone.note || phone.name;
    tag.appendChild(nameEl);

    if (phone.note) {
      const hint = document.createElement('span');
      hint.className = 'phone-note-hint';
      hint.textContent = '(' + phone.name + ')';
      tag.appendChild(hint);
    }

    // v6: 重连按钮（每个手机标签右侧）
    const reconnectBtn = document.createElement('span');
    reconnectBtn.className = 'phone-reconnect-btn';
    reconnectBtn.title = '强制重连此手机';
    reconnectBtn.textContent = '🔄';
    reconnectBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // 不触发选中切换
      if (reconnectBtn.classList.contains('spinning')) return;
      reconnectBtn.classList.add('spinning');
      reconnectBtn.textContent = '⏳';
      window.api.send('force-reconnect', phone.id);
    });
    tag.appendChild(reconnectBtn);

    // 点击切换活跃手机
    tag.addEventListener('click', () => {
      window.api.send('select-phone', phone.id);
    });

    // 双击编辑备注
    tag.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(phone.id, phone.note || '');
    });

    list.appendChild(tag);
  });

  // 更新按钮状态
  const hasNumber = document.getElementById('numberInput').value.trim();
  document.getElementById('callBtn').disabled = isConnected && !hasNumber; // v6: 未连接时不禁用
  document.getElementById('hangupBtn').disabled = !isConnected;
  updateCallBtnText();
  updateHangupBtnText();
}

function startRename(phoneId, currentNote) {
  const list = document.getElementById('phoneList');
  const tags = list.querySelectorAll('.phone-tag');
  tags.forEach(tag => {
    if (tag.__phoneId !== phoneId) return;
    // 替换为输入框
    tag.innerHTML = '';
    const input = document.createElement('input');
    input.className = 'phone-rename-input';
    input.value = currentNote;
    input.placeholder = '输入备注名';
    tag.appendChild(input);
    input.focus();
    input.select();

    const finish = () => {
      window.api.send('rename-phone', { id: phoneId, note: input.value.trim() });
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = currentNote; input.blur(); }
    });
  });
}

// ==================== 拨号盘 ====================
function pressKey(key) {
  const inp = document.getElementById('numberInput');
  inp.value += key; inp.focus();
  inp.dispatchEvent(new Event('input'));
}
function deleteLast() {
  const inp = document.getElementById('numberInput');
  inp.value = inp.value.slice(0, -1);
  inp.dispatchEvent(new Event('input'));
}
function clearNumber() {
  document.getElementById('numberInput').value = '';
  document.getElementById('numberInput').dispatchEvent(new Event('input'));
}

function dial() {
  const number = document.getElementById('numberInput').value.trim().replace(/\s/g, '');
  if (!isConnected) {
    // v6: 手机未连接 → 自动重连上一次拨号的手机（或活跃手机）
    const targetPin = lastDialPin || activePin;
    if (!targetPin) { showToast('无可用手机', 'error'); return; }
    const btn = document.getElementById('callBtn');
    btn.textContent = '⏳ 正在唤醒手机...';
    btn.style.pointerEvents = 'none';
    window.api.send('force-reconnect', targetPin);
    addLog('info', '唤醒手机 (PIN=' + targetPin + ')...');
    // 如果有号码，也发送拨号请求（main.js 会自动排队）
    if (number) window.api.send('dial', number);
    return;
  }
  if (!number) { showToast('请输入号码', 'error'); return; }
  // v6: 记录本次拨号的手机 PIN
  lastDialPin = activePin;
  window.api.send('dial', number);
  addLog('info', '发送拨号: ' + number);
}
function hangup() {
  if (!isConnected) { showToast('手机未连接', 'error'); return; }
  window.api.send('hangup');
  addLog('info', '发送挂断');
  showToast('已发送挂断指令');
}

// ==================== 剪贴板 ====================
function extractPhone(text) {
  const m = text.match(/1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8}/);
  return m ? m[0].replace(/[-\s]/g, '') : null;
}

function pollClipboard() {
  window.api.invoke('read-clipboard').then(d => {
    if (d.text && d.text !== lastClipboard) {
      lastClipboard = d.text;
      const phone = extractPhone(d.text);
      if (phone) {
        const inp = document.getElementById('numberInput');
        inp.value = phone;
        const hint = document.getElementById('clipHint');
        hint.classList.add('flash');
        setTimeout(() => hint.classList.remove('flash'), 400);
      }
    }
  }).catch(() => {}).finally(() => {
    clipboardTimer = setTimeout(pollClipboard, 1000);
  });
}

// ==================== 日志 ====================
function toggleLog() {
  logOpen = !logOpen;
  document.getElementById('logToggle').classList.toggle('open', logOpen);
  document.getElementById('logBody').classList.toggle('open', logOpen);
}

function addLog(type, msg) {
  const body = document.getElementById('logBody');
  const now = new Date();
  const t = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
  const el = document.createElement('div');
  el.className = 'log-entry ' + type;
  el.innerHTML = '<span class="lt">' + t + '</span><span class="lm">' + msg + '</span>';
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
  while (body.children.length > 80) body.removeChild(body.firstChild);
  if (!logOpen) { logOpen = true; document.getElementById('logToggle').classList.add('open'); body.classList.add('open'); }
}

let toastTimer = null;
function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2500);
}

// 键盘快捷键
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') dial();
  if (e.key === 'Backspace' && document.activeElement.id !== 'numberInput') deleteLast();
});

// ==================== 主界面快捷短信模板 ====================
const INDEX_TPL_KEY = 'autodial_sms_templates';
const INDEX_TPL_DEFAULTS = [
  { id: 1, title: '回访问候', content: '您好，我是之前联系过您的客服，请问您对我们产品还有什么疑问吗？' },
  { id: 2, title: '催办提醒', content: '您好，温馨提醒您，您的业务办理进度已更新，请及时查看。' },
  { id: 3, title: '会议通知', content: '您好，我们将于明天上午10点召开线上会议，届时请准时参加。' },
  { id: 4, title: '感谢回复', content: '感谢您的咨询与支持，如有其他问题随时联系我们，祝您生活愉快！' },
  { id: 5, title: '节日祝福', content: '值此佳节来临之际，祝您及家人节日快乐，万事如意！' }
];

function indexLoadTemplates() {
  try {
    const raw = localStorage.getItem(INDEX_TPL_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return JSON.parse(JSON.stringify(INDEX_TPL_DEFAULTS));
}

function renderIndexTemplates() {
  const templates = indexLoadTemplates();
  const container = document.getElementById('indexTplList');
  container.innerHTML = '';
  templates.forEach(tpl => {
    const tag = document.createElement('div');
    tag.className = 'index-tpl-tag';
    tag.textContent = tpl.title;
    tag.title = tpl.content;
    tag.addEventListener('click', () => {
      const number = document.getElementById('numberInput').value.trim().replace(/\s/g, '');
      window.api.send('open-sms', { number: number || '', content: tpl.content });
    });
    container.appendChild(tag);
  });
}

// 初始化主题
if (typeof ThemeEngine !== 'undefined') ThemeEngine.initTheme();

// 模板渲染（在init之前，localStorage立即可用）
renderIndexTemplates();

init();
