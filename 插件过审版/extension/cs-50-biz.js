/**
 * AutoDial Content Script — 模块 50：业务层（v6.3 拆分）
 *
 * 内容由原 content-script.js 的 `if (isTopFrame)` 主块原样抽出，业务代码零改动，仅加模块包装。
 * 负责：实时取号（refreshActivePhone / broadcastToFrames）、坐席号检测（detectPin）、
 *       DOM 就绪编排（onDomReady）、后台消息监听注册（registerContentListeners）。
 *
 * 加载顺序：在 cs-20-widgets.js 之后、cs-70-boot.js 之前。
 */
(function (AD) {
  'use strict';
  if (window.__adv2_biz) return;
  window.__adv2_biz = true;
  if (!AD) return;

  // 本模块用到的其他模块符号（本地别名，保持正文调用点零改动）
  const getMyPhoneAndNameFromCRM = AD.getMyPhoneAndNameFromCRM;
  const updatePhone = AD.updatePhone;
  const createFloat = AD.createFloat;
  const createHangupBtn = AD.createHangupBtn;
  const createManualDial = AD.createManualDial;
  const flashFloat = AD.flashFloat;


  // ─── v5.3: 实时读取「当前激活客户帧」的号码 ──────
  //
  // 背景：客户详情是独立 iframe，靠 5 秒心跳上报号码 → 切客户后顶层浮窗最多滞后 5 秒。
  // 用户若在这几秒内点击，就可能拨到上一位客户。
  //
  // 改为「动作驱动的即时查询」：顶层浮窗左击/右键时广播一次询问，只有 isFrameActive()
  // 为真的那一帧（= 眼前这个客户）会应答自己号码，因此拿到的永远是最新值，既无需等心跳，
  // 也不会被隐藏的旧客户帧串号。超时（300ms 无应答）时沿用现有 AD.currentPhone，退回旧行为。
  var _adAskSeq = 0;
  function broadcastToFrames(msg) {
    var frames = document.querySelectorAll('iframe');
    for (var i = 0; i < frames.length; i++) {
      try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(msg, '*'); } catch (e) {}
    }
  }
  function refreshActivePhone(cb) {
    var reqId = 'adq' + (++_adAskSeq);
    var settled = false;
    function settle(got, phone) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener('message', onReply);
      if (got && phone !== AD.currentPhone) updatePhone(phone);
      if (typeof cb === 'function') cb(AD.currentPhone);
    }
    function onReply(e) {
      if (!e.data || e.data.type !== '__ad_phone_reply' || e.data.reqId !== reqId) return;
      settle(true, e.data.phone || null);
    }
    var timer = setTimeout(function () { settle(false, null); }, 300);
    window.addEventListener('message', onReply);
    broadcastToFrames({ type: '__ad_ask_phone', reqId: reqId });
  }

  // ========== v4: 检测坐席手机号 → 存为 PIN ==========
  // v5.1: PIN 注册时机收紧。原实现由 MutationObserver 持续触发 detectPin()，
  // 使用过程中任何一次识别变化都可能覆盖 PIN；而本机坐席号是唯一的，
  // 只有离职换人才会变，且换人必然伴随 CRM 重新登录/刷新。
  // 因此约定：**只有"本次页面加载后的首次命中"才允许写入 self_phone 并注册 PIN**，
  // 之后由 MutationObserver 触发的识别仅打印日志，不再改动 PIN。
  let _lastPhone = null;
  let _debounceTimer = null;
  let _pinRegistered = false;

  function detectPin() {
    try {
      const result = getMyPhoneAndNameFromCRM();
      if (result && result.phone && result.phone !== _lastPhone) {
        _lastPhone = result.phone;
        // 首次命中 = 本次页面加载（CRM 刷新）的这一次注册机会
        const isInitial = !_pinRegistered;
        if (!isInitial) {
          // 非首次：本次页面加载期间坐席号又变了，沿用原 PIN，什么都不改
          console.log('[AutoDial v4] 坐席手机号发生变化，沿用原 PIN 不再覆盖:', result.phone);
          return true;
        }
        _pinRegistered = true;
        window.__adMyPhone = result.phone;
        chrome.storage.local.set({ self_phone: result.phone });
        console.log('[AutoDial v4] 检测到坐席手机号 (PIN):', result.phone);
        chrome.runtime.sendMessage({ type: 'selfPhoneDetected', phone: result.phone, name: result.name || '', precise: !!result.precise, initial: true });
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

  // 监听来自 background 的消息。
  // 拆分前这段 addListener 直接写在主块里；包成函数由 boot 在「顶层页面」分支调用，
  // 以保证子 iframe 不注册（与拆分前行为一致）。
  function registerContentListeners() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'updatePhone') updatePhone(msg.phone);
      if (msg.type === 'dialResult') {
        flashFloat(msg.ok ? '已拨出' : (msg.err || '失败'), msg.ok);
      }
      if (msg.type === 'pinNotice') {
        // v4.15: 坐席号切换/不一致提示（切换=中性醒目，不一致=红色警告）
        flashFloat(msg.text || '', msg.warn ? false : undefined);
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
  }

  /* ---------- 对外出口 ---------- */
  AD.broadcastToFrames = broadcastToFrames;
  AD.refreshActivePhone = refreshActivePhone;
  AD.detectPin = detectPin;
  AD.onDomReady = onDomReady;
  AD.registerContentListeners = registerContentListeners;
})(window.__ADCS = window.__ADCS || {});
