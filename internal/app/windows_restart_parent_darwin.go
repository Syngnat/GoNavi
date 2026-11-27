//go:build darwin

package app

import (
	"errors"
	"fmt"
	"syscall"
	"time"
)

const (
	restartParentPollInterval = 100 * time.Millisecond
	restartParentWaitTimeout  = 120 * time.Second
)

// WaitForWindowsRestartParent waits on macOS until the old process exits.
// The updater launches the new app before quitting so the install no longer
// depends on a helper surviving the old process.
func WaitForWindowsRestartParent(args []string) error {
	pid, found, err := parseRestartParentPID(args)
	if err != nil || !found {
		return err
	}
	deadline := time.Now().Add(restartParentWaitTimeout)
	for {
		err := syscall.Kill(int(pid), 0)
		switch {
		case err == nil:
		case errors.Is(err, syscall.ESRCH):
			return nil
		case errors.Is(err, syscall.EPERM):
		default:
			return fmt.Errorf("check restart parent process %d: %w", pid, err)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("wait for restart parent process %d: timeout", pid)
		}
		time.Sleep(restartParentPollInterval)
	}
}
