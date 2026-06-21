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

	// CORS middleware
	corsHandler := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
		ok := sendToPhone("dial", map[string]interface{}{"type": "dial", "number": number})
		if !ok && appSettings.CloudEnabled && len(appSettings.CloudServers) > 0 {
			// Queue for wake + auto-dial
			dialQueueMu.Lock()
			dialQueue[activePin] = &DialQueueEntry{
				Number: number,
				Timer:  time.AfterFunc(DialQueueTimeout, func() {
					dialQueueMu.Lock()
					delete(dialQueue, activePin)
					dialQueueMu.Unlock()
				}),
			}
			dialQueueMu.Unlock()
			// Cloud wake
			cloudWsMu.Lock()
			if cloudWs != nil {
				cloudWs.WriteJSON(map[string]interface{}{
					"type":         "reconnect_request",
					"targetDevice": activePin,
				})
			}
			cloudWsMu.Unlock()
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"success": ok, "number": number})
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
		if number == "" {
			json.NewEncoder(w).Encode(map[string]interface{}{"success": false, "error": "number required"})
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
		if len(pin) != 11 {
			json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "配对码必须为11位数字"})
			return
		}
		for _, c := range pin {
			if c < '0' || c > '9' {
				json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "配对码只能包含数字"})
				return
			}
		}

		// Disconnect all devices using old PIN before switching
		if pinCode != "" && pinCode != pin {
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

		pinCode = pin
		appSettings.PinCode = pin
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
		json.NewEncoder(w).Encode(map[string]interface{}{"servers": appSettings.CloudServers})
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
		w.Header().Set("Access-Control-Allow-Origin", "*")
		devicesMu.RLock()
		connected := len(devices) > 0
		phoneCount := len(devices)
		devicesMu.RUnlock()
		hostname, _ := os.Hostname()
		json.NewEncoder(w).Encode(map[string]interface{}{
			"pin":        pinCode,
			"pinSet":     pinCode != "",
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
		Addr:    fmt.Sprintf("0.0.0.0:%d", Port),
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
			fileLog("W", "WS", devicePin, fmt.Sprintf("bad json: %s (raw=%s)", err.Error(), string(raw[:min(len(raw),200)])))
			continue
		}

		msgType, _ := msg["type"].(string)
		if msgType == "" && !isPlugin {
			fileLog("W", "WS", devicePin, fmt.Sprintf("unknown message: %s", string(raw[:min(len(raw),200)])))
			continue
		}

		switch msgType {

		// ── Plugin protocol ──
		case "plugin_hello":
			isPlugin = true
			pluginConnsMu.Lock()
			pluginConns = append(pluginConns, conn)
			pluginConnsMu.Unlock()
			conn.WriteJSON(map[string]string{"type": "plugin_ok"})
			fileLog("I", "WS", "", "plugin authenticated from "+clientIP)

		case "dial":
			if !isPlugin {
				// Plugin dial — send to phone
				number, _ := msg["number"].(string)
				if number == "" {
					conn.WriteJSON(map[string]string{"type": "dial_fail", "reason": "no number"})
					continue
				}
				if sendToPhone("dial", map[string]interface{}{"type": "dial", "number": number}) {
					conn.WriteJSON(map[string]interface{}{"type": "dial_sent", "number": number})
				} else {
					conn.WriteJSON(map[string]interface{}{"type": "dial_waking", "number": number})
				}
			}

		// ── Phone protocol ──
		case "phone_hello":
			// 安全提取 PIN（兼容字符串和数字两种 JSON 类型）
			pin := getStringField(msg, "pin")
			name, _ := msg["deviceName"].(string)

			// 空 PIN 守卫：PIN 未设置时拒绝所有连接
			if pinCode == "" {
				conn.WriteJSON(map[string]string{"type": "auth_fail", "reason": "配对码尚未设置"})
				fileLog("W", "WS", "", "reject: PIN not set yet from "+clientIP)
				continue
			}
			if len(pin) != 11 {
				conn.WriteJSON(map[string]string{"type": "auth_fail", "reason": "配对码必须为11位数字"})
				fileLog("W", "WS", "", fmt.Sprintf("auth fail: invalid pin length from %s", clientIP))
				continue
			}
			if !isNumeric(pin) {
				conn.WriteJSON(map[string]string{"type": "auth_fail", "reason": "配对码只能包含数字"})
				fileLog("W", "WS", "", fmt.Sprintf("auth fail: non-numeric pin from %s", clientIP))
				continue
			}
			if pin != pinCode {
				conn.WriteJSON(map[string]string{"type": "auth_fail", "reason": "配对码错误"})
				fileLog("W", "WS", "", fmt.Sprintf("auth fail: pin mismatch from %s", clientIP))
				continue
			}
			if name == "" {
				name = fmt.Sprintf("Phone-%s", clientIP)
			}
			devicePin = pin
			registerDevice(pin, name, clientIP, false, conn)

			pcConnected := cloudConnected
			conn.WriteJSON(map[string]interface{}{
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
			conn.WriteJSON(map[string]string{"type": "pong"})
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
			ackMu.Lock()
			msgID, _ := msg["messageId"].(string)
			if entry, ok := pendAcks[msgID]; ok {
				entry.Timer.Stop()
				delete(pendAcks, msgID)
				entry.Resolve(true)
			}
			ackMu.Unlock()
		}
	}
}

func sendToPhone(msgType string, msg map[string]interface{}) bool {
	// Generate message ID for ACK tracking
	msgID := fmt.Sprintf("%s-%d-%d", msgType, time.Now().UnixNano(), msgCounter)
	msgCounter++
	msg["messageId"] = msgID

	// Snapshot device websockets under lock, then do I/O outside lock
	devicesMu.RLock()
	type snap struct {
		pin     string
		ws      *websocket.Conn
		cloudWs *websocket.Conn
	}
	var snaps []snap
	for pin, d := range devices {
		snaps = append(snaps, snap{pin: pin, ws: d.Ws, cloudWs: d.CloudWs})
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
				if channel == "lan" && s.cloudWs != nil {
					s.cloudWs.WriteJSON(msg)
					fileLog("I", "Send", s.pin, "retrying via cloud: "+msgType)
				}
				time.Sleep(AckTimeout)
				resultCh <- false
				return
			}
			ackMu.Unlock()
			resultCh <- false
		})

		ackMu.Lock()
		pendAcks[msgID] = &AckEntry{
			Pin:     s.pin,
			Resolve: func(ok bool) { resultCh <- ok },
			Timer:   timer,
			Channel: channel,
		}
		ackMu.Unlock()

		if err := targetWs.WriteJSON(msg); err != nil {
			ackMu.Lock()
			if entry, ok := pendAcks[msgID]; ok {
				entry.Timer.Stop()
				delete(pendAcks, msgID)
			}
			ackMu.Unlock()
			fileLog("E", "Send", s.pin, "write failed: "+err.Error())
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
