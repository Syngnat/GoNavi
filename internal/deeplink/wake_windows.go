//go:build windows

package deeplink

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// The wake-up is a named event per executable. The running GoNavi owns it and waits on it; a
// second process started by a gonavi:// link sets it and exits. The name carries a hash of the
// executable's path: a link opens the GoNavi that registered itself, and that is the one whose
// window must come forward, even when another build (installed, portable, development) is
// running as well. Local\ keeps it inside the user's session.
func wakeEventName(exePath string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(exePath))))
	return `Local\GoNavi-deeplink-` + hex.EncodeToString(sum[:8])
}

// SignalRunning wakes the GoNavi that is running from exePath. It reports false when there is
// none, in which case the caller carries on and starts normally.
func SignalRunning(exePath string) (bool, error) {
	name, err := windows.UTF16PtrFromString(wakeEventName(exePath))
	if err != nil {
		return false, err
	}
	event, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, name)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) {
			return false, nil
		}
		return false, fmt.Errorf("open GoNavi wake-up event: %w", err)
	}
	defer windows.CloseHandle(event)
	// This process was started by the person's click and may take the foreground; the running
	// GoNavi, which has not been touched, may not. Let it.
	allowAnyProcessToTakeTheForeground()
	if err := windows.SetEvent(event); err != nil {
		return false, fmt.Errorf("wake GoNavi: %w", err)
	}
	return true, nil
}

func allowAnyProcessToTakeTheForeground() {
	const asfwAny = ^uintptr(0) // (DWORD)-1
	proc := windows.NewLazySystemDLL("user32.dll").NewProc("AllowSetForegroundWindow")
	_, _, _ = proc.Call(asfwAny)
}

// Listen runs onWake each time another process calls SignalRunning for this executable, until
// the returned function is called. When another GoNavi from the same executable already owns
// the event, this one does not listen (the first keeps it) and the returned function does nothing.
func Listen(exePath string, onWake func()) (stop func(), err error) {
	name, err := windows.UTF16PtrFromString(wakeEventName(exePath))
	if err != nil {
		return func() {}, err
	}
	wake, createErr := windows.CreateEvent(nil, 0, 0, name) // auto-reset: one wake, one callback
	if wake == 0 {
		return func() {}, fmt.Errorf("create GoNavi wake-up event: %w", createErr)
	}
	if errors.Is(createErr, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(wake)
		return func() {}, nil
	}
	quit, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(wake)
		return func() {}, fmt.Errorf("create GoNavi wake-up stop event: %w", err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			which, waitErr := windows.WaitForMultipleObjects([]windows.Handle{quit, wake}, false, windows.INFINITE)
			if waitErr != nil || which != windows.WAIT_OBJECT_0+1 {
				return
			}
			if onWake != nil {
				onWake()
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			_ = windows.SetEvent(quit)
			<-done
			windows.CloseHandle(quit)
			windows.CloseHandle(wake)
		})
	}, nil
}

// Register makes exePath the program that opens gonavi:// links for the current user. It
// reports whether it changed anything.
func Register(exePath string) (bool, error) {
	return register(windowsRegistry{}, exePath)
}

type windowsRegistry struct{}

func (windowsRegistry) Get(path, name string) (string, bool) {
	key, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer key.Close()
	value, _, err := key.GetStringValue(name)
	return value, err == nil
}

func (windowsRegistry) Set(path, name, value string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetStringValue(name, value)
}
