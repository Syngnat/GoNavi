//go:build windows

package app

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var windowsShell32 = windows.NewLazySystemDLL("shell32.dll")
var windowsSetCurrentProcessExplicitAppUserModelID = windowsShell32.NewProc("SetCurrentProcessExplicitAppUserModelID")

// InitializeWindowsApplicationIdentity must run before Wails creates the main
// window. Otherwise Explorer may create the taskbar button under the
// executable's implicit identity and keep serving its embedded icon. The
// stable identity keeps the process, live window, and taskbar shortcut in the
// same Explorer group across icon changes.
func InitializeWindowsApplicationIdentity() error {
	if err := windowsSetCurrentProcessExplicitAppUserModelID.Find(); err != nil {
		return fmt.Errorf("resolve SetCurrentProcessExplicitAppUserModelID: %w", err)
	}
	id, err := windows.UTF16PtrFromString(windowsApplicationUserModelIDForStartup(resolveAppConfigDir()))
	if err != nil {
		return fmt.Errorf("encode Windows application identity: %w", err)
	}
	result, _, callErr := windowsSetCurrentProcessExplicitAppUserModelID.Call(uintptr(unsafe.Pointer(id)))
	if windowsHRESULTFailed(result) {
		return fmt.Errorf("set Windows application identity: HRESULT %#x: %w", uint32(result), callErr)
	}
	return nil
}
