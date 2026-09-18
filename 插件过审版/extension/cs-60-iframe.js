/**
 * AutoDial Content Script — 模块 60：子 iframe 号码扫描（v6.3 拆分）
 *
 * 内容由原 content-script.js 尾部的 iframe 段原样抽出，业务代码零改动，仅加模块包装。
 * 负责：激活态判定（isFrameActive / isFrameShown）、详情页号码与姓名提取、
 *       5 秒心跳上报、切客户即时刷新轮询、DOM 变化触发扫描。
 *
 * 加载顺序：在 cs-50-biz.js 之后、cs-70-boot.js 之前。
 *
 * ⚠️ 本文件顶部的 `if (AD.isTopFrame) return;` 等价于拆分前主块末尾的那句 `return;` ——
 *    顶层页面的 content script 到此为止，绝不扫描号码。
 */
(function (AD) {
  'use strict';
  if (window.__adv2_iframe) return;
  window.__adv2_iframe = true;
  if (!AD) return;

  // 顶层页面到此为止（与拆分前主块末尾 return; 语义完全一致）
  if (AD.isTopFrame) return;

  const T = AD.T;


  // ═══════════════════════════════════════════════
  // 子iframe：扫描手机号并拦截"点击拨打"
  // ═══════════════════════════════════════════════

  // v5.4: 原先此处为 iframeToast() 与 iframe 侧「响应同步登记列表」监听器，
  // 随「同步登记列表」功能一并移除（插件端不再抓取 CRM 列表、也不再批量上报）。

  // 监听主题变更，刷新"点击拨打"链接颜色
  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === '__ad_theme_change' && e.data.accent) {
      document.querySelectorAll('.__ad-dial-link').forEach(link => {
        link.style.setProperty('color', e.data.accent, 'important');
      });
    }
  });

  // v5.2: 判断「本 iframe 是否为当前激活的页签」。
  //
  // 融鑫汇等 CRM 打开多个客户时，会为每个客户保留一个 iframe：切走的客户 iframe 被设为
  // opacity:0 / z-index:-999 叠在下面，而 display、visibility、innerWidth 全都不变，
  // 其 DOM 依旧完全可读。若不加判断，每个已打开客户的 iframe 都会随着 5 秒心跳一起上报
  // 自己那份「手机号码：」，顶层浮窗就会在多个客户之间来回跳。
  // （老版没有心跳，靠 DOM 变化驱动，天然只有当前客户会上报，故无此问题。）
  //
  // 同源时可用 window.frameElement 拿到父文档里承载自己的 <iframe>，逐层向上检查；
  // 跨域取不到时保守放行，退回旧行为，不误伤单客户场景。
  function isFrameActive() {
    try {
      if (document.visibilityState === 'hidden') return false;
      var w = window.innerWidth || document.documentElement.clientWidth || 0;
      var h = window.innerHeight || document.documentElement.clientHeight || 0;
      if (!w || !h) return false;
      var win = window, depth = 0;
      while (win && win.frameElement && depth++ < 5) {
        var cs = win.getComputedStyle(win.frameElement);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        var z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z < 0) return false;
        if (win.parent === win) break;
        win = win.parent;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  // v6.1: isFrameActive() 的「轻量版」——只判可见性，不读 innerWidth/innerHeight。
  //
  // 供 300ms 级别的「激活态轮询」使用（见文件末尾）。区别只在最后那两项视口尺寸检查：
  //   · getComputedStyle().opacity / zIndex 是纯样式读取，不触发重排；
  //   · window.innerWidth / innerHeight 会强制一次布局（layout flush），
  //     放进高频轮询里会给 CRM 页面带来无谓的重排。
  // 因此高频轮询用本函数做「是否被切到前台」的判定，真正扫描前再走完整的 isFrameActive()。
  function isFrameShown() {
    try {
      if (document.visibilityState === 'hidden') return false;
      var win = window, depth = 0;
      while (win && win.frameElement && depth++ < 5) {
        var cs = win.getComputedStyle(win.frameElement);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        if (parseFloat(cs.opacity) === 0) return false;
        var z = parseInt(cs.zIndex, 10);
        if (!isNaN(z) && z < 0) return false;
        if (win.parent === win) break;
        win = win.parent;
      }
      return true;
    } catch (e) {
      return true;
    }
  }

  // v5.3: 响应顶层的"实时读取激活帧号码"请求。
  // 顶层浮窗左击/右键时广播 __ad_ask_phone；只有当前激活的客户帧才应答，
  // 从而让顶层立刻拿到"眼前这个客户"的号码，不必等 5 秒心跳，也不会被旧客户串号。
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || !d.type) return;
    if (d.type === '__ad_ask_phone') {
      // 多层 iframe：继续向下转发，让最深处的激活帧也能应答
      try {
        var subs = document.querySelectorAll('iframe');
        for (var i = 0; i < subs.length; i++) {
          if (subs[i].contentWindow) subs[i].contentWindow.postMessage(d, '*');
        }
      } catch (_) {}
      // 非激活帧一律不应答（与 scan() 同一道守卫，避免隐藏的旧客户帧回来串号）
      if (!isFrameActive()) return;
      var p = null;
      try { p = getPhoneFromDetailPage(); } catch (_) {}
      try {
        window.parent.postMessage({ type: '__ad_phone_reply', reqId: d.reqId, phone: p || null }, '*');
      } catch (_) {}
    } else if (d.type === '__ad_phone_reply') {
      // 多层 iframe：把深层应答逐级冒泡回顶层
      try { if (window.parent !== window) window.parent.postMessage(d, '*'); } catch (_) {}
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
          // v4.23: 点击那一刻重新读取号码。SPA 框架会复用 <a> 节点（只改 href/文本），
          // 闭包里的 phone 是首次拦截时的旧值——换客户后点击会拨错人（旧号码）。
          let current = phone;
          const href = dialLink.getAttribute('href') || '';
          const hrefMatch = href.match(/1[3-9]\d{9}/);
          if (hrefMatch) {
            current = hrefMatch[0];
          } else {
            const textMatch = (dialLink.textContent || '').match(/1[3-9]\d{9}/);
            if (textMatch) current = textMatch[0];
          }
          console.log('[AutoDial v4] 点击拨打:', current);
          chrome.runtime.sendMessage({ type: 'dial', phone: current });
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

  // v4.15: 本帧最近一次检出号码时的 URL，用于 SPA 切换后清除残留号码
  var adLastDetectedUrl = '';

  function scan() {
    // v5.2: 多客户标签场景下，只有「当前激活」的 iframe 才有资格上报号码/姓名。
    // 已打开但被 CRM 隐藏（opacity:0 / z-index:-999）的上一个客户，其 iframe 仍会每 5 秒
    // 心跳一次；若一并上报，顶层浮窗就会在两个客户的号码之间来回跳。
    if (!isFrameActive()) return;
    const phone = getPhoneFromDetailPage();
    if (phone) {
      adLastDetectedUrl = window.location.href;
      return;
    }
    // v4.15: 本帧之前检出过号码、且页面已切走 → 通知顶层清除，
    // 防止残留号码导致误拨上一位客户
    if (adLastDetectedUrl && window.location.href !== adLastDetectedUrl) {
      adLastDetectedUrl = '';
      try { chrome.runtime.sendMessage({ type: 'phoneDetected', phone: null }); } catch (_) {}
    }
  }

  if (document.body) {
    scan();
  }

  setTimeout(scan, 100);
  // v4.15: 每 5 秒心跳一次——静态详情页也要持续上报号码；心跳停止（页面切换/iframe
  // 被移除）时顶层会在 15 秒后清除残留号码
  setInterval(scan, 5000);

  // v6.1: 切客户「即时刷新」——补上缺失的「激活态跃迁」事件源。
  //
  // 现象：切到另一位客户后，浮窗上的号码最多滞后 5 秒才更新（旧版体感更快）。
  //
  // 根因：多客户场景下，CRM 是靠改**父文档里 <iframe> 的 opacity/z-index** 来切换显示的
  //（见上方 isFrameActive 注释）。于是被切出来的那一帧自身文档**没有任何 DOM 变化**，
  // 它的 MutationObserver 不会触发；而它在「还处于隐藏态」时完成加载/渲染的那一次
  // scan()（L1628/L1631）又会被 isFrameActive() 正当拦下（防串号）。
  // 两条路都被堵住，就只剩 5 秒心跳这一条 —— 也就是你看到的「等 5 秒才换过来」。
  //
  // 解法：轮询「我是不是被切到前台了」。每 300ms 只调一次 isFrameShown()
  //（纯样式读取、不重排、不做 TreeWalker），只在【隐藏 → 可见】那一瞬间真正扫描一次。
  // 空闲时零上报、零网络消息，代价可忽略。
  var _adWasShown = isFrameShown();
  setInterval(function () {
    var shown = isFrameShown();
    if (shown && !_adWasShown) {
      try { scan(); } catch (e) { console.warn('[AutoDial] 切客户即时刷新失败:', e); }
    }
    _adWasShown = shown;
  }, 300);

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
})(window.__ADCS = window.__ADCS || {});
