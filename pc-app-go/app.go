package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows/registry"
)

type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	rendererCtx = ctx // for pushToRenderer to emit Wails events

	if err := initLogger(); err != nil {
		println("logger init failed:", err.Error())
	}
	if err := initSettings(); err != nil {
		fileLog("W", "Settings", "", "load error: "+err.Error())
	}
	// 从持久化 settings 恢复用户设置的 PIN（无存储时为空，需手动设11位手机号）
	writePin(getSettings().PinCode)
	fileLog("I", "AutoDial", "", "=== AutoDial PC Go v1.0 ===")
	fileLog("I", "AutoDial", "", "PIN: "+readPin())

	// Start HTTP + WebSocket server
	startHTTPServer()

	// Quick firewall check — verify server is reachable locally
	go func() {
		time.Sleep(1 * time.Second)
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", Port), 3*time.Second)
		if err != nil {
			fileLog("W", "Firewall", "", "port check failed — firewall may block port "+fmt.Sprintf("%d", Port))
		} else {
			conn.Close()
		}
	}()

	// Start UDP discovery
	go startUDPDiscovery()

	// Connect cloud if enabled
	s0 := getSettings()
	if s0.CloudEnabled && len(s0.CloudServers) > 0 {
		go connectCloudServer(s0.CloudServers[0])
	}

	// Periodic heartbeat check
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			checkHeartbeats()
		}
	}()

	// Check and restore phone notes from settings
	notes := getSettings().PhoneNotes
	devicesMu.RLock()
	for pin, note := range notes {
		if d, ok := devices[pin]; ok && d.Note == "" {
			d.Note = note
		}
	}
	devicesMu.RUnlock()

	// Init system tray (delayed to let Wails window create first)
	go func() {
		time.Sleep(2 * time.Second)
		initTray()
		// Silent start: hide window if configured
		if getSettings().SilentStart {
			wailsRuntime.WindowHide(a.ctx)
			setMainWindowVisible(false)
		}
	}()

	// Register tray event handlers on the main goroutine
	// Wails EventsOn callbacks run on the main goroutine where Quit/WindowShow/WindowHide work correctly
	setupTrayActionHandler(a.ctx)
}

func (a *App) shutdown(ctx context.Context) {
	shuttingDown = true // block notifyUpdate goroutines during teardown
	cleanupTray()
	disconnectCloud()
	stopUDPDiscovery()
}

// ── Wails Bindings ──

func (a *App) GetInfo() map[string]interface{} {
	devicesMu.RLock()
	connected := len(devices) > 0
	devicesMu.RUnlock()
	return map[string]interface{}{
		"ip":        getLocalIP(),
		"pin":       readPin(),
		"connected": connected,
		"firewall":  "ok",
	}
}

func (a *App) GetSettings() map[string]interface{} {
	s := getSettings()
	return map[string]interface{}{
		"closeAction":  s.CloseAction,
		"trayExit":     s.TrayExit,
		"autoStart":    s.AutoStart,
		"silentStart":  s.SilentStart,
		"theme":        s.Theme,
		"mode":         s.Mode,
		"cloudEnabled": s.CloudEnabled,
		"cloudServers": s.CloudServers,
	}
}

func (a *App) UpdateSettings(settings map[string]interface{}) {
	cloudChanged := false
	cloudUpdateNeeded := false

	// R3修复: 单次写锁内完成全部字段读-改-写，避免多次取锁读到不一致状态
	settingsMu.Lock()
	if v, ok := settings["theme"].(string); ok {
		appSettings.Theme = v
	}
	if v, ok := settings["mode"].(string); ok {
		appSettings.Mode = v
	}
	if v, ok := settings["closeAction"].(string); ok {
		appSettings.CloseAction = v
	}
	if v, ok := settings["trayExit"].(bool); ok {
		appSettings.TrayExit = v
	}
	if v, ok := settings["autoStart"].(bool); ok {
		appSettings.AutoStart = v
	}
	if v, ok := settings["silentStart"].(bool); ok {
		appSettings.SilentStart = v
	}
	if v, ok := settings["cloudEnabled"].(bool); ok {
		if v != appSettings.CloudEnabled {
			appSettings.CloudEnabled = v
			cloudChanged = true
		}
	}
	if servers, ok := settings["cloudServers"].([]interface{}); ok {
		var list []string
		for _, s := range servers {
			if str, ok := s.(string); ok {
				list = append(list, str)
			}
		}
		appSettings.CloudServers = list
		cloudUpdateNeeded = true
	}
	// 在锁内捕获快照，解锁后用于重连判断，避免解锁后读到被并发修改的值
	curEnabled := appSettings.CloudEnabled
	curServers := appSettings.CloudServers
	settingsMu.Unlock()

	if cloudChanged {
		if curEnabled && len(curServers) > 0 {
			go connectCloudServer(curServers[0])
		} else if !curEnabled {
			disconnectCloud()
		}
	} else if cloudUpdateNeeded && curEnabled && len(curServers) > 0 {
		// Servers changed while cloud was already enabled — restart connection
		disconnectCloud()
		go connectCloudServer(curServers[0])
	}
	saveSettings()
}

// ── New backend bindings for expanded settings ──

func (a *App) ChangeTheme(id string, mode string) {
	settingsMu.Lock()
	appSettings.Theme = id
	if mode != "" {
		appSettings.Mode = mode
	}
	settingsMu.Unlock()
	saveSettings()
}

func (a *App) SetAutoStart(enabled bool) {
	settingsMu.Lock()
	appSettings.AutoStart = enabled
	settingsMu.Unlock()
	saveSettings()

	exePath, err := os.Executable()
	if err != nil {
		fileLog("E", "AutoStart", "", "cannot get exe path: "+err.Error())
		return
	}

	key, err := registry.OpenKey(registry.CURRENT_USER,
		`Software\Microsoft\Windows\CurrentVersion\Run`,
		registry.SET_VALUE)
	if err != nil {
		fileLog("E", "AutoStart", "", "cannot open registry: "+err.Error())
		return
	}
	defer key.Close()

	if enabled {
		if err := key.SetStringValue("AutoDial", exePath); err != nil {
			fileLog("E", "AutoStart", "", "registry write failed: "+err.Error())
		} else {
			fileLog("I", "AutoStart", "", "enabled (registry)")
		}
	} else {
		if err := key.DeleteValue("AutoDial"); err != nil {
			fileLog("W", "AutoStart", "", "registry delete failed (may not exist): "+err.Error())
		} else {
			fileLog("I", "AutoStart", "", "disabled (registry)")
		}
	}
}

func (a *App) ToggleFloatbar() string {
	// Toggle between floatbar mode and main window
	if rendererCtx != nil {
		wailsRuntime.EventsEmit(rendererCtx, "toggle-floatbar", map[string]interface{}{})
	}
	return "ok"
}

func (a *App) GetCloudStatus() map[string]interface{} {
	servers := getSettings().CloudServers
	cloudWsMu.Lock()
	status := map[string]interface{}{
		"connected":  cloudConnected,
		"connecting": cloudConnecting,
		"server":     servers,
		"servers":    servers,
	}
	cloudWsMu.Unlock()
	return status
}

// TestCloudServers tests connectivity to each server via TCP dial
func (a *App) TestCloudServers(servers []string) []map[string]interface{} {
	var results []map[string]interface{}
	for _, addr := range servers {
		// Strip ws:// or wss:// prefix and add ws port if missing
		host := addr
		if strings.HasPrefix(host, "ws://") {
			host = host[5:]
		} else if strings.HasPrefix(host, "wss://") {
			host = host[6:]
		}
		if !strings.Contains(host, ":") {
			host = host + ":35430"
		}
		start := time.Now()
		conn, err := net.DialTimeout("tcp", host, 5*time.Second)
		ms := time.Since(start).Milliseconds()
		if err != nil {
			results = append(results, map[string]interface{}{
				"addr":  addr,
				"ok":    false,
				"error": err.Error(),
				"ms":    0,
			})
		} else {
			conn.Close()
			results = append(results, map[string]interface{}{
				"addr": addr,
				"ok":   true,
				"ms":   ms,
			})
		}
	}
	return results
}

// FetchCloudServers 从 Gist/Gitee 一键获取云服务器列表
// 格式：每行一个 IP:PORT，支持 [old] / [new] 分区标签，# 注释
func (a *App) FetchCloudServers() []string {
	result := make(chan []string, 1)
	go func() {
		sources := []string{
			"https://gist.githubusercontent.com/ztj555/cb6a6bb0ddbe3d4e651d5bb3411777d5/raw/AutoDialservers.txt",
			"https://gitee.com/zuo-tingjun/AutoDialserverslist/raw/master/servers.txt",
		}
		client := &http.Client{Timeout: 10 * time.Second}
		var servers []string

		for _, url := range sources {
			resp, err := client.Get(url)
			if err != nil {
				continue
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil {
				continue
			}
			for _, line := range strings.Split(string(body), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "#") {
					continue
				}
				if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
					continue
				}
				line = strings.ReplaceAll(line, "新云端", "")
				line = strings.ReplaceAll(line, "老云端", "")
				line = strings.ReplaceAll(line, "[new]", "")
				line = strings.ReplaceAll(line, "[old]", "")
				line = strings.TrimSpace(line)
				// 去掉行末别名（格式: "IP:PORT 别名"）
				if idx := strings.Index(line, " "); idx > 0 {
					line = line[:idx]
				}
				if line != "" {
					if !strings.Contains(line, ":") {
						line = line + ":35430"
					}
					servers = append(servers, line)
				}
			}
			if len(servers) > 0 {
				fileLog("I", "Cloud", "", fmt.Sprintf("从 %s 获取到 %d 个服务器", url, len(servers)))
				break
			}
		}
		if len(servers) == 0 {
			fileLog("W", "Cloud", "", "所有服务器列表源均不可达")
		}
		result <- servers
	}()
	select {
	case servers := <-result:
		return servers
	case <-time.After(12 * time.Second):
		fileLog("W", "Cloud", "", "获取服务器列表超时")
		return nil
	}
}

func (a *App) ConnectCloudServer(server string) {
	if server == "" {
		return
	}
	// B21+B23修复: 手动连接时清除用户断开标志，重置重连计数
	cloudUserDisconnected = false
	cloudReconnectCount = 0
	// connectCloudServer() internally handles old connection cleanup (via generation)
	// and device removal. Don't call disconnectCloud() here — it would tear down
	// the active cloud connection needlessly, causing a visible disconnect/reconnect cycle.
	go connectCloudServer(server)
}

func (a *App) UpdateCloudConfig(enabled bool, servers []string) {
	settingsMu.Lock()
	appSettings.CloudEnabled = enabled
	appSettings.CloudServers = servers
	settingsMu.Unlock()
	saveSettings()
	if enabled && len(servers) > 0 {
		// B21+B23: 启用云时重置断开标志和计数
		cloudUserDisconnected = false
		cloudReconnectCount = 0
		go connectCloudServer(servers[0])
	} else if !enabled {
		disconnectCloud()
	}
}

func (a *App) SetPin(pin string) {
	pin = strings.TrimSpace(pin)
	// 对齐 Electron 版：强校验 11 位手机号格式
	if !isValidPhonePIN(pin) {
		pushToRenderer("error", map[string]interface{}{
			"message": "配对码必须为11位手机号(1开头)",
		})
		return
	}
	writePin(pin)
	settingsMu.Lock()
	appSettings.PinCode = pin
	settingsMu.Unlock()
	saveSettings()
	fileLog("I", "App", "", "PIN updated: "+pin)
	// 通知前端更新 PIN 显示
	pushToRenderer("info-push", map[string]interface{}{
		"pin": pin,
	})
}

func (a *App) SendDial(number string) string {
	if sendToPhone("dial", map[string]interface{}{"type": "dial", "number": number}) {
		pushToRenderer("dial-sent", map[string]interface{}{
			"number":  number,
			"phoneId": activePin,
		})
		return "ok"
	}

	// No phone connected — try cloud wake + queue
	s := getSettings()
	if s.CloudEnabled && len(s.CloudServers) > 0 {
		// 锁定当前 activePin 为局部变量，避免定时器回调读取到切换后的新值
		targetPin := activePin
		if targetPin == "" {
			pushToRenderer("error", map[string]interface{}{
				"message": "发送失败：没有选中的手机",
			})
			return "error:no_device"
		}
		// Queue the dial for when phone reconnects
		dialQueueMu.Lock()
		// F4修复: 覆盖同 PIN 旧排队条目前先停止旧 Timer，否则旧定时器到期会误删新条目
		// （连续快速拨号时第二次排队号码被误删）。参照 server.go 排空路径的写法。
		if oldEntry, ok := dialQueue[targetPin]; ok && oldEntry.Timer != nil {
			oldEntry.Timer.Stop()
		}
		dialQueue[targetPin] = &DialQueueEntry{
			Number: number,
			Timer: time.AfterFunc(DialQueueTimeout, func() {
				dialQueueMu.Lock()
				delete(dialQueue, targetPin)
				dialQueueMu.Unlock()
				pushToRenderer("dial-timeout", map[string]interface{}{
					"number": number,
				})
			}),
		}
		dialQueueMu.Unlock()

		// Send wake-up via cloud
		cloudWsMu.Lock()
		if cloudWs != nil {
			cloudWs.WriteJSON(map[string]interface{}{
				"type":         "reconnect_request",
				"targetDevice": targetPin,
			})
		}
		cloudWsMu.Unlock()

		pushToRenderer("dial-waking", map[string]interface{}{
			"pin":    targetPin,
			"number": number,
		})
		return "ok:waking"
	}

	pushToRenderer("error", map[string]interface{}{
		"message": "发送失败：没有可用的手机",
	})
	return "error:no_device"
}

func (a *App) SendHangup() string {
	if sendToPhone("hangup", map[string]interface{}{"type": "hangup"}) {
		pushToRenderer("hangup-sent", map[string]interface{}{})
		return "ok"
	}
	pushToRenderer("error", map[string]interface{}{
		"message": "挂断失败：没有可用的手机",
	})
	return "error:no_device"
}

func (a *App) SendSMS(number string, content string) string {
	if sendToPhone("sms", map[string]interface{}{"type": "sms", "number": number, "content": content}) {
		pushToRenderer("sms-sent", map[string]interface{}{
			"number":  number,
			"content": content,
		})
		return "ok"
	}
	pushToRenderer("error", map[string]interface{}{
		"message": "发送失败：没有可用的手机",
	})
	return "error:no_device"
}

func (a *App) SelectPhone(pin string) {
	setActiveDevice(pin)
}

func (a *App) RenamePhone(pin string, note string) {
	devicesMu.Lock()
	if d, ok := devices[pin]; ok {
		d.Note = note
	}
	devicesMu.Unlock()
	settingsMu.Lock()
	if appSettings.PhoneNotes == nil {
		appSettings.PhoneNotes = make(map[string]string)
	}
	appSettings.PhoneNotes[pin] = note
	settingsMu.Unlock()
	saveSettings()
	notifyUpdate()
}

func (a *App) ForceReconnect(pin string) string {
	pushToRenderer("dial-waking", map[string]interface{}{
		"pin": pin,
	})
	s := getSettings()
	if s.CloudEnabled && len(s.CloudServers) > 0 {
		cloudWsMu.Lock()
		if cloudWs != nil {
			cloudWs.WriteJSON(map[string]interface{}{
				"type":         "reconnect_request",
				"targetDevice": pin,
			})
		}
		cloudWsMu.Unlock()
		pushToRenderer("force-reconnect-result", map[string]interface{}{
			"success": true,
		})
		return "ok"
	}
	pushToRenderer("force-reconnect-result", map[string]interface{}{
		"success": false,
		"error":   "云中转未启用或无可用的云服务器",
	})
	return "error:cloud_disabled"
}

func (a *App) GetPhoneList() []map[string]interface{} {
	return DeviceList()
}

func (a *App) GetActivePhoneID() string {
	return activePin
}

func (a *App) SetTopmost(enabled bool) {
	wailsRuntime.WindowSetAlwaysOnTop(a.ctx, enabled)
}

func (a *App) MinimizeWindow() {
	wailsRuntime.WindowMinimise(a.ctx)
}

func (a *App) CloseWindow() {
	closeAction := getSettings().CloseAction
	fileLog("I", "App", "", "CloseWindow called: trayAdded="+fmt.Sprintf("%v", trayAdded)+" closeAction="+closeAction)
	// If tray is active and closeAction is "minimize", hide to tray
	if trayAdded && closeAction == "minimize" {
		wailsRuntime.WindowHide(a.ctx)
		setMainWindowVisible(false)
		fileLog("I", "App", "", "window hidden to tray")
		return
	}
	// Actually quit — set forceQuit so OnBeforeClose won't block
	forceQuit = true
	wailsRuntime.Quit(a.ctx)
	// Safety net: ensure process exits even if Wails Quit stalls
	go func() {
		time.Sleep(1500 * time.Millisecond)
		fileLog("W", "App", "", "CloseWindow Quit didn't exit, forcing os.Exit")
		os.Exit(0)
	}()
}

// QuitApp truly exits (called from frontend or programmatically)
func (a *App) QuitApp() {
	forceQuit = true
	cleanupTray()
	wailsRuntime.Quit(a.ctx)
	go func() {
		time.Sleep(1500 * time.Millisecond)
		os.Exit(0)
	}()
}

func (a *App) RestartCloud() {
	cloudReconnectCount = 0 // Reset backoff
	disconnectCloud()
	servers := getSettings().CloudServers
	if len(servers) > 0 {
		// C4修复: 异步连接，避免 HandshakeTimeout(最长45s) 同步阻塞前端调用
		go connectCloudServer(servers[0])
	}
}

func (a *App) RestartApp() {
	exePath, err := os.Executable()
	if err != nil {
		fileLog("E", "App", "", "restart: cannot find exe path: "+err.Error())
		wailsRuntime.Quit(a.ctx)
		return
	}
	// Start new instance (detached)
	cmd := exec.Command(exePath)
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		fileLog("E", "App", "", "restart: cannot start new instance: "+err.Error())
	}
	// Release the process so it survives our exit
	go func() {
		if cmd.Process != nil {
			cmd.Process.Release()
		}
	}()
	// Allow a moment for the new process to start
	time.Sleep(300 * time.Millisecond)
	cleanupTray()
	wailsRuntime.Quit(a.ctx)
}

// 切换到浮动横条模式（缩小窗口）
func (a *App) MinimizeToFloatbar() {
	wailsRuntime.WindowSetSize(a.ctx, 400, 52)
	wailsRuntime.WindowSetAlwaysOnTop(a.ctx, true)
}

// 恢复主界面
func (a *App) RestoreMainWindow() {
	wailsRuntime.WindowSetSize(a.ctx, 420, 780)
	wailsRuntime.WindowSetAlwaysOnTop(a.ctx, false)
}

func (a *App) ReadClipboard() map[string]string {
	text, err := wailsRuntime.ClipboardGetText(a.ctx)
	if err != nil {
		return map[string]string{"text": ""}
	}
	return map[string]string{"text": text}
}

func (a *App) GetPlatform() map[string]string {
	return map[string]string{"os": "wails", "goVersion": "1.21"}
}

// Generic event handler for backward compat with Electron's send()
func (a *App) Send(event string, data interface{}) {
	fileLog("I", "App", "", "Send: event="+event+" data="+fmt.Sprintf("%v", data))
	switch event {
	case "window-control":
		if s, ok := data.(string); ok {
			switch s {
			case "minimize":
				a.MinimizeWindow()
			case "close":
				a.CloseWindow()
			}
		}
	case "dial":
		if s, ok := data.(string); ok {
			a.SendDial(s)
		}
	case "hangup":
		a.SendHangup()
	case "open-settings":
		// Embedded settings
	case "toggle-floatbar":
		// 使用新的 MinimizeToFloatbar/RestoreMainWindow
		if v, ok := data.(bool); ok && v {
			a.MinimizeToFloatbar()
		} else {
			a.RestoreMainWindow()
		}
	case "floatbar-minimize":
		a.MinimizeToFloatbar()
	case "floatbar-restore":
		a.RestoreMainWindow()
	case "select-phone":
		if s, ok := data.(string); ok {
			a.SelectPhone(s)
		}
	case "rename-phone":
		if m, ok := data.(map[string]interface{}); ok {
			id, _ := m["id"].(string)
			note, _ := m["note"].(string)
			a.RenamePhone(id, note)
		}
	case "force-reconnect":
		if s, ok := data.(string); ok {
			a.ForceReconnect(s)
		}
	case "restart-cloud":
		a.RestartCloud()
	case "restart-app":
		a.RestartApp()
	case "dial-failed-trigger-recovery":
		a.RestartCloud()
	case "update-bg-color":
		// Theme engine background sync — CSS variables handle this;
		// accepted for compatibility with Electron theme.js
	}
}
