//go:build windows

package singleinstance

import (
	"errors"
	"fmt"

	"golang.org/x/sys/windows"
)

type windowsLock struct {
	handle windows.Handle
	name   string
}

func acquireLock(name string) (platformLock, error) {
	mutexName := "Local\\GoNaviSingleInstance-" + normalizeName(name)
	namePtr, err := windows.UTF16PtrFromString(mutexName)
	if err != nil {
		return nil, fmt.Errorf("encode mutex name: %w", err)
	}

	handle, createErr := windows.CreateMutex(nil, false, namePtr)
	if createErr != nil {
		// 已存在：当前进程不是主实例。
		if errors.Is(createErr, windows.ERROR_ALREADY_EXISTS) {
			if handle != 0 {
				_ = windows.CloseHandle(handle)
			}
			return nil, &lockHeldError{name: name}
		}
		// 权限不足也视为已被占用（例如更高权限实例已持有）。
		if errors.Is(createErr, windows.ERROR_ACCESS_DENIED) {
			return nil, &lockHeldError{name: name}
		}
		return nil, fmt.Errorf("CreateMutex: %w", createErr)
	}

	return &windowsLock{handle: handle, name: name}, nil
}

func (l *windowsLock) Release() error {
	if l == nil || l.handle == 0 {
		return nil
	}
	removeEndpoint(l.name)
	err := windows.CloseHandle(l.handle)
	l.handle = 0
	if err != nil {
		return fmt.Errorf("CloseHandle mutex: %w", err)
	}
	return nil
}

// mutexReleaserName 保留兼容占位，供测试/调试引用。
func mutexReleaserName() string { return "" }
