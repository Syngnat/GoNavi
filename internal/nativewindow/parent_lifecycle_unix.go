//go:build darwin || linux

package nativewindow

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

type unixDetachedParentWatcher struct {
	pid int
}

func newDetachedParentWatcher(pid int) (detachedParentWatcher, error) {
	if pid <= 1 {
		return nil, fmt.Errorf("invalid detached parent process ID: %d", pid)
	}
	return &unixDetachedParentWatcher{pid: pid}, nil
}

func (w *unixDetachedParentWatcher) Alive() (bool, error) {
	if w == nil || w.pid <= 1 {
		return false, nil
	}
	// Unix reparents an orphan to launchd/init. Checking both PPID and signal 0
	// prevents a recycled PID from keeping a detached window alive indefinitely.
	if os.Getppid() != w.pid {
		return false, nil
	}
	err := unix.Kill(w.pid, 0)
	switch {
	case err == nil, errors.Is(err, unix.EPERM):
		return true, nil
	case errors.Is(err, unix.ESRCH):
		return false, nil
	default:
		return true, err
	}
}

func (*unixDetachedParentWatcher) Close() error {
	return nil
}
