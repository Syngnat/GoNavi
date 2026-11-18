//go:build windows && !wails3

package nativewindow

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

var allowSetForegroundWindowProc = windows.NewLazySystemDLL("user32.dll").NewProc("AllowSetForegroundWindow")

var allowSetForegroundWindow = func(processID uint32) bool {
	result, _, _ := allowSetForegroundWindowProc.Call(uintptr(processID))
	return result != 0
}

func grantParentForegroundAccess() error {
	parentProcessID := os.Getppid()
	if parentProcessID <= 0 {
		return fmt.Errorf("invalid parent process ID %d", parentProcessID)
	}
	if !allowSetForegroundWindow(uint32(parentProcessID)) {
		return fmt.Errorf("AllowSetForegroundWindow rejected parent process %d", parentProcessID)
	}
	return nil
}
