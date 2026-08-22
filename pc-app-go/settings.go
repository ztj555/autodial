package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type Settings struct {
	CloseAction  string            `json:"closeAction"`
	TrayExit     bool              `json:"trayExit"`
	AutoStart    bool              `json:"autoStart"`
	SilentStart  bool              `json:"silentStart"`
	Theme        string            `json:"theme"`
	PinCode      string            `json:"pinCode"`
	Mode         string            `json:"mode"`
	PhoneNotes   map[string]string `json:"phoneNotes"`
	CloudServer  string            `json:"cloudServer"`
	CloudEnabled bool              `json:"cloudEnabled"`
	CloudServers []string          `json:"cloudServers"`
}

// R3修复: settingsMu 保护 appSettings 跨 HTTP handler / Wails binding / 云 goroutine
// 并发读写，消除 data race。
var settingsMu sync.RWMutex
var appSettings Settings
var settingsFile string

// getSettings 返回 appSettings 的深拷贝（嵌套 map/slice 一并复制），
// 供各 goroutine 安全读取，避免返回后对共享容器产生竞态。
// 注意：不要在持有 devicesMu/cloudWsMu 之外的其它锁时以会产生反向加锁顺序的
// 方式调用本函数（当前无任何代码在持有 settingsMu 时再取 devicesMu/cloudWsMu）。
func getSettings() Settings {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	s := appSettings
	if s.PhoneNotes != nil {
		notes := make(map[string]string, len(s.PhoneNotes))
		for k, v := range s.PhoneNotes {
			notes[k] = v
		}
		s.PhoneNotes = notes
	}
	if s.CloudServers != nil {
		servers := make([]string, len(s.CloudServers))
		copy(servers, s.CloudServers)
		s.CloudServers = servers
	}
	return s
}

// setSettings 在写锁内整体替换 appSettings。
func setSettings(s Settings) {
	settingsMu.Lock()
	appSettings = s
	settingsMu.Unlock()
}

func defaultSettings() Settings {
	return Settings{
		CloseAction: "minimize",
		TrayExit:    true,
		AutoStart:   false,
		SilentStart: false,
		Theme:       "sky-blue",
		Mode:        "light",
		PhoneNotes:  make(map[string]string),
	}
}

func initSettings() error {
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		cfgDir = filepath.Join(os.Getenv("APPDATA"), "autodial-pc")
	}
	settingsFile = filepath.Join(cfgDir, "settings.json")
	return loadSettings()
}

func loadSettings() error {
	s := defaultSettings()
	setSettings(s)
	data, err := os.ReadFile(settingsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return saveSettings()
		}
		return err
	}
	// Fix D2: check unmarshal errors and log them
	if err := json.Unmarshal(data, &s); err != nil {
		fileLog("W", "Settings", "", "config parse error, using defaults: "+err.Error())
		s = defaultSettings()
		setSettings(s)
		return saveSettings()
	}
	// Sync cloudServer to cloudServers
	if s.CloudServer != "" && len(s.CloudServers) == 0 {
		s.CloudServers = []string{s.CloudServer}
	}
	if s.CloudEnabled && len(s.CloudServers) == 0 {
		s.CloudEnabled = false
	}
	setSettings(s)
	return saveSettings()
}

// saveSettings 原子写：先写同目录临时文件再 os.Rename，避免进程崩溃留下半写文件。
// 注意：不得在持有 settingsMu 写锁时调用本函数（内部会取读锁）。
func saveSettings() error {
	os.MkdirAll(filepath.Dir(settingsFile), 0755)
	settingsMu.RLock()
	data, err := json.MarshalIndent(appSettings, "", "  ")
	settingsMu.RUnlock()
	if err != nil {
		return err
	}
	tmp := settingsFile + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}
	return os.Rename(tmp, settingsFile)
}
