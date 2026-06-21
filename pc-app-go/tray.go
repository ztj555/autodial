package main

import (
	"context"
	"image"
	"image/color"
	"image/draw"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

// Window procedure callback — kept as package-level var to avoid GC
var trayWndProcCB uintptr

var (
	trayWindow   windows.HWND
	trayAdded    bool
	trayHicon    windows.Handle
	trayHbmColor windows.Handle
	trayHbmMask  windows.Handle

	// Track main window visibility — Wails has no IsVisible() API
	mainWindowVisible   = true
	mainWindowVisibleMu sync.Mutex

	trayCleanupOnce sync.Once
)

// ── Windows API DLLs ──

var (
	user32DLL   = windows.NewLazySystemDLL("user32.dll")
	shell32DLL  = windows.NewLazySystemDLL("shell32.dll")
	kernel32DLL = windows.NewLazySystemDLL("kernel32.dll")
	gdi32DLL    = windows.NewLazySystemDLL("gdi32.dll")
)

var (
	pDefWindowProcW      = user32DLL.NewProc("DefWindowProcW")
	pCreateWindowExW     = user32DLL.NewProc("CreateWindowExW")
	pRegisterClassExW    = user32DLL.NewProc("RegisterClassExW")
	pGetMessageW         = user32DLL.NewProc("GetMessageW")
	pTranslateMessage    = user32DLL.NewProc("TranslateMessage")
	pDispatchMessageW    = user32DLL.NewProc("DispatchMessageW")
	pPostQuitMessage     = user32DLL.NewProc("PostQuitMessage")
	pGetCursorPos        = user32DLL.NewProc("GetCursorPos")
	pSetForegroundWindow = user32DLL.NewProc("SetForegroundWindow")
	pShellNotifyIconW    = shell32DLL.NewProc("Shell_NotifyIconW")
	pCreatePopupMenu     = user32DLL.NewProc("CreatePopupMenu")
	pAppendMenuW         = user32DLL.NewProc("AppendMenuW")
	pTrackPopupMenu      = user32DLL.NewProc("TrackPopupMenu")
	pDestroyMenu         = user32DLL.NewProc("DestroyMenu")
	pCreateBitmap        = gdi32DLL.NewProc("CreateBitmap")
	pDeleteObject        = gdi32DLL.NewProc("DeleteObject")
	pGetModuleHandleW    = kernel32DLL.NewProc("GetModuleHandleW")
)

// ── Constants ──

const (
	WM_USER_TRAY = 0x0400 + 100

	NIM_ADD     = 0x00000000
	NIM_DELETE  = 0x00000002
	NIF_MESSAGE = 0x00000001
	NIF_ICON    = 0x00000002
	NIF_TIP     = 0x00000004

	WM_LBUTTONUP = 0x0202
	WM_RBUTTONUP = 0x0205

	MF_STRING    = 0x00000000
	MF_SEPARATOR = 0x00000800

	TPM_RIGHTBUTTON = 0x00000002
	TPM_BOTTOMALIGN = 0x00000020
	TPM_LEFTALIGN   = 0x00000000
	TPM_RETURNCMD   = 0x00000100

	WS_OVERLAPPED = 0x00000000

	ID_TRAY_SHOW     = 1001
	ID_TRAY_FLOATBAR = 1002
	ID_TRAY_SEP      = 1003
	ID_TRAY_EXIT     = 1004
)

// ── Win32 structs ──

type NOTIFYICONDATA struct {
	CbSize           uint32
	HWnd             windows.HWND
	UID              uint32
	UFlags           uint32
	UCallbackMessage uint32
	HIcon            windows.Handle
	SzTip            [128]uint16
	DwState          uint32
	DwStateMask      uint32
	SzInfo           [256]uint16
	UTimeoutVersion  uint32
	SzInfoTitle      [64]uint16
	DwInfoFlags      uint32
	GuidItem         windows.GUID
	HBalloonIcon     windows.Handle
}

type WNDCLASSEXW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     windows.Handle
	HIcon         windows.Handle
	HCursor       windows.Handle
	HbrBackground windows.Handle
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       windows.Handle
}

type POINT struct {
	X int32
	Y int32
}

type ICONINFO struct {
	FIcon    uint32
	XHotspot uint32
	YHotspot uint32
	HbmMask  windows.Handle
	HbmColor windows.Handle
}

type MSG struct {
	HWnd    windows.HWND
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      POINT
}

// ── Window visibility tracking ──

func setMainWindowVisible(v bool) {
	mainWindowVisibleMu.Lock()
	mainWindowVisible = v
	mainWindowVisibleMu.Unlock()
}

func isMainWindowVisible() bool {
	mainWindowVisibleMu.Lock()
	defer mainWindowVisibleMu.Unlock()
	return mainWindowVisible
}

// ── Window procedure ──

func trayWndProc(hwnd windows.HWND, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case WM_USER_TRAY:
		switch uint32(lParam) {
		case WM_LBUTTONUP:
			handleTrayAction("toggle")
		case WM_RBUTTONUP:
			showTrayContextMenu(hwnd)
		}
		return 0
	}
	ret, _, _ := pDefWindowProcW.Call(uintptr(hwnd), uintptr(msg), wParam, lParam)
	return ret
}

// ── Context menu ──

func showTrayContextMenu(hwnd windows.HWND) {
	hMenu, _, _ := pCreatePopupMenu.Call()

	showLabel, _ := syscall.UTF16PtrFromString("显示主窗口")
	floatLabel, _ := syscall.UTF16PtrFromString("悬浮横条")
	exitLabel, _ := syscall.UTF16PtrFromString("退出 AutoDial")

	pAppendMenuW.Call(hMenu, MF_STRING, ID_TRAY_SHOW, uintptr(unsafe.Pointer(showLabel)))
	pAppendMenuW.Call(hMenu, MF_STRING, ID_TRAY_FLOATBAR, uintptr(unsafe.Pointer(floatLabel)))
	pAppendMenuW.Call(hMenu, MF_SEPARATOR, ID_TRAY_SEP, 0)
	pAppendMenuW.Call(hMenu, MF_STRING, ID_TRAY_EXIT, uintptr(unsafe.Pointer(exitLabel)))

	var pt POINT
	pGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	pSetForegroundWindow.Call(uintptr(hwnd))

	cmd, _, _ := pTrackPopupMenu.Call(hMenu,
		TPM_RIGHTBUTTON|TPM_BOTTOMALIGN|TPM_LEFTALIGN|TPM_RETURNCMD,
		uintptr(pt.X), uintptr(pt.Y),
		0, uintptr(hwnd), 0)

	pDestroyMenu.Call(hMenu)

	switch uint32(cmd) {
	case ID_TRAY_SHOW:
		handleTrayAction("show")
	case ID_TRAY_FLOATBAR:
		handleTrayAction("show-floatbar")
	case ID_TRAY_EXIT:
		exitApp()
	}
}

// exitApp runs on the tray message pump thread (inside wndproc call chain).
// It sets the forceQuit flag so OnBeforeClose won't block, removes the tray icon,
// stops the message pump, and directly calls Quit to close the Wails window.
// A timed os.Exit(0) fallback ensures the process terminates even if Quit stalls.
func exitApp() {
	fileLog("I", "Tray", "", "user requested exit from tray menu")
	forceQuit = true
	removeTrayIcon()

	// Call Quit directly — Wails Quit() posts WM_CLOSE to the main window
	// via the internal event bus, which works from any goroutine/thread.
	if rendererCtx != nil {
		wailsRuntime.Quit(rendererCtx)
	}

	// Stop tray message pump (must be after Quit so the event can be dispatched)
	pPostQuitMessage.Call(0)

	// Safety net: if Wails Quit doesn't close the process within 3 seconds,
	// force exit. This handles edge cases where the Wails event loop stalls.
	go func() {
		time.Sleep(1500 * time.Millisecond)
		fileLog("W", "Tray", "", "Quit didn't close, forcing os.Exit")
		os.Exit(0)
	}()
}

// ── Tray action dispatch via Wails events ──
// WindowShow/WindowHide must be called on the Wails main goroutine.
// We emit events from the tray thread and handle them in startup()'s EventsOn.

func handleTrayAction(action string) {
	if rendererCtx != nil {
		wailsRuntime.EventsEmit(rendererCtx, "tray-action", action)
	}
}

// setupTrayActionHandler must be called from startup() (main goroutine).
// It listens for tray events and calls Wails runtime API safely.
func setupTrayActionHandler(ctx context.Context) {
	wailsRuntime.EventsOn(ctx, "tray-action", func(optionalData ...interface{}) {
		if len(optionalData) == 0 {
			return
		}
		action, ok := optionalData[0].(string)
		if !ok {
			return
		}
		switch action {
		case "show":
			wailsRuntime.WindowShow(ctx)
			setMainWindowVisible(true)
			fileLog("I", "Tray", "", "action: show window")
		case "toggle":
			if isMainWindowVisible() {
				wailsRuntime.WindowHide(ctx)
				setMainWindowVisible(false)
				fileLog("I", "Tray", "", "action: hide window (toggle)")
			} else {
				wailsRuntime.WindowShow(ctx)
				setMainWindowVisible(true)
				fileLog("I", "Tray", "", "action: show window (toggle)")
			}
		case "show-floatbar":
			wailsRuntime.WindowShow(ctx)
			setMainWindowVisible(true)
			wailsRuntime.EventsEmit(ctx, "tray-toggle-floatbar", map[string]interface{}{})
			fileLog("I", "Tray", "", "action: show + floatbar")
		}
	})

	// tray-quit relay removed — exitApp now calls wailsRuntime.Quit() directly
}

// ── Icon generation: golden circle with phone receiver ──

func makeTrayHICON() windows.Handle {
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	draw.Draw(img, img.Bounds(), &image.Uniform{color.Transparent}, image.Point{}, draw.Src)

	gold := color.RGBA{201, 168, 76, 255}
	white := color.RGBA{255, 255, 255, 255}

	cx, cy, cr := 16, 16, 14
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			dx, dy := x-cx, y-cy
			if dx*dx+dy*dy <= cr*cr {
				img.Set(x, y, gold)
			}
		}
	}

	for y := 5; y <= 13; y++ {
		for x := 7; x <= 25; x++ {
			dx := float64(x - 16)
			dy := float64(y - 16)
			d2 := dx*dx + dy*dy
			if d2 >= 10.2*10.2 && d2 <= 13.5*13.5 && y <= 11 {
				img.Set(x, y, white)
			}
		}
	}
	for y := 11; y <= 24; y++ {
		for x := 7; x <= 10; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a > 30000 {
				img.Set(x, y, white)
			}
		}
	}
	for y := 11; y <= 24; y++ {
		for x := 22; x <= 25; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a > 30000 {
				img.Set(x, y, white)
			}
		}
	}
	for y := 23; y <= 26; y++ {
		for x := 9; x <= 23; x++ {
			_, _, _, a := img.At(x, y).RGBA()
			if a > 30000 {
				img.Set(x, y, white)
			}
		}
	}

	colorPixels := make([]byte, 32*32*4)
	maskPixels := make([]byte, 32*4)

	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			c := img.At(x, y).(color.RGBA)
			offset := (y*32 + x) * 4
			colorPixels[offset] = c.B
			colorPixels[offset+1] = c.G
			colorPixels[offset+2] = c.R
			colorPixels[offset+3] = 255
			if c.A < 128 {
				maskPixels[y*4+x/8] |= 1 << (7 - (x % 8))
			}
		}
	}

	hColor, _, _ := pCreateBitmap.Call(32, 32, 1, 32, uintptr(unsafe.Pointer(&colorPixels[0])))
	hMask, _, _ := pCreateBitmap.Call(32, 32, 1, 1, uintptr(unsafe.Pointer(&maskPixels[0])))

	if hColor == 0 {
		solidGold := make([]byte, 32*32*4)
		for i := 0; i < len(solidGold); i += 4 {
			solidGold[i] = gold.B
			solidGold[i+1] = gold.G
			solidGold[i+2] = gold.R
			solidGold[i+3] = 255
		}
		hColor, _, _ = pCreateBitmap.Call(32, 32, 1, 32, uintptr(unsafe.Pointer(&solidGold[0])))
		zeroMask := make([]byte, 32*4)
		hMask, _, _ = pCreateBitmap.Call(32, 32, 1, 1, uintptr(unsafe.Pointer(&zeroMask[0])))
	}

	trayHbmColor = windows.Handle(hColor)
	trayHbmMask = windows.Handle(hMask)

	var ii ICONINFO
	ii.FIcon = 1
	ii.HbmColor = windows.Handle(hColor)
	ii.HbmMask = windows.Handle(hMask)

	hicon, _, _ := syscall.NewLazyDLL("user32.dll").NewProc("CreateIconIndirect").Call(
		uintptr(unsafe.Pointer(&ii)),
	)
	return windows.Handle(hicon)
}

// ── Public API ──

func initTray() {
	trayHicon = makeTrayHICON()

	inst, _, _ := pGetModuleHandleW.Call(0)
	clsName, _ := syscall.UTF16PtrFromString("AutoDialTrayClass")

	trayWndProcCB = syscall.NewCallback(trayWndProc)

	var wc WNDCLASSEXW
	wc.CbSize = uint32(unsafe.Sizeof(wc))
	wc.LpfnWndProc = trayWndProcCB
	wc.HInstance = windows.Handle(inst)
	wc.LpszClassName = clsName

	pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

	tw, _, _ := pCreateWindowExW.Call(
		0, uintptr(unsafe.Pointer(clsName)),
		uintptr(unsafe.Pointer(syscall.StringToUTF16Ptr("TrayHelper"))),
		WS_OVERLAPPED,
		0, 0, 0, 0,
		0, 0, inst, 0,
	)
	trayWindow = windows.HWND(tw)

	if trayWindow == 0 {
		fileLog("E", "Tray", "", "failed to create tray helper window")
		return
	}

	addTrayIcon()
	fileLog("I", "Tray", "", "tray icon added, starting message pump")

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		var msg MSG
		for {
			ret, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(ret) <= 0 {
				fileLog("I", "Tray", "", "message pump exiting")
				return
			}
			pTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
			pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
		}
	}()
}

func addTrayIcon() {
	var nid NOTIFYICONDATA
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = trayWindow
	nid.UID = 1
	nid.UFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP
	nid.UCallbackMessage = WM_USER_TRAY
	nid.HIcon = trayHicon

	tip, _ := syscall.UTF16FromString("AutoDial - 一键拨号")
	copy(nid.SzTip[:], tip)

	ret, _, _ := pShellNotifyIconW.Call(NIM_ADD, uintptr(unsafe.Pointer(&nid)))
	if ret != 0 {
		trayAdded = true
	} else {
		fileLog("E", "Tray", "", "Shell_NotifyIcon ADD failed")
	}
}

func removeTrayIcon() {
	if !trayAdded {
		return
	}
	var nid NOTIFYICONDATA
	nid.CbSize = uint32(unsafe.Sizeof(nid))
	nid.HWnd = trayWindow
	nid.UID = 1
	pShellNotifyIconW.Call(NIM_DELETE, uintptr(unsafe.Pointer(&nid)))
	trayAdded = false
	fileLog("I", "Tray", "", "tray icon removed")
}

func cleanupTray() {
	trayCleanupOnce.Do(func() {
		removeTrayIcon()
		pPostQuitMessage.Call(0)
	})
}
