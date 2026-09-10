//go:build windows

package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"unsafe"

	"GoNavi-Wails/internal/logger"

	"golang.org/x/sys/windows"
)

const (
	windowsImageIcon       = 1
	windowsLoadFromFile    = 0x0010
	windowsGetIconMessage  = 0x007f
	windowsSetIconMessage  = 0x0080
	windowsIconSmall       = 0
	windowsIconBig         = 1
	windowsClassIconLarge  = -14
	windowsClassIconSmall  = -34
	windowsSmallIconPixels = 16
	windowsLargeIconPixels = 32
)

var (
	windowsApplicationIconUser32          = windows.NewLazySystemDLL("user32.dll")
	windowsApplicationIconLoadImage       = windowsApplicationIconUser32.NewProc("LoadImageW")
	windowsApplicationIconSendMessage     = windowsApplicationIconUser32.NewProc("SendMessageW")
	windowsApplicationIconSetClassLong    = windowsApplicationIconUser32.NewProc("SetClassLongW")
	windowsApplicationIconSetClassLongPtr = windowsApplicationIconUser32.NewProc("SetClassLongPtrW")
	windowsApplicationIconDestroy         = windowsApplicationIconUser32.NewProc("DestroyIcon")
	windowsApplicationIconHandleMu        sync.Mutex
	windowsApplicationIconSmallHandle     uintptr
	windowsApplicationIconLargeHandle     uintptr

	windowsApplicationIconSendMessageCall = func(hwnd, message, wParam, lParam uintptr) uintptr {
		result, _, _ := windowsApplicationIconSendMessage.Call(hwnd, message, wParam, lParam)
		return result
	}
	windowsApplicationIconSetClassIcon = func(hwnd uintptr, index int32, icon uintptr) {
		proc := windowsApplicationIconSetClassLongPtr
		if unsafe.Sizeof(uintptr(0)) == 4 {
			proc = windowsApplicationIconSetClassLong
		}
		proc.Call(hwnd, uintptr(int64(index)), icon)
	}
	windowsApplicationIconSetTaskbarProperties = setWindowsTaskbarProperties
)

func setApplicationIconPNG(pngBytes []byte, configDir string, runtimeContext context.Context) error {
	if len(pngBytes) == 0 {
		return errors.New("application icon PNG is empty")
	}
	if strings.TrimSpace(configDir) == "" {
		configDir = resolveAppConfigDir()
	}
	iconPath, err := persistWindowsApplicationIcon(pngBytes, configDir)
	if err != nil {
		return err
	}
	// Migrate existing taskbar pins before assigning the explicit window AUMID.
	// The update is synchronous so quitting cannot leave a half-written pin.
	if err := updateCurrentWindowsApplicationShortcuts(iconPath); err != nil {
		logger.Warnf("更新 Windows 应用快捷方式图标失败：%v", err)
	}
	_, err = setCurrentWindowsApplicationIcon(runtimeContext, iconPath)
	if err != nil {
		return err
	}
	return nil
}

func setCurrentWindowsApplicationIcon(runtimeContext context.Context, iconPath string) (uintptr, error) {
	small, err := loadWindowsApplicationIcon(iconPath, windowsSmallIconPixels)
	if err != nil {
		return 0, err
	}
	large, err := loadWindowsApplicationIcon(iconPath, windowsLargeIconPixels)
	if err != nil {
		destroyWindowsApplicationIcon(small)
		return 0, err
	}

	mainWindow, err := resolveWailsMainWindowHandle(runtimeContext)
	if err != nil {
		destroyWindowsApplicationIcon(small)
		destroyWindowsApplicationIcon(large)
		return 0, fmt.Errorf("resolve Windows application window: %w", err)
	}
	applyErr := applyWindowsApplicationIcon(mainWindow, iconPath, small, large)

	// WM_SETICON / class icon calls transfer live references to these handles.
	// Keep them alive even when Explorer's taskbar refresh reports an error.
	windowsApplicationIconHandleMu.Lock()
	previousSmall := windowsApplicationIconSmallHandle
	previousLarge := windowsApplicationIconLargeHandle
	windowsApplicationIconSmallHandle = small
	windowsApplicationIconLargeHandle = large
	windowsApplicationIconHandleMu.Unlock()
	destroyWindowsApplicationIcon(previousSmall)
	destroyWindowsApplicationIcon(previousLarge)
	if applyErr != nil {
		return mainWindow, applyErr
	}
	return mainWindow, nil
}

func resolveWailsMainWindowHandle(runtimeContext context.Context) (handle uintptr, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			handle = 0
			err = fmt.Errorf("resolve Wails main window handle panic: %v", recovered)
		}
	}()
	if runtimeContext == nil {
		return 0, errors.New("runtime context is nil")
	}
	frontendValue, err := resolveWailsFrontendValue(runtimeContext)
	if err != nil {
		return 0, err
	}
	mainWindowValue, err := accessibleWailsFrontendField(frontendValue, "mainWindow")
	if err != nil {
		return 0, err
	}
	handleMethod := mainWindowValue.MethodByName("Handle")
	if !handleMethod.IsValid() {
		return 0, errors.New("mainWindow.Handle method not found (wails version may have changed)")
	}
	if handleMethod.Type().NumIn() != 0 || handleMethod.Type().NumOut() != 1 {
		return 0, fmt.Errorf("mainWindow.Handle signature changed: expected func() uintptr, got %v", handleMethod.Type())
	}
	result := handleMethod.Call(nil)[0]
	if result.Kind() != reflect.Uintptr && result.Kind() != reflect.Uint && result.Kind() != reflect.Uint64 && result.Kind() != reflect.Uint32 {
		return 0, fmt.Errorf("mainWindow.Handle returned unsupported kind %v", result.Kind())
	}
	handle = uintptr(result.Uint())
	if handle == 0 {
		return 0, errors.New("mainWindow.Handle returned zero")
	}
	return handle, nil
}

func applyWindowsApplicationIcon(hwnd uintptr, iconPath string, small, large uintptr) error {
	if hwnd == 0 {
		return errors.New("Windows application window handle is zero")
	}
	windowsApplicationIconSendMessageCall(hwnd, windowsSetIconMessage, windowsIconSmall, small)
	windowsApplicationIconSendMessageCall(hwnd, windowsSetIconMessage, windowsIconBig, large)

	// WM_SETICON is the live taskbar/Alt+Tab source. Updating the class fallback
	// as well prevents a later non-client refresh from restoring Wails' embedded
	// executable icon.
	windowsApplicationIconSetClassIcon(hwnd, windowsClassIconSmall, small)
	windowsApplicationIconSetClassIcon(hwnd, windowsClassIconLarge, large)

	actualSmall := windowsApplicationIconSendMessageCall(hwnd, windowsGetIconMessage, windowsIconSmall, 0)
	actualLarge := windowsApplicationIconSendMessageCall(hwnd, windowsGetIconMessage, windowsIconBig, 0)
	if actualSmall != small || actualLarge != large {
		return fmt.Errorf(
			"Windows icon readback mismatch: small=%#x want=%#x, large=%#x want=%#x",
			actualSmall,
			small,
			actualLarge,
			large,
		)
	}
	if err := windowsApplicationIconSetTaskbarProperties(hwnd, iconPath); err != nil {
		return fmt.Errorf("set Windows taskbar icon properties: %w", err)
	}
	return nil
}

func loadWindowsApplicationIcon(iconPath string, size int) (uintptr, error) {
	path, err := windows.UTF16PtrFromString(iconPath)
	if err != nil {
		return 0, fmt.Errorf("encode Windows application icon path: %w", err)
	}
	handle, _, callErr := windowsApplicationIconLoadImage.Call(
		0,
		uintptr(unsafe.Pointer(path)),
		windowsImageIcon,
		uintptr(size),
		uintptr(size),
		windowsLoadFromFile,
	)
	if handle == 0 {
		return 0, fmt.Errorf("load %dx%d Windows application icon: %w", size, size, callErr)
	}
	return handle, nil
}

func destroyWindowsApplicationIcon(handle uintptr) {
	if handle != 0 {
		windowsApplicationIconDestroy.Call(handle)
	}
}

func updateCurrentWindowsApplicationShortcuts(iconPath string) error {
	executablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve Windows application executable: %w", err)
	}
	scriptDir := filepath.Dir(iconPath)
	temporary, err := os.CreateTemp(scriptDir, ".gonavi-brand-shortcuts-*.ps1")
	if err != nil {
		return fmt.Errorf("create Windows shortcut update script: %w", err)
	}
	scriptPath := temporary.Name()
	defer os.Remove(scriptPath)
	script := windowsShortcutRepairPowerShellScript + `

$ErrorActionPreference = 'Stop'
[void](Set-GoNaviShortcutBrandIcon -TargetPath $env:GONAVI_BRAND_TARGET -IconPath $env:GONAVI_BRAND_ICON)
`
	if _, err := temporary.WriteString(strings.ReplaceAll(script, "\n", "\r\n")); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write Windows shortcut update script: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close Windows shortcut update script: %w", err)
	}

	cmd := exec.Command(
		"powershell.exe",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		windowsUpdatePowerShellExecutionPolicy,
		"-File",
		scriptPath,
	)
	cmd.Dir = scriptDir
	cmd.Env = append(cmd.Environ(),
		"GONAVI_BRAND_TARGET="+executablePath,
		"GONAVI_BRAND_ICON="+iconPath,
	)
	configureWindowsUpdateCommand(cmd)
	if output, err := cmd.CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(output))
		if detail != "" {
			return fmt.Errorf("update Windows application shortcuts: %w: %s", err, detail)
		}
		return fmt.Errorf("update Windows application shortcuts: %w", err)
	}
	return nil
}
