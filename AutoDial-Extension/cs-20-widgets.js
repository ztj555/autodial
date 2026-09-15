/**
 * AutoDial Content Script — 模块 20：挂件层（v6.1 拆分第二期）
 *
 * 负责：浮动按钮、挂断按钮（含左下角拖拽缩放）、手动拨号条、
 *       号码刷新与状态反馈（updatePhone / flashFloat / restoreFloatLabel）。
 *
 * 挂件句柄（AD.floatEl / AD.hangupEl / AD.hangupResizeHandle / AD.manualDialBar）
 * 由 cs-10-theme.js 声明并持有，本模块只赋值/读取。
 *
 * 加载顺序：... → cs-10-theme.js → 本文件 → cs-30-menu.js → ... → content-script.js
 */
(function (AD) {
  'use strict';
  if (window.__adv2_widgets) return;
  window.__adv2_widgets = true;
  if (!AD) return;

  // 本模块私有状态只有挂断按钮的尺寸（hangupSize / HANGUP_MIN / HANGUP_MAX，
  // 定义在下方「挂断悬浮按钮」段）；其余跨模块共享的状态一律走 AD.xxx。
// ═══════════════════════════════════════════════

function createFloat() {
  if (document.getElementById('__ad_float')) return;
  const t = AD.T();

  AD.floatEl = document.createElement('div');
  AD.floatEl.id = '__ad_float';
  Object.assign(AD.floatEl.style, {
    position: 'fixed',
    right: '20px',
    top: '370px',
    zIndex: '2147483647',
    padding: '10px 18px',
    fontSize: '13px',
    fontWeight: '600',
    color: t.text,
    background: t.bg2,
    borderRadius: '999px',
    boxShadow: `0 4px 14px ${t.accent}1F`,
    cursor: 'grab',
    userSelect: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'background .2s, box-shadow .2s, transform .15s',
    whiteSpace: 'nowrap',
    letterSpacing: '0.5px',
    border: `1px solid ${t.accent}33`,
  });
  AD.floatEl.addEventListener('mouseenter', () => {
    const c = AD.T();
    AD.floatEl.style.transform = 'translateY(-1px)';
    AD.floatEl.style.boxShadow = AD.currentPhone
      ? `0 8px 24px ${c.accent}66`
      : `0 6px 18px ${c.accent}26`;
  });
  AD.floatEl.addEventListener('mouseleave', () => {
    const c = AD.T();
    AD.floatEl.style.transform = '';
    AD.floatEl.style.boxShadow = AD.currentPhone
      ? `0 6px 20px ${c.accent}59`
      : `0 4px 14px ${c.accent}1F`;
  });
  AD.floatEl.addEventListener('pointerdown', () => { AD.floatEl.style.transform = 'scale(.97)'; });
  AD.floatEl.addEventListener('pointerup', () => { AD.floatEl.style.transform = ''; });
  AD.floatEl.addEventListener('pointercancel', () => { AD.floatEl.style.transform = ''; });
  // 用 span 包内容（图标 + 文字），避免 textContent 覆盖子元素
  const dialLabel = document.createElement('span');
  dialLabel.id = '__ad_dial_label';
  dialLabel.style.pointerEvents = 'none'; // 不拦截指针事件，让父元素处理
  dialLabel.style.display = 'inline-flex';
  dialLabel.style.alignItems = 'center';
  dialLabel.style.gap = '6px';
  dialLabel.innerHTML = AD.adIcon('phone', 15) + '<span>等待号码...</span>';
  AD.floatEl.appendChild(dialLabel);

  // ─── 拖动（仅左右边缘启动，中间区域点击拨号） ────
  let dragging = false, dragStartX = 0, dragStartY = 0, ox = 0, oy = 0;
  const DRAG_EDGE = 0.18; // 左右各 18% 为拖动区域
  AD.floatEl.addEventListener('pointerdown', (e) => {
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const r = AD.floatEl.getBoundingClientRect();
    const xRatio = (e.clientX - r.left) / r.width;
    // 中间区域（号码/表情）：不启动拖动，允许 click 正常触发
    if (xRatio > DRAG_EDGE && xRatio < (1 - DRAG_EDGE)) return;
    dragging = true;
    ox = e.clientX - r.left;
    oy = e.clientY - r.top;
    AD.floatEl.setPointerCapture(e.pointerId);
    AD.floatEl.style.cursor = 'grabbing';
    e.preventDefault();
  });
  AD.floatEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    AD.floatEl.style.left = (e.clientX - ox) + 'px';
    AD.floatEl.style.top = (e.clientY - oy) + 'px';
    AD.floatEl.style.right = 'auto';
    AD.floatEl.style.bottom = 'auto';
  });
  AD.floatEl.addEventListener('pointerup', () => {
    dragging = false;
    AD.floatEl.style.cursor = 'grab';
  });

  // ─── 点击拨号 ────────────────────────────────
  // v4.23: 防连点——2 秒窗口内只发一次，避免连点触发两次拨号指令
  // v5.3: 点击瞬间先向"当前激活客户帧"取一次实时号码，再拨——消除 5 秒心跳滞后，
  //       确保拨的永远是"眼前这个客户"（拿不到才提示未检测到号码）
  let lastFloatDialClick = 0;
  AD.floatEl.addEventListener('click', (e) => {
    // 比较按下和抬起的位置，超过 5px 视为拖动，不触发拨号
    const dist = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
    if (dist > 5) return;
    const now = Date.now();
    if (now - lastFloatDialClick < 2000) return;
    AD.refreshActivePhone((phone) => {
      if (!phone) { flashFloat('未检测到号码', false); return; }
      lastFloatDialClick = Date.now();
      // v4.15: 点击立即进入"拨号中"状态（清除旧失败提示），结果回来后刷新
      flashFloat('拨号中…', undefined);
      chrome.runtime.sendMessage({ type: 'dial', phone });
    });
  });

  // ─── 右键菜单 ────────────────────────────────
  AD.floatEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    AD.showContextMenu(e.clientX, e.clientY);
  });

  document.body.appendChild(AD.floatEl);
}

// ═══════════════════════════════════════════════
// 挂断悬浮按钮（椭圆 + "挂断"文字 + 主题化 + 左下角拖拽缩放）
// ═══════════════════════════════════════════════
AD.hangupEl = null;
AD.hangupResizeHandle = null; // 左下角缩放手柄
let hangupSize = parseInt(localStorage.getItem('__ad_hangup_size') || '48', 10);
const HANGUP_MIN = 36, HANGUP_MAX = 100;

function createHangupBtn() {
  if (document.getElementById('__ad_hangup')) return;
  const t = AD.T();

  AD.hangupEl = document.createElement('div');
  AD.hangupEl.id = '__ad_hangup';
  applyHangupSize(hangupSize);

  Object.assign(AD.hangupEl.style, {
    position: 'fixed',
    right: '20px',
    top: '140px',
    zIndex: '2147483646',
    borderRadius: '20px',
    background: t.bg2,
    boxShadow: `0 4px 14px ${t.accent}1F`,
    cursor: 'pointer',
    userSelect: 'none',
    display: 'flex',  // 始终显示
    alignItems: 'center',
    justifyContent: 'center',
    gap: '5px',
    transition: 'box-shadow .2s, background .2s',
    color: t.red,
    fontWeight: '700',
    letterSpacing: '1px',
    border: `1px solid ${t.red}55`,
  });
  // 用 span 包内容（图标 + 文字），文字单独 span 供 flash 更新
  const hangupLabel = document.createElement('span');
  hangupLabel.innerHTML = AD.adIcon('phoneX', 13) + '<span class="__ad_hangup_text">挂断</span>';
  hangupLabel.style.pointerEvents = 'none';
  hangupLabel.style.display = 'inline-flex';
  hangupLabel.style.alignItems = 'center';
  hangupLabel.style.gap = '5px';
  AD.hangupEl.appendChild(hangupLabel);

  // ─── 点击挂断 ────────────────────────────────
  AD.hangupEl.addEventListener('click', (e) => {
    const dist = Math.hypot(e.clientX - hDragStartX, e.clientY - hDragStartY);
    if (dist > 5) return;
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'hangup' }, (resp) => {
      if (chrome.runtime.lastError) {
        flashHangup('PC端未运行', false);
        return;
      }
      if (resp && resp.success) {
        flashHangup('已挂断', true);
        // 挂断后 2 秒隐藏按钮
        clearTimeout(window.__ad_hangup_timer);
        window.__ad_hangup_timer = setTimeout(() => {
          if (AD.hangupEl) AD.hangupEl.style.display = 'none';
        }, 2000);
      }
      else flashHangup(resp?.error || '挂断失败', false);
    });
  });

  // ─── 右键菜单（同拨号按钮） ──────────────────
  AD.hangupEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    AD.showContextMenu(e.clientX, e.clientY);
  });

  // ─── 拖动（仅左右边缘启动，中间区域点击挂断） ───
  let hDragging = false, hDragStartX = 0, hDragStartY = 0, hOx = 0, hOy = 0;
  const HANGUP_DRAG_EDGE = 0.18;
  AD.hangupEl.addEventListener('pointerdown', (e) => {
    if (AD.hangupResizeHandle && e.target === AD.hangupResizeHandle) return;
    hDragStartX = e.clientX;
    hDragStartY = e.clientY;
    const r = AD.hangupEl.getBoundingClientRect();
    const xRatio = (e.clientX - r.left) / r.width;
    if (xRatio > HANGUP_DRAG_EDGE && xRatio < (1 - HANGUP_DRAG_EDGE)) return;
    hDragging = true;
    hOx = e.clientX - r.left;
    hOy = e.clientY - r.top;
    AD.hangupEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  AD.hangupEl.addEventListener('pointermove', (e) => {
    if (!hDragging) return;
    AD.hangupEl.style.left = (e.clientX - hOx) + 'px';
    AD.hangupEl.style.top = (e.clientY - hOy) + 'px';
    AD.hangupEl.style.right = 'auto';
    AD.hangupEl.style.bottom = 'auto';
  });
  AD.hangupEl.addEventListener('pointerup', () => { hDragging = false; });

  // ─── 左下角缩放手柄 ─────────────────────────
  AD.hangupResizeHandle = document.createElement('div');
  Object.assign(AD.hangupResizeHandle.style, {
    position: 'absolute',
    left: '0px',
    bottom: '0px',
    width: '14px',
    height: '14px',
    cursor: 'nwse-resize',
    zIndex: '1',
    // 用三角形视觉提示（红色系，与挂断语义一致）
    background: `linear-gradient(135deg, ${t.red}55 50%, transparent 50%)`,
    borderRadius: '0 0 0 4px',
    opacity: '0.6',
    transition: 'opacity .15s',
  });
  // hover 时手柄更明显
  AD.hangupResizeHandle.addEventListener('mouseenter', () => {
    AD.hangupResizeHandle.style.opacity = '1';
  });
  AD.hangupResizeHandle.addEventListener('mouseleave', () => {
    AD.hangupResizeHandle.style.opacity = '0.6';
  });

  // 缩放拖拽逻辑
  let resizing = false, resizeStartX = 0, resizeStartSize = 0;
  AD.hangupResizeHandle.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    resizing = true;
    resizeStartX = e.clientX;
    resizeStartSize = hangupSize;
    AD.hangupResizeHandle.setPointerCapture(e.pointerId);
  });
  AD.hangupResizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const dx = resizeStartX - e.clientX;
    const newSize = Math.min(HANGUP_MAX, Math.max(HANGUP_MIN, resizeStartSize + dx));
    if (newSize !== hangupSize) {
      hangupSize = newSize;
      localStorage.setItem('__ad_hangup_size', hangupSize);
      applyHangupSize(hangupSize);
    }
  });
  AD.hangupResizeHandle.addEventListener('pointerup', () => { resizing = false; });

  AD.hangupEl.appendChild(AD.hangupResizeHandle);
  document.body.appendChild(AD.hangupEl);
}

function applyHangupSize(size) {
  if (!AD.hangupEl) return;
  // 椭圆形：宽 = size * 2.0，高 = size * 0.72（扁椭圆，上下不宽）
  const w = Math.round(size * 2.0);
  const h = Math.round(size * 0.72);
  AD.hangupEl.style.width = w + 'px';
  AD.hangupEl.style.height = h + 'px';
  AD.hangupEl.style.fontSize = Math.round(h * 0.45) + 'px';
  AD.hangupEl.style.borderRadius = Math.round(h * 0.45) + 'px';
}

function flashHangup(text, ok) {
  if (!AD.hangupEl) return;
  const t = AD.T();
  const h = Math.round(hangupSize * 0.72);
  const label = AD.hangupEl.querySelector('.__ad_hangup_text');
  if (label) label.textContent = text;
  AD.hangupEl.style.fontSize = Math.round(h * 0.38) + 'px';
  AD.hangupEl.style.background = t.gradRed; // 挂断按钮点击后始终显示红色
  AD.hangupEl.style.color = '#FFFFFF';
  AD.hangupEl.style.border = '1px solid transparent';
  setTimeout(() => {
    if (label) label.textContent = '挂断';
    AD.hangupEl.style.fontSize = Math.round(h * 0.45) + 'px';
    AD.hangupEl.style.background = t.bg2; // 恢复主题卡片色
    AD.hangupEl.style.color = t.red;
    AD.hangupEl.style.border = `1px solid ${t.red}55`;
  }, 1800);
}

// ═══════════════════════════════════════════════
// 手动拨号悬浮条（独立于自动检测按钮，隐藏式）
// 输入框 + 粘贴按钮 + 拨号按钮
// ═══════════════════════════════════════════════
AD.manualDialBar = null;

function createManualDial() {
  if (document.getElementById('__ad_manual')) return;
  const t = AD.T();

  AD.manualDialBar = document.createElement('div');
  AD.manualDialBar.id = '__ad_manual';
  Object.assign(AD.manualDialBar.style, {
    position: 'fixed',
    right: '20px',
    bottom: '80px',
    zIndex: '2147483645',
    display: 'none',  // 默认隐藏，右键菜单切换
    alignItems: 'center',
    gap: '8px',
    padding: '8px',
    background: t.bg2,
    borderRadius: '14px',
    boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
    border: `1px solid ${t.accent}33`,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    backdropFilter: 'blur(16px)',
    transition: 'opacity .18s ease, transform .18s ease',
  });

  // ── 输入框 ──
  const input = document.createElement('input');
  input.type = 'tel';  // 移动端弹出数字键盘
  input.placeholder = '输入号码';
  input.autocomplete = 'off';
  Object.assign(input.style, {
    width: '140px',
    height: '34px',
    padding: '0 10px',
    fontSize: '14px',
    fontWeight: '500',
    letterSpacing: '1px',
    color: t.text,
    background: t.bg3,
    border: `1px solid ${t.accent}33`,
    borderRadius: '10px',
    outline: 'none',
    textAlign: 'center',
    transition: 'border-color .15s, box-shadow .15s',
  });
  input.addEventListener('focus', () => {
    const c = AD.T();
    input.style.borderColor = c.accent;
    input.style.boxShadow = `0 0 0 3px ${c.accent}26`;
  });
  input.addEventListener('blur', () => {
    input.style.borderColor = AD.T().accent + '33';
    input.style.boxShadow = 'none';
  });
  // 回车直接拨号
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualDial();
  });
  AD.manualDialBar.appendChild(input);

  // ── 清空按钮 ──
  const pasteBtn = document.createElement('button');
  pasteBtn.className = '__ad_manual_paste';
  pasteBtn.textContent = '清空';
  Object.assign(pasteBtn.style, {
    height: '34px',
    padding: '0 12px',
    fontSize: '13px',
    fontWeight: '600',
    color: t.text2,
    background: 'transparent',
    border: `1px solid ${t.accent}44`,
    borderRadius: '10px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'opacity .15s, background .15s',
  });
  pasteBtn.addEventListener('click', () => {
    input.value = '';
    input.focus();
  });
  pasteBtn.addEventListener('mouseenter', () => { pasteBtn.style.opacity = '0.8'; });
  pasteBtn.addEventListener('mouseleave', () => { pasteBtn.style.opacity = '1'; });
  AD.manualDialBar.appendChild(pasteBtn);

  // ── 拨号按钮 ──
  const dialBtn = document.createElement('button');
  dialBtn.className = '__ad_manual_dial';
  dialBtn.textContent = '拨号';
  Object.assign(dialBtn.style, {
    height: '34px',
    padding: '0 16px',
    fontSize: '13px',
    fontWeight: '700',
    color: '#FFFFFF',
    background: t.gradAccent,
    border: 'none',
    borderRadius: '10px',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    transition: 'opacity .15s',
  });
  dialBtn.addEventListener('click', manualDial);
  dialBtn.addEventListener('mouseenter', () => { dialBtn.style.opacity = '0.85'; });
  dialBtn.addEventListener('mouseleave', () => { dialBtn.style.opacity = '1'; });
  AD.manualDialBar.appendChild(dialBtn);

  document.body.appendChild(AD.manualDialBar);
}

function manualDial() {
  if (!AD.manualDialBar) return;
  const input = AD.manualDialBar.querySelector('input');
  const number = (input?.value || '').trim();
  if (!number) return;
  chrome.runtime.sendMessage({ type: 'dial', phone: number });
}

function toggleManualDial() {
  if (!AD.manualDialBar) return;
  const showing = AD.manualDialBar.style.display !== 'none';
  if (showing) {
    AD.manualDialBar.style.display = 'none';
  } else {
    AD.manualDialBar.style.display = 'flex';
    AD.manualDialBar.style.opacity = '0';
    AD.manualDialBar.style.transform = 'translateY(6px)';
    requestAnimationFrame(() => {
      AD.manualDialBar.style.opacity = '1';
      AD.manualDialBar.style.transform = 'translateY(0)';
    });
  }
}

function updatePhone(phone) {
  AD.currentPhone = phone || null;
  window.__adPhone = AD.currentPhone;
  // v4.15: 记录最近一次收到号码的时间，供"残留号码保鲜检查"使用
  if (AD.currentPhone) window.__adLastPhoneAt = Date.now();
  // v4.15: 号码清空时同步清除残留的客户姓名，防止"张三 + 李四的号码"错配登记
  if (!AD.currentPhone) window.__adCustomerName = '';
  if (!AD.floatEl) return;
  const t = AD.T();
  const label = document.getElementById('__ad_dial_label');
  if (label) label.innerHTML = AD.adIcon('phone', 15) + '<span>' + (AD.currentPhone ? AD.escHtml(AD.currentPhone) : '等待号码...') + '</span>';
  if (AD.currentPhone) {
    AD.floatEl.style.background = t.gradAccent;
    AD.floatEl.style.color = t.textOnAccent || t.text;
    AD.floatEl.style.boxShadow = `0 6px 20px ${t.accent}59`;
  } else {
    AD.floatEl.style.background = t.bg2;
    AD.floatEl.style.color = t.text;
    AD.floatEl.style.boxShadow = `0 4px 14px ${t.accent}1F`;
  }
  // v4.15: 检测到新号码时恢复挂断按钮——此前挂断成功一次后永久消失，直到刷新页面
  const hu = document.getElementById('__ad_hangup');
  if (hu && hu.style.display === 'none') hu.style.display = 'flex';
}

function flashFloat(text, ok) {
  if (!AD.floatEl) return;
  const t = AD.T();
  const label = document.getElementById('__ad_dial_label');
  // v4.15: ok=undefined 表示"进行中"中性态；失败态不再 1 秒消失——
  // 业务员正看客户资料很容易错过红闪，误以为已拨出（ customer 永远等不到电话）
  if (label) label.innerHTML = AD.adIcon('phone', 15) + '<span>' + (ok === false ? '✗ ' : (ok === true ? '✓ ' : '')) + AD.escHtml(text) + '</span>';
  if (ok === true) {
    AD.floatEl.style.background = t.gradGreen;
    AD.floatEl.style.color = '#FFFFFF';
    AD.floatEl.style.boxShadow = `0 6px 20px ${t.green}55`;
  } else if (ok === false) {
    AD.floatEl.style.background = t.gradRed;
    AD.floatEl.style.color = '#FFFFFF';
    AD.floatEl.style.boxShadow = `0 6px 20px ${t.red}55`;
  } else {
    AD.floatEl.style.background = t.bg2;
    AD.floatEl.style.color = t.text;
    AD.floatEl.style.boxShadow = `0 4px 14px ${t.accent}1F`;
  }
  // 清理旧定时器，防止闪烁冲突
  clearTimeout(window.__ad_flash_timer);
  const token = (window.__ad_flash_seq = (window.__ad_flash_seq || 0) + 1);
  if (ok === true) {
    // 成功 2.5 秒恢复
    window.__ad_flash_timer = setTimeout(() => {
      if (token === window.__ad_flash_seq) restoreFloatLabel(t);
    }, 2500);
  } else if (ok === undefined) {
    // 中性态 10 秒兜底恢复（结果一直没回来时）
    window.__ad_flash_timer = setTimeout(() => {
      if (token === window.__ad_flash_seq) restoreFloatLabel(t);
    }, 10000);
  }
  // 失败态（ok===false）保持到下次操作或号码变化，由 updatePhone/下次 flashFloat 清除
}

function restoreFloatLabel(t) {
  const lb = document.getElementById('__ad_dial_label');
  if (lb) lb.innerHTML = AD.adIcon('phone', 15) + '<span>' + (AD.currentPhone ? AD.escHtml(AD.currentPhone) : '等待号码...') + '</span>';
  AD.floatEl.style.background = AD.currentPhone ? t.gradAccent : t.bg2;
  AD.floatEl.style.color = AD.currentPhone ? (t.textOnAccent || t.text) : t.text;
  AD.floatEl.style.boxShadow = AD.currentPhone
    ? `0 6px 20px ${t.accent}59`
    : `0 4px 14px ${t.accent}1F`;
}

  /* ---------- 对外出口（供 content-script.js / 后续 cs-30~70 模块调用）---------- */
  AD.createFloat = createFloat;
  AD.createHangupBtn = createHangupBtn;
  AD.applyHangupSize = applyHangupSize;
  AD.flashHangup = flashHangup;
  AD.createManualDial = createManualDial;
  AD.manualDial = manualDial;
  AD.toggleManualDial = toggleManualDial;
  AD.updatePhone = updatePhone;
  AD.flashFloat = flashFloat;
  AD.restoreFloatLabel = restoreFloatLabel;
})(window.__ADCS = window.__ADCS || {});
