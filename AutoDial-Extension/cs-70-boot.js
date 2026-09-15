/**
 * AutoDial Content Script — 模块 70：顶层启动编排（v6.3 拆分，即原 content-script.js）
 *
 * 本文件是拆分前 1879 行 `content-script.js` 的最后残留（重新命名，内容未改）。
 * 内容由原主块剩余部分组成，业务代码零改动，仅加模块包装。
 * 负责：挂件/业务层的本地别名、DOM 就绪启动、后台消息监听注册、
 *       chrome.storage 跨页换肤、客户姓名接收、残留号码保鲜定时器。
 *
 * 加载顺序：必须排在所有 cs-*.js 之后（其余模块在加载期只定义、不执行副作用）。
 */
(function () {
  'use strict';
  if (window.__adv2_main) return;
  window.__adv2_main = true;

  const AD = window.__ADCS;
  if (!AD) return;

  // v6.1：以下符号已迁至 cs-00-core.js / cs-10-theme.js / cs-20-widgets.js / cs-50-biz.js，
  //       这里只做本地别名，让下方调用点一行都不用改。
  const isTopFrame = AD.isTopFrame;
  const rebuildThemes = AD.rebuildThemes;
  const applyTheme = AD.applyTheme;

  if (isTopFrame) {
    AD.floatEl = null;
    AD.currentPhone = null;

    // v6.1（阶段 2/4）：挂件层与业务层的启动入口
    const updatePhone = AD.updatePhone;
    const onDomReady = AD.onDomReady;
    const registerContentListeners = AD.registerContentListeners;

    // DOM 就绪后立即检测一次（SPA可能还未渲染，加延迟重试）
    if (document.body) { onDomReady(); }
    else { document.addEventListener('DOMContentLoaded', onDomReady); }

    // 监听来自background的消息
    registerContentListeners();


    // v5.5: 跟随「扩展弹窗 / 其他端」的主题切换实时换肤。
    // 此前 AD.currentThemeId 只在脚本注入时从 localStorage 读一次 —— 在弹窗里换了主题，
    // 已打开的 CRM 页面悬浮挂件不跟随，得刷新页面才生效。
    // chrome.storage 是跨上下文共享的，弹窗只需写入 __ad_theme 即可推到所有 CRM 标签页。
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        // v6.0：明暗档是独立维度，任一端（弹窗/其他标签页）改了都要重建扁平表
        const mv = changes.__ad_theme_mode && changes.__ad_theme_mode.newValue;
        if (mv && AD_NORM_MODE(mv) !== AD.currentMode) {
          AD.currentMode = AD_NORM_MODE(mv);
          localStorage.setItem('__ad_theme_mode', AD.currentMode);
          rebuildThemes();
          applyTheme(AD.currentThemeId);
          return;
        }
        const nv = changes.__ad_theme && changes.__ad_theme.newValue;
        if (nv && nv !== AD.currentThemeId && AD.EXT_THEMES[nv]) applyTheme(nv);
      });
    } catch (_) {}

    // 监听子iframe发来的客户姓名
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'nameDetected') {
        window.__adCustomerName = e.data.name;
      }
    });

    // v4.15: 残留号码保鲜检查。详情页 iframe 心跳（见 scan 的 setInterval）停止
    // 15 秒（页面已切换/iframe被移除）→ 清空残留号码，防止误拨上一位客户
    window.__adLastPhoneAt = 0;
    setInterval(() => {
      if (AD.currentPhone && Date.now() - (window.__adLastPhoneAt || 0) > 15000) {
        console.log('[AutoDial v4] 页面已离开详情页，清除残留号码:', AD.currentPhone);
        updatePhone(null);
      }
    }, 5000);

    return; // 顶层页面只做浮动按钮，不做手机号扫描
  }
})();
