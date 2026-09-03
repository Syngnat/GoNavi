//go:build !windows

package runharness

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

func openExistingKeyFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDWR, 0)
}

func createKeyFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
}

func validateKeyFilePermissions(file *os.File, mode os.FileMode) error {
	if mode.Perm() != 0o600 {
		return fmt.Errorf("key file permissions are %04o, want 0600", mode.Perm())
	}
	if file == nil {
		return errors.New("key file handle is unavailable for owner validation")
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("key file owner could not be verified")
	}
	if uint64(stat.Uid) != uint64(os.Getuid()) {
		return errors.New("key file must be owned by the current user")
	}
	return nil
}

func secureKeyFileACL(_ *os.File) error { return nil }
