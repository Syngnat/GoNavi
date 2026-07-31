//go:build windows

package nativewindow

import (
	"fmt"

	"golang.org/x/sys/windows"
)

type windowsDetachedParentWatcher struct {
	handle windows.Handle
}

func newDetachedParentWatcher(pid int) (detachedParentWatcher, error) {
	if pid <= 1 {
		return nil, fmt.Errorf("invalid detached parent process ID: %d", pid)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil, fmt.Errorf("open detached parent process %d: %w", pid, err)
	}
	return &windowsDetachedParentWatcher{handle: handle}, nil
}

func (w *windowsDetachedParentWatcher) Alive() (bool, error) {
	if w == nil || w.handle == 0 {
		return false, nil
	}
	result, err := windows.WaitForSingleObject(w.handle, 0)
	if err != nil {
		return true, err
	}
	switch result {
	case windows.WAIT_OBJECT_0:
		return false, nil
	case uint32(windows.WAIT_TIMEOUT):
		return true, nil
	default:
		return true, fmt.Errorf("unexpected detached parent wait result: %d", result)
	}
}

func (w *windowsDetachedParentWatcher) Close() error {
	if w == nil || w.handle == 0 {
		return nil
	}
	err := windows.CloseHandle(w.handle)
	w.handle = 0
	return err
}
