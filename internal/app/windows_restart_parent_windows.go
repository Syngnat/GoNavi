//go:build windows

package app

import (
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
)

// WaitForWindowsRestartParent blocks a relaunched process until the old one
// exits and releases its single-instance lock. Both the v2 and v3 entry points
// call this before creating their application.
func WaitForWindowsRestartParent(args []string) error {
	for _, arg := range args {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(arg)), windowsRestartParentPIDArgument) {
			continue
		}
		pidText := strings.TrimSpace(arg[len(windowsRestartParentPIDArgument):])
		pid, err := strconv.ParseUint(pidText, 10, 32)
		if err != nil || pid <= 1 {
			return fmt.Errorf("invalid restart parent process ID %q", pidText)
		}
		handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
		if err != nil {
			// If the old process has already exited, its handle may no longer be
			// openable; startup can safely continue in that case.
			if err == windows.ERROR_INVALID_PARAMETER || err == windows.ERROR_FILE_NOT_FOUND {
				return nil
			}
			return fmt.Errorf("open restart parent process %d: %w", pid, err)
		}
		defer windows.CloseHandle(handle)
		if _, err := windows.WaitForSingleObject(handle, windows.INFINITE); err != nil {
			return fmt.Errorf("wait for restart parent process %d: %w", pid, err)
		}
		return nil
	}
	return nil
}
