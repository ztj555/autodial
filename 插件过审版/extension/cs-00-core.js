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

  // ─── 色彩工具（v6.3.3）─────────────────────────
  /* 归一化解析：必须同时吃 #RRGGBB / #RGB / rgb() / rgba()。
   * 「毛玻璃」档的 bg2 是 rgba(255,255,255,.5)，只认 #RRGGBB 会拿到 null ——
   * v6.0 就栽在这：派生 CSS 变量全废、弹窗整片白屏。 */
  function adParseColor(c) {
    const s = String(c == null ? '' : c).trim();
    let m = /^#([0-9a-f]{6})$/i.exec(s);
    if (m) { const v = parseInt(m[1], 16); return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 }; }
    m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) { const h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16), a: 1 }; }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
    return null;
  }
  function adHex(p) {
    const h = (x) => { const t = Math.max(0, Math.min(255, Math.round(x))).toString(16); return t.length < 2 ? '0' + t : t; };
    return '#' + h(p.r) + h(p.g) + h(p.b);
  }
  /* 半透明色合成到实底上 → 实色。挂断按钮底色要"压卡片底"，而卡片底在毛玻璃档是
   * 半透明的；先合成为实色，算出来的对比度才等于浏览器里真实看到的那个。 */
  function adSolidColor(color, backdrop) {
    const p = adParseColor(color);
    if (!p) return null;
    if (p.a >= 1) return p;
    const b = adParseColor(backdrop) || { r: 255, g: 255, b: 255, a: 1 };
    return { r: p.r * p.a + b.r * (1 - p.a), g: p.g * p.a + b.g * (1 - p.a), b: p.b * p.a + b.b * (1 - p.a), a: 1 };
  }
  function adSolidHex(color, backdrop) {
    const p = adSolidColor(color, backdrop);
    return p ? adHex(p) : color;
  }
  function adLum(p) {
    if (!p) return null;
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b);
  }
  function adContrast(fg, bg) {
    const x = adLum(fg), y = adLum(bg);
    if (x === null || y === null) return null;
    const hi = Math.max(x, y), lo = Math.min(x, y);
    return (hi + 0.05) / (lo + 0.05);
  }

  // ─── 危险色填充（v6.3.2，仍用于挂断按钮的"点击反馈态"）───
  /* 挂断按钮点击后要"实心红底 + 白字"，但主题红只保证在**卡片底上当文字**够清楚，
   * 拿它当**底**再压白字就未必：亮白档 3.84:1、暗夜档只有 3.46:1（都低于 AA 4.5:1）。
   * 统一叠一层 26% 中性黑把底压深（scrim，材质设计里的常规手法，不引入任何色相）。
   * 16 套色相 × 2 档实测：叠加后白字对比度 4.90 ~ 9.56:1，32 组全部达标 AA。 */
  var AD_DANGER_SCRIM = 'rgba(0,0,0,.26)';
  function adDangerFill(redGrad) {
    return 'linear-gradient(' + AD_DANGER_SCRIM + ',' + AD_DANGER_SCRIM + '), ' + redGrad;
  }

  // ─── 「可读版主题色」（v6.3.3 供空心挂断按钮的文字/描边）───
  /* 空心按钮 = 卡片底 + 主题色描边/文字。但主题色**直接**当文字有一半主题看不清：
   * 亮白档底色接近纯白，而 16 套主题色里 10 套是中等明度 —— 实测 16/32 组低于 AA 4.5:1
   * （最差只有 2.30:1）。所以保留色相、只调明度：亮底往黑混、暗底往白混，混到刚好
   * ≥4.5:1 为止。结果 32 组全部达标（最差 4.50:1），观感仍是"主题色"，只是深/亮了一档。 */
  const AD_INK_MIN = 4.5;
  const AD_INK_CACHE = {};
  function adInk(color, cardBg, pageBg) {
    const key = color + '|' + cardBg + '|' + (pageBg == null ? '' : pageBg);
    if (AD_INK_CACHE[key]) return AD_INK_CACHE[key];
    const base = adSolidColor(color, pageBg);
    const bg = adSolidColor(cardBg, pageBg);
    if (!base || !bg) return color;              // 解析失败：原样返回，绝不抛
    const target = adLum(bg) > 0.35 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
    let out = color;
    for (let k = 0; k <= 1.0001; k += 0.01) {
      const cand = {
        r: base.r + (target.r - base.r) * k,
        g: base.g + (target.g - base.g) * k,
        b: base.b + (target.b - base.b) * k, a: 1
      };
      if (adContrast(cand, bg) >= AD_INK_MIN) { out = adHex(cand); break; }
    }
    AD_INK_CACHE[key] = out;
    return out;
  }

  /* ---------- 对外出口 ---------- */
  AD.isTopFrame = isTopFrame;
  AD.isOwnUiNode = isOwnUiNode;
  AD.getMyPhoneAndNameFromCRM = getMyPhoneAndNameFromCRM;
  AD.AD_ICON = AD_ICON;
  AD.adIcon = adIcon;
  AD.escHtml = escHtml;
  AD.adParseColor = adParseColor;
  AD.adSolidHex = adSolidHex;
  AD.adContrast = adContrast;
  AD.adInk = adInk;
  AD.adDangerFill = adDangerFill;
})(window.__ADCS = window.__ADCS || {});
