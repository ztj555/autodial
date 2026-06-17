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
            return window.go.main.App.SendSMS(args[0], '');
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
          default:
            console.warn('[WailsAdapter] unknown send channel:', channel);
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
      }
      return () => {}; // cleanup function
    }
  };

  // Poll for phone list + status updates (since Wails doesn't have push events easily)
  let lastPhoneList = '[]';
  let lastConnected = false;
  setTimeout(function pollState() {
    try {
      if (window.go && window.go.main && window.go.main.App) {
        var phones = window.go.main.App.GetPhoneList();
        var activeId = window.go.main.App.GetActivePhoneID();
        var phonesStr = JSON.stringify(phones);

        if (phonesStr !== lastPhoneList) {
          lastPhoneList = phonesStr;
          if (phonesCallback) {
            try { phonesCallback({ phones: phones, activeId: activeId }); } catch(e) {}
          }
        }

        var connected = phones && phones.length > 0;
        if (connected !== lastConnected) {
          lastConnected = connected;
          if (statusCallback) {
            try { statusCallback({ connected: connected, phoneIP: null }); } catch(e) {}
          }
        }
      }
    } catch(e) {}
    setTimeout(pollState, 1000);
  }, 500);
})();
