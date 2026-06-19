/**
 * AutoDial Popup v3.1
 * 简化版：只设服务器地址 + 显示自动登录状态，无需手动输入账号密码
 */
document.addEventListener('DOMContentLoaded', () => {
  const serverInput = document.getElementById('serverInput');
  const serverStatus = document.getElementById('serverStatus');

  // 加载保存的服务器地址
  chrome.storage.local.get(['cloud_api'], (s) => {
    serverInput.value = s.cloud_api || '';
    if (s.cloud_api) testServer(s.cloud_api);
  });

  // 测试服务器连接
  document.getElementById('testServerBtn').addEventListener('click', () => {
    const addr = serverInput.value.trim();
    if (!addr) { setServerStatus('请输入地址', 'err'); return; }
    chrome.storage.local.set({ cloud_api: addr });
    testServer(addr);
  });

  async function testServer(addr) {
    setServerStatus('测试中...', 'checking');
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${addr}/health`, { signal: ctrl.signal });
      const d = await res.json();
      if (d.ok) {
        setServerStatus('✓ 已连接 (' + (d.data?.service || 'v3') + ')', 'ok');
      } else {
        setServerStatus('✗ 服务器异常', 'err');
      }
    } catch (e) {
      setServerStatus('✗ 无法连接', 'err');
    }
  }

  function setServerStatus(text, cls) {
    serverStatus.textContent = text;
    serverStatus.className = 'server-status ' + cls;
  }

  // 检查登录状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (!chrome.runtime.lastError && status && status.loggedIn) {
      showStatus(status);
    } else {
      showSetup();
    }
  });

  // 退出
  document.getElementById('logoutBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'logout' }, () => showSetup());
  });

  function showSetup() {
    document.getElementById('setupPanel').style.display = 'block';
    document.getElementById('statusPanel').style.display = 'none';
  }

  async function showStatus(status) {
    document.getElementById('setupPanel').style.display = 'none';
    document.getElementById('statusPanel').style.display = 'block';
    document.getElementById('myPhone').textContent = status.phone || '--';
    document.getElementById('connMode').textContent =
      status.pcAlive === true ? 'PC 直连（局域网）' :
      status.pcAlive === false ? '云端连接' : '检测中...';
  }
});
