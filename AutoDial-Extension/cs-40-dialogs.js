/**
 * AutoDial Content Script — 模块 40：设置弹窗 / 一键登记弹窗 / 辅助构造（v6.1 拆分第三期）
 *
 * 负责：设置弹窗（PIN + 云地址）、一键登记确认弹窗、区块/按钮辅助（mkSection / mkBtn）、
 *       openDesktopApp / toggleFloatbar / sendSms。
 *
 * 加载顺序：... → cs-30-menu.js → 本文件 → cs-70-boot.js
 */
(function (AD) {
  'use strict';
  if (window.__adv2_dialogs) return;
  window.__adv2_dialogs = true;
  if (!AD) return;

  // 本模块私有常量：SECTION_ICON（区块标题→图标映射）。
function showSettingsDialog() {
  const t = AD.T();

  // 关闭已打开的
  const old = document.getElementById('__ad_settings');
  if (old) { old.remove(); document.getElementById('__ad_settings_overlay')?.remove(); }

  // 遮罩
  const overlay = document.createElement('div');
  overlay.id = '__ad_settings_overlay';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '2147483646',
    background: 'rgba(0,0,0,0.45)',
    backdropFilter: 'blur(2px)',
  });
  overlay.addEventListener('click', closeSettings);
  document.body.appendChild(overlay);

  // 弹窗主体
  const dialog = document.createElement('div');
  dialog.id = '__ad_settings';
  Object.assign(dialog.style, {
    position: 'fixed', left: '50%', top: '50%',
    transform: 'translate(-50%, -50%) scale(0.95)',
    zIndex: '2147483647',
    width: '380px', maxWidth: 'calc(100vw - 32px)',
    background: t.bg2,
    borderRadius: '16px',
    boxShadow: `0 16px 48px rgba(0,0,0,0.45), 0 0 0 1px ${t.accent}22`,
    padding: '20px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    color: t.text,
    fontSize: '14px',
    backdropFilter: 'blur(24px)',
    opacity: '0',
    transition: 'opacity .2s ease, transform .2s ease',
  });

  // 入场动画
  requestAnimationFrame(() => {
    dialog.style.opacity = '1';
    dialog.style.transform = 'translate(-50%, -50%) scale(1)';
  });

  function closeSettings() {
    dialog.style.opacity = '0';
    dialog.style.transform = 'translate(-50%, -50%) scale(0.95)';
    setTimeout(() => { overlay.remove(); dialog.remove(); }, 200);
  }
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { closeSettings(); document.removeEventListener('keydown', escClose); }
  });

  // ── 标题（20px 图标底座 + 15px/700 标题 + 右侧 × 关闭） ──
  const title = document.createElement('div');
  Object.assign(title.style, {
    display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px',
  });
  const tile = document.createElement('span');
  Object.assign(tile.style, {
    width: '20px', height: '20px', borderRadius: '6px',
    background: t.accent + '1F', color: t.accent,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: '0',
  });
  tile.innerHTML = AD.adIcon('gear', 12);
  const titleText = document.createElement('span');
  titleText.textContent = '设置';
  Object.assign(titleText.style, { fontSize: '15px', fontWeight: '700', color: t.text, letterSpacing: '0.5px' });
  const titleCloseBtn = document.createElement('button');
  titleCloseBtn.innerHTML = AD.adIcon('x', 14);
  Object.assign(titleCloseBtn.style, {
    marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer',
    color: t.text2, padding: '4px', display: 'inline-flex', alignItems: 'center', borderRadius: '6px',
  });
  titleCloseBtn.addEventListener('click', closeSettings);
  title.append(tile, titleText, titleCloseBtn);
  dialog.appendChild(title);

  // ═══════════════════ PIN 区 ═══════════════════
  const pinSection = mkSection('配对码 (PIN)', '4位或11位数字，用于配对和标识');
  dialog.appendChild(pinSection);

  const pinRow = document.createElement('div');
  Object.assign(pinRow.style, { display: 'flex', gap: '8px', marginBottom: '4px' });
  const pinInput = document.createElement('input');
  pinInput.type = 'tel';
  pinInput.maxLength = 11;
  pinInput.placeholder = '4位或11位数字配对码';
  Object.assign(pinInput.style, {
    flex: '1', height: '40px', padding: '0 12px', fontSize: '15px', fontWeight: '500', letterSpacing: '1px',
    background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '10px',
    color: t.text, outline: 'none', textAlign: 'center',
    transition: 'border-color .15s, box-shadow .15s',
  });
  pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, ''); });
  pinInput.addEventListener('focus', () => {
    const c = AD.T();
    pinInput.style.borderColor = c.accent;
    pinInput.style.boxShadow = `0 0 0 3px ${c.accent}26`;
  });
  pinInput.addEventListener('blur', () => {
    pinInput.style.borderColor = AD.T().accent + '33';
    pinInput.style.boxShadow = 'none';
  });

  const pinSaveBtn = mkBtn('保存', t.gradAccent, '#FFFFFF');
  pinSaveBtn.addEventListener('click', () => {
    const v = pinInput.value.trim();
    if (!/^\d{4}$|^\d{11}$/.test(v)) {
      pinStatus.textContent = '请输入4位或11位数字配对码'; pinStatus.style.color = t.red;
      return;
    }
    chrome.runtime.sendMessage({ type: 'setPin', pin: v }, (resp) => {
      if (chrome.runtime.lastError || !resp?.success) {
        pinStatus.textContent = '保存失败'; pinStatus.style.color = t.red;
      } else {
        pinStatus.textContent = '✓ 已保存'; pinStatus.style.color = t.green;
        setTimeout(() => { pinStatus.textContent = ''; }, 2000);
      }
    });
  });
  pinRow.appendChild(pinInput);
  pinRow.appendChild(pinSaveBtn);
  dialog.appendChild(pinRow);

  const pinStatus = document.createElement('div');
  Object.assign(pinStatus.style, { fontSize: '11px', minHeight: '16px', marginBottom: '16px', paddingLeft: '4px', color: t.text2 });
  dialog.appendChild(pinStatus);

  // 加载当前 PIN
  chrome.storage.local.get(['pin', 'self_phone'], (s) => {
    pinInput.value = s.pin || s.self_phone || '';
  });

  // ═══════════════════ 云中继地址区（v5.6 走 addr.js） ═══════════════════
  const srvSection = mkSection('云中继地址', '默认端口 35430 · 留空则用自动获取的地址');
  dialog.appendChild(srvSection);

  const srvRow = document.createElement('div');
  Object.assign(srvRow.style, { display: 'flex', gap: '8px', marginBottom: '4px' });
  const srvInput = document.createElement('input');
  srvInput.type = 'text';
  srvInput.placeholder = '例: 101.34.65.254:35430';
  Object.assign(srvInput.style, {
    flex: '1', height: '40px', padding: '0 12px', fontSize: '14px',
    background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '10px',
    color: t.text, outline: 'none',
    transition: 'border-color .15s, box-shadow .15s',
  });
  srvInput.addEventListener('focus', () => {
    const c = AD.T();
    srvInput.style.borderColor = c.accent;
    srvInput.style.boxShadow = `0 0 0 3px ${c.accent}26`;
  });
  srvInput.addEventListener('blur', () => {
    srvInput.style.borderColor = AD.T().accent + '33';
    srvInput.style.boxShadow = 'none';
  });

  const srvSaveBtn = mkBtn('保存', t.gradAccent, '#FFFFFF');
  srvSaveBtn.addEventListener('click', async () => {
    const v = srvInput.value.trim();
    if (!v) {
      await AD_ADDR.setManual('');
      srvStatus.textContent = '✓ 已清空，将使用自动获取的地址'; srvStatus.style.color = t.green;
      const a = await AD_ADDR.readActive();
      srvInput.value = AD_ADDR.cleanAddr(a.addr);
      srcHint.textContent = '来源：' + AD_ADDR.sourceLabel(a.source);
      setTimeout(() => { srvStatus.textContent = ''; }, 2000);
      return;
    }
    const saved = await AD_ADDR.setManual(v);
    srvInput.value = AD_ADDR.cleanAddr(saved.addr);
    srcHint.textContent = '来源：手动';
    srvStatus.textContent = '✓ 已保存'; srvStatus.style.color = t.green;
    setTimeout(() => { srvStatus.textContent = ''; }, 2000);
  });
  srvRow.appendChild(srvInput);
  srvRow.appendChild(srvSaveBtn);
  dialog.appendChild(srvRow);

  const srvStatus = document.createElement('div');
  Object.assign(srvStatus.style, { fontSize: '11px', minHeight: '16px', marginBottom: '4px', paddingLeft: '4px', color: t.text2 });
  dialog.appendChild(srvStatus);

  // v5.6：来源提示行（手动 / 自动 / 默认）
  const srcHint = document.createElement('div');
  Object.assign(srcHint.style, { fontSize: '11px', marginBottom: '8px', paddingLeft: '4px', color: t.text2 });
  dialog.appendChild(srcHint);

  // v5.6：输入框显示「真实生效地址」。此前只读 cloud_api —— 从没手动设过时是空白，
  // 但后台实际在用自动获取的候选首位，看到的值和用到的值不是一回事。
  AD_ADDR.readActive().then((a) => {
    srvInput.value = AD_ADDR.cleanAddr(a.addr);
    srcHint.textContent = '来源：' + AD_ADDR.sourceLabel(a.source);
  });

  // 按钮行: 测试连接 + 获取候选
  const actionRow = document.createElement('div');
  Object.assign(actionRow.style, { display: 'flex', gap: '8px', marginBottom: '8px' });

  const testBtn = mkBtn('测试连接', t.bg3, t.text, `1px solid ${t.accent}33`);
  testBtn.addEventListener('click', async () => {
    const addr = srvInput.value.trim();
    if (!addr) { srvStatus.textContent = '请输入服务器地址'; srvStatus.style.color = t.red; return; }
    srvStatus.textContent = '测试中...'; srvStatus.style.color = t.text2;
    // v5.6：统一走 AD_ADDR.probe（与弹窗同一个实现），失败按原因区分，
    // 不再是笼统的"无法连接"（地址错/端口拒绝/超时/不是本服务）。
    const r = await AD_ADDR.probe(addr, { timeoutMs: 8000 });
    srvStatus.textContent = AD_ADDR.probeMessage(r);
    srvStatus.style.color = r.ok ? t.green : t.red;
  });
  actionRow.appendChild(testBtn);

  const fetchBtn = mkBtn('获取候选', t.bg3, t.text, `1px solid ${t.accent}33`);
  fetchBtn.addEventListener('click', async () => {
    srvStatus.textContent = '获取中...'; srvStatus.style.color = t.text2;
    // v5.6：只刷新「候选池」，**不再**把 servers[0] 写进 cloud_api。
    // 此前点一次「一键获取」就顶掉手动地址，并从此永久钉死在第一台机器上
    // （后面自动列表再更新也不会跟随）。
    const list = await AD_ADDR.fetchList(8000);
    if (!list.length) {
      srvStatus.textContent = '获取失败，请检查网络'; srvStatus.style.color = t.red;
      return;
    }
    await AD_ADDR.applyAuto(list);
    srvInput.value = list[0];  // 仅填入输入框作建议，点「保存」才真正生效
    srvStatus.textContent = `✓ 获取到 ${list.length} 个候选，点「保存」启用首个`; srvStatus.style.color = t.green;
  });
  actionRow.appendChild(fetchBtn);
  dialog.appendChild(actionRow);

  // ── 关闭按钮 ──
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '关闭';
  Object.assign(closeBtn.style, {
    display: 'block', margin: '14px auto 0', height: '38px', padding: '0 32px',
    background: 'transparent', color: t.text2, border: `1px solid ${t.accent}33`,
    borderRadius: '10px', cursor: 'pointer', fontSize: '13px',
  });
  closeBtn.addEventListener('click', closeSettings);
  dialog.appendChild(closeBtn);

  document.body.appendChild(dialog);
}

// ── 辅助：区块标题 ──
const SECTION_ICON = { '配对码 (PIN)': 'lock', '云端服务器': 'cloud' };
function mkSection(title, subtitle) {
  const t = AD.T();
  const el = document.createElement('div');
  Object.assign(el.style, { marginBottom: '10px' });
  const head = document.createElement('div');
  Object.assign(head.style, {
    fontSize: '13px', fontWeight: '600', color: t.accent, marginBottom: '2px',
    display: 'flex', alignItems: 'center', gap: '6px',
  });
  head.innerHTML = AD.adIcon(SECTION_ICON[title] || 'gear', 14) + '<span>' + title + '</span>';
  el.appendChild(head);
  if (subtitle) {
    const sub = document.createElement('div');
    Object.assign(sub.style, { fontSize: '11px', color: t.text2, paddingLeft: '20px' });
    sub.textContent = subtitle;
    el.appendChild(sub);
  }
  return el;
}

// ── 辅助：按钮 ──
function mkBtn(text, bg, color, border) {
  const btn = document.createElement('button');
  btn.textContent = text;
  Object.assign(btn.style, {
    height: '40px', padding: '0 16px', fontSize: '13px', fontWeight: '600',
    background: bg || 'transparent', color: color || '#fff',
    border: border || 'none', borderRadius: '10px',
    cursor: 'pointer', whiteSpace: 'nowrap', transition: 'opacity .15s',
  });
  btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.8'; });
  btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
  return btn;
}

function openDesktopApp() {
  chrome.runtime.sendMessage({ type: 'openDesktop' }, (resp) => {
    if (chrome.runtime.lastError) { AD.flashFloat('PC端未运行', false); return; }
    if (resp && resp.success) AD.flashFloat('已打开主界面', true);
    else AD.flashFloat('打开失败', false);
  });
}

function toggleFloatbar() {
  chrome.runtime.sendMessage({ type: 'toggleFloatbar' }, (resp) => {
    if (chrome.runtime.lastError) { AD.flashFloat('PC端未运行', false); return; }
    if (resp && resp.success) AD.flashFloat(resp.visible ? '悬浮窗已显示' : '悬浮窗已隐藏', true);
    else AD.flashFloat('操作失败', false);
  });
}

function sendSms(phone) {
  chrome.runtime.sendMessage({ type: 'sendSms', phone }, (resp) => {
    if (chrome.runtime.lastError) { AD.flashFloat('PC端未运行', false); return; }
    if (resp && resp.success) AD.flashFloat('已打开短信窗口', true);
    else AD.flashFloat('打开短信窗口失败', false);
  });
}

// ─── 一键登记确认弹窗 ────────────────────────────
function showRegisterConfirm(name, phone) {
  // 移除已有弹窗
  var old = document.getElementById('autodial-register-overlay');
  if (old) old.remove();

  var pin = window.__adMyPhone || '';
  var mgrName = window.__adMyName || pin; // 优先用自动检测的姓名，兜底用 PIN

  var t = AD.T();
  var overlay = document.createElement('div');
  overlay.id = 'autodial-register-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;' +
    'background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;' +
    'align-items:center;justify-content:center;font-family:sans-serif;';

  overlay.innerHTML = '<div style="background:' + t.bg2 + ';border-radius:16px;padding:20px;' +
    'min-width:300px;max-width:360px;color:' + t.text + ';text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.45),0 0 0 1px ' + t.accent + '22;backdrop-filter:blur(16px);font-family:system-ui,-apple-system,sans-serif;">' +
    '<div style="font-size:16px;font-weight:bold;color:' + t.accentLight + ';margin-bottom:16px;">确认登记客户信息</div>' +
    '<div style="text-align:left;margin-bottom:16px;">' +
    '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">客户姓名：</span>' + AD.escHtml(name) + '</div>' +
    '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">客户手机号：</span>' + AD.escHtml(phone) + '</div>' +
    '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">接待顾问：</span>' +
    '<select id="autodial-register-manager" style="width:100%;padding:8px 10px;border:1px solid ' + t.accent + '33;border-radius:10px;background:' + t.bg3 + ';color:' + t.text + ';font-size:14px;box-sizing:border-box;margin-top:4px;outline:none;">' +
    '<option value="' + AD.escHtml(mgrName || '') + '" selected>' + AD.escHtml(mgrName || '加载中…') + '</option>' +
    '</select></div>' +
    '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">事由：</span>贷款咨询</div>' +
    '</div>' +
    '<div style="display:flex;gap:12px;">' +
    '<button id="autodial-register-cancel" style="flex:1;height:42px;border:1px solid ' + t.accent + '44;' +
    'border-radius:999px;background:transparent;color:' + t.text2 + ';cursor:pointer;font-size:14px;font-family:inherit;">取消</button>' +
    '<button id="autodial-register-confirm" style="flex:1;height:42px;border:none;' +
    'border-radius:999px;background:' + t.gradAccent + ';color:#FFFFFF;cursor:pointer;font-size:14px;font-weight:bold;font-family:inherit;box-shadow:0 3px 10px ' + t.accent + '44;">确认登记</button>' +
    '</div></div>';

  document.body.appendChild(overlay);

  // 异步拉取 CRM 顾问列表，填充下拉框
  chrome.runtime.sendMessage({ type: 'getConsultantList' }, function(resp) {
    var select = document.getElementById('autodial-register-manager');
    if (!select) return; // 弹窗已被关闭
    var list = (resp && resp.list) || [];
    if (!list.length) return; // 拉取失败时保留默认选项
    var html = '';
    var mgrInList = false;
    for (var i = 0; i < list.length; i++) {
      var sel = (list[i].name === mgrName) ? ' selected' : '';
      if (list[i].name === mgrName) mgrInList = true;
      html += '<option value="' + AD.escHtml(list[i].name) + '"' + sel + '>' + AD.escHtml(list[i].name) + '</option>';
    }
    // 若当前姓名不在 CRM 列表中，保留为第一项
    if (!mgrInList && mgrName) {
      html = '<option value="' + AD.escHtml(mgrName) + '" selected>' + AD.escHtml(mgrName) + '</option>' + html;
    }
    select.innerHTML = html;
  });

  document.getElementById('autodial-register-cancel').onclick = function() {
    overlay.remove();
  };
  document.getElementById('autodial-register-confirm').onclick = function() {
    var mgrSelect = document.getElementById('autodial-register-manager');
    var finalMgrName = mgrSelect ? mgrSelect.value.trim() : '';
    overlay.remove();
    chrome.runtime.sendMessage({
      type: 'registerVisit',
      name: name,
      phone: phone,
      managerName: finalMgrName || undefined
    }, function(resp) {
      if (resp && resp.success) {
        AD.showToast('✅ 已登记 ' + name);
      } else {
        AD.showToast('✗ 登记失败: ' + (resp ? resp.error : '网络错误'));
      }
    });
  };

  // 点击遮罩关闭
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
}

  /* ---------- 对外出口 ---------- */
  AD.showSettingsDialog = showSettingsDialog;
  AD.mkSection = mkSection;
  AD.mkBtn = mkBtn;
  AD.openDesktopApp = openDesktopApp;
  AD.toggleFloatbar = toggleFloatbar;
  AD.sendSms = sendSms;
  AD.showRegisterConfirm = showRegisterConfirm;
})(window.__ADCS = window.__ADCS || {});
