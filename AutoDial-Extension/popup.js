/**
 * AutoDial Popup v3 — 登录 / 状态面板
 */
document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('loginForm');
  const statusPanel = document.getElementById('statusPanel');
  const phoneInput = document.getElementById('phoneInput');
  const passwordInput = document.getElementById('passwordInput');

  // 检查登录状态
  chrome.runtime.sendMessage({ type: 'getStatus' }, (status) => {
    if (chrome.runtime.lastError) return showLogin();
    if (status && status.loggedIn) {
      showStatus(status);
    } else {
      showLogin();
    }
  });

  // 登录/注册按钮
  document.getElementById('loginBtn').addEventListener('click', async () => {
    const phone = phoneInput.value.trim();
    const password = passwordInput.value;
    if (!phone || phone.length !== 11 || !phone.startsWith('1')) {
      alert('请输入正确的手机号');
      return;
    }
    if (!password || password.length < 6) {
      alert('密码至少6位');
      return;
    }

    document.getElementById('loginBtn').textContent = '登录中...';
    document.getElementById('loginBtn').disabled = true;

    chrome.runtime.sendMessage(
      { type: 'autoRegisterAndLogin', phone, password },
      (resp) => {
        document.getElementById('loginBtn').textContent = '登录 / 注册';
        document.getElementById('loginBtn').disabled = false;
        if (resp && resp.success) {
          showStatus({ loggedIn: true, phone, pcAlive: null });
        } else {
          alert('登录失败，请检查账号密码');
        }
      }
    );
  });

  // 回车登录
  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
  });

  // 退出
  document.getElementById('logoutBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'logout' }, () => showLogin());
  });

  function showLogin() {
    loginForm.style.display = 'block';
    statusPanel.style.display = 'none';
  }

  function showStatus(status) {
    loginForm.style.display = 'none';
    statusPanel.style.display = 'block';
    document.getElementById('myPhone').textContent = status.phone || '--';
    document.getElementById('connMode').textContent =
      status.pcAlive === true ? 'PC 直连（局域网）' :
      status.pcAlive === false ? '云端连接' : '检测中...';
  }
});
