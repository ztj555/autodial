// v5.5: 变量映射表收口到 themes.js 的 AD_APPLY_THEME()（原先 popup/theme-init.js 与
// 本文件各抄了一份，弹窗加运行时切换时还要再抄第三份）
(function () {
  chrome.storage.local.get(['__ad_theme'], function (s) {
    AD_APPLY_THEME(s.__ad_theme || 'sky-blue');
  });
})();

var params = new URLSearchParams(location.search);
var rid = params.get('request_id');
var api = params.get('api');
var device = params.get('device');
var pin = params.get('pin');
var dpin = params.get('default_pin');

document.getElementById('device').textContent = device || '-';
document.getElementById('pin').textContent = pin || '-';
document.getElementById('default_pin').textContent = dpin || '-';

async function respond(allow) {
  document.querySelector('.btns').style.display = 'none';
  var st = document.getElementById('status');
  st.style.display = 'block';
  st.textContent = allow ? '正在授权...' : '正在拒绝...';
  try {
    var r = await chrome.runtime.sendMessage({
      type: 'respondAuth',
      request_id: rid,
      allow: allow,
      api: api,
      pin: pin
    });
    if (r && r.ok) {
      st.className = 'status success';
      st.textContent = allow ? '✅ 已授权，设备可正常连接' : '🚫 已拒绝设备连接';
    } else {
      st.className = 'status error';
      st.textContent = '操作失败: ' + ((r && r.error) || '未知错误');
    }
  } catch(e) {
    st.className = 'status error';
    st.textContent = '网络错误，请重试';
  }
  setTimeout(function() { window.close(); }, 2000);
}

document.getElementById('denyBtn').addEventListener('click', function () { respond(false); });
document.getElementById('allowBtn').addEventListener('click', function () { respond(true); });
