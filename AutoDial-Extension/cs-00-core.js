/**
 * AutoDial Content Script — 模块 00：核心工具层（v6.1 拆分）
 *
 * 内容由原 content-script.js 的 IIFE 顶层原样抽出，业务代码零改动，仅加模块包装。
 * 负责：防重入守卫、isTopFrame、isOwnUiNode、getMyPhoneAndNameFromCRM、
 *       矢量图标表 AD_ICON / adIcon、HTML 转义 escHtml。
 *
 * 加载顺序：themes.js → addr.js → 本文件 → 其余 cs-*.js
 */
(function (AD) {
  'use strict';
  if (window.__adv2) return;
  window.__adv2 = true;

  const isTopFrame = (window === window.top);
  console.log('[AutoDial v4]', isTopFrame ? '顶层页面' : '子iframe', window.location.href);

  // ========== v3: 检测坐席手机号（TreeWalker扫描body前部，<1ms）==========
  // 融鑫汇CRM手机号是裸StaticText节点，在页面顶部，无class/id
  // TreeWalker从body顶部向下扫，第一个命中的手机号就是坐席的

  /**
   * v5.1: 判断某个文本节点是否落在"本插件自己注入的挂件"里。
   *
   * 这是那条 [P1]「误判号码可能成为生效 PIN」的真正来源：
   * 浮窗的号码标签 #__ad_dial_label 展示的是**客户号码**，登记弹窗
   * autodial-register-overlay 展示的是"客户手机号：xxx"，二者都 append 在顶层
   * document.body 里。而 detectPin() 的 TreeWalker 扫的正是同一个 body ——
   * 于是"我们自己写进去的客户号码"会被当成坐席号读回来。
   *
   * 所有自建节点的 id 均以 __ad_ 或 autodial- 开头，用 closest 做一次前缀匹配即可。
   */
  function isOwnUiNode(node) {
    var el = node && node.parentElement;
    if (!el || typeof el.closest !== 'function') return false;
    try {
      return !!el.closest('[id^="__ad_"], [id^="autodial-"]');
    } catch (e) {
      return false;
    }
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
      if (phoneEl && !isOwnUiNode(phoneEl)) {
        var phoneText = phoneEl.textContent.trim();
        var m = phoneText.match(/1[3-9]\d{9}/);
        if (m) {
          var name = nameEl && !isOwnUiNode(nameEl) ? nameEl.textContent.trim() : '';
          // v4.15: precise=true 表示选择器精确命中，可作为自动切换坐席号的依据
          return { phone: m[0], name: name, precise: true };
        }
      }
    } catch(e) {}

    // 方式二: TreeWalker 扫描（兜底，适配未来 DOM 变化）
    // v5.1: 跳过本插件自己的挂件，避免浮窗/登记弹窗里的客户号码被误判成坐席号
    var PHONE_RE = /1[3-9]\d{9}/;
    var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return isOwnUiNode(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var prevText = '';
    while (w.nextNode()) {
      var text = w.currentNode.textContent.trim();
      var m = text.match(PHONE_RE);
      if (m) {
        return { phone: m[0], name: prevText, precise: false };
      }
      // 记录不含数字、长度2-10的纯文本（可能是姓名）
      if (text && !/\d/.test(text) && text.length >= 2 && text.length <= 10) {
        prevText = text;
      }
    }
    return null;
  }

  // ── v5 矢量图标（Phosphor 风格 24 viewBox / stroke 1.8，替代功能 emoji） ──
  const AD_ICON = {
    phone: '<path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.4 21 3 13.6 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.1 2.2z"/>',
    phoneX: '<path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.4 21 3 13.6 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.4 0 .8-.3 1l-2.1 2.2z"/><path d="M16.5 5.5l5 5M21.5 5.5l-5 5"/>',
    monitor: '<rect x="3" y="4.5" width="18" height="12.5" rx="2"/><path d="M9 21h6M12 17v4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    chat: '<path d="M2.5 6.5A1.5 1.5 0 0 1 4 5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16H9.5L5 19.5V16H4a1.5 1.5 0 0 1-1.5-1.5v-8z"/>',
    pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z"/><path d="M14.5 6.5l3 3"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.5 0 2.2-1.2 1.6-2.4-.5-1 .1-2 1.3-2H17a4.4 4.4 0 0 0 4-4.4C21 6.7 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/>',
    keypad: '<rect x="3" y="3" width="4" height="4" rx="1"/><rect x="10" y="3" width="4" height="4" rx="1"/><rect x="17" y="3" width="4" height="4" rx="1"/><rect x="3" y="10" width="4" height="4" rx="1"/><rect x="10" y="10" width="4" height="4" rx="1"/><rect x="17" y="10" width="4" height="4" rx="1"/><rect x="3" y="17" width="4" height="4" rx="1"/><rect x="10" y="17" width="4" height="4" rx="1"/>',
    gear: '<circle cx="12" cy="12" r="3.5"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 19.5c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5"/>',
    bolt: '<path d="M13 2L4.5 13.5H11L9.5 22 19 10h-6.5L13 2z"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    mapPin: '<path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 11h6M9 15h6"/>',
    cloud: '<path d="M7 18a4 4 0 0 1-.5-7.97A5 5 0 0 1 16 9.5 3.5 3.5 0 0 1 17.5 18H7z"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    sync: '<path d="M20 12a8 8 0 0 1-8 8 8 8 0 0 1-6.7-3.8M4 12a8 8 0 0 1 8-8 8 8 0 0 1 6.7 3.8M20 4v4h-4M4 20v-4h4"/>',
  };
  function adIcon(name, size) {
    var s = size || 16;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;pointer-events:none;vertical-align:-3px">' + (AD_ICON[name] || '') + '</svg>';
  }

  // ─── HTML 转义 ──────────────────────────────────
  function escHtml(s) {
    // v4.23 (E-11): 补引号转义——输出若落在 HTML 属性内（如 title/value）不再可注入
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  /* ---------- 对外出口 ---------- */
  AD.isTopFrame = isTopFrame;
  AD.isOwnUiNode = isOwnUiNode;
  AD.getMyPhoneAndNameFromCRM = getMyPhoneAndNameFromCRM;
  AD.AD_ICON = AD_ICON;
  AD.adIcon = adIcon;
  AD.escHtml = escHtml;
})(window.__ADCS = window.__ADCS || {});
