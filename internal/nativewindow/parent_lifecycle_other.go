//go:build !darwin && !linux && !windows

package nativewindow

import (
	"fmt"
	"os"
)

type genericDetachedParentWatcher struct {
	pid int
}

func newDetachedParentWatcher(pid int) (detachedParentWatcher, error) {
	if pid <= 1 {
		return nil, fmt.Errorf("invalid detached parent process ID: %d", pid)
	}
	return &genericDetachedParentWatcher{pid: pid}, nil
}

func (w *genericDetachedParentWatcher) Alive() (bool, error) {
	return w != nil && os.Getppid() == w.pid, nil
}

func (*genericDetachedParentWatcher) Close() error {
	return nil
}
