// Wails API Adapter — maps Electron window.api calls to Wails Go bindings
(function () {
  let phonesCallback = null;
  let statusCallback = null;
  let infoCallback = null;
  let floatbarCallback = null;
  let dialResultCallback = null;
  let dialSentCallback = null;
  let dialWakingCallback = null;
  let dialTimeoutCallback = null;
  let hangupSentCallback = null;
  let serverLogCallback = null;
  let errorCallback = null;
  let forceReconnectCallback = null;
  let smsResultCallback = null;
  let smsSentCallback = null;

  window.api = {
    send: async function (channel, ...args) {
      try {
        switch (channel) {
          case 'window-control':
            return window.go.main.App.Send('window-control', args[0]);
          case 'dial':
            if (args[0]) return window.go.main.App.Send('dial', args[0]);
            return window.go.main.App.SendDial(args[0]);
          case 'hangup':
            return window.go.main.App.Send('hangup');
          case 'open-sms':
            var n = (typeof args[0] === 'object') ? (args[0].number || '') : String(args[0] || '');
            var c = (typeof args[0] === 'object') ? (args[0].content || '') : '';
            return window.go.main.App.SendSMS(n, c);
          case 'open-settings':
            return;
          case 'select-phone':
            return window.go.main.App.SelectPhone(args[0]);
          case 'rename-phone':
            return window.go.main.App.RenamePhone(args[0].id, args[0].note);
          case 'force-reconnect':
            return window.go.main.App.ForceReconnect(args[0]);
          case 'set-topmost':
            return window.go.main.App.SetTopmost(args[0]);
          case 'toggle-floatbar':
            return window.go.main.App.ToggleFloatbar();
          case 'restart-cloud':
            return window.go.main.App.RestartCloud();
          case 'restart-app':
            return window.go.main.App.RestartApp();
          case 'dial-failed-trigger-recovery':
            return window.go.main.App.RestartCloud();
          case 'floatbar-minimize':
            return window.go.main.App.MinimizeToFloatbar();
          case 'floatbar-restore':
            return window.go.main.App.RestoreMainWindow();
          case 'update-cloud-config':
            return window.go.main.App.UpdateCloudConfig(args[0], args[1] || []);
          default:
            try { return window.go.main.App.Send(channel, args[0]); } catch(e) { console.warn('[WailsAdapter] unknown:', channel); }
        }
      } catch (e) {
        console.error('[WailsAdapter] send error:', channel, e);
      }
    },

    invoke: async function (channel, ...args) {
      try {
        switch (channel) {
          case 'get-info':
            return await window.go.main.App.GetInfo();
          case 'get-settings':
            return await window.go.main.App.GetSettings();
          case 'read-clipboard':
            return await window.go.main.App.ReadClipboard();
          default:
            console.warn('[WailsAdapter] unknown invoke channel:', channel);
            return null;
        }
      } catch (e) {
        console.error('[WailsAdapter] invoke error:', channel, e);
        return null;
      }
    },

    on: function (channel, callback) {
      switch (channel) {
        case 'phones-update': phonesCallback = callback; break;
        case 'status-update': statusCallback = callback; break;
        case 'info-push': infoCallback = callback; break;
        case 'floatbar-visible-changed': floatbarCallback = callback; break;
        case 'dial-result': dialResultCallback = callback; break;
        case 'dial-sent': dialSentCallback = callback; break;
        case 'dial-waking': dialWakingCallback = callback; break;
        case 'dial-timeout': dialTimeoutCallback = callback; break;
        case 'hangup-sent': hangupSentCallback = callback; break;
        case 'server-log': serverLogCallback = callback; break;
        case 'error': errorCallback = callback; break;
        case 'force-reconnect-result': forceReconnectCallback = callback; break;
        case 'sms-result': smsResultCallback = callback; break;
        case 'sms-sent': smsSentCallback = callback; break;
      }
      return () => {}; // cleanup function
    }
  };

  // Poll for phone list + status updates
  let lastPhoneList = '[]';
  let lastConnected = false;
  setTimeout(async function pollState() {
    try {
      var App = window['go'] && window['go']['main'] && window['go']['main']['App'];
      if (App) {
        var phones = await App.GetPhoneList();
        var activeId = await App.GetActivePhoneID();
        var phonesStr = JSON.stringify(phones);

        if (phonesStr !== lastPhoneList) {
          console.log('[WailsAdapter] phones changed:', phonesStr.substring(0, 200));
          lastPhoneList = phonesStr;
          if (phonesCallback) {
            try { phonesCallback({ phones: phones, activeId: activeId }); } catch(e) { console.error('[WailsAdapter] phonesCallback error:', e); }
          }
        }

        var connected = !!(phones && Array.isArray(phones) && phones.length > 0);
        if (connected !== lastConnected) {
          console.log('[WailsAdapter] connected changed:', connected);
          lastConnected = connected;
          if (statusCallback) {
            try { statusCallback({ connected: connected, phoneIP: (phones && phones.length > 0 && phones[0].ip) || null }); } catch(e) { console.error('[WailsAdapter] statusCallback error:', e); }
          }
        }
      }
    } catch(e) {
      console.error('[WailsAdapter] pollState error:', e);
    }
    setTimeout(pollState, 1000);
  }, 500);

  // Listen for Wails backend events (Go pushToRenderer) and forward to stored callbacks
  if (window.runtime && window.runtime.EventsOn) {
    window.runtime.EventsOn('dial-sent', function(data) {
      if (dialSentCallback) dialSentCallback(data);
      if (dialResultCallback) dialResultCallback({ ok: true, number: (data && data.number) || '' });
    });
    window.runtime.EventsOn('dial-waking', function(data) {
      if (dialWakingCallback) dialWakingCallback(data);
    });
    window.runtime.EventsOn('info-push', function(data) {
      if (infoCallback) infoCallback(data);
    });
    window.runtime.EventsOn('dial-timeout', function(data) {
      if (dialTimeoutCallback) dialTimeoutCallback(data);
      if (dialResultCallback) dialResultCallback({ ok: false, number: (data && data.number) || '', error: '超时' });
    });
    window.runtime.EventsOn('hangup-sent', function(data) {
      if (hangupSentCallback) hangupSentCallback(data);
    });
    window.runtime.EventsOn('force-reconnect-result', function(data) {
      if (forceReconnectCallback) forceReconnectCallback(data);
    });
    window.runtime.EventsOn('error', function(data) {
      if (errorCallback) errorCallback(data);
      if (dialResultCallback && data && data.message) dialResultCallback({ ok: false, error: data.message });
    });
    window.runtime.EventsOn('server-log', function(data) {
      if (serverLogCallback) serverLogCallback(data);
    });
    // 手机端回报的真实拨号结果 — 后端 pushToRenderer("dial-result", ...)
    window.runtime.EventsOn('dial-result', function(data) {
      if (dialResultCallback) dialResultCallback(data);
    });
    // 短信结果 — 后端 pushToRenderer("sms-result", ...)
    window.runtime.EventsOn('sms-result', function(data) {
      if (smsResultCallback) smsResultCallback(data);
    });
    window.runtime.EventsOn('sms-sent', function(data) {
      if (smsSentCallback) smsSentCallback(data);
    });
  }
})();
