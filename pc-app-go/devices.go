package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	Port              = 35432
	DiscoveryPort     = 35433
	HeartbeatTimeout  = 120 * time.Second
	NeighborTTL       = 30 * time.Second
	MaxConnections    = 10 // Fix D6: increased from 2 to support multi-phone scenarios
	AckTimeout        = 3 * time.Second
	DialQueueTimeout  = 30 * time.Second
	CloudPingInterval = 15 * time.Second
	CloudPongTimeout  = 20 * time.Second
)

var (
	pinCode  string
	pinMu    sync.RWMutex // Fix B1: protect pinCode from concurrent read/write
	upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		// S1修复: WS 仅绑定回环端口(127.0.0.1:35432)，校验 Host 与来源，
		// 阻止任意网页通过 WebSocket 拨号/发短信/挂断
		return isLoopbackHost(r.Host) && isTrustedLocalOrigin(r.Header.Get("Origin"))
	}}
	devices     = make(map[string]*PhoneDevice)
	activePin   string
	devicesMu   sync.RWMutex
	pendAcks    = make(map[string]*AckEntry)
	ackMu       sync.Mutex
	msgCounter  atomic.Uint64
	dialQueue   = make(map[string]*DialQueueEntry)
	dialQueueMu sync.Mutex

	// Cloud
	cloudWs             *websocket.Conn
	cloudWsMu           sync.Mutex
	cloudWsLastPong     time.Time
	cloudConnected      bool
	cloudConnecting     bool
	cloudReconnectTimer *time.Timer
)

// readPin safely reads the current PIN under the read lock
func readPin() string {
	pinMu.RLock()
	defer pinMu.RUnlock()
	return pinCode
}

// writePin safely writes a new PIN under the write lock
func writePin(newPin string) {
	pinMu.Lock()
	defer pinMu.Unlock()
	pinCode = newPin
}

type PhoneDevice struct {
	Pin           string `json:"pin"`
	Name          string `json:"name"`
	Note          string `json:"note"`
	IP            string `json:"ip"`
	Active        bool   `json:"active"`
	IsCloud       bool   `json:"isCloud"`
	Stale         bool   `json:"stale"`
	ConnType      string `json:"connectionType"`
	Status        string `json:"status"`
	Ws            *websocket.Conn
	CloudWs       *websocket.Conn
	wsMu          sync.Mutex // C2修复: 串行化 LAN Ws 的写入（读循环与 sendToPhone 共享同一连接）
	LastHeartbeat time.Time
	ConnectedAt   time.Time
}

// writeWs 串行化对 LAN WebSocket 的写入（gorilla/websocket 禁止并发写）。
// 云端连接是全局共享的单一连接，统一由全局 cloudWsMu 保护，不走本方法。
func (d *PhoneDevice) writeWs(msg interface{}) error {
	d.wsMu.Lock()
	defer d.wsMu.Unlock()
	if d.Ws == nil {
		return fmt.Errorf("ws closed")
	}
	return d.Ws.WriteJSON(msg)
}

type AckEntry struct {
	Pin     string
	Resolve func(bool)
	Timer   *time.Timer
	Retried bool
	Channel string
}

type DialQueueEntry struct {
	Number  string
	Timer   *time.Timer
	Resolve func(bool)
}

func getMacAddress() string {
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		mac := iface.HardwareAddr.String()
		if mac == "" || mac == "00:00:00:00:00:00" {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil && !ipnet.IP.IsLoopback() {
				ip := ipnet.IP.String()
				if strings.HasPrefix(ip, "169.254.") {
					continue
				}
				return mac
			}
		}
	}
	host, _ := os.Hostname()
	return host
}

func getLocalIP() string {
	// Match Electron: filter out virtual/VPN adapters by name, prefer real LAN addresses
	excludeKeywords := []string{
		"virtual", "vmware", "docker", "hyper", "bluetooth", "loopback",
		"nodebabylink", "本地连接*", "tunnel", "tap", "vpn", "wintun",
	}
	ifaces, _ := net.Interfaces()

	// Collect IPs with interface info
	type ifaceIP struct {
		ip    string
		name  string
		isLAN bool
	}
	var ips []ifaceIP

	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(iface.Name)
		excluded := false
		for _, kw := range excludeKeywords {
			if strings.Contains(name, kw) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}

		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok || ipnet.IP.To4() == nil || ipnet.IP.IsLoopback() {
				continue
			}
			ip := ipnet.IP.String()
			if strings.HasPrefix(ip, "169.254.") {
				continue
			}
			isLAN := strings.HasPrefix(ip, "192.168.") ||
				strings.HasPrefix(ip, "10.") ||
				is172Private(ip)
			ips = append(ips, ifaceIP{ip: ip, name: iface.Name, isLAN: isLAN})
		}
	}

	// Prefer LAN IPs on preferred interfaces (WLAN/WiFi, Ethernet first)
	preferKeywords := []string{"wlan", "wi-fi", "无线", "wifi", "eth", "以太", "ethernet", "pci", "en"}
	for _, pk := range preferKeywords {
		for _, ip := range ips {
			if ip.isLAN && strings.Contains(strings.ToLower(ip.name), pk) {
				return ip.ip
			}
		}
	}
	// Then any LAN IP
	for _, ip := range ips {
		if ip.isLAN {
			return ip.ip
		}
	}
	// Fallback: any non-excluded IP
	if len(ips) > 0 {
		return ips[0].ip
	}
	return "--"
}

func getLocalIPs() []string {
	excludeKeywords := []string{
		"virtual", "vmware", "docker", "hyper", "bluetooth", "loopback",
		"nodebabylink", "tunnel", "tap", "vpn", "wintun",
	}
	ifaces, _ := net.Interfaces()
	var ips []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		name := strings.ToLower(iface.Name)
		excluded := false
		for _, kw := range excludeKeywords {
			if strings.Contains(name, kw) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok && ipnet.IP.To4() != nil && !ipnet.IP.IsLoopback() {
				ip := ipnet.IP.String()
				if !strings.HasPrefix(ip, "169.254.") {
					ips = append(ips, ip)
				}
			}
		}
	}
	return ips
}

func is172Private(ip string) bool {
	parts := strings.Split(ip, ".")
	if len(parts) != 4 {
		return false
	}
	if parts[0] != "172" {
		return false
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	return n >= 16 && n <= 31
}

// ── Device Management ──

func registerDevice(pin string, name, ip string, isCloud bool, ws *websocket.Conn) {
	devicesMu.Lock()
	defer devicesMu.Unlock()

	if d, ok := devices[pin]; ok {
		if ws != nil {
			if isCloud {
				d.CloudWs = ws
			} else {
				d.Ws = ws
			}
		}
		d.LastHeartbeat = time.Now()
		d.Stale = false
		d.Status = "online"
		if isCloud {
			d.IsCloud = true
			d.ConnType = "cloud"
		} else {
			d.IP = ip
			d.ConnType = "lan"
		}
		fileLog("I", "DevMgr", pin, fmt.Sprintf("device updated: name=%s ip=%s", name, ip))
	} else {
		count := 0
		for _, d := range devices {
			if !d.Stale {
				count++
			}
		}
		if count >= MaxConnections {
			fileLog("W", "DevMgr", pin, "registration rejected: max connections reached")
			return
		}
		d := &PhoneDevice{
			Pin:           pin,
			Name:          name,
			IP:            ip,
			IsCloud:       isCloud,
			LastHeartbeat: time.Now(),
			ConnectedAt:   time.Now(),
			Status:        "online",
		}
		if isCloud {
			d.ConnType = "cloud"
		} else {
			d.Ws = ws
			d.ConnType = "lan"
		}
		devices[pin] = d
		fileLog("I", "DevMgr", pin, fmt.Sprintf("new device: name=%s ip=%s", name, ip))
	}

	if activePin == "" {
		activePin = pin
	}
	notifyUpdate()
}

func removeDevice(pin string, transport string) {
	devicesMu.Lock()
	defer devicesMu.Unlock()

	d, ok := devices[pin]
	if !ok {
		return
	}

	if transport == "lan" {
		if d.Ws != nil {
			d.Ws.Close()
			d.Ws = nil
		}
		d.Stale = true
		d.ConnType = ""
		if d.CloudWs != nil {
			d.ConnType = "cloud"
			d.Status = "online"
		} else {
			d.Status = "offline"
		}
	} else if transport == "cloud" {
		d.CloudWs = nil
		d.Stale = true
		if d.Ws != nil {
			d.ConnType = "lan"
			d.Status = "online"
		} else {
			d.ConnType = ""
			d.Status = "offline"
		}
	} else {
		// R2修复+收敛: 心跳超时全量移除时关闭 LAN 连接（每连接独立读 goroutine，
		// 必须 Close 防阻塞泄漏）；共享 CloudWs 的生死由 cloud.go 的 pong 看门狗
		// 与读循环退出机制负责，此处不 Close，避免单台云设备超时关闭共享连接
		// 导致全体云设备闪断重连。gorilla/websocket Close 可与其他方法并发调用，
		// 与 writeWs(wsMu) 不冲突（C2 兼容）。
		if d.Ws != nil {
			d.Ws.Close()
		}
		delete(devices, pin)
		if activePin == pin {
			activePin = ""
		}
	}
	notifyUpdate()
}

func DeviceList() []map[string]interface{} {
	devicesMu.RLock()
	defer devicesMu.RUnlock()
	// R3修复: 锁内一次性取备注快照（深拷贝），避免直接读共享 map 的竞态
	notes := getSettings().PhoneNotes
	list := make([]map[string]interface{}, 0)
	for pin, d := range devices {
		note := d.Note
		if note == "" {
			note = notes[pin]
		}
		if note == "" {
			note = notes[d.Name]
		}
		displayName := note
		if displayName == "" {
			displayName = d.Name
		}
		list = append(list, map[string]interface{}{
			"id":             pin,
			"pin":            pin,
			"name":           displayName,
			"note":           note,
			"ip":             d.IP,
			"active":         pin == activePin,
			"stale":          d.Stale,
			"status":         d.Status,
			"isCloud":        d.IsCloud,
			"connectionType": d.ConnType,
		})
	}
	return list
}

func setActiveDevice(pin string) {
	devicesMu.Lock()
	defer devicesMu.Unlock()
	if _, ok := devices[pin]; ok {
		activePin = pin
		notifyUpdate()
	}
}

func notifyUpdate() {
	// During shutdown, skip — the Wails runtime is shutting down
	// and EventsEmit would stall or fail.
	if shuttingDown {
		return
	}
	// Push device list and connection status to frontend via Wails events.
	// IMPORTANT: This must run in a separate goroutine because callers
	// (registerDevice, etc.) hold devicesMu.Lock(), and DeviceList() /
	// the RLock here would deadlock on the same goroutine.
	go func() {
		devicesMu.RLock()
		phoneCount := len(devices)
		connected := phoneCount > 0
		devicesMu.RUnlock()

		pushToRenderer("phones-update", map[string]interface{}{
			"phones":   DeviceList(),
			"activeId": activePin,
		})
		pushToRenderer("status-update", map[string]interface{}{
			"connected": connected,
			"phoneIP":   "",
		})
	}()
}

// getStringField safely extracts a string value from a JSON map.
// JSON numbers may be decoded as float64, so both string and numeric types are handled.
func getStringField(m map[string]interface{}, key string) string {
	v, ok := m[key]
	if !ok {
		return ""
	}
	switch val := v.(type) {
	case string:
		return val
	case float64:
		// JSON 数字解析为 float64，11位手机号在 float64 精度内可精确表示
		return strconv.FormatInt(int64(val), 10)
	case int:
		return strconv.Itoa(val)
	case int64:
		return strconv.FormatInt(val, 10)
	default:
		return fmt.Sprintf("%v", val)
	}
}

// isNumeric checks if a string consists entirely of digit characters.
func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// isValidPhonePIN checks if the PIN is 4-digit or 11-digit numeric.
// Compatible: old PC clients use 4-digit PINs; new clients use 11-digit phone numbers.
func isValidPhonePIN(pin string) bool {
	if !isNumeric(pin) {
		return false
	}
	return len(pin) == 4 || len(pin) == 11
}

// isValidDialNumber validates phone number format for HTTP /dial.
// Allows Chinese mobile, landline, international (+prefix), and 400/800 numbers.
// Format: 3-20 digits, optionally with +, *, #, spaces, hyphens, parentheses.
// Accepts: 10086, 13800138000, +8613800138000, *100#, 400-800-8800
func isValidDialNumber(number string) bool {
	cleaned := strings.ReplaceAll(number, " ", "")
	cleaned = strings.ReplaceAll(cleaned, "-", "")
	cleaned = strings.ReplaceAll(cleaned, "(", "")
	cleaned = strings.ReplaceAll(cleaned, ")", "")
	cleaned = strings.ReplaceAll(cleaned, "*", "")
	cleaned = strings.ReplaceAll(cleaned, "#", "")
	if len(cleaned) < 3 || len(cleaned) > 20 {
		return false
	}
	for i, c := range cleaned {
		if i == 0 && c == '+' {
			continue
		}
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// broadcastWakeUp sends a UDP wake_connect broadcast to all phones on LAN.
// Used when a dial request arrives but no phone is connected.
func broadcastWakeUp() {
	udpMu.Lock()
	defer udpMu.Unlock()
	if udpConn == nil {
		return
	}
	msg, err := json.Marshal(map[string]string{
		"type": "wake_connect",
		"pin":  readPin(),
		"ip":   getLocalIP(),
		"port": fmt.Sprintf("%d", Port),
	})
	if err != nil {
		return
	}
	broadAddr := &net.UDPAddr{IP: net.IPv4(255, 255, 255, 255), Port: DiscoveryPort}
	if _, err := udpConn.WriteToUDP(msg, broadAddr); err != nil {
		fileLog("W", "UDP", "", "broadcast wake_connect failed: "+err.Error())
	}
	fileLog("I", "UDP", "", "broadcast wake_connect to LAN")
}

func checkHeartbeats() {
	devicesMu.Lock()
	type timedOutDevice struct {
		pin     string
		isCloud bool
	}
	var toRemove []timedOutDevice
	now := time.Now()
	for pin, d := range devices {
		if !d.LastHeartbeat.IsZero() && now.Sub(d.LastHeartbeat) > HeartbeatTimeout {
			fileLog("W", "DevMgr", pin, fmt.Sprintf("heartbeat timeout (%.0fs)", now.Sub(d.LastHeartbeat).Seconds()))
			// R2收敛: 云设备共享同一 CloudWs，超时只清引用、不关闭共享连接，
			// 避免单台云手机超时触发全体云设备闪断重连
			toRemove = append(toRemove, timedOutDevice{pin: pin, isCloud: d.IsCloud || d.CloudWs != nil})
		}
	}
	devicesMu.Unlock()

	for _, item := range toRemove {
		if item.isCloud {
			removeDevice(item.pin, "cloud")
		} else {
			removeDevice(item.pin, "all")
		}
	}
}
