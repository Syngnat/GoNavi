//go:build unix

package singleinstance

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

type unixLock struct {
	file *os.File
	name string
}

func lockFilePath(name string) string {
	return filepath.Join(runtimeDir(), normalizeName(name)+".single.lock")
}

func acquireLock(name string) (platformLock, error) {
	path := lockFilePath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create single-instance lock dir: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open single-instance lock file: %w", err)
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, &lockHeldError{name: name}
		}
		return nil, fmt.Errorf("flock single-instance lock: %w", err)
	}
	// 写入 PID 便于人工排查；不依赖它做正确性判断。
	_, _ = file.Seek(0, 0)
	_ = file.Truncate(0)
	_, _ = file.WriteString(fmt.Sprintf("%d\n", os.Getpid()))
	return &unixLock{file: file, name: name}, nil
}

func (l *unixLock) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	// 故意不删除锁文件，避免 unlink+flock 竞态导致双主实例。
	// 进程退出时 OS 会自动释放 flock。
	removeEndpoint(l.name)
	_ = unix.Flock(int(l.file.Fd()), unix.LOCK_UN)
	err := l.file.Close()
	l.file = nil
	if err != nil && !strings.Contains(err.Error(), "file already closed") {
		return err
	}
	return nil
}
