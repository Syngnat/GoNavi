//go:build !windows

package cli

import (
	"errors"
	"os"
	"syscall"
)

func validateConnectionFilePermissions(file *os.File, mode os.FileMode) error {
	if mode.Perm()&0o077 != 0 {
		return errors.New("connection file permissions must deny group and other access (for example chmod 600)")
	}
	if file == nil {
		return errors.New("connection file handle is unavailable for owner validation")
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return errors.New("connection file owner could not be verified")
	}
	if uint64(stat.Uid) != uint64(os.Getuid()) {
		return errors.New("connection file must be owned by the current user")
	}
	return nil
}
