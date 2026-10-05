package app

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"syscall"
)

func activateOptionalDriverAgentBinary(driverType string, installPath string, runtimePath string) error {
	source := strings.TrimSpace(installPath)
	target := strings.TrimSpace(runtimePath)
	if source == "" || target == "" {
		return fmt.Errorf("agent path is empty")
	}
	if source == target {
		return nil
	}

	absSource := source
	absTarget := target
	if value, err := filepath.Abs(source); err == nil && strings.TrimSpace(value) != "" {
		absSource = value
	}
	if value, err := filepath.Abs(target); err == nil && strings.TrimSpace(value) != "" {
		absTarget = value
	}
	if strings.EqualFold(absSource, absTarget) {
		return nil
	}
	if err := copyAgentBinary(source, target); err != nil {
		return err
	}
	return copyOptionalDriverSupportFilesFromDirectory(driverType, filepath.Dir(source), filepath.Dir(target))
}

func copyAgentBinary(sourcePath, targetPath string) error {
	src, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer src.Close()

	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return chmodErr
	}
	if err := renameTempFileOverTarget(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if chmodErr := os.Chmod(targetPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return chmodErr
	}
	return nil
}

func copyOptionalDriverSupportFile(sourcePath, targetPath string) error {
	src, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer src.Close()

	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := renameTempFileOverTarget(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func isDriverInstallFileBusyError(err error) bool {
	if err == nil {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case 5, 32, 33: // ERROR_ACCESS_DENIED / SHARING_VIOLATION / LOCK_VIOLATION on Windows
			return true
		case syscall.EBUSY, syscall.ETXTBSY:
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	markers := []string{
		"access is denied",
		"being used by another process",
		"sharing violation",
		"text file busy",
		"resource busy",
		"ebusy",
		"etxtbsy",
	}
	for _, marker := range markers {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func wrapDriverInstallReplaceError(err error) error {
	if err == nil {
		return nil
	}
	var localized *localizedDriverBackendError
	if errors.As(err, &localized) && localized != nil && strings.TrimSpace(localized.key) != "" {
		return err
	}
	if isDriverInstallFileBusyError(err) {
		return newLocalizedDriverBackendError("driver_manager.backend.error.agent_file_busy", nil, err)
	}
	return err
}

func wrapDriverInstallReplaceErrorOr(err error, fallbackKey string) error {
	if err == nil {
		return nil
	}
	wrapped := wrapDriverInstallReplaceError(err)
	var localized *localizedDriverBackendError
	if errors.As(wrapped, &localized) && localized != nil && strings.TrimSpace(localized.key) != "" {
		return wrapped
	}
	key := strings.TrimSpace(fallbackKey)
	if key == "" {
		key = "driver_manager.backend.error.replace_agent_failed"
	}
	return newLocalizedDriverBackendError(key, nil, err)
}

func renameTempFileOverTarget(tempPath, targetPath string) error {
	if err := os.Rename(tempPath, targetPath); err == nil {
		return nil
	} else {
		firstErr := err
		if removeErr := os.Remove(targetPath); removeErr != nil && !os.IsNotExist(removeErr) {
			return wrapDriverInstallReplaceError(firstErr)
		}
		if retryErr := os.Rename(tempPath, targetPath); retryErr != nil {
			return wrapDriverInstallReplaceError(retryErr)
		}
		return nil
	}
}

func copyOptionalDriverSupportFilesFromDirectory(driverType string, sourceDir string, targetDir string) error {
	names := optionalDriverSupportFileNames(driverType)
	if len(names) == 0 {
		return nil
	}
	sourceRoot := strings.TrimSpace(sourceDir)
	targetRoot := strings.TrimSpace(targetDir)
	if sourceRoot == "" || targetRoot == "" {
		return newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_directory_empty", nil, nil)
	}
	for _, name := range names {
		sourcePath := filepath.Join(sourceRoot, name)
		targetPath := filepath.Join(targetRoot, name)
		if err := copyOptionalDriverSupportFile(sourcePath, targetPath); err != nil {
			return newLocalizedDriverBackendError("driver_manager.backend.error.copy_runtime_dependency_entry_failed", map[string]any{"name": name}, err)
		}
	}
	return nil
}

func scaleProgress(downloaded, total, start, end int64) (int64, int64) {
	if end <= start {
		return end, 100
	}
	if total <= 0 {
		return start, 100
	}
	if downloaded < 0 {
		downloaded = 0
	}
	if downloaded > total {
		downloaded = total
	}
	span := end - start
	return start + ((downloaded * span) / total), 100
}
