//go:build windows

package app

import (
	"context"
	"errors"
	"strings"
	"testing"
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
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
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

	const iconPath = `C:\Users\tester\gonavi-brand.ico`
	if err := applyWindowsApplicationIcon(hwnd, iconPath, small, large); err != nil {
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
}

func TestApplyWindowsApplicationIconRejectsSilentSetFailure(t *testing.T) {
	originalSend := windowsApplicationIconSendMessageCall
	originalSetClass := windowsApplicationIconSetClassIcon
	originalSetTaskbarProperties := windowsApplicationIconSetTaskbarProperties
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
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

	err := applyWindowsApplicationIcon(0x1234, `C:\brand.ico`, 0x2001, 0x2002)
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
	t.Cleanup(func() {
		windowsApplicationIconSendMessageCall = originalSend
		windowsApplicationIconSetClassIcon = originalSetClass
		windowsApplicationIconSetTaskbarProperties = originalSetTaskbarProperties
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

	err := applyWindowsApplicationIcon(0x1234, `C:\brand.ico`, 0x2001, 0x2002)
	if err == nil || !strings.Contains(err.Error(), "taskbar") {
		t.Fatalf("expected taskbar property error, got %v", err)
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
