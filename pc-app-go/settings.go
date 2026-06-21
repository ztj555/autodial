package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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

var appSettings Settings
var settingsFile string

func defaultSettings() Settings {
	return Settings{
		CloseAction: "minimize",
		TrayExit:    true,
		AutoStart:   false,
		SilentStart: false,
		Theme:       "lavender",
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
	appSettings = defaultSettings()
	data, err := os.ReadFile(settingsFile)
	if err != nil {
		if os.IsNotExist(err) {
			return saveSettings()
		}
		return err
	}
	json.Unmarshal(data, &appSettings)
	// Sync cloudServer to cloudServers
	if appSettings.CloudServer != "" && len(appSettings.CloudServers) == 0 {
		appSettings.CloudServers = []string{appSettings.CloudServer}
	}
	if appSettings.CloudEnabled && len(appSettings.CloudServers) == 0 {
		appSettings.CloudEnabled = false
	}
	return saveSettings()
}

func saveSettings() error {
	os.MkdirAll(filepath.Dir(settingsFile), 0755)
	data, _ := json.MarshalIndent(appSettings, "", "  ")
	return os.WriteFile(settingsFile, data, 0644)
}
