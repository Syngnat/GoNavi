//go:build !windows

package app

import (
	"errors"
	"os"
	"path/filepath"
)

func atomicReplaceSQLAuditFile(source, target string) error {
	if err := os.Rename(source, target); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(target))
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

// atomicCreateSQLAuditFile publishes source at target without replacing an
// existing target. Both paths are created in the same directory, so a hard
// link gives us an atomic CREATE_NEW-style destination while the temporary
// source remains private until it is removed.
func atomicCreateSQLAuditFile(source, target string) error {
	if err := os.Link(source, target); err != nil {
		return err
	}
	if err := os.Remove(source); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(target))
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}
