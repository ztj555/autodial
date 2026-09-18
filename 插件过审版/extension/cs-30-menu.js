/**
 * AutoDial Content Script — 模块 30：自定义右键菜单 + 主题选择子菜单（v6.1 拆分第三期）
 *
 * 负责：浮动按钮 / 挂断按钮的右键菜单、菜单项文案刷新（refreshContextMenuLabels）、
 *       主题选择子菜单（showThemeMenu）。
 *
 * 菜单项的 action 通过 AD.xxx 运行时查找；对由后加载模块（cs-40-dialogs.js）提供的
 * 动作，统一用箭头函数包装转发（防御性：不依赖 items 数组的构造时机）。
 *
 * 加载顺序：... → cs-20-widgets.js → 本文件 → cs-40-dialogs.js → cs-70-boot.js
 */
(function (AD) {
  'use strict';
  if (window.__adv2_menu) return;
  window.__adv2_menu = true;
  if (!AD) return;

  // 本模块私有状态：AD.contextMenu（菜单元素，与 cs-10-theme.js 共用同一句柄）
  // 与 _ctxMousedownHandler（点击外部关闭的事件句柄）。
// ─── 自定义右键菜单 ──────────────────────────────
AD.contextMenu = null;
let _ctxMousedownHandler = null;

// v5.3: 用最新号码刷新已弹出的菜单文案（号码实时查询回来后调用）
function refreshContextMenuLabels() {
  const menu = document.getElementById('__ad_ctxmenu');
  if (!menu) return;
  const setLabel = (key, text) => {
    const row = menu.querySelector('[data-ad-ctx="' + key + '"]');
    const span = row && row.querySelector('span');
    if (span) span.textContent = text;
  };
  const phone = AD.currentPhone;
  setLabel('dial', phone ? '拨打 ' + phone : '拨号（未检测号码）');
  setLabel('sms', phone ? '发短信 ' + phone : '发短信（未检测号码）');
  const custName = window.__adCustomerName || '';
  const custPhone = window.__adPhone || '';
  setLabel('register', (custPhone && custName) ? '一键登记 ' + custName + ' ' + custPhone : '一键登记（未检测客户）');
}

function showContextMenu(x, y) {
  AD.hideContextMenu();
  const t = AD.T();

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
    AD.hideContextMenu();
  });
  overlay.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    AD.hideContextMenu();
  });
  document.body.appendChild(overlay);

  AD.contextMenu = document.createElement('div');
  AD.contextMenu.id = '__ad_ctxmenu';
  Object.assign(AD.contextMenu.style, {
    position: 'fixed',
    left: x + 'px',
    top: y + 'px',
    zIndex: '2147483647',
    background: t.bg2,
    borderRadius: '14px',
    boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
    padding: '6px',
    minWidth: '220px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    color: t.text,
    overflow: 'hidden',
    backdropFilter: 'blur(16px)',
  });

  const items = [
    { icon: 'monitor', label: '打开电脑端主界面', action: () => AD.openDesktopApp() },
    { icon: 'eye', label: '显示/隐藏悬浮窗', action: () => AD.toggleFloatbar() },
    { type: 'separator' },
    { icon: 'phone', key: 'dial', label: AD.currentPhone ? '拨打 ' + AD.currentPhone : '拨号（未检测号码）', action: () => {
      if (!AD.currentPhone) { AD.flashFloat('未检测到号码', false); return; }
      chrome.runtime.sendMessage({ type: 'dial', phone: AD.currentPhone });
    }},
    { icon: 'chat', key: 'sms', label: AD.currentPhone ? '发短信 ' + AD.currentPhone : '发短信（未检测号码）', action: () => {
      if (!AD.currentPhone) { AD.flashFloat('未检测到号码', false); return; }
      AD.sendSms(AD.currentPhone);
    }},
    { icon: 'pencil', key: 'register', label: (function() {
      var custName = window.__adCustomerName || '';
      var custPhone = window.__adPhone || '';
      return custPhone && custName ? '一键登记 ' + custName + ' ' + custPhone : '一键登记（未检测客户）';
    })(), action: () => {
      var custName = window.__adCustomerName || '';
      var custPhone = window.__adPhone || AD.currentPhone || '';
      if (!custPhone || !custName) { AD.flashFloat('未检测到客户信息', false); return; }
      AD.showRegisterConfirm(custName, custPhone);
    }},
    { type: 'separator' },
    { icon: 'palette', label: '切换主题', action: showThemeMenu },
    { icon: 'keypad', label: '手动拨号', action: AD.toggleManualDial },
    { icon: 'gear', label: '设置', action: () => AD.showSettingsDialog() },
    { type: 'separator' },
    { type: 'account' },  // 占位，渲染时异步填充当前登录账号
    { icon: 'x', label: '关闭菜单', action: () => {} },
  ];

  items.forEach(item => {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      Object.assign(sep.style, { height: '1px', background: t.accent + '22', margin: '4px 12px' });
      AD.contextMenu.appendChild(sep);
      return;
    }
    if (item.type === 'account') {
      const row = document.createElement('div');
      Object.assign(row.style, {
        padding: '8px 10px', margin: '0 2px', borderRadius: '8px',
        display: 'flex', alignItems: 'center', gap: '8px',
        whiteSpace: 'nowrap', fontSize: '12px',
      });
      row.innerHTML = AD.adIcon('user', 14) + '<span>加载中...</span>';
      AD.contextMenu.appendChild(row);
      // PIN 模式：显示自动检测的坐席号 + PC 状态
      chrome.storage.local.get(['self_phone', 'pin'], (s) => {
        const phone = s.pin || s.self_phone;
        if (phone) {
          row.innerHTML = AD.adIcon('user', 14) + '<span>PIN: ' + AD.escHtml(phone) + '</span>';
          row.style.color = t.text2;
          row.style.cursor = 'default';
          // 异步查 PC 状态（v5.6.1：在线/离线都显示 —— 原实现离线时整行不插入，
          // 用户看不到「离线」，与 popup 的三行状态语义不一致）
          chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
            const pcOn = !!(status && status.pcAlive === true);
            const pcRow = document.createElement('div');
            pcRow.style.cssText = 'padding:0 10px 6px 10px;font-size:11px;';
            pcRow.style.color = pcOn ? t.green : t.text2;
            pcRow.textContent = 'PIN 已就绪 · PC ' + (pcOn ? '在线' : '离线');
            row.parentNode.insertBefore(pcRow, row.nextSibling);
          });
        } else {
          row.innerHTML = AD.adIcon('bolt', 14) + '<span>未检测到坐席号</span>';
          row.style.color = t.red;
          row.style.fontWeight = '600';
          row.style.cursor = 'pointer';
          row.addEventListener('mouseenter', () => { row.style.background = t.accent + '18'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
          row.addEventListener('click', (e) => { e.stopPropagation(); AD.hideContextMenu(); AD.detectPin(); });
        }
      });
      return;
    }
    const row = document.createElement('div');
    Object.assign(row.style, {
      padding: '8px 10px',
      margin: '0 2px',
      borderRadius: '8px',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      transition: 'background .15s',
      whiteSpace: 'nowrap',
    });
    if (item.key) row.setAttribute('data-ad-ctx', item.key);
    if (item.icon) {
      row.innerHTML = AD.adIcon(item.icon, 15) + '<span style="pointer-events:none">' + AD.escHtml(item.label) + '</span>';
    } else {
      row.textContent = item.label;
    }
    row.addEventListener('mouseenter', () => { row.style.background = t.accent + '14'; });
    row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      AD.hideContextMenu();
      item.action();
    });
    AD.contextMenu.appendChild(row);
  });

  document.body.appendChild(AD.contextMenu);

  requestAnimationFrame(() => {
    const rect = AD.contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) AD.contextMenu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) AD.contextMenu.style.top = (window.innerHeight - rect.height - 8) + 'px';
    if (rect.left < 0) AD.contextMenu.style.left = '8px';
    if (rect.top < 0) AD.contextMenu.style.top = '8px';
  });

  // v5.3: 右键即刷新——弹出菜单的同时向"当前激活客户帧"取最新号码，
  //       拿到后就地更新菜单里的拨打/发短信/一键登记文案（菜单先弹出，不阻塞手感）
  AD.refreshActivePhone(() => refreshContextMenuLabels());

  _ctxMousedownHandler = (e) => {
    const menu = document.getElementById('__ad_ctxmenu');
    if (menu && !menu.contains(e.target)) {
      AD.hideContextMenu();
    }
  };
  // 用 setTimeout 延迟一帧注册，避免与当前右键事件冲突
  setTimeout(() => {
    document.addEventListener('mousedown', _ctxMousedownHandler, true);
  }, 0);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') AD.hideContextMenu(); }, { once: true });
}

// v6.1: 实体由 cs-10-theme.js 的共享命名空间持有（AD.hideContextMenu），这里只赋值
//（原本是块内 function 声明，顶层 applyTheme 看不到，见文件顶部说明）。
AD.hideContextMenu = function () {
  // 移除遮罩层
  const overlay = document.getElementById('__ad_ctxmenu_overlay');
  if (overlay) overlay.remove();
  // 移除菜单
  const el = document.getElementById('__ad_ctxmenu');
  if (el) el.remove();
  AD.contextMenu = null;
};

// ─── 主题选择子菜单 ──────────────────────────────
function showThemeMenu() {
  const t = AD.T();
  const menu = document.createElement('div');
  menu.id = '__ad_thememenu';
  Object.assign(menu.style, {
    position: 'fixed',
    right: '20px',
    bottom: '140px',
    zIndex: '2147483647',
    background: t.bg2,
    borderRadius: '14px',
    boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
    padding: '12px',
    width: '200px',
    maxHeight: 'calc(100vh - 180px)',
    overflowY: 'auto',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: '13px',
    color: t.text,
    backdropFilter: 'blur(20px)',
  });

  const title = document.createElement('div');
  Object.assign(title.style, {
    fontSize: '12px',
    color: t.text2,
    marginBottom: '10px',
    fontWeight: '500',
    letterSpacing: '1px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  });
  title.innerHTML = AD.adIcon('palette', 13) + '<span>选择主题</span>';
  menu.appendChild(title);

  // v6.0：明暗档切换（色相与明暗是两个独立维度，挂件菜单里也要能切）
  const modeRow = document.createElement('div');
  Object.assign(modeRow.style, { display: 'flex', gap: '6px', marginBottom: '10px' });
  AD_THEME_MODES.forEach((mk) => {
    const on = mk === AD.currentMode;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = AD_THEME_MODE_LABEL[mk];
    Object.assign(b.style, {
      flex: '1', fontFamily: 'inherit', fontSize: '12px', lineHeight: '1',
      padding: '6px 0', borderRadius: '999px', cursor: on ? 'default' : 'pointer',
      border: '1px solid ' + (on ? t.accent : t.accent + '33'),
      background: on ? t.accent : 'transparent',
      color: on ? (t.textOnAccent || '#FFFFFF') : t.text2,
      transition: 'background .15s, color .15s',
    });
    if (!on) {
      b.addEventListener('mouseenter', () => { b.style.background = t.accent + '12'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; });
      b.addEventListener('click', () => {
        AD.applyMode(mk);
        document.getElementById('__ad_thememenu')?.remove();
        showThemeMenu();   // 就地重建：菜单保持打开并刷新选中态
      });
    }
    modeRow.appendChild(b);
  });
  menu.appendChild(modeRow);

  // 色相网格（16 套 4 列 × 4 行）。
  // v5.x 是 9 行竖排列表；升到 16 套后竖排会撑满整屏，改网格后高度只有原来的 1/4
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
    gap: '8px', justifyItems: 'center',
  });
  AD_THEME_LIST.forEach((id) => {
    const theme = AD.EXT_THEMES[id];
    if (!theme) return;
    const isActive = id === AD.currentThemeId;
    const swatch = document.createElement('span');
    swatch.title = theme.name;
    Object.assign(swatch.style, {
      width: '26px', height: '26px', borderRadius: '50%',
      cursor: isActive ? 'default' : 'pointer',
      background: theme.gradAccent,
      boxShadow: isActive
        ? `0 0 0 2px ${t.bg2}, 0 0 0 4px ${theme.accent}55`
        : `0 1px 4px ${theme.accent}55`,
      transition: 'transform .12s',
    });
    if (!isActive) {
      swatch.addEventListener('mouseenter', () => { swatch.style.transform = 'scale(1.12)'; });
      swatch.addEventListener('mouseleave', () => { swatch.style.transform = 'scale(1)'; });
      swatch.addEventListener('click', () => {
        AD.applyTheme(id);
        document.getElementById('__ad_thememenu')?.remove();
      });
    }
    grid.appendChild(swatch);
  });
  menu.appendChild(grid);

  // 当前生效的「色相 · 明暗」，避免只靠色块光环猜
  const curRow = document.createElement('div');
  Object.assign(curRow.style, {
    marginTop: '10px', textAlign: 'center', fontSize: '11px', color: t.text2,
  });
  curRow.textContent = (AD.EXT_THEMES[AD.currentThemeId] ? AD.EXT_THEMES[AD.currentThemeId].name : '') +
                       ' \u00B7 ' + AD_THEME_MODE_LABEL[AD.currentMode];
  menu.appendChild(curRow);

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

  /* ---------- 对外出口 ---------- */
  AD.refreshContextMenuLabels = refreshContextMenuLabels;
  AD.showContextMenu = showContextMenu;
  AD.showThemeMenu = showThemeMenu;
})(window.__ADCS = window.__ADCS || {});
