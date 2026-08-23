//go:build windows

package app

import "golang.org/x/sys/windows"

func atomicReplaceSQLAuditFile(source, target string) error {
	sourcePath, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	targetPath, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(
		sourcePath,
		targetPath,
		windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH,
	)
}

// atomicCreateSQLAuditFile publishes source only when target does not exist.
// MoveFileEx without MOVEFILE_REPLACE_EXISTING maps to a CREATE_NEW-style
// operation and keeps the destination hidden until the move completes.
func atomicCreateSQLAuditFile(source, target string) error {
	sourcePath, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	targetPath, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(sourcePath, targetPath, windows.MOVEFILE_WRITE_THROUGH)
}
