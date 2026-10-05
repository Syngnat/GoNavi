package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func normalizeSQLFileName(rawName string) (string, error) {
	return normalizeSQLFileNameWithText(rawName, nil)
}

func normalizeSQLFileNameWithText(rawName string, text fileBackendTextFunc) (string, error) {
	name := strings.TrimSpace(rawName)
	if name == "" {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.sql_file_name_required", nil))
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.sql_file_name_no_separator", nil))
	}
	if !strings.EqualFold(filepath.Ext(name), ".sql") {
		name += ".sql"
	}
	return name, nil
}

func normalizeSQLDirectoryName(rawName string) (string, error) {
	return normalizeSQLDirectoryNameWithText(rawName, nil)
}

func normalizeSQLDirectoryNameWithText(rawName string, text fileBackendTextFunc) (string, error) {
	name := strings.TrimSpace(rawName)
	if name == "" {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_name_required", nil))
	}
	if strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_name_no_separator", nil))
	}
	return name, nil
}

func normalizeSQLDirectoryPath(directoryPath string) (string, error) {
	return normalizeSQLDirectoryPathWithText(directoryPath, nil)
}

func normalizeSQLDirectoryPathWithText(directoryPath string, text fileBackendTextFunc) (string, error) {
	target := strings.TrimSpace(directoryPath)
	if target == "" {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_path_required", nil))
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()}))
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s", fileBackendText(text, "file.backend.error.selected_path_not_directory", nil))
	}
	return target, nil
}

func normalizeExistingSQLDirectoryPath(directoryPath string) (string, os.FileInfo, error) {
	return normalizeExistingSQLDirectoryPathWithText(directoryPath, nil)
}

func normalizeExistingSQLDirectoryPathWithText(directoryPath string, text fileBackendTextFunc) (string, os.FileInfo, error) {
	target := strings.TrimSpace(directoryPath)
	if target == "" {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.directory_path_required", nil))
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()}))
	}
	if !info.IsDir() {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.selected_path_not_directory", nil))
	}
	return target, info, nil
}

func normalizeExistingSQLFilePath(filePath string) (string, os.FileInfo, error) {
	return normalizeExistingSQLFilePathWithText(filePath, nil)
}

func normalizeExistingSQLFilePathWithText(filePath string, text fileBackendTextFunc) (string, os.FileInfo, error) {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.file_path_required", nil))
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()}))
	}
	if info.IsDir() {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil))
	}
	if !strings.EqualFold(filepath.Ext(target), ".sql") {
		return "", nil, fmt.Errorf("%s", fileBackendText(text, "file.backend.error.sql_file_extension_required", nil))
	}
	return target, info, nil
}

func createSQLFileInDirectory(directoryPath string, rawName string) connection.QueryResult {
	return createSQLFileInDirectoryWithText(directoryPath, rawName, nil)
}

func createSQLFileInDirectoryWithText(directoryPath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	directory, err := normalizeSQLDirectoryPathWithText(directoryPath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLFileNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(directory, name)
	if _, err := os.Lstat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.sql_file_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.WriteFile(target, []byte(""), 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.create_sql_file_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target, "name": filepath.Base(target)}}
}

func createSQLDirectoryInDirectory(parentPath string, rawName string) connection.QueryResult {
	return createSQLDirectoryInDirectoryWithText(parentPath, rawName, nil)
}

func createSQLDirectoryInDirectoryWithText(parentPath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	parent, err := normalizeSQLDirectoryPathWithText(parentPath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLDirectoryNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(parent, name)
	if _, err := os.Stat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.directory_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.Mkdir(target, 0o755); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.create_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "name": filepath.Base(target)}}
}

func deleteSQLFileByPath(filePath string) connection.QueryResult {
	return deleteSQLFileByPathWithText(filePath, nil)
}

func deleteSQLFileByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	target, _, err := normalizeExistingSQLFilePathWithText(filePath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := os.Remove(target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.delete_sql_file_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target}}
}

func deleteSQLDirectoryByPath(directoryPath string) connection.QueryResult {
	return deleteSQLDirectoryByPathWithText(directoryPath, nil)
}

func deleteSQLDirectoryByPathWithText(directoryPath string, text fileBackendTextFunc) connection.QueryResult {
	target := strings.TrimSpace(directoryPath)
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.directory_path_required", nil)}
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	info, err := os.Stat(target)
	if os.IsNotExist(err) {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "alreadyMissing": true}}
	}
	if err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_directory_info_failed", map[string]any{"detail": err.Error()})}
	}
	if !info.IsDir() {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_directory", nil)}
	}
	if err := os.Remove(target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.delete_sql_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target}}
}

func renameSQLFileByPath(filePath string, rawName string) connection.QueryResult {
	return renameSQLFileByPathWithText(filePath, rawName, nil)
}

func renameSQLFileByPathWithText(filePath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	source, _, err := normalizeExistingSQLFilePathWithText(filePath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLFileNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(filepath.Dir(source), name)
	if source == target {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target, "name": filepath.Base(target)}}
	}
	if _, err := os.Stat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.target_sql_file_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_target_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.Rename(source, target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.rename_sql_file_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target, "name": filepath.Base(target)}}
}

func renameSQLDirectoryByPath(directoryPath string, rawName string) connection.QueryResult {
	return renameSQLDirectoryByPathWithText(directoryPath, rawName, nil)
}

func renameSQLDirectoryByPathWithText(directoryPath string, rawName string, text fileBackendTextFunc) connection.QueryResult {
	source, _, err := normalizeExistingSQLDirectoryPathWithText(directoryPath, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	name, err := normalizeSQLDirectoryNameWithText(rawName, text)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	target := filepath.Join(filepath.Dir(source), name)
	if source == target {
		return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "name": filepath.Base(target)}}
	}
	if _, err := os.Stat(target); err == nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.target_directory_exists", nil)}
	} else if !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_target_directory_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.Rename(source, target); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.rename_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"directoryPath": target, "name": filepath.Base(target)}}
}
