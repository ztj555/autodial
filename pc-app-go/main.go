package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:frontend/dist
var assets embed.FS

// forceQuit bypasses the "minimize on close" logic in OnBeforeClose.
// Set to true when the tray menu or QuitApp requests an actual exit.
var forceQuit bool

// shuttingDown is set to true at the beginning of shutdown().
// notifyUpdate() checks this to avoid pushing events during teardown.
var shuttingDown bool

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "AutoDial",
		Width:     420,
		Height:    780,
		MinWidth:  360,
		MinHeight: 600,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 243, G: 240, B: 255, A: 255}, // lavender light bg
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose: func(ctx context.Context) bool {
			// Programmatic quit (tray exit, QuitApp) — always allow
			if forceQuit {
				return true
			}
			// If tray is active and closeAction is minimize, hide to tray instead of quitting
			if trayAdded && appSettings.CloseAction == "minimize" {
				wailsRuntime.WindowHide(ctx)
				setMainWindowVisible(false)
				return false // prevent quit
			}
			return true // allow quit
		},
		Bind: []interface{}{app},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}

