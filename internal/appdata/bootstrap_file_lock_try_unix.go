//go:build unix

package appdata

import (
	"errors"
	"os"
	"syscall"
)

// tryAcquireBootstrapFileLock 尝试获取排他文件锁但不阻塞：锁被占用时
// 立即返回 ErrFileLockHeld，供长持有锁的调用方快速失败。
func tryAcquireBootstrapFileLock(path string) (*bootstrapFileLock, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrFileLockHeld
		}
		return nil, err
	}
	_ = file.Chmod(0o600)
	return &bootstrapFileLock{file: file}, nil
}
