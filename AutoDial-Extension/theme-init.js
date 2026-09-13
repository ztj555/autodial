// 弹窗主题初始化（MV3 CSP 修复）
//
// 原实现把这段逻辑写在 popup.html 的 <script>...</script> 内联块里。
// MV3 扩展页面的默认 CSP 是 script-src 'self'，内联脚本会被直接拒绝执行，
// 而且不会有任何报错提示 —— 表现就是"改非默认主题后，弹窗里样式没变"
// （打开弹窗瞬间闪回默认配色）。
// 抽成外部文件后由 manifest 的 CSP 正常放行，与 auth.html 的 auth.js 同思路。
//
// v5.5: 变量映射表收口到 themes.js 的 AD_APPLY_THEME()，本文件只负责"读偏好并应用"。
(function () {
  chrome.storage.local.get(['__ad_theme'], function (s) {
    AD_APPLY_THEME(s.__ad_theme || 'sky-blue');
  });
})();
