/**
 * AutoDial Content Script v4.0
 * 1. 主题系统（参考手机端/PC端16套主题）
 * 2. 拨号悬浮按钮 + 挂断悬浮按钮（均主题化、可拖动）
 * 3. 右键菜单（含 PIN 状态 + 主题切换）
 * 4. 子iframe扫描手机号
 */
(function () {
  'use strict';
  if (window.__adv2) return;
  window.__adv2 = true;

  const isTopFrame = (window === window.top);
  console.log('[AutoDial v4]', isTopFrame ? '顶层页面' : '子iframe', window.location.href);

  // ========== v3: 检测坐席手机号（TreeWalker扫描body前部，<1ms）==========
  // 融鑫汇CRM手机号是裸StaticText节点，在页面顶部，无class/id
  // TreeWalker从body顶部向下扫，第一个命中的手机号就是坐席的
  function getMyPhoneFromCRM() {
    const result = getMyPhoneAndNameFromCRM();
    return result ? result.phone : null;
  }

  /**
   * 从 CRM 页面同时检测坐席手机号和姓名。
   * DOM 结构（已确认）：div.user-name = 姓名，div.user-phone = 手机号。
   * CSS 选择器优先；选择器失效时回退到 TreeWalker 文本扫描。
   */
  function getMyPhoneAndNameFromCRM() {
    // 方式一: CSS 选择器（精确匹配已知 DOM 结构）
    try {
      var phoneEl = document.querySelector('.user-phone');
      var nameEl = document.querySelector('.user-name');
      if (phoneEl) {
        var phoneText = phoneEl.textContent.trim();
        var m = phoneText.match(/1[3-9]\d{9}/);
        if (m) {
          var name = nameEl ? nameEl.textContent.trim() : '';
          return { phone: m[0], name: name };
        }
      }
    } catch(e) {}

    // 方式二: TreeWalker 扫描（兜底，适配未来 DOM 变化）
    var PHONE_RE = /1[3-9]\d{9}/;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var prevText = '';
    while (w.nextNode()) {
      var text = w.currentNode.textContent.trim();
      var m = text.match(PHONE_RE);
      if (m) {
        return { phone: m[0], name: prevText };
      }
      // 记录不含数字、长度2-10的纯文本（可能是姓名）
      if (text && !/\d/.test(text) && text.length >= 2 && text.length <= 10) {
        prevText = text;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // 主题数据（精选8套，适配插件端场景）
  // ═══════════════════════════════════════════════════════════════
  const EXT_THEMES = {
    'dark-gold': {
      name: '暗金', icon: '✦',
      accent: '#C9A84C', accentLight: '#F0C040', accentDark: '#8B6914',
      bg: '#111318', bg2: '#1A1D24', bg3: '#22262F',
      text: '#E8DCC8', text2: '#A09070',
      green: '#2ECC71', red: '#E74C3C',
      gradAccent: 'linear-gradient(135deg,#C9A84C,#8B6914)',
      gradIdle: 'linear-gradient(135deg,#5b5b5b,#333)',
      gradGreen: 'linear-gradient(135deg,#2ECC71,#27AE60)',
      gradRed: 'linear-gradient(135deg,#E74C3C,#C0392B)',
    },
    'cyber-frost': {
      name: '冰蓝冷峻', icon: '❄',
      accent: '#00BCD4', accentLight: '#4DD0E1', accentDark: '#006064',
      bg: '#0A1628', bg2: '#122A45', bg3: '#1A3A5C',
      text: '#E0F0FF', text2: '#7BA3C4',
      green: '#00E676', red: '#FF5252',
      gradAccent: 'linear-gradient(135deg,#00BCD4,#006064)',
      gradIdle: 'linear-gradient(135deg,#1A3A5C,#0A1628)',
      gradGreen: 'linear-gradient(135deg,#00E676,#00C853)',
      gradRed: 'linear-gradient(135deg,#FF5252,#D32F2F)',
    },
    'deep-space': {
      name: '深空紫', icon: '◆',
      accent: '#BB86FC', accentLight: '#DA98FF', accentDark: '#7B1FA2',
      bg: '#0D0A18', bg2: '#18142E', bg3: '#241E42',
      text: '#E8DEFF', text2: '#9575CD',
      green: '#00E676', red: '#FF5252',
      gradAccent: 'linear-gradient(135deg,#BB86FC,#7B1FA2)',
      gradIdle: 'linear-gradient(135deg,#241E42,#0D0A18)',
      gradGreen: 'linear-gradient(135deg,#00E676,#00C853)',
      gradRed: 'linear-gradient(135deg,#FF5252,#C0392B)',
    },
    'cyberpunk': {
      name: '赛博朋克', icon: '⚡',
      accent: '#00FFFF', accentLight: '#80FFFF', accentDark: '#008B8B',
      bg: '#0A0010', bg2: '#150022', bg3: '#220035',
      text: '#F0F0FF', text2: '#8866CC',
      green: '#39FF14', red: '#FF0039',
      gradAccent: 'linear-gradient(135deg,#00FFFF,#008B8B)',
      gradIdle: 'linear-gradient(135deg,#220035,#0A0010)',
      gradGreen: 'linear-gradient(135deg,#39FF14,#00C853)',
      gradRed: 'linear-gradient(135deg,#FF0039,#C0392B)',
    },
    'minimalist': {
      name: '极简白', icon: '○',
      accent: '#888888', accentLight: '#AAAAAA', accentDark: '#666666',
      bg: '#1A1A1A', bg2: '#2A2A2A', bg3: '#3A3A3A',
      text: '#E8E8E8', text2: '#999999',
      green: '#4CAF50', red: '#EF5350',
      gradAccent: 'linear-gradient(135deg,#888888,#666666)',
      gradIdle: 'linear-gradient(135deg,#3A3A3A,#1A1A1A)',
      gradGreen: 'linear-gradient(135deg,#4CAF50,#388E3C)',
      gradRed: 'linear-gradient(135deg,#EF5350,#C62828)',
    },
    'forest-green': {
      name: '森林绿', icon: '♣',
      accent: '#81C784', accentLight: '#A5D6A7', accentDark: '#388E3C',
      bg: '#0E1810', bg2: '#182818', bg3: '#223822',
      text: '#E0F0E0', text2: '#7AA07A',
      green: '#69F0AE', red: '#FF8A80',
      gradAccent: 'linear-gradient(135deg,#81C784,#388E3C)',
      gradIdle: 'linear-gradient(135deg,#223822,#0E1810)',
      gradGreen: 'linear-gradient(135deg,#69F0AE,#00E676)',
      gradRed: 'linear-gradient(135deg,#FF8A80,#E74C3C)',
    },
    'energetic-orange': {
      name: '活力橙', icon: '☀',
      accent: '#FF9800', accentLight: '#FFB74D', accentDark: '#E65100',
      bg: '#1A1510', bg2: '#2A2018', bg3: '#3A2D20',
      text: '#FFF5E6', text2: '#B08D60',
      green: '#66BB6A', red: '#EF5350',
      gradAccent: 'linear-gradient(135deg,#FF9800,#E65100)',
      gradIdle: 'linear-gradient(135deg,#3A2D20,#1A1510)',
      gradGreen: 'linear-gradient(135deg,#66BB6A,#388E3C)',
      gradRed: 'linear-gradient(135deg,#EF5350,#C62828)',
    },
    'ocean-blue': {
      name: '海洋蓝', icon: '◎',
      accent: '#42A5F5', accentLight: '#64B5F6', accentDark: '#1565C0',
      bg: '#0B1424', bg2: '#152238', bg3: '#1E3050',
      text: '#E0ECFF', text2: '#7890B8',
      green: '#00E676', red: '#FF5252',
      gradAccent: 'linear-gradient(135deg,#42A5F5,#1565C0)',
      gradIdle: 'linear-gradient(135deg,#1E3050,#0B1424)',
      gradGreen: 'linear-gradient(135deg,#00E676,#00C853)',
      gradRed: 'linear-gradient(135deg,#FF5252,#C62828)',
    },
  };

  // 当前主题
  let currentThemeId = localStorage.getItem('__ad_theme') || 'dark-gold';
  function T() { return EXT_THEMES[currentThemeId] || EXT_THEMES['dark-gold']; }

  function applyTheme(id) {
    currentThemeId = id;
    localStorage.setItem('__ad_theme', id);
    const t = T();
    // 刷新拨号按钮（完整刷新所有主题相关属性）
    if (floatEl) {
      floatEl.style.background = currentPhone ? t.gradAccent : t.gradIdle;
      floatEl.style.color = t.text;
      floatEl.style.boxShadow = `0 4px 16px ${t.accent}22`;
      floatEl.style.border = `1px solid ${t.accent}33`;
    }
    // 刷新挂断按钮（跟随主题 idle 颜色）
    if (hangupEl) {
      hangupEl.style.background = t.gradIdle;
      hangupEl.style.color = t.text;
      hangupEl.style.boxShadow = `0 2px 10px ${t.accent}33`;
      hangupEl.style.border = `1px solid ${t.accent}33`;
      const label = hangupEl.querySelector('span');
      if (label) label.style.color = t.text;
    }
    // 刷新缩放手柄颜色（用 accent 而非 red）
    if (hangupResizeHandle) {
      hangupResizeHandle.style.background = `linear-gradient(135deg, ${t.accent}66 50%, transparent 50%)`;
    }
    // 刷新右键菜单（如果打开的话）
    hideContextMenu();
    // 刷新手动拨号条主题
    if (manualDialBar) {
      manualDialBar.style.background = t.bg2;
      manualDialBar.style.border = `1px solid ${t.accent}33`;
      manualDialBar.style.boxShadow = `0 4px 16px ${t.accent}22`;
      const input = manualDialBar.querySelector('input');
      if (input) {
        input.style.background = t.bg3;
        input.style.color = t.text;
        input.style.border = `1px solid ${t.accent}33`;
      }
      manualDialBar.querySelectorAll('button').forEach(btn => {
        if (btn.classList.contains('__ad_manual_paste')) {
          btn.style.color = t.text;
          btn.style.border = `1px solid ${t.accent}44`;
          btn.style.background = t.bg3;
        }
        if (btn.classList.contains('__ad_manual_dial')) {
          btn.style.background = t.gradAccent;
        }
      });
    }
    // 广播主题变更给子 iframe，刷新"点击拨打"链接颜色
    if (isTopFrame) {
      try {
        document.querySelectorAll('iframe').forEach(iframe => {
          iframe.contentWindow?.postMessage({ type: '__ad_theme_change', accent: t.accent }, '*');
        });
      } catch (_) {}
    }
  }

  // ═══════════════════════════════════════════════
  // 顶层页面：创建浮动拖动按钮
  // ═══════════════════════════════════════════════
  if (isTopFrame) {
    let floatEl = null;
    let currentPhone = null;

    function createFloat() {
      if (document.getElementById('__ad_float')) return;
      const t = T();

      floatEl = document.createElement('div');
      floatEl.id = '__ad_float';
      Object.assign(floatEl.style, {
        position: 'fixed',
        right: '20px',
        top: '370px',
        zIndex: '2147483647',
        padding: '10px 20px',
        fontSize: '13px',
        fontWeight: '600',
        color: t.text,
        background: t.gradIdle,
        borderRadius: '24px',
        boxShadow: `0 4px 16px ${t.accent}22`,
        cursor: 'grab',
        userSelect: 'none',
        transition: 'background .2s, box-shadow .2s',
        whiteSpace: 'nowrap',
        letterSpacing: '0.5px',
        border: `1px solid ${t.accent}33`,
      });
      // 用 span 包文字，避免 textContent 覆盖子元素
      const dialLabel = document.createElement('span');
      dialLabel.id = '__ad_dial_label';
      dialLabel.textContent = '📞 等待号码...';
      dialLabel.style.pointerEvents = 'none'; // 不拦截指针事件，让父元素处理
      floatEl.appendChild(dialLabel);

      // ─── 拖动（仅左右边缘启动，中间区域点击拨号） ────
      let dragging = false, dragStartX = 0, dragStartY = 0, ox = 0, oy = 0;
      const DRAG_EDGE = 0.18; // 左右各 18% 为拖动区域
      floatEl.addEventListener('pointerdown', (e) => {
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        const r = floatEl.getBoundingClientRect();
        const xRatio = (e.clientX - r.left) / r.width;
        // 中间区域（号码/表情）：不启动拖动，允许 click 正常触发
        if (xRatio > DRAG_EDGE && xRatio < (1 - DRAG_EDGE)) return;
        dragging = true;
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        floatEl.setPointerCapture(e.pointerId);
        floatEl.style.cursor = 'grabbing';
        e.preventDefault();
      });
      floatEl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        floatEl.style.left = (e.clientX - ox) + 'px';
        floatEl.style.top = (e.clientY - oy) + 'px';
        floatEl.style.right = 'auto';
        floatEl.style.bottom = 'auto';
      });
      floatEl.addEventListener('pointerup', () => {
        dragging = false;
        floatEl.style.cursor = 'grab';
      });

      // ─── 点击拨号 ────────────────────────────────
      floatEl.addEventListener('click', (e) => {
        // 比较按下和抬起的位置，超过 5px 视为拖动，不触发拨号
        const dist = Math.hypot(e.clientX - dragStartX, e.clientY - dragStartY);
        if (dist > 5) return;
        if (!currentPhone) {
          flashFloat('未检测到号码', false);
          return;
        }
        chrome.runtime.sendMessage({ type: 'dial', phone: currentPhone });
      });

      // ─── 右键菜单 ────────────────────────────────
      floatEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY);
      });

      document.body.appendChild(floatEl);
    }

    // ═══════════════════════════════════════════════
    // 挂断悬浮按钮（椭圆 + "挂断"文字 + 主题化 + 左下角拖拽缩放）
    // ═══════════════════════════════════════════════
    let hangupEl = null;
    let hangupResizeHandle = null; // 左下角缩放手柄
    let hangupSize = parseInt(localStorage.getItem('__ad_hangup_size') || '48', 10);
    const HANGUP_MIN = 36, HANGUP_MAX = 100;

    function createHangupBtn() {
      if (document.getElementById('__ad_hangup')) return;
      const t = T();

      hangupEl = document.createElement('div');
      hangupEl.id = '__ad_hangup';
      applyHangupSize(hangupSize);

      Object.assign(hangupEl.style, {
        position: 'fixed',
        right: '20px',
        top: '140px',
        zIndex: '2147483646',
        borderRadius: '20px',
        background: t.gradIdle,
        boxShadow: `0 2px 10px ${t.accent}33`,
        cursor: 'pointer',
        userSelect: 'none',
        display: 'flex',  // 始终显示
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'box-shadow .2s, background .2s',
        color: t.text,
        fontWeight: '700',
        letterSpacing: '1px',
        border: `1px solid ${t.accent}33`,
      });
      // 用 span 包文字，避免 textContent 覆盖手柄子元素
      const hangupLabel = document.createElement('span');
      hangupLabel.textContent = '挂断';
      hangupLabel.style.pointerEvents = 'none';
      hangupEl.appendChild(hangupLabel);

      // ─── 点击挂断 ────────────────────────────────
      hangupEl.addEventListener('click', (e) => {
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
              if (hangupEl) hangupEl.style.display = 'none';
            }, 2000);
          }
          else flashHangup(resp?.error || '挂断失败', false);
        });
      });

      // ─── 右键菜单（同拨号按钮） ──────────────────
      hangupEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY);
      });

      // ─── 拖动（仅左右边缘启动，中间区域点击挂断） ───
      let hDragging = false, hDragStartX = 0, hDragStartY = 0, hOx = 0, hOy = 0;
      const HANGUP_DRAG_EDGE = 0.18;
      hangupEl.addEventListener('pointerdown', (e) => {
        if (hangupResizeHandle && e.target === hangupResizeHandle) return;
        hDragStartX = e.clientX;
        hDragStartY = e.clientY;
        const r = hangupEl.getBoundingClientRect();
        const xRatio = (e.clientX - r.left) / r.width;
        if (xRatio > HANGUP_DRAG_EDGE && xRatio < (1 - HANGUP_DRAG_EDGE)) return;
        hDragging = true;
        hOx = e.clientX - r.left;
        hOy = e.clientY - r.top;
        hangupEl.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      hangupEl.addEventListener('pointermove', (e) => {
        if (!hDragging) return;
        hangupEl.style.left = (e.clientX - hOx) + 'px';
        hangupEl.style.top = (e.clientY - hOy) + 'px';
        hangupEl.style.right = 'auto';
        hangupEl.style.bottom = 'auto';
      });
      hangupEl.addEventListener('pointerup', () => { hDragging = false; });

      // ─── 左下角缩放手柄 ─────────────────────────
      hangupResizeHandle = document.createElement('div');
      Object.assign(hangupResizeHandle.style, {
        position: 'absolute',
        left: '0px',
        bottom: '0px',
        width: '14px',
        height: '14px',
        cursor: 'nwse-resize',
        zIndex: '1',
        // 用三角形视觉提示
        background: `linear-gradient(135deg, ${t.accent}66 50%, transparent 50%)`,
        borderRadius: '0 0 0 4px',
        opacity: '0.6',
        transition: 'opacity .15s',
      });
      // hover 时手柄更明显
      hangupResizeHandle.addEventListener('mouseenter', () => {
        hangupResizeHandle.style.opacity = '1';
      });
      hangupResizeHandle.addEventListener('mouseleave', () => {
        hangupResizeHandle.style.opacity = '0.6';
      });

      // 缩放拖拽逻辑
      let resizing = false, resizeStartX = 0, resizeStartSize = 0;
      hangupResizeHandle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        resizing = true;
        resizeStartX = e.clientX;
        resizeStartSize = hangupSize;
        hangupResizeHandle.setPointerCapture(e.pointerId);
      });
      hangupResizeHandle.addEventListener('pointermove', (e) => {
        if (!resizing) return;
        const dx = resizeStartX - e.clientX;
        const newSize = Math.min(HANGUP_MAX, Math.max(HANGUP_MIN, resizeStartSize + dx));
        if (newSize !== hangupSize) {
          hangupSize = newSize;
          localStorage.setItem('__ad_hangup_size', hangupSize);
          applyHangupSize(hangupSize);
        }
      });
      hangupResizeHandle.addEventListener('pointerup', () => { resizing = false; });

      hangupEl.appendChild(hangupResizeHandle);
      document.body.appendChild(hangupEl);
    }

    function applyHangupSize(size) {
      if (!hangupEl) return;
      // 椭圆形：宽 = size * 2.0，高 = size * 0.72（扁椭圆，上下不宽）
      const w = Math.round(size * 2.0);
      const h = Math.round(size * 0.72);
      hangupEl.style.width = w + 'px';
      hangupEl.style.height = h + 'px';
      hangupEl.style.fontSize = Math.round(h * 0.45) + 'px';
      hangupEl.style.borderRadius = Math.round(h * 0.45) + 'px';
    }

    function flashHangup(text, ok) {
      if (!hangupEl) return;
      const t = T();
      const h = Math.round(hangupSize * 0.72);
      const label = hangupEl.querySelector('span');
      if (label) label.textContent = text;
      hangupEl.style.fontSize = Math.round(h * 0.38) + 'px';
      hangupEl.style.background = t.gradRed; // 挂断按钮点击后始终显示红色
      setTimeout(() => {
        if (label) label.textContent = '挂断';
        hangupEl.style.fontSize = Math.round(h * 0.45) + 'px';
        hangupEl.style.background = t.gradIdle; // 恢复主题色
      }, 1800);
    }

    // ═══════════════════════════════════════════════
    // 手动拨号悬浮条（独立于自动检测按钮，隐藏式）
    // 输入框 + 粘贴按钮 + 拨号按钮
    // ═══════════════════════════════════════════════
    let manualDialBar = null;

    function createManualDial() {
      if (document.getElementById('__ad_manual')) return;
      const t = T();

      manualDialBar = document.createElement('div');
      manualDialBar.id = '__ad_manual';
      Object.assign(manualDialBar.style, {
        position: 'fixed',
        right: '20px',
        bottom: '80px',
        zIndex: '2147483645',
        display: 'none',  // 默认隐藏，右键菜单切换
        alignItems: 'center',
        gap: '6px',
        padding: '6px 8px',
        background: t.bg2,
        borderRadius: '12px',
        boxShadow: `0 4px 16px ${t.accent}22`,
        border: `1px solid ${t.accent}33`,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      });

      // ── 输入框 ──
      const input = document.createElement('input');
      input.type = 'tel';  // 移动端弹出数字键盘
      input.placeholder = '输入号码';
      input.autocomplete = 'off';
      Object.assign(input.style, {
        width: '140px',
        padding: '6px 10px',
        fontSize: '14px',
        fontWeight: '500',
        letterSpacing: '1px',
        color: t.text,
        background: t.bg3,
        border: `1px solid ${t.accent}33`,
        borderRadius: '8px',
        outline: 'none',
        textAlign: 'center',
      });
      // 回车直接拨号
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') manualDial();
      });
      manualDialBar.appendChild(input);

      // ── 清空按钮 ──
      const pasteBtn = document.createElement('button');
      pasteBtn.className = '__ad_manual_paste';
      pasteBtn.textContent = '清空';
      Object.assign(pasteBtn.style, {
        padding: '6px 12px',
        fontSize: '13px',
        fontWeight: '600',
        color: t.text,
        background: t.bg3,
        border: `1px solid ${t.accent}44`,
        borderRadius: '8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'opacity .15s',
      });
      pasteBtn.addEventListener('click', () => {
        input.value = '';
        input.focus();
      });
      pasteBtn.addEventListener('mouseenter', () => { pasteBtn.style.opacity = '0.8'; });
      pasteBtn.addEventListener('mouseleave', () => { pasteBtn.style.opacity = '1'; });
      manualDialBar.appendChild(pasteBtn);

      // ── 拨号按钮 ──
      const dialBtn = document.createElement('button');
      dialBtn.className = '__ad_manual_dial';
      dialBtn.textContent = '拨号';
      Object.assign(dialBtn.style, {
        padding: '6px 14px',
        fontSize: '13px',
        fontWeight: '700',
        color: t.bg,
        background: t.gradAccent,
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        transition: 'opacity .15s',
      });
      dialBtn.addEventListener('click', manualDial);
      dialBtn.addEventListener('mouseenter', () => { dialBtn.style.opacity = '0.85'; });
      dialBtn.addEventListener('mouseleave', () => { dialBtn.style.opacity = '1'; });
      manualDialBar.appendChild(dialBtn);

      document.body.appendChild(manualDialBar);
    }

    function manualDial() {
      if (!manualDialBar) return;
      const input = manualDialBar.querySelector('input');
      const number = (input?.value || '').trim();
      if (!number) return;
      chrome.runtime.sendMessage({ type: 'dial', phone: number });
    }

    function toggleManualDial() {
      if (!manualDialBar) return;
      const showing = manualDialBar.style.display !== 'none';
      manualDialBar.style.display = showing ? 'none' : 'flex';
    }

    // ─── 自定义右键菜单 ──────────────────────────────
    let contextMenu = null;
    let _ctxMousedownHandler = null;

    function showContextMenu(x, y) {
      hideContextMenu();
      const t = T();

      // 全屏透明遮罩层：负责捕获菜单外的所有点击
      const overlay = document.createElement('div');
      overlay.id = '__ad_ctxmenu_overlay';
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483646', // 比菜单低 1
        cursor: 'default',
      });
      overlay.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideContextMenu();
      });
      overlay.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideContextMenu();
      });
      document.body.appendChild(overlay);

      contextMenu = document.createElement('div');
      contextMenu.id = '__ad_ctxmenu';
      Object.assign(contextMenu.style, {
        position: 'fixed',
        left: x + 'px',
        top: y + 'px',
        zIndex: '2147483647',
        background: t.bg2,
        borderRadius: '10px',
        boxShadow: `0 4px 20px ${t.accent}22, 0 0 0 1px ${t.accent}33`,
        padding: '4px 0',
        minWidth: '220px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        color: t.text,
        overflow: 'hidden',
        backdropFilter: 'blur(16px)',
      });

      const items = [
        { label: '🖥 打开电脑端主界面', action: openDesktopApp },
        { label: '📋 显示/隐藏悬浮窗', action: toggleFloatbar },
        { type: 'separator' },
        { label: currentPhone ? '📞 拨打 ' + currentPhone : '📞 拨号（未检测号码）', action: () => {
          if (!currentPhone) { flashFloat('未检测到号码', false); return; }
          chrome.runtime.sendMessage({ type: 'dial', phone: currentPhone });
        }},
        { label: currentPhone ? '💬 发短信 ' + currentPhone : '💬 发短信（未检测号码）', action: () => {
          if (!currentPhone) { flashFloat('未检测到号码', false); return; }
          sendSms(currentPhone);
        }},
        { label: (function() {
          var custName = window.__adCustomerName || '';
          var custPhone = window.__adPhone || '';
          return custPhone && custName ? '📝 一键登记 ' + custName + ' ' + custPhone : '📝 一键登记（未检测客户）';
        })(), action: () => {
          var custName = window.__adCustomerName || '';
          var custPhone = window.__adPhone || currentPhone || '';
          if (!custPhone || !custName) { flashFloat('未检测到客户信息', false); return; }
          showRegisterConfirm(custName, custPhone);
        }},
        { type: 'separator' },
        { label: '🎨 切换主题', action: showThemeMenu },
        { label: '📱 手动拨号', action: toggleManualDial },
        { label: '⚙ 设置', action: showSettingsDialog },
        { type: 'separator' },
        { type: 'account' },  // 占位，渲染时异步填充当前登录账号
        { label: '✕ 关闭菜单', action: () => {} },
      ];

      items.forEach(item => {
        if (item.type === 'separator') {
          const sep = document.createElement('div');
          Object.assign(sep.style, { height: '1px', background: t.accent + '22', margin: '4px 8px' });
          contextMenu.appendChild(sep);
          return;
        }
        if (item.type === 'account') {
          const row = document.createElement('div');
          row.style.cssText = 'padding:8px 14px;white-space:nowrap;font-size:12px;';
          row.textContent = '👤 加载中...';
          contextMenu.appendChild(row);
          // PIN 模式：显示自动检测的坐席号 + PC 状态
          chrome.storage.local.get(['self_phone', 'pin'], (s) => {
            const phone = s.pin || s.self_phone;
            if (phone) {
              row.textContent = '👤 PIN: ' + phone;
              row.style.color = t.text2;
              row.style.cursor = 'default';
              // 异步查 PC 状态
              chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
                if (status && status.pcAlive === true) {
                  const pcRow = document.createElement('div');
                  pcRow.style.cssText = 'padding:0 14px 6px 14px;font-size:11px;color:' + t.text2 + ';';
                  pcRow.textContent = 'PIN 已就绪，PC 在线';
                  row.parentNode.insertBefore(pcRow, row.nextSibling);
                }
              });
            } else {
              row.textContent = '⚡ 未检测到坐席号';
              row.style.color = t.red;
              row.style.fontWeight = '600';
              row.style.cursor = 'pointer';
              row.addEventListener('mouseenter', () => { row.style.background = t.accent + '18'; });
              row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
              row.addEventListener('click', (e) => { e.stopPropagation(); hideContextMenu(); detectPin(); });
            }
          });
          return;
        }
        const row = document.createElement('div');
        Object.assign(row.style, {
          padding: '8px 14px',
          cursor: 'pointer',
          transition: 'background .15s',
          whiteSpace: 'nowrap',
        });
        row.textContent = item.label;
        row.addEventListener('mouseenter', () => { row.style.background = t.accent + '18'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          hideContextMenu();
          item.action();
        });
        contextMenu.appendChild(row);
      });

      document.body.appendChild(contextMenu);

      requestAnimationFrame(() => {
        const rect = contextMenu.getBoundingClientRect();
        if (rect.right > window.innerWidth) contextMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
        if (rect.bottom > window.innerHeight) contextMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
        if (rect.left < 0) contextMenu.style.left = '8px';
        if (rect.top < 0) contextMenu.style.top = '8px';
      });

      _ctxMousedownHandler = (e) => {
        const menu = document.getElementById('__ad_ctxmenu');
        if (menu && !menu.contains(e.target)) {
          hideContextMenu();
        }
      };
      // 用 setTimeout 延迟一帧注册，避免与当前右键事件冲突
      setTimeout(() => {
        document.addEventListener('mousedown', _ctxMousedownHandler, true);
      }, 0);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); }, { once: true });
    }

    function hideContextMenu() {
      // 移除遮罩层
      const overlay = document.getElementById('__ad_ctxmenu_overlay');
      if (overlay) overlay.remove();
      // 移除菜单
      const el = document.getElementById('__ad_ctxmenu');
      if (el) el.remove();
      contextMenu = null;
    }

    // ─── 获取当前位置（右键菜单"获取当前位置"） ───
    function showPosition() {
      const t = T();
      const tip = document.createElement('div');
      tip.id = '__ad_position_tip';
      Object.assign(tip.style, {
        position: 'fixed',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)',
        zIndex: '2147483647',
        background: t.bg2,
        color: t.text,
        borderRadius: '10px',
        boxShadow: `0 4px 20px ${t.accent}44, 0 0 0 1px ${t.accent}44`,
        padding: '16px 20px',
        fontFamily: 'monospace, system-ui',
        fontSize: '13px',
        lineHeight: '1.8',
        minWidth: '280px',
        backdropFilter: 'blur(16px)',
      });

      const title = document.createElement('div');
      title.textContent = '📍 当前按钮位置';
      Object.assign(title.style, { fontWeight: '700', marginBottom: '10px', fontSize: '14px', color: t.accent });
      tip.appendChild(title);

      const lines = [];
      if (floatEl) {
        const r = floatEl.getBoundingClientRect();
        const l = floatEl.style.left || (r.left + 'px');
        const t2 = floatEl.style.top || (r.top + 'px');
        lines.push(`拨号按钮: left=${l}, top=${t2}`);
      }
      if (hangupEl) {
        const r = hangupEl.getBoundingClientRect();
        const l = hangupEl.style.left || (r.left + 'px');
        const t2 = hangupEl.style.top || (r.top + 'px');
        lines.push(`挂断按钮: left=${l}, top=${t2}`);
      }

      lines.forEach(text => {
        const div = document.createElement('div');
        div.textContent = text;
        tip.appendChild(div);
      });

      const copyBtn = document.createElement('button');
      copyBtn.textContent = '📋 复制位置';
      Object.assign(copyBtn.style, {
        marginTop: '12px',
        padding: '6px 14px',
        background: t.gradAccent,
        color: t.bg,
        border: 'none',
        borderRadius: '6px',
        cursor: 'pointer',
        fontWeight: '600',
        fontSize: '12px',
      });
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(lines.join('\n')).then(() => {
          copyBtn.textContent = '✓ 已复制';
          setTimeout(() => { tip.remove(); }, 800);
        });
      };
      tip.appendChild(copyBtn);

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '关闭';
      Object.assign(closeBtn.style, {
        marginTop: '8px',
        marginLeft: '8px',
        padding: '6px 14px',
        background: 'transparent',
        color: t.text2,
        border: `1px solid ${t.accent}44`,
        borderRadius: '6px',
        cursor: 'pointer',
        fontSize: '12px',
      });
      closeBtn.onclick = () => tip.remove();
      tip.appendChild(closeBtn);

      document.body.appendChild(tip);
    }

    // ─── 主题选择子菜单 ──────────────────────────────
    function showThemeMenu() {
      const t = T();
      const menu = document.createElement('div');
      menu.id = '__ad_thememenu';
      Object.assign(menu.style, {
        position: 'fixed',
        right: '20px',
        bottom: '140px',
        zIndex: '2147483647',
        background: t.bg,
        borderRadius: '12px',
        boxShadow: `0 8px 32px ${t.accent}33, 0 0 0 1px ${t.accent}44`,
        padding: '12px',
        width: '200px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '13px',
        color: t.text,
        backdropFilter: 'blur(20px)',
      });

      const title = document.createElement('div');
      Object.assign(title.style, {
        fontSize: '12px',
        color: t.text2,
        marginBottom: '8px',
        fontWeight: '500',
        letterSpacing: '1px',
      });
      title.textContent = '🎨 选择主题';
      menu.appendChild(title);

      // 主题列表
      Object.entries(EXT_THEMES).forEach(([id, theme]) => {
        const row = document.createElement('div');
        const isActive = id === currentThemeId;
        Object.assign(row.style, {
          padding: '8px 10px',
          borderRadius: '8px',
          cursor: isActive ? 'default' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          marginBottom: '2px',
          transition: 'background .15s',
          background: isActive ? theme.accent + '22' : 'transparent',
          borderLeft: isActive ? `3px solid ${theme.accent}` : '3px solid transparent',
        });

        // 色块预览
        const swatch = document.createElement('span');
        Object.assign(swatch.style, {
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: theme.gradAccent,
          display: 'inline-block',
          flexShrink: '0',
          boxShadow: `0 1px 4px ${theme.accent}55`,
        });
        row.appendChild(swatch);

        // 名称
        const label = document.createElement('span');
        label.textContent = theme.icon + ' ' + theme.name;
        label.style.color = isActive ? theme.accent : theme.text;
        label.style.fontWeight = isActive ? '600' : '400';
        row.appendChild(label);

        if (!isActive) {
          row.addEventListener('mouseenter', () => { row.style.background = theme.accent + '12'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
        }

        row.addEventListener('click', () => {
          applyTheme(id);
          document.getElementById('__ad_thememenu')?.remove();
        });

        menu.appendChild(row);
      });

      // 关闭按钮
      const closeRow = document.createElement('div');
      Object.assign(closeRow.style, {
        marginTop: '8px',
        paddingTop: '8px',
        borderTop: `1px solid ${t.accent}22`,
        textAlign: 'center',
        color: t.text2,
        cursor: 'pointer',
        fontSize: '12px',
      });
      closeRow.textContent = '关闭';
      closeRow.addEventListener('click', () => menu.remove());
      menu.appendChild(closeRow);

      document.body.appendChild(menu);

      // 点击外部关闭
      const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          document.removeEventListener('mousedown', closeHandler, true);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', closeHandler, true), 100);
    }

    function showSettingsDialog() {
      const t = T();

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
        borderRadius: '14px',
        boxShadow: `0 12px 48px rgba(0,0,0,0.5), 0 0 0 1px ${t.accent}22`,
        padding: '24px',
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

      // ── 标题 ──
      const title = document.createElement('div');
      title.textContent = '⚙ 设置';
      Object.assign(title.style, {
        fontSize: '17px', fontWeight: '700', marginBottom: '20px',
        color: t.accent, letterSpacing: '0.5px',
      });
      dialog.appendChild(title);

      // ═══════════════════ PIN 区 ═══════════════════
      const pinSection = mkSection('📞 配对码 (PIN)', '4位或11位数字，用于配对和标识');
      dialog.appendChild(pinSection);

      const pinRow = document.createElement('div');
      Object.assign(pinRow.style, { display: 'flex', gap: '8px', marginBottom: '4px' });
      const pinInput = document.createElement('input');
      pinInput.type = 'tel';
      pinInput.maxLength = 11;
      pinInput.placeholder = '4位或11位数字配对码';
      Object.assign(pinInput.style, {
        flex: '1', padding: '10px 12px', fontSize: '15px', fontWeight: '500', letterSpacing: '1px',
        background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '8px',
        color: t.text, outline: 'none', textAlign: 'center',
      });
      pinInput.addEventListener('input', () => { pinInput.value = pinInput.value.replace(/\D/g, ''); });
      pinInput.addEventListener('focus', () => { pinInput.style.borderColor = t.accent; });
      pinInput.addEventListener('blur', () => { pinInput.style.borderColor = t.accent + '33'; });

      const pinSaveBtn = mkBtn('保存', t.gradAccent, t.bg);
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
            pinStatus.textContent = '✓ 已保存'; pinStatus.style.color = '#2ECC71';
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

      // ═══════════════════ 云端服务器区 ═══════════════════
      const srvSection = mkSection('☁ 云端服务器', '默认端口 35430，可保留为空走直连');
      dialog.appendChild(srvSection);

      const srvRow = document.createElement('div');
      Object.assign(srvRow.style, { display: 'flex', gap: '8px', marginBottom: '4px' });
      const srvInput = document.createElement('input');
      srvInput.type = 'text';
      srvInput.placeholder = '例: 262ao85kz470.vicp.fun:55535';
      Object.assign(srvInput.style, {
        flex: '1', padding: '10px 12px', fontSize: '14px',
        background: t.bg3, border: `1px solid ${t.accent}33`, borderRadius: '8px',
        color: t.text, outline: 'none',
      });
      srvInput.addEventListener('focus', () => { srvInput.style.borderColor = t.accent; });
      srvInput.addEventListener('blur', () => { srvInput.style.borderColor = t.accent + '33'; });

      const srvSaveBtn = mkBtn('保存', t.gradAccent, t.bg);
      srvSaveBtn.addEventListener('click', () => {
        chrome.storage.local.set({ cloud_api: srvInput.value.trim() }, () => {
          srvStatus.textContent = '✓ 已保存'; srvStatus.style.color = '#2ECC71';
          setTimeout(() => { srvStatus.textContent = ''; }, 2000);
        });
      });
      srvRow.appendChild(srvInput);
      srvRow.appendChild(srvSaveBtn);
      dialog.appendChild(srvRow);

      const srvStatus = document.createElement('div');
      Object.assign(srvStatus.style, { fontSize: '11px', minHeight: '16px', marginBottom: '8px', paddingLeft: '4px', color: t.text2 });
      dialog.appendChild(srvStatus);

      // 加载当前服务器
      chrome.storage.local.get(['cloud_api'], (s) => {
        srvInput.value = s.cloud_api || '';
      });

      // 按钮行: 测试连接 + 一键获取
      const actionRow = document.createElement('div');
      Object.assign(actionRow.style, { display: 'flex', gap: '8px', marginBottom: '8px' });

      const testBtn = mkBtn('测试连接', t.bg3, t.text, `1px solid ${t.accent}33`);
      testBtn.addEventListener('click', async () => {
        let addr = srvInput.value.trim();
        if (!addr) { srvStatus.textContent = '请输入服务器地址'; srvStatus.style.color = t.red; return; }
        if (!/^https?:\/\//i.test(addr)) addr = 'http://' + addr;
        srvStatus.textContent = '测试中...'; srvStatus.style.color = t.text2;
        try {
          const start = Date.now();
          const r = await fetch(addr + '/health');
          const d = await r.json();
          const ms = Date.now() - start;
          if (d.service) {
            srvStatus.textContent = `✓ 连接成功 (${ms}ms)`; srvStatus.style.color = '#2ECC71';
          } else {
            srvStatus.textContent = '✗ 服务异常'; srvStatus.style.color = t.red;
          }
        } catch (_) {
          srvStatus.textContent = '✗ 无法连接'; srvStatus.style.color = t.red;
        }
      });
      actionRow.appendChild(testBtn);

      const fetchBtn = mkBtn('一键获取', t.bg3, t.text, `1px solid ${t.accent}33`);
      fetchBtn.addEventListener('click', async () => {
        srvStatus.textContent = '获取中...'; srvStatus.style.color = t.text2;
        const sources = [
          'https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt',
          'https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt'
        ];
        let servers = [];
        for (const url of sources) {
          try {
            const ctrl = new AbortController();
            setTimeout(() => ctrl.abort(), 8000);
            const r = await fetch(url, { signal: ctrl.signal });
            if (!r.ok) continue;
            const text = await r.text();
            for (let line of text.split('\n')) {
              line = line.trim();
              if (!line || line.startsWith('#') || /^\[.+\]$/.test(line)) continue;
              line = line.replace(/新云端|老云端/g, '').replace(/^(https?|wss?):\/\//i, '').trim();
              if (!line) continue;
              if (!line.includes(':')) line += ':35430';
              servers.push(line);
            }
            if (servers.length > 0) {
              chrome.storage.local.set({ cloud_apis_fetched: servers });
              srvInput.value = servers[0];
              chrome.storage.local.set({ cloud_api: servers[0] });
              srvStatus.textContent = `✓ 获取到 ${servers.length} 个服务器`; srvStatus.style.color = '#2ECC71';
              return;
            }
          } catch (_) { continue; }
        }
        srvStatus.textContent = '获取失败，请检查网络'; srvStatus.style.color = t.red;
      });
      actionRow.appendChild(fetchBtn);
      dialog.appendChild(actionRow);

      // ── 关闭按钮 ──
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '关闭';
      Object.assign(closeBtn.style, {
        display: 'block', margin: '12px auto 0', padding: '8px 32px',
        background: 'transparent', color: t.text2, border: `1px solid ${t.accent}33`,
        borderRadius: '8px', cursor: 'pointer', fontSize: '13px',
      });
      closeBtn.addEventListener('click', closeSettings);
      dialog.appendChild(closeBtn);

      document.body.appendChild(dialog);
    }

    // ── 辅助：区块标题 ──
    function mkSection(icon, subtitle) {
      const t = T();
      const el = document.createElement('div');
      Object.assign(el.style, { marginBottom: '10px' });
      const head = document.createElement('div');
      Object.assign(head.style, { fontSize: '13px', fontWeight: '600', color: t.accent, marginBottom: '2px' });
      head.textContent = icon;
      el.appendChild(head);
      if (subtitle) {
        const sub = document.createElement('div');
        Object.assign(sub.style, { fontSize: '11px', color: t.text2 });
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
        padding: '10px 16px', fontSize: '13px', fontWeight: '600',
        background: bg || 'transparent', color: color || '#fff',
        border: border || 'none', borderRadius: '8px',
        cursor: 'pointer', whiteSpace: 'nowrap', transition: 'opacity .15s',
      });
      btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.8'; });
      btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
      return btn;
    }

    function openDesktopApp() {
      chrome.runtime.sendMessage({ type: 'openDesktop' }, (resp) => {
        if (chrome.runtime.lastError) { flashFloat('PC端未运行', false); return; }
        if (resp && resp.success) flashFloat('已打开主界面', true);
        else flashFloat('打开失败', false);
      });
    }

    function toggleFloatbar() {
      chrome.runtime.sendMessage({ type: 'toggleFloatbar' }, (resp) => {
        if (chrome.runtime.lastError) { flashFloat('PC端未运行', false); return; }
        if (resp && resp.success) flashFloat(resp.visible ? '悬浮窗已显示' : '悬浮窗已隐藏', true);
        else flashFloat('操作失败', false);
      });
    }

    function sendSms(phone) {
      chrome.runtime.sendMessage({ type: 'sendSms', phone }, (resp) => {
        if (chrome.runtime.lastError) { flashFloat('PC端未运行', false); return; }
        if (resp && resp.success) flashFloat('已打开短信窗口', true);
        else flashFloat('打开短信窗口失败', false);
      });
    }

    function updatePhone(phone) {
      currentPhone = phone;
      window.__adPhone = phone;
      if (!floatEl) return;
      const t = T();
      const label = document.getElementById('__ad_dial_label');
      if (label) label.textContent = '📞 ' + phone;
      floatEl.style.background = t.gradAccent;
      floatEl.style.boxShadow = `0 4px 16px ${t.accent}33`;
    }

    function flashFloat(text, ok) {
      if (!floatEl) return;
      const t = T();
      const label = document.getElementById('__ad_dial_label');
      if (label) label.textContent = (ok ? '✓ ' : '✗ ') + text;
      floatEl.style.background = ok ? t.gradGreen : t.gradRed;
      floatEl.style.boxShadow = ok
        ? `0 4px 16px ${t.green}44`
        : `0 4px 16px ${t.red}44`;
      // 清理旧定时器，防止闪烁冲突
      clearTimeout(window.__ad_flash_timer);
      // 成功2.5秒恢复，失败6秒恢复
      window.__ad_flash_timer = setTimeout(() => {
        const lb = document.getElementById('__ad_dial_label');
        if (lb) lb.textContent = currentPhone ? '📞 ' + currentPhone : '📞 等待号码...';
        floatEl.style.background = currentPhone ? t.gradAccent : t.gradIdle;
        floatEl.style.boxShadow = `0 4px 16px ${t.accent}22`;
      }, ok ? 2500 : 1000);
    }

    // ─── Toast 提示 ──────────────────────────────────
    function showToast(text) {
      var old = document.getElementById('__ad_toast');
      if (old) old.remove();
      var t = T();
      var toast = document.createElement('div');
      toast.id = '__ad_toast';
      toast.textContent = text;
      Object.assign(toast.style, {
        position: 'fixed',
        bottom: '40px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        background: t.bg2,
        color: t.text,
        padding: '10px 24px',
        borderRadius: '8px',
        fontSize: '14px',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        border: '1px solid ' + t.accent + '33',
        backdropFilter: 'blur(12px)',
        transition: 'opacity .3s',
      });
      document.body.appendChild(toast);
      setTimeout(function() {
        toast.style.opacity = '0';
        setTimeout(function() { if (toast.parentNode) toast.remove(); }, 300);
      }, 2500);
    }

    // ─── HTML 转义 ──────────────────────────────────
    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ─── 一键登记确认弹窗 ────────────────────────────
    function showRegisterConfirm(name, phone) {
      // 移除已有弹窗
      var old = document.getElementById('autodial-register-overlay');
      if (old) old.remove();

      var pin = window.__adMyPhone || '';
      var mgrName = window.__adMyName || pin; // 优先用自动检测的姓名，兜底用 PIN

      var t = T();
      var overlay = document.createElement('div');
      overlay.id = 'autodial-register-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;' +
        'background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;' +
        'align-items:center;justify-content:center;font-family:sans-serif;';

      overlay.innerHTML = '<div style="background:' + t.bg2 + ';border-radius:12px;padding:24px;' +
        'min-width:300px;max-width:360px;color:' + t.text + ';text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.5);">' +
        '<div style="font-size:16px;font-weight:bold;color:' + t.accentLight + ';margin-bottom:16px;">确认登记客户信息</div>' +
        '<div style="text-align:left;margin-bottom:16px;">' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">客户姓名：</span>' + escHtml(name) + '</div>' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">客户手机号：</span>' + escHtml(phone) + '</div>' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">接待顾问：</span>' + escHtml(mgrName || '未设置') + '</div>' +
        '<div style="margin-bottom:8px;"><span style="color:' + t.text2 + ';">事由：</span>贷款咨询</div>' +
        '</div>' +
        '<div style="display:flex;gap:12px;">' +
        '<button id="autodial-register-cancel" style="flex:1;padding:10px;border:1px solid #444;' +
        'border-radius:8px;background:transparent;color:' + t.text2 + ';cursor:pointer;font-size:14px;">取消</button>' +
        '<button id="autodial-register-confirm" style="flex:1;padding:10px;border:none;' +
        'border-radius:8px;background:' + t.accentLight + ';color:' + t.bg + ';cursor:pointer;font-size:14px;font-weight:bold;">确认登记</button>' +
        '</div></div>';

      document.body.appendChild(overlay);

      document.getElementById('autodial-register-cancel').onclick = function() {
        overlay.remove();
      };
      document.getElementById('autodial-register-confirm').onclick = function() {
        overlay.remove();
        chrome.runtime.sendMessage({
          type: 'registerVisit',
          name: name,
          phone: phone
        }, function(resp) {
          if (resp && resp.success) {
            showToast('✅ 已登记 ' + name);
          } else {
            showToast('✗ 登记失败: ' + (resp ? resp.error : '网络错误'));
          }
        });
      };

      // 点击遮罩关闭
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) overlay.remove();
      });
    }

    // ========== v4: 检测坐席手机号 → 存为 PIN ==========
    let _lastPhone = null;
    let _debounceTimer = null;

    function detectPin() {
      try {
        const result = getMyPhoneAndNameFromCRM();
        if (result && result.phone && result.phone !== _lastPhone) {
          _lastPhone = result.phone;
          window.__adMyPhone = result.phone;
          chrome.storage.local.set({ self_phone: result.phone });
          console.log('[AutoDial v4] 检测到坐席手机号 (PIN):', result.phone);
          chrome.runtime.sendMessage({ type: 'selfPhoneDetected', phone: result.phone, name: result.name || '' });
          // 同步检测并存储经理姓名
          if (result.name) {
            window.__adMyName = result.name;
            chrome.storage.local.set({ manager_name: result.name });
            console.log('[AutoDial v4] 检测到经理姓名:', result.name);
          }
          return true;
        }
      } catch(e) {}
      return false;
    }

    // DOM 就绪后立即检测一次（SPA可能还未渲染，加延迟重试）
    function onDomReady() {
      createFloat();
      createHangupBtn();
      createManualDial();
      // 每次页面加载时检测一次PC状态（后续拨号直接复用缓存）
      chrome.runtime.sendMessage({ type: 'checkPc' });

      if (!detectPin()) {
        // 首次未检出，SPA可能在异步渲染，500ms/1500ms后重试
        setTimeout(() => { if (!detectPin()) setTimeout(detectPin, 1000); }, 500);
      }

      // SPA 页面切换时重新检测（debounce 500ms）
      new MutationObserver(() => {
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(detectPin, 500);
      }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.body) { onDomReady(); }
    else { document.addEventListener('DOMContentLoaded', onDomReady); }

    // 监听来自background的消息
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'updatePhone') updatePhone(msg.phone);
      if (msg.type === 'dialResult') {
        flashFloat(msg.ok ? '已拨出' : (msg.err || '失败'), msg.ok);
      }
      if (msg.type === 'reDetect') {
        // 用户点拨号时background让重新扫手机号和姓名
        const result = getMyPhoneAndNameFromCRM();
        if (result && result.phone) {
          _lastPhone = result.phone;
          window.__adMyPhone = result.phone;
          chrome.storage.local.set({ self_phone: result.phone });
          if (result.name) {
            window.__adMyName = result.name;
            chrome.storage.local.set({ manager_name: result.name });
          }
        }
        sendResponse({ phone: result ? result.phone : null });
        return true;
      }
    });

    // 监听子iframe发来的客户姓名
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'nameDetected') {
        window.__adCustomerName = e.data.name;
      }
    });

    return; // 顶层页面只做浮动按钮，不做手机号扫描
  }

  // ═══════════════════════════════════════════════
  // 子iframe：扫描手机号并拦截"点击拨打"
  // ═══════════════════════════════════════════════

  // 监听主题变更，刷新"点击拨打"链接颜色
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === '__ad_theme_change' && e.data.accent) {
      document.querySelectorAll('.__ad-dial-link').forEach(link => {
        link.style.setProperty('color', e.data.accent, 'important');
      });
    }
  });

  function getPhoneFromDetailPage() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: node => node.textContent.trim() === '手机号码：' || node.textContent.trim() === '手机号码:' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
    );

    while (walker.nextNode()) {
      const labelNode = walker.currentNode;
      const valueEl = labelNode.parentElement?.nextElementSibling;
      if (!valueEl) continue;

      const raw = valueEl.firstChild?.textContent?.trim() || '';
      const phone = raw.match(/^(1[3-9]\d{9})/)?.[1];
      if (!phone) continue;

      console.log('[AutoDial v4] ✓ 检测到客户手机号:', phone);

      chrome.runtime.sendMessage({ type: 'phoneDetected', phone });

      const dialLink = valueEl.querySelector('a');
      if (dialLink && !dialLink.__adHooked) {
        dialLink.__adHooked = true;
        dialLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          console.log('[AutoDial v4] 点击拨打:', phone);
          chrome.runtime.sendMessage({ type: 'dial', phone });
        });
        dialLink.classList.add('__ad-dial-link');
        dialLink.style.cssText += `;color:${T().accent}!important;font-weight:bold;`;
        console.log('[AutoDial v4] ✓ 已拦截"点击拨打"链接');
      }

      // 同时检测客户姓名
      var customerName = getNameFromDetailPage();
      if (customerName) {
        window.parent.postMessage({ type: 'nameDetected', name: customerName }, '*');
      }

      return phone;
    }

    return null;
  }

  // 从CRM详情页提取客户姓名（找"姓名："标签）
  function getNameFromDetailPage() {
    var labels = ['姓名：', '姓名:', '客户姓名：', '客户姓名:', '客户名称：', '客户名称:'];
    var allElements = document.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
      var el = allElements[i];
      // 跳过不可见元素、大的容器元素
      if (el.offsetParent === null && el.tagName !== 'BODY' && el.tagName !== 'HTML') continue;
      if (el.children.length > 10) continue;
      var text = (el.textContent || '').trim();
      for (var j = 0; j < labels.length; j++) {
        if (text.indexOf(labels[j]) === 0 || text === labels[j].replace(/[：:]/g, '')) {
          // 取标签后面兄弟节点的文本
          var next = el.nextElementSibling;
          if (next) {
            var name = (next.textContent || next.value || '').trim();
            if (name && name.length >= 1 && name.length <= 30 && !/\d{11}/.test(name)) {
              return name;
            }
          }
          // 如果标签在同一个节点内，取标签后的文字
          var after = text.substring(labels[j].length).trim();
          if (after && after.length >= 1 && after.length <= 30 && !/\d{11}/.test(after)) {
            return after;
          }
        }
      }
    }
    return '';
  }

  function scan() {
    const phone = getPhoneFromDetailPage();
    if (phone) return;
  }

  if (document.body) {
    scan();
  }

  setTimeout(scan, 100);

  const obs = new MutationObserver(() => {
    clearTimeout(scan._timer);
    scan._timer = setTimeout(scan, 150);
  });
  if (document.body) {
    obs.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      obs.observe(document.body, { childList: true, subtree: true });
      scan();
    });
  }
})();
