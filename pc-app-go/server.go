package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

var rendererCtx context.Context

// Plugin connections (browser extensions, no PIN auth)
var (
	pluginConns   []*websocket.Conn
	pluginConnsMu sync.Mutex
)

func startHTTPServer() *http.Server {
	mux := http.NewServeMux()

	// CORS middleware (S1修复: 前置本地端口访问校验，拒绝非回环 Host / 非可信来源)
	corsHandler := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if rejectUntrustedRequest(w, r) {
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			if r.Method == "OPTIONS" {
				w.WriteHeader(200)
				return
			}
			h(w, r)
		}
	}

	// /dial?number=xxx
	mux.HandleFunc("/dial", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		number := r.URL.Query().Get("number")
		if number == "" {
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "number required"})
			return
		}
		// 号码格式校验（对齐 Electron 版：允许手机号、固话、国际号码、400/800）
		if !isValidDialNumber(number) {
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "无效的号码格式"})
			return
		}

		ok := sendToPhone("dial", map[string]interface{}{"type": "dial", "number": number})
		queuedCloud := false
		recoveryTriggered := false

		if ok {
			// 拨号成功 → 写入剪贴板（对齐 Electron 版）
			if rendererCtx != nil {
				wailsRuntime.ClipboardSetText(rendererCtx, number)
			}
		} else {
			// 手机不在线 → 尝试排队 + 云端唤醒
			s := getSettings()
			if s.CloudEnabled && len(s.CloudServers) > 0 {
				targetPin := activePin
				if targetPin != "" {
					dialQueueMu.Lock()
					// F4修复: 覆盖同 PIN 旧排队条目前先停止旧 Timer（与 app.go 对齐），
					// 防止旧定时器到期误删新条目
					if oldEntry, ok := dialQueue[targetPin]; ok && oldEntry.Timer != nil {
						oldEntry.Timer.Stop()
					}
					dialQueue[targetPin] = &DialQueueEntry{
						Number: number,
						Timer: time.AfterFunc(DialQueueTimeout, func() {
							dialQueueMu.Lock()
							delete(dialQueue, targetPin)
							dialQueueMu.Unlock()
						}),
					}
					dialQueueMu.Unlock()
				}
				// Cloud wake
				cloudWsMu.Lock()
				if cloudWs != nil && targetPin != "" {
					cloudWs.WriteJSON(map[string]interface{}{
						"type":         "reconnect_request",
						"targetDevice": targetPin,
					})
					queuedCloud = true
				}
				cloudWsMu.Unlock()

				// 无设备或无云端连接 → 触发恢复
				if !queuedCloud {
					// 触发云端重连（云端断开时）
					if !cloudConnected {
						go connectCloudServer(s.CloudServers[0])
					}
					// 发送 UDP 广播唤醒局域网内所有手机
					broadcastWakeUp()
					recoveryTriggered = true
				}
			} else {
				// 云端未启用 → UDP 广播唤醒
				broadcastWakeUp()
				recoveryTriggered = true
			}
			// 写入剪贴板（即使手机不在线也写，方便用户复制号码）
			if rendererCtx != nil {
				wailsRuntime.ClipboardSetText(rendererCtx, number)
			}
		}

		resp := map[string]interface{}{"number": number}
		if queuedCloud {
			resp["success"] = true
			resp["mode"] = "cloud_waking"
		} else if recoveryTriggered {
			resp["success"] = false
			resp["error"] = "手机未连接，已触发局域网唤醒"
			resp["recovery"] = map[string]interface{}{
				"lanBroadcast": true,
			}
		} else {
			resp["success"] = ok
		}
		json.NewEncoder(w).Encode(resp)
	}))

	// /hangup
	mux.HandleFunc("/hangup", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		ok := sendToPhone("hangup", map[string]interface{}{"type": "hangup"})
		json.NewEncoder(w).Encode(map[string]interface{}{"success": ok})
	}))

	// /sms?number=xxx&content=xxx
	mux.HandleFunc("/sms", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		number := r.URL.Query().Get("number")
		content := r.URL.Query().Get("content")
		// G2修复: 与 /dial 一致，校验号码格式（原实现仅判非空，任意内容可注入）
		if number == "" || !isValidDialNumber(number) {
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "无效的号码格式"})
			return
		}
		ok := sendToPhone("sms", map[string]interface{}{"type": "sms", "number": number, "content": content})
		json.NewEncoder(w).Encode(map[string]interface{}{"success": ok, "number": number})
	}))

	// /open — show/focus main window
	mux.HandleFunc("/open", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		if rendererCtx != nil {
			wailsRuntime.WindowShow(rendererCtx)
			wailsRuntime.WindowUnminimise(rendererCtx)
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true})
	}))

	// /api/set-pin — set 11-digit pairing code
	mux.HandleFunc("/api/set-pin", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "POST required"})
			return
		}
		var body struct {
			Pin string `json:"pin"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "invalid json"})
			return
		}
		pin := strings.TrimSpace(body.Pin)
		// B11修复: 与 Chrome 扩展统一校验格式 (^1[3-9]\d{9}$)
		if !isValidPhonePIN(pin) {
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "配对码必须为11位手机号(1开头)"})
			return
		}

		// Disconnect all devices using old PIN before switching
		if readPin() != "" && readPin() != pin {
			devicesMu.Lock()
			for devicePin, d := range devices {
				if d.Ws != nil {
					d.Ws.Close()
				}
				if d.CloudWs != nil {
					d.CloudWs.Close()
				}
				delete(devices, devicePin)
			}
			activePin = ""
			devicesMu.Unlock()
			notifyUpdate()
		}

		writePin(pin)
		settingsMu.Lock()
		appSettings.PinCode = pin
		settingsMu.Unlock()
		saveSettings()
		fileLog("I", "API", "", "PIN set via /api/set-pin")
		json.NewEncoder(w).Encode(map[string]interface{}{"ok": true})
	}))

	// /toggle-floatbar
	mux.HandleFunc("/toggle-floatbar", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		if rendererCtx != nil {
			wailsRuntime.EventsEmit(rendererCtx, "toggle-floatbar", map[string]interface{}{})
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"success": true, "visible": true})
	}))

	// /cloud-servers
	mux.HandleFunc("/cloud-servers", corsHandler(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{"servers": getSettings().CloudServers})
	}))

	// WebSocket upgrade handler
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.ToLower(r.Header.Get("Upgrade")) == "websocket" {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				fileLog("E", "WS", "", "upgrade failed: "+err.Error())
				return
			}
			go handleLocalWS(conn)
			return
		}
		// Status JSON
		if rejectUntrustedRequest(w, r) {
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		devicesMu.RLock()
		connected := len(devices) > 0
		phoneCount := len(devices)
		devicesMu.RUnlock()
		hostname, _ := os.Hostname()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"pin":        readPin(),
			"pinSet":     readPin() != "",
			"ip":         getLocalIP(),
			"port":       Port,
			"connected":  connected,
			"phoneCount": phoneCount,
			"phones":     DeviceList(),
			"hostname":   hostname,
			"firewall":   "ok",
			"ips":        getLocalIPs(),
		})
	})

	server := &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", Port),
		Handler: mux,
	}
	go func() {
		fileLog("I", "Server", "", fmt.Sprintf("HTTP+WS server on port %d", Port))
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fileLog("E", "Server", "", "failed: "+err.Error())
			// Port conflict — notify user
			pushToRenderer("server-log", map[string]interface{}{
				"level": "error",
				"text":  fmt.Sprintf("端口 %d 被占用！请先关闭旧版 AutoDial 再启动本程序", Port),
			})
		}
	}()
	return server
}

func handleLocalWS(conn *websocket.Conn) {
	clientIP := "unknown"
	if addr := conn.RemoteAddr().String(); addr != "" {
		if parts := strings.Split(addr, ":"); len(parts) > 0 {
			clientIP = parts[0]
		}
	}
	fileLog("I", "WS", "", "connected from "+clientIP)

	var devicePin string
	var isPlugin bool

	// C2修复: 写 LAN 连接前加设备写锁，防止与 sendToPhone 并发写同一连接导致 panic。
	// 未注册设备/插件连接仅有本读循环一个写者，无需加锁。
	writeConnJSON := func(v interface{}) error {
		if devicePin != "" {
			devicesMu.RLock()
			d, ok := devices[devicePin]
			devicesMu.RUnlock()
			if ok && d.Ws == conn {
				return d.writeWs(v)
			}
		}
		return conn.WriteJSON(v)
	}

	defer func() {
		conn.Close()
		if isPlugin {
			pluginConnsMu.Lock()
			for i, pc := range pluginConns {
				if pc == conn {
					pluginConns = append(pluginConns[:i], pluginConns[i+1:]...)
					break
				}
			}
			pluginConnsMu.Unlock()
			fileLog("I", "WS", "", "plugin disconnected from "+clientIP)
			return
		}
		if devicePin != "" {
			dName := devicePin
			devicesMu.RLock()
			if d, ok := devices[devicePin]; ok {
				dName = d.Name
			}
			devicesMu.RUnlock()
			removeDevice(devicePin, "lan")
			pushToRenderer("server-log", map[string]interface{}{
				"level": "warn",
				"text":  fmt.Sprintf("手机已断开: %s (PIN=%s)", dName, devicePin),
			})
		}
		fileLog("I", "WS", devicePin, "disconnected")
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			fileLog("W", "WS", devicePin, "read error: "+err.Error())
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(raw, &msg); err != nil {
			fileLog("W", "WS", devicePin, fmt.Sprintf("bad json: %s (raw=%s)", err.Error(), string(raw[:min(len(raw), 200)])))
			continue
		}

		msgType, _ := msg["type"].(string)
		if msgType == "" && !isPlugin {
			fileLog("W", "WS", devicePin, fmt.Sprintf("unknown message: %s", string(raw[:min(len(raw), 200)])))
			continue
		}

		switch msgType {

		// ── Plugin protocol ──
		case "plugin_hello":
			isPlugin = true
			pluginConnsMu.Lock()
			pluginConns = append(pluginConns, conn)
			pluginConnsMu.Unlock()
			writeConnJSON(map[string]string{"type": "plugin_ok"})
			fileLog("I", "WS", "", "plugin authenticated from "+clientIP)
		case "dial":
			// Fix D7: clarify — this handles dial requests from non-plugin WS connections
			// (legacy Electron extension or direct WS clients). The v4 Chrome extension
			// uses HTTP /dial instead, so this path is rarely reached.
			if !isPlugin {
				number, _ := msg["number"].(string)
				if number == "" {
					writeConnJSON(map[string]string{"type": "dial_fail", "reason": "no number"})
					continue
				}
				if sendToPhone("dial", map[string]interface{}{"type": "dial", "number": number}) {
					writeConnJSON(map[string]interface{}{"type": "dial_sent", "number": number})
				} else {
					writeConnJSON(map[string]interface{}{"type": "dial_waking", "number": number})
				}
			}

		// ── Phone protocol ──
		case "phone_hello":
			// 安全提取 PIN（兼容字符串和数字两种 JSON 类型）
			pin := getStringField(msg, "pin")
			name, _ := msg["deviceName"].(string)

			// 空 PIN 守卫：PIN 未设置时拒绝所有连接
			if readPin() == "" {
				writeConnJSON(map[string]string{"type": "auth_fail", "reason": "配对码尚未设置"})
				fileLog("W", "WS", "", "reject: PIN not set yet from "+clientIP)
				continue
			}
			// B11修复: 与 Chrome 扩展统一校验格式 (^1[3-9]\d{9}$)
			if !isValidPhonePIN(pin) {
				writeConnJSON(map[string]string{"type": "auth_fail", "reason": "配对码必须为11位手机号(1开头)"})
				fileLog("W", "WS", "", fmt.Sprintf("auth fail: invalid pin format from %s", clientIP))
				continue
			}
			if pin != readPin() {
				writeConnJSON(map[string]string{"type": "auth_fail", "reason": "配对码错误"})
				fileLog("W", "WS", "", fmt.Sprintf("auth fail: pin mismatch from %s", clientIP))
				continue
			}
			if name == "" {
				name = fmt.Sprintf("Phone-%s", clientIP)
			}
			devicePin = pin
			registerDevice(pin, name, clientIP, false, conn)

			pcConnected := cloudConnected
			writeConnJSON(map[string]interface{}{
				"type":       "auth_ok",
				"pin":        pin,
				"pcCount":    getPCCount(),
				"pc_present": pcConnected,
			})
			fileLog("I", "WS", pin, fmt.Sprintf("phone authenticated: %s", name))
			pushToRenderer("server-log", map[string]interface{}{
				"level": "success",
				"text":  fmt.Sprintf("手机已连接: %s (PIN=%s)", name, pin),
			})

			// Drain dial queue for this PIN
			dialQueueMu.Lock()
			if entry, ok := dialQueue[pin]; ok {
				number := entry.Number
				if entry.Timer != nil {
					entry.Timer.Stop()
				}
				delete(dialQueue, pin)
				dialQueueMu.Unlock()
				fileLog("I", "WS", pin, fmt.Sprintf("auto-dialing queued number: %s", number))
				go func(n string) {
					time.Sleep(500 * time.Millisecond)
					sendToPhone("dial", map[string]interface{}{"type": "dial", "number": n})
					pushToRenderer("dial-sent", map[string]interface{}{
						"number":  n,
						"phoneId": pin,
					})
				}(number)
			} else {
				dialQueueMu.Unlock()
			}

		case "ping":
			writeConnJSON(map[string]string{"type": "pong"})
			if devicePin != "" {
				devicesMu.Lock()
				if d, ok := devices[devicePin]; ok {
					d.LastHeartbeat = time.Now()
				}
				devicesMu.Unlock()
			}

		case "dial_result":
			number, _ := msg["number"].(string)
			status, _ := msg["status"].(string)
			fileLog("I", "WS", devicePin, fmt.Sprintf("dial result: %s %s", number, status))
			pushToRenderer("dial-result", map[string]interface{}{
				"number": number,
				"status": status,
			})
			// Forward to plugins
			pluginConnsMu.Lock()
			for _, pc := range pluginConns {
				pc.WriteJSON(map[string]interface{}{
					"type":   "dial_result",
					"number": number,
					"status": status,
				})
			}
			pluginConnsMu.Unlock()

		case "sms_result":
			number, _ := msg["number"].(string)
			status, _ := msg["status"].(string)
			fileLog("I", "WS", devicePin, fmt.Sprintf("sms result: %s %s", number, status))
			pushToRenderer("sms-result", map[string]interface{}{
				"number": number,
				"status": status,
			})
			// Forward to plugins
			pluginConnsMu.Lock()
			for _, pc := range pluginConns {
				pc.WriteJSON(map[string]interface{}{
					"type":   "sms_result",
					"number": number,
					"status": status,
				})
			}
			pluginConnsMu.Unlock()

		case "ack":
			handleAck(msg)
		}
	}
}

// handleAck 处理手机/云通道返回的 ACK，解析对应 pendAcks 等待者。
// 本地 WS 与云通道共用同一 pendAcks/ackMu，因此必须使用同一把锁。
func handleAck(msg map[string]interface{}) {
	ackMu.Lock()
	msgID, _ := msg["messageId"].(string)
	if entry, ok := pendAcks[msgID]; ok {
		entry.Timer.Stop()
		delete(pendAcks, msgID)
		entry.Resolve(true)
	}
	ackMu.Unlock()
}

func sendToPhone(msgType string, msg map[string]interface{}) bool {
	// Generate message ID for ACK tracking
	msgID := fmt.Sprintf("%s-%d-%d", msgType, time.Now().UnixNano(), msgCounter.Add(1))
	msg["messageId"] = msgID

	// Snapshot device websockets under lock, then do I/O outside lock
	// 优先 activePin 对应设备，再遍历其余设备
	devicesMu.RLock()
	type snap struct {
		pin     string
		ws      *websocket.Conn
		cloudWs *websocket.Conn
	}
	var snaps []snap
	if d, ok := devices[activePin]; ok {
		snaps = append(snaps, snap{pin: activePin, ws: d.Ws, cloudWs: d.CloudWs})
	}
	for pin, d := range devices {
		if pin != activePin {
			snaps = append(snaps, snap{pin: pin, ws: d.Ws, cloudWs: d.CloudWs})
		}
	}
	devicesMu.RUnlock()

	// Try LAN first, then cloud
	for _, s := range snaps {
		var targetWs *websocket.Conn
		var channel string
		if s.ws != nil {
			targetWs = s.ws
			channel = "lan"
		} else if s.cloudWs != nil {
			targetWs = s.cloudWs
			channel = "cloud"
		}
		if targetWs == nil {
			continue
		}

		// Register ACK waiter
		resultCh := make(chan bool, 1)
		timer := time.AfterFunc(AckTimeout, func() {
			ackMu.Lock()
			if entry, ok := pendAcks[msgID]; ok && !entry.Retried {
				entry.Retried = true
				ackMu.Unlock()
				if channel == "lan" {
					// Fix B4: protect cloudWs access with cloudWsMu
					cloudWsMu.Lock()
					if s.cloudWs != nil {
						s.cloudWs.WriteJSON(msg)
						fileLog("I", "Send", s.pin, "retrying via cloud: "+msgType)
					}
					cloudWsMu.Unlock()
				}
				time.Sleep(AckTimeout)
				// R1修复: 超时最终路径清理 pendAcks，防止每个超时泄漏一个 AckEntry。
				// 若 ACK 在重试期间先行到达，handleAck 已删除条目，此处 delete 为幂等空操作。
				ackMu.Lock()
				delete(pendAcks, msgID)
				ackMu.Unlock()
				// G1修复: ACK 先行到达时 resultCh 已满，直接写入会永久阻塞泄漏 goroutine
				select {
				case resultCh <- false:
				default:
				}
				return
			}
			// R1修复: 其它最终路径（条目已重试/已被 ACK 删除）同样清理 pendAcks
			delete(pendAcks, msgID)
			ackMu.Unlock()
			select {
			case resultCh <- false:
			default:
			}
		})

		ackMu.Lock()
		pendAcks[msgID] = &AckEntry{
			Pin:     s.pin,
			Resolve: func(ok bool) { resultCh <- ok },
			Timer:   timer,
			Channel: channel,
		}
		ackMu.Unlock()

		var writeErr error
		if channel == "lan" {
			// C2修复: LAN 写走设备级写锁，与 handleLocalWS 读循环串行化
			devicesMu.RLock()
			d, ok := devices[s.pin]
			devicesMu.RUnlock()
			if ok {
				writeErr = d.writeWs(msg)
			} else {
				writeErr = targetWs.WriteJSON(msg)
			}
		} else {
			// C2修复: 云通道写统一用全局 cloudWsMu（所有设备共享同一云连接）
			cloudWsMu.Lock()
			writeErr = targetWs.WriteJSON(msg)
			cloudWsMu.Unlock()
		}
		if writeErr != nil {
			ackMu.Lock()
			if entry, ok := pendAcks[msgID]; ok {
				entry.Timer.Stop()
				delete(pendAcks, msgID)
			}
			ackMu.Unlock()
			fileLog("E", "Send", s.pin, "write failed: "+writeErr.Error())
			continue
		}

		fileLog("I", "Send", s.pin, "sent: "+msgType+" (id="+msgID+")")
		ok := <-resultCh
		return ok
	}
	return false
}

func pushToRenderer(event string, data interface{}) {
	fileLog("I", "Push", "", fmt.Sprintf("event=%s data=%v", event, data))
	if rendererCtx != nil {
		wailsRuntime.EventsEmit(rendererCtx, event, data)
	}
}

func getPCCount() int {
	count := 0
	if cloudConnected {
		count++
	}
	count += GetNeighborCount()
	return count
}
