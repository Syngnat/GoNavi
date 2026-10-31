//go:build windows

package appdata

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// tryAcquireBootstrapFileLock 尝试获取排他文件锁但不阻塞：锁被占用时
// 立即返回 ErrFileLockHeld，供长持有锁的调用方快速失败。
func tryAcquireBootstrapFileLock(path string) (*bootstrapFileLock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	lock := &bootstrapFileLock{file: file}
	if err := windows.LockFileEx(
		windows.Handle(file.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0,
		1,
		0,
		&lock.overlapped,
	); err != nil {
		_ = file.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, ErrFileLockHeld
		}
		return nil, err
	}
	_ = file.Chmod(0o600)
	return lock, nil
}
