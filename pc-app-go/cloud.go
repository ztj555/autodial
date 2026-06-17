package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

var (
	cloudGeneration     int
	cloudReconnectCount int
)

// ladderDelay returns reconnect delay based on attempt count (exponential backoff)
func ladderDelay() time.Duration {
	switch {
	case cloudReconnectCount <= 1:
		return 0
	case cloudReconnectCount <= 3:
		return time.Duration(cloudReconnectCount) * time.Second
	case cloudReconnectCount <= 6:
		return 5 * time.Second
	case cloudReconnectCount <= 10:
		return 10 * time.Second
	case cloudReconnectCount <= 15:
		return 30 * time.Second
	case cloudReconnectCount <= 20:
		return 60 * time.Second
	default:
		return 5 * time.Minute
	}
}

func connectCloudServer(serverURL string) {
	cloudReconnectCount++
	gen := cloudGeneration + 1
	cloudGeneration = gen

	cloudWsMu.Lock()
	cloudConnecting = true
	if cloudWs != nil {
		cloudWs.Close()
		cloudWs = nil
	}
	cloudWsMu.Unlock()

	u, err := url.Parse(serverURL)
	if err != nil {
		// URL without scheme (e.g. "host:port") — url.Parse sees ":55535" as invalid.
		// Prepend ws:// and retry.
		u2, err2 := url.Parse("ws://" + serverURL)
		if err2 != nil {
			fileLog("E", "Cloud", "", "invalid cloud URL: "+serverURL+" ("+err2.Error()+")")
			cloudWsMu.Lock()
			cloudConnecting = false
			cloudWsMu.Unlock()
			return
		}
		u = u2
	}

	fileLog("I", "Cloud", "", fmt.Sprintf("connecting to %s (gen=%d)", u.String(), gen))

	// Custom dialer with TCP keepalive
	dialer := websocket.DefaultDialer
	dialer.NetDial = func(network, addr string) (net.Conn, error) {
		d := net.Dialer{
			KeepAlive: 10 * time.Second,
		}
		conn, err := d.Dial(network, addr)
		if err != nil {
			return nil, err
		}
		if tcpConn, ok := conn.(*net.TCPConn); ok {
			tcpConn.SetKeepAlive(true)
			tcpConn.SetKeepAlivePeriod(10 * time.Second)
		}
		return conn, nil
	}

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		fileLog("E", "Cloud", "", "connect failed: "+err.Error())
		cloudWsMu.Lock()
		cloudConnecting = false
		cloudWsMu.Unlock()
		scheduleCloudReconnect()
		return
	}

	cloudWsMu.Lock()
	cloudWs = conn
	cloudConnected = false
	cloudConnecting = false
	cloudWsLastPong = time.Now()
	cloudWsMu.Unlock()

	// Send pc_hello
	hostname, _ := os.Hostname()
	conn.WriteJSON(map[string]interface{}{
		"type":     "pc_hello",
		"pin":      pinCode,
		"hostname": hostname,
	})

	// Read goroutine with generation check
	go func(conn *websocket.Conn, myGen int) {
		defer func() {
			conn.Close()
			cloudWsMu.Lock()
			if cloudWs == conn && cloudGeneration == myGen {
				cloudWs = nil
				cloudConnected = false
			}
			cloudWsMu.Unlock()
			removeAllCloudDevices()
			scheduleCloudReconnect()
		}()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				fileLog("W", "Cloud", "", fmt.Sprintf("read error (gen=%d): %s", myGen, err.Error()))
				return
			}

			// Ignore messages from old generations
			cloudWsMu.Lock()
			if cloudGeneration != myGen || cloudWs != conn {
				cloudWsMu.Unlock()
				return
			}
			cloudWsMu.Unlock()

			var msg map[string]interface{}
			if err := json.Unmarshal(raw, &msg); err != nil {
				continue
			}

			msgType, _ := msg["type"].(string)
			switch msgType {
			case "pc_auth_ok":
				cloudReconnectCount = 0 // Reset backoff on success
				phoneCount := 0
				if pc, ok := msg["phoneCount"].(float64); ok {
					phoneCount = int(pc)
				}
				cloudWsMu.Lock()
				if cloudWs == conn && cloudGeneration == myGen {
					cloudConnected = true
				}
				cloudWsMu.Unlock()
				fileLog("I", "Cloud", "", fmt.Sprintf("auth ok, phones=%d", phoneCount))

			case "phone_hello":
				pin, _ := msg["pin"].(string)
				deviceName, _ := msg["deviceName"].(string)
				deviceID, _ := msg["deviceId"].(string)
				if deviceID == "" {
					deviceID = deviceName
				}
				registerDevice(pin, deviceName, "cloud", true, conn)
				fileLog("I", "Cloud", pin, fmt.Sprintf("phone online via cloud: %s", deviceID))

			case "pong":
				cloudWsMu.Lock()
				if cloudWs == conn && cloudGeneration == myGen {
					cloudWsLastPong = time.Now()
				}
				cloudWsMu.Unlock()

			case "ping":
				deviceName, _ := msg["deviceName"].(string)
				if deviceName != "" {
					updateHeartbeatByName(deviceName)
				}
				conn.WriteJSON(map[string]string{"type": "pong"})

			case "dial_result", "sms_result":
				pushToRenderer("dial-result", msg)

			case "pc_offline":
				fileLog("W", "Cloud", "", "pc_offline from relay")

			case "error":
				reason, _ := msg["reason"].(string)
				fileLog("E", "Cloud", "", "error: "+reason)
			}
		}
	}(conn, gen)

	// Ping timer goroutine
	go func(conn *websocket.Conn, myGen int) {
		ticker := time.NewTicker(CloudPingInterval)
		defer ticker.Stop()
		for range ticker.C {
			cloudWsMu.Lock()
			if cloudWs != conn || cloudGeneration != myGen {
				cloudWsMu.Unlock()
				return
			}
			if time.Since(cloudWsLastPong) > CloudPongTimeout {
				fileLog("W", "Cloud", "", fmt.Sprintf("pong timeout (%.0fs, gen=%d)", time.Since(cloudWsLastPong).Seconds(), myGen))
				conn.Close()
				cloudWs = nil
				cloudConnected = false
				cloudWsMu.Unlock()
				removeAllCloudDevices()
				scheduleCloudReconnect()
				return
			}
			conn.WriteJSON(map[string]string{"type": "ping"})
			cloudWsMu.Unlock()
		}
	}(conn, gen)
}

func scheduleCloudReconnect() {
	if cloudReconnectTimer != nil {
		cloudReconnectTimer.Stop()
	}
	if len(appSettings.CloudServers) == 0 {
		return
	}
	// Don't reconnect if already connected — prevents reconnect storms
	// where a stale timer kills an active connection.
	cloudWsMu.Lock()
	if cloudConnected {
		cloudWsMu.Unlock()
		return
	}
	cloudWsMu.Unlock()
	servers := appSettings.CloudServers
	delay := ladderDelay()
	fileLog("I", "Cloud", "", fmt.Sprintf("scheduling reconnect in %v (attempt=%d)", delay, cloudReconnectCount))
	cloudReconnectTimer = time.AfterFunc(delay, func() {
		cloudWsMu.Lock()
		cloudConnecting = true
		cloudWsMu.Unlock()
		for i, srv := range servers {
			fileLog("I", "Cloud", "", fmt.Sprintf("trying server %d/%d: %s", i+1, len(servers), srv))
			connectCloudServer(srv)
			cloudWsMu.Lock()
			connected := cloudConnected
			cloudWsMu.Unlock()
			if connected {
				return
			}
			time.Sleep(2 * time.Second)
		}
		cloudWsMu.Lock()
		cloudConnecting = false
		cloudWsMu.Unlock()
		fileLog("W", "Cloud", "", "all servers failed, will retry")
	})
}

func disconnectCloud() {
	cloudWsMu.Lock()
	defer cloudWsMu.Unlock()
	if cloudWs != nil {
		cloudWs.Close()
		cloudWs = nil
	}
	removeAllCloudDevices()
	cloudConnected = false
}

func removeAllCloudDevices() {
	devicesMu.Lock()
	defer devicesMu.Unlock()
	for pin, d := range devices {
		if d.IsCloud {
			delete(devices, pin)
		}
	}
	notifyUpdate()
}

func updateHeartbeatByName(name string) {
	devicesMu.Lock()
	defer devicesMu.Unlock()
	for _, d := range devices {
		if d.Name == name {
			d.LastHeartbeat = time.Now()
			return
		}
	}
}
