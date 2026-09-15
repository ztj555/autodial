/**
 * AutoDial Content Script — 模块 10：主题与挂件句柄（v6.1 拆分）
 *
 * 主题表来自 themes.js（AD_THEMES / AD_FLAT_ALL），本模块只负责“按明暗档摊平 + 换肤”。
 * 挂件句柄集中在本模块声明，供各挂件模块读写。
 */
(function (AD) {
  'use strict';
  if (window.__adv2_theme) return;
  window.__adv2_theme = true;
  if (!AD) return;

  // 来自 cs-00-core.js：applyTheme 单据该标志决定是否换挂件颜色
  const isTopFrame = AD.isTopFrame;

  // ═══════════════════════════════════════════════════════════════
  // 主题数据（v5 起统一取自 themes.js 的 AD_THEMES，唯一权威源）
  // ═══════════════════════════════════════════════════════════════
  // v6.0：主题 = 色相 × 明暗两个正交维度。AD.EXT_THEMES 是"按当前明暗档摊平"后的扁平表 ——
  // 脚本里 60+ 处 t.accent / t.gradAccent / t.bg2 的写法因此一行都不用改，
  // 只在切换色相或明暗档时重建一次即可。
  AD.currentMode = AD_NORM_MODE(localStorage.getItem('__ad_theme_mode'));
  AD.EXT_THEMES = AD_FLAT_ALL(AD.currentMode);
  function rebuildThemes() { AD.EXT_THEMES = AD_FLAT_ALL(AD.currentMode); }

  // 当前主题 = 色相 + 明暗（默认 sky-blue + light，与手机端 ThemeManager 一致）
  AD.currentThemeId = AD_HAS_THEME(localStorage.getItem('__ad_theme'))
    ? localStorage.getItem('__ad_theme') : AD_THEME_DEFAULT;
  function T() { return AD.EXT_THEMES[AD.currentThemeId] || AD.EXT_THEMES[AD_THEME_DEFAULT]; }

  // ─── 挂件句柄与菜单工具（v6.1：统一挂到共享命名空间 AD）───
  // applyMode / applyTheme 要操作浮窗、挂断按钮、手动拨号条，而这些挂件由 cs-20-widgets.js
  // 创建 —— 属于跨模块共享状态，所以统一挂在这里，模块内外一律用 AD.xxx 访问。
  // ⚠️ 不要再改回"模块私有的 let"：v5.5~v6.0.0 曾把句柄声明在 if (isTopFrame) 块内，
  //    顶层函数够不着，applyTheme 每次调用都在首行抛：
  //        ReferenceError: AD.floatEl is not defined  @ content-script.js:144
  //    抛错点在函数中部 ⇒ 菜单关闭 / 明暗切换 / 跨页换肤一起静默失效（v6.0.1 修复）。
  //    v6.1 拆分后同理：必须挂在 AD 上。
  AD.floatEl = null;            // #__ad_float 拨号浮窗
  AD.currentPhone = null;       // 当前检测到的客户号码
  AD.hangupEl = null;           // #__ad_hangup 挂断按钮
  AD.hangupResizeHandle = null; // #__ad_hangup 左下角缩放手柄
  AD.manualDialBar = null;      // #__ad_manual 手动拨号条
  AD.contextMenu = null;        // #__ad_ctxmenu 自定义右键菜单
  // 真实实现由 cs-30-menu.js 赋值；这里先放空实现，
  // 保证 applyTheme 在任何时序下调用它都不会抛。
  AD.hideContextMenu = function () {};

  // v6.0：切换明暗档。色相不动，只把整张扁平表按新档位重建，再走一遍 applyTheme 的换肤逻辑
  function applyMode(mode) {
    const mk = AD_NORM_MODE(mode);
    if (mk === AD.currentMode) return;
    AD.currentMode = mk;
    localStorage.setItem('__ad_theme_mode', mk);
    try { chrome.storage.local.set({ __ad_theme_mode: mk }); } catch (_) {}
    rebuildThemes();
    applyTheme(AD.currentThemeId);
  }

  function applyTheme(id) {
    AD.currentThemeId = AD_HAS_THEME(id) ? id : AD_THEME_DEFAULT;
    localStorage.setItem('__ad_theme', AD.currentThemeId);
    // v5: 同步给 popup/auth（chrome.storage 跨上下文共享）
    try { chrome.storage.local.set({ __ad_theme: AD.currentThemeId }); } catch (_) {}
    const t = T();
    // 刷新拨号按钮（完整刷新所有主题相关属性）
    if (AD.floatEl) {
      AD.floatEl.style.background = AD.currentPhone ? t.gradAccent : t.bg2;
      AD.floatEl.style.color = AD.currentPhone ? (t.textOnAccent || t.text) : t.text;
      AD.floatEl.style.boxShadow = AD.currentPhone
        ? `0 6px 20px ${t.accent}59`
        : `0 4px 14px ${t.accent}1F`;
      AD.floatEl.style.border = `1px solid ${t.accent}33`;
    }
    // 刷新挂断按钮（idle = 卡片底 + 红字，语义"挂断"）
    if (AD.hangupEl) {
      AD.hangupEl.style.background = t.bg2;
      AD.hangupEl.style.color = t.red;
      AD.hangupEl.style.boxShadow = `0 4px 14px ${t.accent}1F`;
      AD.hangupEl.style.border = `1px solid ${t.red}55`;
      const label = AD.hangupEl.querySelector('span');
      if (label) label.style.color = t.red;
    }
    // 刷新缩放手柄颜色（红色系，与挂断语义一致）
    if (AD.hangupResizeHandle) {
      AD.hangupResizeHandle.style.background = `linear-gradient(135deg, ${t.red}55 50%, transparent 50%)`;
    }
    // 刷新右键菜单（如果打开的话）
    AD.hideContextMenu();
    // 刷新手动拨号条主题
    if (AD.manualDialBar) {
      AD.manualDialBar.style.background = t.bg2;
      AD.manualDialBar.style.border = `1px solid ${t.accent}33`;
      AD.manualDialBar.style.boxShadow = `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`;
      const input = AD.manualDialBar.querySelector('input');
      if (input) {
        input.style.background = t.bg3;
        input.style.color = t.text;
        input.style.border = `1px solid ${t.accent}33`;
      }
      AD.manualDialBar.querySelectorAll('button').forEach(btn => {
        if (btn.classList.contains('__ad_manual_paste')) {
          btn.style.color = t.text2;
          btn.style.border = `1px solid ${t.accent}44`;
          btn.style.background = 'transparent';
        }
        if (btn.classList.contains('__ad_manual_dial')) {
          btn.style.background = t.gradAccent;
          btn.style.color = '#FFFFFF';
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

  // v5.4: 「同步登记列表」功能整体移除 —— 插件端不再抓取 CRM 来访列表页
  // （list_user_visit.html）的分页数据，也不再通过 batchSyncVisits 批量写入云端。
  // 云端接口保留；当前客户的登记仍走「一键登记」registerVisit()。

  // ─── Toast 提示（R6修复: 从 if(isTopFrame) 块内上提到 IIFE 顶层，顶层与 iframe 共用） ───
  // 当前调用方：「一键登记」结果提示（见下方 register 流程）。
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
      padding: '10px 22px',
      borderRadius: '12px',
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: `0 6px 24px ${t.accent}2E, 0 0 0 1px ${t.accent}1A`,
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

  /* ---------- 对外出口 ---------- */
  AD.rebuildThemes = rebuildThemes;
  AD.T = T;
  AD.applyMode = applyMode;
  AD.applyTheme = applyTheme;
  AD.showToast = showToast;
})(window.__ADCS = window.__ADCS || {});
