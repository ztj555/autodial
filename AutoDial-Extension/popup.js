/**
 * AutoDial Popup v3
 */
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const statusPanel = document.getElementById('statusPanel');
  const phoneInput = document.getElementById('phoneInput');
  const passwordInput = document.getElementById('passwordInput');
  const serverInput = document.getElementById('serverInput');
  const serverStatus = document.getElementById('serverStatus');
  const registerUrlHint = document.getElementById('registerUrlHint');

  // 加载保存的服务器地址 + 显示注册提示链接
  chrome.storage.local.get(['cloud_api'], (s) => {
    const addr = s.cloud_api || '';
    serverInput.value = addr;
    updateRegisterHint(addr);
    if (addr) testServer(addr);
  });

  function updateRegisterHint(addr) {
    if (addr) {
      registerUrlHint.textContent = addr.replace(/:\d+/, '') + ':35441/register';
    }
  }

  // ===== 测试服务器连接 =====
  document.getElementById('testServerBtn').addEventListener('click', () => {
    const addr = serverInput.value.trim();
    if (!addr) { setServerStatus('请输入地址', 'err'); return; }
    chrome.storage.local.set({ cloud_api: addr });
    updateRegisterHint(addr);
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
      setServerStatus('✗ 无法连接: ' + (e.name === 'AbortError' ? '超时' : e.message), 'err');
    }
  }

  function setServerStatus(text, cls) {
    serverStatus.textContent = text;
    serverStatus.className = 'server-status ' + cls;
  }

  // 打开注册页面
  document.getElementById('openRegisterLink').addEventListener('click', (e) => {
    e.preventDefault();
    const addr = serverInput.value.trim();
    if (addr) {
      chrome.tabs.create({ url: addr + '/register' });
    } else {
      alert('请先设置并测试服务器地址');
    }
  });

  // 检查登录状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (!chrome.runtime.lastError && status && status.loggedIn) {
      showStatus(status);
    } else {
      showLogin();
    }
  });

  // ===== 登录 =====
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const phone = phoneInput.value.trim();
    const password = passwordInput.value;
    if (!phone || phone.length !== 11 || !phone.startsWith('1')) { alert('请输入正确的手机号'); return false; }
    if (!password || password.length < 6) { alert('密码至少6位'); return false; }
    chrome.storage.local.set({ cloud_api: serverInput.value.trim() });

    const btn = document.getElementById('loginBtn');
    btn.textContent = '登录中...'; btn.disabled = true;

    chrome.runtime.sendMessage({ type: 'manualLogin', phone, password }, (resp) => {
      btn.textContent = '登录'; btn.disabled = false;
      if (resp && resp.success) {
        showStatus({ loggedIn: true, phone, pcAlive: null });
      } else {
        alert(resp && resp.error ? resp.error : '登录失败，请检查账号密码');
      }
    });
  });

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
  });

  // 退出
  document.getElementById('logoutBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'logout' }, () => showLogin());
  });

  function showLogin() { loginForm.style.display = 'block'; statusPanel.style.display = 'none'; }

  async function showStatus(status) {
    loginForm.style.display = 'none';
    statusPanel.style.display = 'block';
    document.getElementById('myPhone').textContent = status.phone || '--';
    const stored = await new Promise(r => chrome.storage.local.get(['cloud_api'], s => r(s.cloud_api)));
    document.getElementById('myServer').textContent = stored || '--';
    document.getElementById('connMode').textContent =
      status.pcAlive === true ? 'PC 直连（局域网）' :
      status.pcAlive === false ? '云端连接' : '检测中...';
  }
});
