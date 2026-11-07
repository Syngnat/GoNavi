//go:build windows && !wails3

package app

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type fakeBrandIconWindow struct {
	hwnd uintptr
}

func (w *fakeBrandIconWindow) Handle() uintptr {
	return w.hwnd
}

type fakeBrandIconFrontend struct {
	chromium   *fakeChromium
	mainWindow *fakeBrandIconWindow
}

func TestResolveWailsMainWindowHandleUsesExactFrontendWindow(t *testing.T) {
	const want = uintptr(0x1234)
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBrandIconFrontend{
		chromium:   &fakeChromium{},
		mainWindow: &fakeBrandIconWindow{hwnd: want},
	})

	got, err := resolveWailsMainWindowHandle(ctx)
	if err != nil {
		t.Fatalf("resolve Wails main window handle: %v", err)
	}
	if got != want {
		t.Fatalf("main window handle = %#x, want %#x", got, want)
	}
}

func TestApplyWindowsApplicationIconVerifiesMainWindowReadback(t *testing.T) {
	const (
		hwnd  = uintptr(0x1234)
		small = uintptr(0x2001)
		large = uintptr(0x2002)
	)
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
	})

	current := map[uintptr]uintptr{}
	var calls [][4]uintptr
	windowsApplicationIconSendMessageCall = func(actualHWND, message, iconType, icon uintptr) uintptr {
		calls = append(calls, [4]uintptr{actualHWND, message, iconType, icon})
		switch message {
		case windowsSetIconMessage:
			current[iconType] = icon
		case windowsGetIconMessage:
			return current[iconType]
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(actualHWND uintptr, index int32, icon uintptr) {
		if actualHWND != hwnd {
			t.Fatalf("class icon HWND = %#x, want %#x", actualHWND, hwnd)
		}
		if index != windowsClassIconSmall && index != windowsClassIconLarge {
			t.Fatalf("unexpected class icon index %d", index)
		}
		if icon != small && icon != large {
			t.Fatalf("unexpected class icon handle %#x", icon)
		}
	}
	var taskbarHWND uintptr
	var taskbarIconPath string
	windowsApplicationIconSetTaskbarProperties = func(actualHWND uintptr, iconPath string) error {
		taskbarHWND = actualHWND
		taskbarIconPath = iconPath
		return nil
	}
	var refreshedHWND uintptr
	windowsRefreshTaskbarButton = func(actualHWND uintptr) error {
		refreshedHWND = actualHWND
		return nil
	}

	const iconPath = `C:\Users\tester\gonavi-brand.ico`
	if _, err := applyWindowsApplicationIcon(hwnd, iconPath, small, large); err != nil {
		t.Fatalf("apply Windows application icon: %v", err)
	}
	if len(calls) != 4 {
		t.Fatalf("SendMessage call count = %d, want 4: %#v", len(calls), calls)
	}
	if calls[0] != [4]uintptr{hwnd, windowsSetIconMessage, windowsIconSmall, small} {
		t.Fatalf("small icon update = %#v", calls[0])
	}
	if calls[1] != [4]uintptr{hwnd, windowsSetIconMessage, windowsIconBig, large} {
		t.Fatalf("large icon update = %#v", calls[1])
	}
	if taskbarHWND != hwnd || taskbarIconPath != iconPath {
		t.Fatalf("taskbar properties = (%#x, %q), want (%#x, %q)", taskbarHWND, taskbarIconPath, hwnd, iconPath)
	}
	if refreshedHWND != hwnd {
		t.Fatalf("refreshed taskbar HWND = %#x, want %#x", refreshedHWND, hwnd)
	}
}

func TestApplyWindowsApplicationIconRejectsSilentSetFailure(t *testing.T) {
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
	})
	windowsApplicationIconSendMessageCall = func(_, message, _, _ uintptr) uintptr {
		if message == windowsGetIconMessage {
			return 0
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error {
		t.Fatal("taskbar properties must not update when icon readback failed")
		return nil
	}

	_, err := applyWindowsApplicationIcon(0x1234, `C:\brand.ico`, 0x2001, 0x2002)
	if err == nil {
		t.Fatal("expected readback mismatch to fail")
	}
	if got := err.Error(); !containsAll(got, "readback", "small", "large") {
		t.Fatalf("unexpected readback error: %v", err)
	}
}

func TestApplyWindowsApplicationIconReturnsTaskbarPropertyFailure(t *testing.T) {
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
	})
	windowsApplicationIconSendMessageCall = func(_, message, iconType, icon uintptr) uintptr {
		if message == windowsGetIconMessage {
			if iconType == windowsIconSmall {
				return 0x2001
			}
			return 0x2002
		}
		return icon
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error {
		return errors.New("shell rejected taskbar properties")
	}
	windowsRefreshTaskbarButton = func(uintptr) error {
		t.Fatal("taskbar button must not refresh when properties fail")
		return nil
	}

	_, err := applyWindowsApplicationIcon(0x1234, `C:\brand.ico`, 0x2001, 0x2002)
	if err == nil || !strings.Contains(err.Error(), "taskbar") {
		t.Fatalf("expected taskbar property error, got %v", err)
	}
}

func TestApplyWindowsApplicationIconReturnsTaskbarRefreshFailure(t *testing.T) {
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
	})
	windowsApplicationIconSendMessageCall = func(_, message, iconType, icon uintptr) uintptr {
		if message == windowsGetIconMessage {
			if iconType == windowsIconSmall {
				return 0x2001
			}
			return 0x2002
		}
		return icon
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error { return nil }
	windowsRefreshTaskbarButton = func(uintptr) error {
		return errors.New("Explorer rejected taskbar refresh")
	}

	_, err := applyWindowsApplicationIcon(0x1234, `C:\brand.ico`, 0x2001, 0x2002)
	if err == nil || !strings.Contains(err.Error(), "refresh Windows taskbar icon") {
		t.Fatalf("expected taskbar refresh failure, got %v", err)
	}
}

func containsAll(value string, fragments ...string) bool {
	for _, fragment := range fragments {
		if !strings.Contains(value, fragment) {
			return false
		}
	}
	return true
}

func TestInitializePersistedNativeBrandIconAppliesActiveIcon(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0x22, G: 0x66, B: 0xaa, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	iconPath, err := persistWindowsApplicationIcon(encoded.Bytes(), configDir)
	if err != nil {
		t.Fatalf("persist active icon: %v", err)
	}
	if err := activatePersistedWindowsApplicationIcon(iconPath, configDir); err != nil {
		t.Fatalf("activate active icon: %v", err)
	}

	const (
		hwnd  = uintptr(0x1234)
		small = uintptr(0x2001)
		large = uintptr(0x2002)
	)
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBrandIconFrontend{
		chromium:   &fakeChromium{},
		mainWindow: &fakeBrandIconWindow{hwnd: hwnd},
	})
	application := NewAppWithSecretStore(nil)
	application.configDir = configDir

	originalDPI := windowsApplicationIconSystemDPI
	originalLoad := windowsApplicationIconLoad
	originalDestroy := windowsApplicationIconDestroyCall
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	originalUpdateShortcuts := windowsUpdateCurrentApplicationShortcuts
	originalResolveInstallTarget := updateResolveInstallTarget
	originalVersion := AppVersion
	windowsApplicationIconHandleMu.Lock()
	originalSmallHandle := windowsApplicationIconSmallHandle
	originalLargeHandle := windowsApplicationIconLargeHandle
	windowsApplicationIconSmallHandle = 0
	windowsApplicationIconLargeHandle = 0
	windowsApplicationIconHandleMu.Unlock()
	t.Cleanup(func() {
		windowsApplicationIconSystemDPI = originalDPI
		windowsApplicationIconLoad = originalLoad
		windowsApplicationIconDestroyCall = originalDestroy
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
		windowsUpdateCurrentApplicationShortcuts = originalUpdateShortcuts
		updateResolveInstallTarget = originalResolveInstallTarget
		AppVersion = originalVersion
		windowsApplicationIconHandleMu.Lock()
		windowsApplicationIconSmallHandle = originalSmallHandle
		windowsApplicationIconLargeHandle = originalLargeHandle
		windowsApplicationIconHandleMu.Unlock()
	})

	windowsApplicationIconSystemDPI = func() int { return 96 }
	var loadedSizes []int
	windowsApplicationIconLoad = func(actualPath string, size int) (uintptr, error) {
		if application.ctx != ctx {
			t.Fatal("runtime context was not bound before persisted icon restore")
		}
		if actualPath != iconPath {
			t.Fatalf("loaded icon path = %q, want %q", actualPath, iconPath)
		}
		loadedSizes = append(loadedSizes, size)
		if size == windowsTaskbarIconPixels(96) {
			return small, nil
		}
		return large, nil
	}
	windowsApplicationIconDestroyCall = func(uintptr) {}
	current := map[uintptr]uintptr{}
	windowsApplicationIconSendMessageCall = func(actualHWND, message, iconType, icon uintptr) uintptr {
		if actualHWND != hwnd {
			t.Fatalf("icon message HWND = %#x, want %#x", actualHWND, hwnd)
		}
		switch message {
		case windowsSetIconMessage:
			current[iconType] = icon
		case windowsGetIconMessage:
			return current[iconType]
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	var taskbarIconPath string
	var shortcutIconPath string
	shortcutUpdateCount := 0
	var identityEvents []string
	windowsUpdateCurrentApplicationShortcuts = func(actualPath string) error {
		shortcutUpdateCount++
		shortcutIconPath = actualPath
		identityEvents = append(identityEvents, "shortcut")
		return nil
	}
	installDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(installDir, windowsMSIInstallMarker), []byte("MSI"), 0o644); err != nil {
		t.Fatal(err)
	}
	updateResolveInstallTarget = func() string {
		return filepath.Join(installDir, "GoNavi.exe")
	}
	AppVersion = "1.0.0"
	windowsApplicationIconSetTaskbarProperties = func(actualHWND uintptr, actualPath string) error {
		if actualHWND != hwnd {
			t.Fatalf("taskbar HWND = %#x, want %#x", actualHWND, hwnd)
		}
		taskbarIconPath = actualPath
		identityEvents = append(identityEvents, "window")
		return nil
	}
	windowsRefreshTaskbarButton = func(actualHWND uintptr) error {
		if actualHWND != hwnd {
			t.Fatalf("refresh taskbar HWND = %#x, want %#x", actualHWND, hwnd)
		}
		identityEvents = append(identityEvents, "refresh")
		return nil
	}

	if err := InitializePersistedNativeBrandIcon(application, ctx); err != nil {
		t.Fatalf("initialize persisted native brand icon: %v", err)
	}
	if len(loadedSizes) != 2 || loadedSizes[0] != windowsTaskbarIconPixels(96) || loadedSizes[1] != windowsAltTabIconPixels(96) {
		t.Fatalf("loaded icon sizes = %v, want [%d %d]", loadedSizes, windowsTaskbarIconPixels(96), windowsAltTabIconPixels(96))
	}
	if taskbarIconPath != iconPath {
		t.Fatalf("taskbar icon path = %q, want %q", taskbarIconPath, iconPath)
	}
	if shortcutIconPath != iconPath {
		t.Fatalf("shortcut icon path = %q, want %q", shortcutIconPath, iconPath)
	}
	if got := strings.Join(identityEvents, ","); got != "shortcut,window" {
		t.Fatalf("startup identity order = %q, want shortcut,window", got)
	}
	if err := InitializePersistedNativeBrandIcon(application, ctx); err != nil {
		t.Fatalf("initialize persisted native brand icon again: %v", err)
	}
	if shortcutUpdateCount != 2 {
		t.Fatalf("shortcut update count = %d, want repair on every startup", shortcutUpdateCount)
	}
	AppVersion = "1.0.1"
	if err := InitializePersistedNativeBrandIcon(application, ctx); err != nil {
		t.Fatalf("initialize persisted native brand icon after MSI update: %v", err)
	}
	if shortcutUpdateCount != 3 {
		t.Fatalf("shortcut update count after MSI update = %d, want 3", shortcutUpdateCount)
	}
}

func TestRepairPersistedWindowsApplicationShortcutsRepairsPortablePinOnEveryStartup(t *testing.T) {
	originalUpdateShortcuts := windowsUpdateCurrentApplicationShortcuts
	originalResolveInstallTarget := updateResolveInstallTarget
	originalVersion := AppVersion
	t.Cleanup(func() {
		windowsUpdateCurrentApplicationShortcuts = originalUpdateShortcuts
		updateResolveInstallTarget = originalResolveInstallTarget
		AppVersion = originalVersion
	})

	installDir := t.TempDir()
	updateResolveInstallTarget = func() string {
		return filepath.Join(installDir, "GoNavi.exe")
	}
	AppVersion = "1.2.3"
	called := 0
	windowsUpdateCurrentApplicationShortcuts = func(string) error {
		called++
		return nil
	}
	repairPersistedWindowsApplicationShortcuts(`C:\icons\gonavi-brand.ico`)
	repairPersistedWindowsApplicationShortcuts(`C:\icons\gonavi-brand.ico`)
	if called != 2 {
		t.Fatalf("portable shortcut repair count = %d, want 2", called)
	}
}

func TestRepairPersistedWindowsApplicationShortcutsRetriesAfterFailure(t *testing.T) {
	originalUpdateShortcuts := windowsUpdateCurrentApplicationShortcuts
	originalResolveInstallTarget := updateResolveInstallTarget
	originalVersion := AppVersion
	t.Cleanup(func() {
		windowsUpdateCurrentApplicationShortcuts = originalUpdateShortcuts
		updateResolveInstallTarget = originalResolveInstallTarget
		AppVersion = originalVersion
	})

	installDir := t.TempDir()
	updateResolveInstallTarget = func() string {
		return filepath.Join(installDir, "GoNavi.exe")
	}
	AppVersion = "1.2.3"

	updateCalls := 0
	windowsUpdateCurrentApplicationShortcuts = func(string) error {
		updateCalls++
		if updateCalls == 1 {
			return errors.New("simulated partial shortcut failure")
		}
		return nil
	}
	iconPath := filepath.Join(installDir, "icons", "brand.ico")
	repairPersistedWindowsApplicationShortcuts(iconPath)
	repairPersistedWindowsApplicationShortcuts(iconPath)
	if updateCalls != 2 {
		t.Fatalf("shortcut repair calls = %d, want retry after failure", updateCalls)
	}
}

func TestSetApplicationIconPNGDoesNotActivateAfterShortcutFailure(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0x44, G: 0x88, B: 0xcc, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	if err := clearPersistedWindowsApplicationIcon(configDir); err != nil {
		t.Fatalf("initialize empty active icon state: %v", err)
	}
	originalUpdate := windowsUpdateCurrentApplicationShortcuts
	t.Cleanup(func() { windowsUpdateCurrentApplicationShortcuts = originalUpdate })
	windowsUpdateCurrentApplicationShortcuts = func(string) error {
		return errors.New("shortcut update failed")
	}

	if _, err := setApplicationIconPNG(encoded.Bytes(), configDir, context.Background()); err == nil {
		t.Fatal("expected shortcut update failure")
	}
	activeStatePath := filepath.Join(configDir, windowsApplicationIconDirectoryName, windowsApplicationIconStateFileName)
	if data, err := os.ReadFile(activeStatePath); err != nil || strings.TrimSpace(string(data)) != "" {
		t.Fatalf("active icon state after failed live apply = %q, err=%v, want empty", string(data), err)
	}
}

func TestPrepareWindowsBrandIconRestartDoesNotActivateAfterShortcutFailure(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0x99, G: 0x33, B: 0x55, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	if err := clearPersistedWindowsApplicationIcon(configDir); err != nil {
		t.Fatalf("initialize empty active icon state: %v", err)
	}
	originalUpdate := windowsUpdateCurrentApplicationShortcuts
	t.Cleanup(func() { windowsUpdateCurrentApplicationShortcuts = originalUpdate })
	windowsUpdateCurrentApplicationShortcuts = func(string) error {
		return errors.New("shortcut update failed")
	}

	if err := prepareWindowsBrandIconRestartPNG(encoded.Bytes(), configDir); err == nil {
		t.Fatal("expected shortcut update failure")
	}
	activeStatePath := filepath.Join(configDir, windowsApplicationIconDirectoryName, windowsApplicationIconStateFileName)
	if data, err := os.ReadFile(activeStatePath); err != nil || strings.TrimSpace(string(data)) != "" {
		t.Fatalf("active icon state after failed prepare = %q, err=%v, want empty", string(data), err)
	}
	candidatePath := windowsApplicationIconCandidatePath(encoded.Bytes(), configDir)
	if _, err := os.Stat(candidatePath); err != nil {
		t.Fatalf("failed prepare should retain candidate ICO for partial shortcut updates: %v", err)
	}
}

// 用户报告的回归：全新安装（或从未选过图标）的机器上，原生图标被自动改成
// 吉祥物，而应用内选择器仍是默认值。根因是启动路径在指针缺失时从残留的内容
// 寻址 ICO 里「挑最新」并立刻写成指针，把用户从未选择过的图标固化成当前选择。
// 本用例锁死契约：只有残留 ICO、没有指针时，启动路径必须一个图标应用动作都
// 不做（不加载、不写快捷方式、不碰窗口图标），并保持默认图标。
func TestInitializePersistedNativeBrandIconIgnoresResidualIconsWithoutPointer(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0xcc, G: 0x33, B: 0x11, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	// 残留 ICO：指针引入前的版本落过盘，卸载也刻意保留这些文件。
	if _, err := persistWindowsApplicationIcon(encoded.Bytes(), configDir); err != nil {
		t.Fatalf("persist residual icon: %v", err)
	}
	statePath := filepath.Join(configDir, windowsApplicationIconDirectoryName, windowsApplicationIconStateFileName)
	if _, err := os.Stat(statePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("test precondition: active icon pointer must be absent, stat err=%v", err)
	}

	const hwnd = uintptr(0x1234)
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBrandIconFrontend{
		chromium:   &fakeChromium{},
		mainWindow: &fakeBrandIconWindow{hwnd: hwnd},
	})
	application := NewAppWithSecretStore(nil)
	application.configDir = configDir

	originalPinsDirectory := windowsTaskbarPinsDirectory
	originalUpdateShortcuts := windowsUpdateCurrentApplicationShortcuts
	originalDPI := windowsApplicationIconSystemDPI
	originalLoad := windowsApplicationIconLoad
	originalDestroy := windowsApplicationIconDestroyCall
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRepairDefault := windowsRepairDefaultApplicationShortcuts
	originalResolveInstallTarget := updateResolveInstallTarget
	originalVersion := AppVersion
	windowsApplicationIconHandleMu.Lock()
	originalSmallHandle := windowsApplicationIconSmallHandle
	originalLargeHandle := windowsApplicationIconLargeHandle
	windowsApplicationIconSmallHandle = 0
	windowsApplicationIconLargeHandle = 0
	windowsApplicationIconHandleMu.Unlock()
	t.Cleanup(func() {
		windowsTaskbarPinsDirectory = originalPinsDirectory
		windowsUpdateCurrentApplicationShortcuts = originalUpdateShortcuts
		windowsApplicationIconSystemDPI = originalDPI
		windowsApplicationIconLoad = originalLoad
		windowsApplicationIconDestroyCall = originalDestroy
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRepairDefaultApplicationShortcuts = originalRepairDefault
		updateResolveInstallTarget = originalResolveInstallTarget
		AppVersion = originalVersion
		windowsApplicationIconHandleMu.Lock()
		windowsApplicationIconSmallHandle = originalSmallHandle
		windowsApplicationIconLargeHandle = originalLargeHandle
		windowsApplicationIconHandleMu.Unlock()
	})

	pinsDir := t.TempDir()
	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	// 该分支会派生机器层快捷方式迁移（关闭安装器授予的 Users-Modify 篡改面）。
	// 本用例替换掉它，避免对开发者本机真实快捷方式动手。
	repairDefaultCalls := make(chan struct{}, 1)
	windowsRepairDefaultApplicationShortcuts = func() {
		select {
		case repairDefaultCalls <- struct{}{}:
		default:
		}
	}
	windowsApplicationIconSystemDPI = func() int { return 96 }
	iconLoads := 0
	windowsApplicationIconLoad = func(string, int) (uintptr, error) {
		iconLoads++
		return 0x2001, nil
	}
	windowsApplicationIconDestroyCall = func(uintptr) {}
	windowsApplicationIconSendMessageCall = func(_, _, _, _ uintptr) uintptr { return 0 }
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error { return nil }
	shortcutUpdates := 0
	windowsUpdateCurrentApplicationShortcuts = func(string) error {
		shortcutUpdates++
		return nil
	}
	installDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(installDir, windowsMSIInstallMarker), []byte("MSI"), 0o644); err != nil {
		t.Fatal(err)
	}
	updateResolveInstallTarget = func() string {
		return filepath.Join(installDir, "GoNavi.exe")
	}
	AppVersion = "1.0.0"

	if err := InitializePersistedNativeBrandIcon(application, ctx); err != nil {
		t.Fatalf("initialize persisted native brand icon: %v", err)
	}
	if iconLoads != 0 {
		t.Fatalf("residual ICOs without a pointer must not be applied, icon loads = %d, want 0", iconLoads)
	}
	if shortcutUpdates != 0 {
		t.Fatalf("residual ICOs without a pointer must not rewrite shortcuts, updates = %d, want 0", shortcutUpdates)
	}
	// 不套用图标，但「从未选择过」分支仍必须保留机器层快捷方式迁移：安装器授予
	// 的 Users-Modify 权限是跨用户篡改面，首次启动就该收敛。
	select {
	case <-repairDefaultCalls:
	case <-time.After(time.Second):
		t.Fatal("never-selected startup branch must still migrate machine-layer shortcuts")
	}
	// 启动路径也不得把猜测结果固化成指针：空指针即「已清理」，必须保持原样。
	data, err := os.ReadFile(statePath)
	if err == nil && strings.TrimSpace(string(data)) != "" {
		t.Fatalf("startup invented a selection from residual ICOs: active icon state = %q, want empty", string(data))
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read active icon state: %v", err)
	}
}

func TestRemoveStaleWindowsShortcutUpdateScriptsKeepsIconState(t *testing.T) {
	configDir := t.TempDir()
	iconDir := filepath.Join(configDir, windowsApplicationIconDirectoryName)
	if err := os.MkdirAll(iconDir, 0o755); err != nil {
		t.Fatal(err)
	}
	staleScripts := []string{".gonavi-brand-shortcuts-123.ps1", ".gonavi-brand-shortcuts-456.ps1"}
	for _, name := range staleScripts {
		if err := os.WriteFile(filepath.Join(iconDir, name), []byte("script"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	keep := map[string]string{
		"gonavi-brand-d89e4f026a938e22fe081e12.ico": "ico",
		windowsApplicationIconStateFileName:         "gonavi-brand-d89e4f026a938e22fe081e12.ico\n",
		".gonavi-brand-shortcuts.ps1":               "not matching the numbered temp pattern",
	}
	for name, content := range keep {
		if err := os.WriteFile(filepath.Join(iconDir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	removeStaleWindowsShortcutUpdateScripts(configDir)

	for _, name := range staleScripts {
		if _, err := os.Stat(filepath.Join(iconDir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("stale shortcut script %s was not removed: %v", name, err)
		}
	}
	for name := range keep {
		if _, err := os.Stat(filepath.Join(iconDir, name)); err != nil {
			t.Fatalf("cleanup removed %s: %v", name, err)
		}
	}
}

func TestWindowsDiffPinsNameSets(t *testing.T) {
	added, removed := windowsDiffPinsNameSets("gonavi.lnk\nsteam.lnk", "explorer.lnk\ngonavi.lnk")
	if len(added) != 1 || added[0] != "explorer.lnk" {
		t.Fatalf("unexpected added set: %v", added)
	}
	if len(removed) != 1 || removed[0] != "steam.lnk" {
		t.Fatalf("unexpected removed set: %v", removed)
	}
	added, removed = windowsDiffPinsNameSets("", "")
	if len(added) != 0 || len(removed) != 0 {
		t.Fatalf("empty sets must not diff: %v %v", added, removed)
	}
}

func TestWindowsPinsChangeAffectsGoNavi(t *testing.T) {
	cases := []struct {
		name    string
		added   []string
		removed []string
		want    bool
	}{
		{name: "our pin added", added: []string{"gonavi.lnk"}, want: true},
		{name: "our rotated pin removed", removed: []string{"gonavi (2).lnk"}, want: true},
		{name: "foreign pins only", added: []string{"chrome.lnk"}, removed: []string{"steam.lnk"}, want: false},
		{name: "nothing changed", want: false},
	}
	for _, tc := range cases {
		if got := windowsPinsChangeAffectsGoNavi(tc.added, tc.removed); got != tc.want {
			t.Fatalf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestWindowsSendShortcutRefreshNotificationsUsesKnownFolders(t *testing.T) {
	var items, directories []string
	previousItem := windowsApplicationIconNotifyItemChanged
	previousDirectory := windowsApplicationIconNotifyDirectoryChanged
	defer func() {
		windowsApplicationIconNotifyItemChanged = previousItem
		windowsApplicationIconNotifyDirectoryChanged = previousDirectory
	}()
	windowsApplicationIconNotifyItemChanged = func(path string) { items = append(items, path) }
	windowsApplicationIconNotifyDirectoryChanged = func(path string) { directories = append(directories, path) }

	windowsSendShortcutRefreshNotifications()

	if len(directories) == 0 {
		t.Fatal("no folder notifications were sent")
	}
	seenPrograms := false
	for _, dir := range directories {
		if strings.HasSuffix(strings.ToLower(dir), `start menu\programs`) {
			seenPrograms = true
		}
	}
	if !seenPrograms {
		t.Fatalf("Start Menu Programs folder missing from refresh pass: %v", directories)
	}
	// Item notifications only fire for existing GoNavi-prefixed .lnk files
	// (the same name set the repair script claims); on a clean machine none
	// exist, which must not error or notify.
	for _, item := range items {
		base := strings.ToLower(filepath.Base(item))
		if !strings.HasSuffix(base, ".lnk") || !strings.HasPrefix(base, "gonavi") {
			t.Fatalf("unexpected item notification target: %s", item)
		}
	}
}

func TestWindowsGoNaviShortcutNamesInClaimsVariantNames(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"GoNavi.lnk", "GoNavi (2).lnk", "GoNavi-rotated.lnk", "File Explorer.lnk", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "GoNavi-directory.lnk"), 0o755); err != nil {
		t.Fatal(err)
	}
	got := windowsGoNaviShortcutNamesIn(dir)
	want := []string{"GoNavi (2).lnk", "GoNavi-rotated.lnk", "GoNavi.lnk"}
	if !slices.Equal(got, want) {
		t.Fatalf("claimed names = %v, want %v", got, want)
	}
	if missing := windowsGoNaviShortcutNamesIn(filepath.Join(dir, "not-exist")); missing != nil {
		t.Fatalf("missing directory should claim nothing, got %v", missing)
	}
}

func TestWindowsSendShortcutRefreshNotificationsTargetsVariantPin(t *testing.T) {
	var items, directories []string
	previousItem := windowsApplicationIconNotifyItemChanged
	previousDirectory := windowsApplicationIconNotifyDirectoryChanged
	previousDirectories := windowsKnownGoNaviShortcutDirectories
	previousPins := windowsTaskbarPinsDirectory
	defer func() {
		windowsApplicationIconNotifyItemChanged = previousItem
		windowsApplicationIconNotifyDirectoryChanged = previousDirectory
		windowsKnownGoNaviShortcutDirectories = previousDirectories
		windowsTaskbarPinsDirectory = previousPins
	}()
	windowsApplicationIconNotifyItemChanged = func(path string) { items = append(items, path) }
	windowsApplicationIconNotifyDirectoryChanged = func(path string) { directories = append(directories, path) }

	pinsDir := t.TempDir()
	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	windowsKnownGoNaviShortcutDirectories = func() []string { return []string{pinsDir} }

	// 固定项不叫 GoNavi.lnk（如副本 GoNavi (2).lnk）时也必须按实际
	// 文件路径发出单项通知。
	variantPin := filepath.Join(pinsDir, "GoNavi (2).lnk")
	if err := os.WriteFile(variantPin, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	windowsSendShortcutRefreshNotifications()

	if len(items) != 1 || items[0] != variantPin {
		t.Fatalf("item notifications = %v, want [%s]", items, variantPin)
	}
	if len(directories) != 0 {
		t.Fatalf("taskbar directory must not receive broad refresh notifications: %v", directories)
	}
}

func TestWindowsSendShortcutRefreshNotificationsSkipsForeignPin(t *testing.T) {
	previousItem := windowsApplicationIconNotifyItemChanged
	previousDirectory := windowsApplicationIconNotifyDirectoryChanged
	previousDirectories := windowsKnownGoNaviShortcutDirectories
	previousPins := windowsTaskbarPinsDirectory
	defer func() {
		windowsApplicationIconNotifyItemChanged = previousItem
		windowsApplicationIconNotifyDirectoryChanged = previousDirectory
		windowsKnownGoNaviShortcutDirectories = previousDirectories
		windowsTaskbarPinsDirectory = previousPins
	}()
	windowsApplicationIconNotifyItemChanged = func(path string) {}
	windowsApplicationIconNotifyDirectoryChanged = func(path string) {}

	pinsDir := t.TempDir()
	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	windowsKnownGoNaviShortcutDirectories = func() []string { return []string{pinsDir} }
	if err := os.WriteFile(filepath.Join(pinsDir, "File Explorer.lnk"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	windowsSendShortcutRefreshNotifications()

}

// 45s 超时硬杀会绕过脚本自身的清理路径，桌面/开始菜单目录里会留下
// "GoNavi-gonavi-update-<8hex>.lnk" 替换残渣；启动清理必须删除它们且不
// 碰正常快捷方式。
func TestRemoveStaleWindowsShortcutReplacementFiles(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "GoNavi-gonavi-update-1a2b3c4d.lnk")
	variantStale := filepath.Join(dir, "GoNavi (2)-gonavi-update-deadbeef.lnk")
	keep := filepath.Join(dir, "GoNavi.lnk")
	notHex := filepath.Join(dir, "GoNavi-gonavi-update-zzzzzzzz.lnk")
	for _, path := range []string{stale, variantStale, keep, notHex} {
		if err := os.WriteFile(path, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	previousDirectories := windowsKnownGoNaviShortcutDirectories
	defer func() { windowsKnownGoNaviShortcutDirectories = previousDirectories }()
	windowsKnownGoNaviShortcutDirectories = func() []string { return []string{dir} }

	removeStaleWindowsShortcutReplacementFiles()

	for _, path := range []string{stale, variantStale} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("stale replacement file was not removed: %s", path)
		}
	}
	for _, path := range []string{keep, notHex} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("unrelated file was removed: %s", path)
		}
	}
}

func TestWindowsShortcutUpdateFailedCount(t *testing.T) {
	testCases := []struct {
		name   string
		output string
		want   int
	}{
		{name: "marker absent", output: "some noise only\n", want: 0},
		{name: "zero failures", output: "UPDATED=5 FAILED=0\n", want: 0},
		{name: "with failures", output: "noise\nUPDATED=3 FAILED=2\r\nmore", want: 2},
		{name: "missing failed marker", output: "UPDATED=3\n", want: 0},
		{name: "negative count", output: "UPDATED=3 FAILED=-1", want: 0},
		{name: "non numeric count", output: "UPDATED=3 FAILED=many", want: 0},
	}
	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			if got := windowsShortcutUpdateFailedCount(tc.output); got != tc.want {
				t.Fatalf("windowsShortcutUpdateFailedCount(%q) = %d, want %d", tc.output, got, tc.want)
			}
		})
	}
}

// 每次实时切换都必须恰好补发一次全局关联刷新：固定按钮（含刚取消固定的）
// 图标快照对其他一切刷新手段（UPDATEITEM/窗口属性/DeleteTab+AddTab/
// WM_SETICON）都不重采样，且无法区分「从未固定」与「刚取消固定」。刷新位
// 置必须在快捷方式与窗口身份都提交之后，否则 Explorer 采样到中间态。
func TestSetApplicationIconPNGFlushesAssociationOnEveryLiveSwitch(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 2, 2))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0x10, G: 0x42, B: 0x88, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	pinsDir := t.TempDir()
	pinPath := filepath.Join(pinsDir, "GoNavi.lnk")
	if err := os.WriteFile(pinPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	const (
		hwnd  = uintptr(0x1234)
		small = uintptr(0x2001)
		large = uintptr(0x2002)
	)
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBrandIconFrontend{
		chromium:   &fakeChromium{},
		mainWindow: &fakeBrandIconWindow{hwnd: hwnd},
	})

	originalPinsDirectory := windowsTaskbarPinsDirectory
	originalUpdateShortcuts := windowsUpdateCurrentApplicationShortcuts
	originalDPI := windowsApplicationIconSystemDPI
	originalLoad := windowsApplicationIconLoad
	originalDestroy := windowsApplicationIconDestroyCall
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	originalAssociationChanged := windowsApplicationIconNotifyAssociationChanged
	originalRecreateForPin := windowsRecreateTaskbarButtonForPinRefresh
	windowsApplicationIconHandleMu.Lock()
	originalSmallHandle := windowsApplicationIconSmallHandle
	originalLargeHandle := windowsApplicationIconLargeHandle
	windowsApplicationIconSmallHandle = 0
	windowsApplicationIconLargeHandle = 0
	windowsApplicationIconHandleMu.Unlock()
	t.Cleanup(func() {
		windowsTaskbarPinsDirectory = originalPinsDirectory
		windowsUpdateCurrentApplicationShortcuts = originalUpdateShortcuts
		windowsApplicationIconSystemDPI = originalDPI
		windowsApplicationIconLoad = originalLoad
		windowsApplicationIconDestroyCall = originalDestroy
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
		windowsApplicationIconNotifyAssociationChanged = originalAssociationChanged
		windowsRecreateTaskbarButtonForPinRefresh = originalRecreateForPin
		windowsApplicationIconHandleMu.Lock()
		windowsApplicationIconSmallHandle = originalSmallHandle
		windowsApplicationIconLargeHandle = originalLargeHandle
		windowsApplicationIconHandleMu.Unlock()
	})

	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	windowsUpdateCurrentApplicationShortcuts = func(string) error { return nil }
	windowsApplicationIconSystemDPI = func() int { return 96 }
	windowsApplicationIconLoad = func(string, int) (uintptr, error) { return small, nil }
	windowsApplicationIconDestroyCall = func(uintptr) {}
	current := map[uintptr]uintptr{}
	windowsApplicationIconSendMessageCall = func(_, message, iconType, icon uintptr) uintptr {
		switch message {
		case windowsSetIconMessage:
			current[iconType] = icon
		case windowsGetIconMessage:
			return current[iconType]
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error { return nil }
	windowsRefreshTaskbarButton = func(uintptr) error { return nil }
	associationFlushes := 0
	windowsApplicationIconNotifyAssociationChanged = func() { associationFlushes++ }
	recreatesForPin := 0
	windowsRecreateTaskbarButtonForPinRefresh = func(uintptr) bool { recreatesForPin++; return true }

	if _, err := setApplicationIconPNG(encoded.Bytes(), configDir, ctx); err != nil {
		t.Fatalf("set application icon with GoNavi pin: %v", err)
	}
	if associationFlushes != 1 {
		t.Fatalf("association flush count with GoNavi pin = %d, want 1", associationFlushes)
	}
	// 一次切换只允许一次按钮重建：历史上曾因重复调用块导致固定窗口隐藏/
	// 恢复两次（窗口闪两下），且第二次失败会跳过持久化激活造成状态分裂。
	if recreatesForPin != 1 {
		t.Fatalf("taskbar recreate count with GoNavi pin = %d, want 1", recreatesForPin)
	}

	if err := os.Remove(pinPath); err != nil {
		t.Fatal(err)
	}
	if _, err := setApplicationIconPNG(encoded.Bytes(), configDir, ctx); err != nil {
		t.Fatalf("set application icon without GoNavi pin: %v", err)
	}
	if associationFlushes != 2 {
		t.Fatalf("association flush count after pin removal = %d, want 2 (unpinned buttons keep a stale snapshot too)", associationFlushes)
	}
	if recreatesForPin != 1 {
		t.Fatalf("taskbar recreate count after pin removal = %d, want 1 (no pin, no recreate)", recreatesForPin)
	}
}

// 启动期恢复不得发送全局关联刷新：启动时任务栏按钮本就按已改写的固定项
// 重建，此时刷新只会带来一次无意义的全桌面重绘。
func TestInitializePersistedNativeBrandIconDoesNotFlushAssociation(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	source.SetNRGBA(0, 0, color.NRGBA{R: 0x22, G: 0x66, B: 0xaa, A: 0xff})
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatal(err)
	}
	configDir := t.TempDir()
	iconPath, err := persistWindowsApplicationIcon(encoded.Bytes(), configDir)
	if err != nil {
		t.Fatalf("persist active icon: %v", err)
	}
	if err := activatePersistedWindowsApplicationIcon(iconPath, configDir); err != nil {
		t.Fatalf("activate active icon: %v", err)
	}

	const hwnd = uintptr(0x1234)
	ctx := context.WithValue(context.Background(), stringContextKey("frontend"), &fakeBrandIconFrontend{
		chromium:   &fakeChromium{},
		mainWindow: &fakeBrandIconWindow{hwnd: hwnd},
	})
	application := NewAppWithSecretStore(nil)
	application.configDir = configDir

	pinsDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(pinsDir, "GoNavi.lnk"), nil, 0o644); err != nil {
		t.Fatal(err)
	}

	originalPinsDirectory := windowsTaskbarPinsDirectory
	originalUpdateShortcuts := windowsUpdateCurrentApplicationShortcuts
	originalDPI := windowsApplicationIconSystemDPI
	originalLoad := windowsApplicationIconLoad
	originalDestroy := windowsApplicationIconDestroyCall
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	originalAssociationChanged := windowsApplicationIconNotifyAssociationChanged
	originalResolveInstallTarget := updateResolveInstallTarget
	originalVersion := AppVersion
	windowsApplicationIconHandleMu.Lock()
	originalSmallHandle := windowsApplicationIconSmallHandle
	originalLargeHandle := windowsApplicationIconLargeHandle
	windowsApplicationIconSmallHandle = 0
	windowsApplicationIconLargeHandle = 0
	windowsApplicationIconHandleMu.Unlock()
	t.Cleanup(func() {
		windowsTaskbarPinsDirectory = originalPinsDirectory
		windowsUpdateCurrentApplicationShortcuts = originalUpdateShortcuts
		windowsApplicationIconSystemDPI = originalDPI
		windowsApplicationIconLoad = originalLoad
		windowsApplicationIconDestroyCall = originalDestroy
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
		windowsApplicationIconNotifyAssociationChanged = originalAssociationChanged
		updateResolveInstallTarget = originalResolveInstallTarget
		AppVersion = originalVersion
		windowsApplicationIconHandleMu.Lock()
		windowsApplicationIconSmallHandle = originalSmallHandle
		windowsApplicationIconLargeHandle = originalLargeHandle
		windowsApplicationIconHandleMu.Unlock()
	})

	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	windowsUpdateCurrentApplicationShortcuts = func(string) error { return nil }
	windowsApplicationIconSystemDPI = func() int { return 96 }
	windowsApplicationIconLoad = func(string, int) (uintptr, error) { return 0x2001, nil }
	windowsApplicationIconDestroyCall = func(uintptr) {}
	current := map[uintptr]uintptr{}
	windowsApplicationIconSendMessageCall = func(_, message, iconType, icon uintptr) uintptr {
		switch message {
		case windowsSetIconMessage:
			current[iconType] = icon
		case windowsGetIconMessage:
			return current[iconType]
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error { return nil }
	windowsRefreshTaskbarButton = func(uintptr) error { return nil }
	associationFlushes := 0
	windowsApplicationIconNotifyAssociationChanged = func() { associationFlushes++ }
	installDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(installDir, windowsMSIInstallMarker), []byte("MSI"), 0o644); err != nil {
		t.Fatal(err)
	}
	updateResolveInstallTarget = func() string {
		return filepath.Join(installDir, "GoNavi.exe")
	}
	AppVersion = "1.0.0"

	if err := InitializePersistedNativeBrandIcon(application, ctx); err != nil {
		t.Fatalf("initialize persisted native brand icon: %v", err)
	}
	if associationFlushes != 0 {
		t.Fatalf("association flush count on startup restore = %d, want 0", associationFlushes)
	}
}

// 实时切换时只有存在本应用固定项才强制重建任务栏按钮（隐藏/恢复窗口）：
// 固定按钮的图标快照对其他一切手段都不重采样；启动路径（refreshTaskbar=
// false）与无固定项时不得触发，避免无意义的窗口闪烁。
func TestApplyWindowsApplicationIconModeRecreatesButtonOnlyForPins(t *testing.T) {
	pinsDir := t.TempDir()
	pinPath := filepath.Join(pinsDir, "GoNavi.lnk")
	if err := os.WriteFile(pinPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	const (
		hwnd  = uintptr(0x1234)
		small = uintptr(0x2001)
		large = uintptr(0x2002)
	)
	originalPinsDirectory := windowsTaskbarPinsDirectory
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	originalRecreate := windowsRecreateTaskbarButtonForPinRefresh
	t.Cleanup(func() {
		windowsTaskbarPinsDirectory = originalPinsDirectory
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
		windowsRecreateTaskbarButtonForPinRefresh = originalRecreate
	})
	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	current := map[uintptr]uintptr{}
	windowsApplicationIconSendMessageCall = func(_, message, iconType, icon uintptr) uintptr {
		switch message {
		case windowsSetIconMessage:
			current[iconType] = icon
		case windowsGetIconMessage:
			return current[iconType]
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error { return nil }
	windowsRefreshTaskbarButton = func(uintptr) error { return nil }
	recreated := 0
	windowsRecreateTaskbarButtonForPinRefresh = func(uintptr) bool { recreated++; return true }

	if _, err := applyWindowsApplicationIconMode(hwnd, `C:\brand.ico`, small, large, true); err != nil {
		t.Fatalf("apply icon with pin: %v", err)
	}
	if recreated != 1 {
		t.Fatalf("recreation count with pin = %d, want 1", recreated)
	}

	if err := os.Remove(pinPath); err != nil {
		t.Fatal(err)
	}
	if _, err := applyWindowsApplicationIconMode(hwnd, `C:\brand.ico`, small, large, true); err != nil {
		t.Fatalf("apply icon without pin: %v", err)
	}
	if recreated != 1 {
		t.Fatalf("recreation count without pin = %d, want still 1", recreated)
	}

	if err := os.WriteFile(pinPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := applyWindowsApplicationIconMode(hwnd, `C:\brand.ico`, small, large, false); err != nil {
		t.Fatalf("apply icon on startup path: %v", err)
	}
	if recreated != 1 {
		t.Fatalf("recreation count on startup path = %d, want still 1", recreated)
	}
}

// 固定项按钮重建失败时热应用并未覆盖固定按钮（Explorer 快照不重采样）：
// 必须透传 restartRecommended 让前端引导用户重启；重建成功时不得误报。
func TestApplyWindowsApplicationIconModeReportsRestartRecommendedWhenPinRebuildFails(t *testing.T) {
	pinsDir := t.TempDir()
	pinPath := filepath.Join(pinsDir, "GoNavi.lnk")
	if err := os.WriteFile(pinPath, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	const (
		hwnd  = uintptr(0x1234)
		small = uintptr(0x2001)
		large = uintptr(0x2002)
	)
	originalPinsDirectory := windowsTaskbarPinsDirectory
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	originalRefreshTaskbar := windowsRefreshTaskbarButton
	originalRecreate := windowsRecreateTaskbarButtonForPinRefresh
	t.Cleanup(func() {
		windowsTaskbarPinsDirectory = originalPinsDirectory
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
		windowsRefreshTaskbarButton = originalRefreshTaskbar
		windowsRecreateTaskbarButtonForPinRefresh = originalRecreate
	})
	windowsTaskbarPinsDirectory = func() string { return pinsDir }
	current := map[uintptr]uintptr{}
	windowsApplicationIconSendMessageCall = func(_, message, iconType, icon uintptr) uintptr {
		switch message {
		case windowsSetIconMessage:
			current[iconType] = icon
		case windowsGetIconMessage:
			return current[iconType]
		}
		return 0
	}
	windowsApplicationIconSetClassIcon = func(uintptr, int32, uintptr) {}
	windowsApplicationIconSetTaskbarProperties = func(uintptr, string) error { return nil }
	windowsRefreshTaskbarButton = func(uintptr) error { return nil }

	windowsRecreateTaskbarButtonForPinRefresh = func(uintptr) bool { return false }
	restartRecommended, err := applyWindowsApplicationIconMode(hwnd, `C:\brand.ico`, small, large, true)
	if err != nil {
		t.Fatalf("apply icon with failed pin rebuild: %v", err)
	}
	if !restartRecommended {
		t.Fatal("expected restartRecommended when pin rebuild fails")
	}

	windowsRecreateTaskbarButtonForPinRefresh = func(uintptr) bool { return true }
	restartRecommended, err = applyWindowsApplicationIconMode(hwnd, `C:\brand.ico`, small, large, true)
	if err != nil {
		t.Fatalf("apply icon with successful pin rebuild: %v", err)
	}
	if restartRecommended {
		t.Fatal("expected no restart recommendation when pin rebuild succeeds")
	}
}

// 无法读取窗口状态（假句柄、句柄为 0）时必须整体放弃：盲目隐藏会破坏窗口
// 状态，宁可让固定按钮等待下次机会。
func TestRecreateWindowsTaskbarButtonForPinRefreshSkipsUnknownState(t *testing.T) {
	if recreateWindowsTaskbarButtonForPinRefresh(0) {
		t.Fatal("zero hwnd must skip recreation")
	}
	// 假句柄：GetWindowPlacement 失败 → 返回 false 且不产生副作用。
	if recreateWindowsTaskbarButtonForPinRefresh(0xdeadbeef) {
		t.Fatal("unknown hwnd must skip recreation")
	}
}
