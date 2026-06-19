/**
 * AutoDial Popup v3
 */
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const statusPanel = document.getElementById('statusPanel');
  const phoneInput = document.getElementById('phoneInput');
  const passwordInput = document.getElementById('passwordInput');
  const serverInput = document.getElementById('serverInput');
  const serverInputStatus = document.getElementById('serverInputStatus');

  // 加载保存的服务器地址
  chrome.storage.local.get(['cloud_api'], (s) => {
    const addr = s.cloud_api || '';
    if (serverInput) serverInput.value = addr;
    if (serverInputStatus) serverInputStatus.value = addr;
  });

  // 服务器设置折叠
  document.getElementById('serverToggle').addEventListener('click', () => {
    const el = document.getElementById('serverArea');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });
  document.getElementById('settingsToggle')?.addEventListener('click', () => {
    const el = document.getElementById('settingsArea');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  });

  // 全局保存服务器
  function saveServer(inputEl) {
    const addr = inputEl.value.trim();
    if (!addr) return;
    chrome.storage.local.set({ cloud_api: addr });
  }
  document.getElementById('saveServerOnlyBtn').addEventListener('click', () => saveServer(serverInput));
  document.getElementById('saveServerBtn')?.addEventListener('click', () => saveServer(serverInputStatus));

  // 检查登录状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (chrome.runtime.lastError) return showLogin();
    if (status && status.loggedIn) {
      showStatus(status);
    } else {
      showLogin();
    }
  });

  // ===== 登录按钮 =====
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const phone = phoneInput.value.trim();
    const password = passwordInput.value;
    if (!validateInput(phone, password)) return;
    saveServer(serverInput);

    disableButtons(true, '登录中...');
    chrome.runtime.sendMessage({ type: 'manualLogin', phone, password }, (resp) => {
      disableButtons(false, '登录');
      if (resp && resp.success) {
        showStatus({ loggedIn: true, phone, pcAlive: null });
      } else {
        alert('登录失败，请检查账号密码');
      }
    });
  });

  // ===== 注册按钮 =====
  document.getElementById('registerBtn').addEventListener('click', async () => {
    const phone = phoneInput.value.trim();
    const password = passwordInput.value;
    if (!validateInput(phone, password)) return;
    saveServer(serverInput);

    disableButtons(true, '注册中...');
    chrome.runtime.sendMessage({ type: 'manualRegister', phone, password }, (resp) => {
      disableButtons(false, '注册');
      if (resp && resp.success) {
        showStatus({ loggedIn: true, phone, pcAlive: null });
      } else {
        alert(resp?.error || '注册失败，请检查网络或服务器地址');
      }
    });
  });

  function validateInput(phone, password) {
    if (!phone || phone.length !== 11 || !phone.startsWith('1')) { alert('请输入正确的手机号'); return false; }
    if (!password || password.length < 6) { alert('密码至少6位'); return false; }
    return true;
  }

  function disableButtons(disabled, loginText) {
    document.getElementById('loginBtn').disabled = disabled;
    document.getElementById('loginBtn').textContent = loginText;
    document.getElementById('registerBtn').disabled = disabled;
  }

  // 回车登录
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
  });

  // 退出
  document.getElementById('logoutBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'logout' }, () => showLogin());
  });

  async function showLogin() {
    loginForm.style.display = 'block';
    statusPanel.style.display = 'none';
  }

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
