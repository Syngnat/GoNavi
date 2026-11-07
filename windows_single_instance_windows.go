//go:build windows && !wails3

package main

import (
	"errors"
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

// The named auto-reset event is both the lifetime lease and the activation
// mailbox. A signal remains pending while the Wails window is still starting.
func acquireWindowsMSISingleInstance(uniqueID string, onSecondInstance func()) (func(), bool, error) {
	eventName, err := windows.UTF16PtrFromString(`Local\GoNavi-` + uniqueID + `-activate`)
	if err != nil {
		return nil, false, fmt.Errorf("build single-instance event name: %w", err)
	}

	activationEvent, eventErr := windows.CreateEvent(nil, 0, 0, eventName)
	if errors.Is(eventErr, windows.ERROR_ALREADY_EXISTS) {
		signalErr := windows.SetEvent(activationEvent)
		windows.CloseHandle(activationEvent)
		if signalErr != nil {
			return nil, false, fmt.Errorf("activate primary GoNavi window: %w", signalErr)
		}
		return nil, false, nil
	}
	if eventErr != nil {
		return nil, false, fmt.Errorf("create single-instance activation event: %w", eventErr)
	}

	stopEvent, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		windows.CloseHandle(activationEvent)
		return nil, false, fmt.Errorf("create single-instance stop event: %w", err)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			event, waitErr := windows.WaitForMultipleObjects(
				[]windows.Handle{stopEvent, activationEvent},
				false,
				windows.INFINITE,
			)
			if waitErr != nil {
				return
			}
			switch event {
			case windows.WAIT_OBJECT_0:
				return
			case windows.WAIT_OBJECT_0 + 1:
				if onSecondInstance != nil {
					onSecondInstance()
				}
			default:
				return
			}
		}
	}()

	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			_ = windows.SetEvent(stopEvent)
			<-done
			windows.CloseHandle(stopEvent)
			windows.CloseHandle(activationEvent)
		})
	}
	return release, true, nil
}
