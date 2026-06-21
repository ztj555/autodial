package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	Port               = 35432
	DiscoveryPort      = 35433
	HeartbeatTimeout   = 120 * time.Second
	NeighborTTL        = 30 * time.Second
	MaxConnections     = 2
	AckTimeout         = 3 * time.Second
	DialQueueTimeout   = 30 * time.Second
	CloudPingInterval  = 15 * time.Second
	CloudPongTimeout   = 20 * time.Second
)

var (
	pinCode      string
	upgrader     = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	devices      = make(map[string]*PhoneDevice)
	activePin    string
	devicesMu    sync.RWMutex
	onUpdate     func()
	pendAcks     = make(map[string]*AckEntry)
	ackMu        sync.Mutex
	msgCounter   int
	dialQueue    = make(map[string]*DialQueueEntry)
	dialQueueMu  sync.Mutex

	// Cloud
	cloudWs             *websocket.Conn
	cloudWsMu           sync.Mutex
	cloudWsLastPong     time.Time
	cloudConnected      bool
	cloudConnecting     bool
	cloudReconnectTimer *time.Timer
)

type PhoneDevice struct {
	Pin          string `json:"pin"`
	Name         string `json:"name"`
	Note         string `json:"note"`
	IP           string `json:"ip"`
	Active       bool   `json:"active"`
	IsCloud      bool   `json:"isCloud"`
	Stale        bool   `json:"stale"`
	ConnType     string `json:"connectionType"`
	Status       string `json:"status"`
	Ws           *websocket.Conn
	CloudWs      *websocket.Conn
	LastHeartbeat time.Time
	ConnectedAt  time.Time
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

func generatePinCode() string {
	// B15修复: v4 架构要求 11 位手机号作为 PIN，不再生成 4 位短码。
	// 首次启动时 pinCode 为空，所有手机连接被拒绝，
	// 用户必须通过 /api/set-pin 或前端设置 11 位手机号。
	// 重启后由 B24 修复从 appSettings.PinCode 恢复。
	return ""
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
		ip       string
		name     string
		isLAN    bool
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
			Pin:          pin,
			Name:         name,
			IP:           ip,
			IsCloud:      isCloud,
			LastHeartbeat: time.Now(),
			ConnectedAt:  time.Now(),
			Status:       "online",
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
	list := make([]map[string]interface{}, 0)
	for pin, d := range devices {
		note := d.Note
		if note == "" {
			note = appSettings.PhoneNotes[pin]
		}
		if note == "" {
			note = appSettings.PhoneNotes[d.Name]
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
	// Legacy callback (unused but kept for compatibility)
	if onUpdate != nil {
		onUpdate()
	}
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
		return fmt.Sprintf("%.0f", val)
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

// isValidPhonePIN checks if the PIN matches the 11-digit Chinese mobile format (^1[3-9]\d{9}$).
// B11修复: 与 Chrome 扩展的 PIN 校验保持一致。
func isValidPhonePIN(pin string) bool {
	if len(pin) != 11 {
		return false
	}
	if pin[0] != '1' {
		return false
	}
	if pin[1] < '3' || pin[1] > '9' {
		return false
	}
	return isNumeric(pin)
}

func checkHeartbeats() {
	devicesMu.Lock()
	var toRemove []string
	now := time.Now()
	for pin, d := range devices {
		if !d.LastHeartbeat.IsZero() && now.Sub(d.LastHeartbeat) > HeartbeatTimeout {
			fileLog("W", "DevMgr", pin, fmt.Sprintf("heartbeat timeout (%.0fs)", now.Sub(d.LastHeartbeat).Seconds()))
			toRemove = append(toRemove, pin)
		}
	}
	devicesMu.Unlock()

	for _, pin := range toRemove {
		removeDevice(pin, "all")
	}
}
