package app

import (
	"fmt"
	"os"
	"path/filepath"
	goRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func normalizeDirectoryDialogPath(currentDir string) string {
	defaultDir := strings.TrimSpace(currentDir)
	if defaultDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			defaultDir = home
		}
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if defaultDir != "" && !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}
	return defaultDir
}

func absDialogPath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return ""
	}
	if abs, err := filepath.Abs(trimmed); err == nil {
		return abs
	}
	return trimmed
}

// resolveFileOpenDialogDirectory picks the directory for OpenFileDialog.
// currentPath may be a previously selected file, including extensionless SSH keys
// such as id_rsa / id_ed25519 / custom names under ~/.ssh.
func resolveFileOpenDialogDirectory(currentPath string, emptyFallback string) string {
	path := strings.TrimSpace(currentPath)
	if path == "" {
		path = strings.TrimSpace(emptyFallback)
	}
	if path == "" {
		return ""
	}

	if info, err := os.Stat(path); err == nil {
		if info.IsDir() {
			return absDialogPath(path)
		}
		return absDialogPath(filepath.Dir(path))
	}

	// Path does not exist: treat it as a file location when a parent exists.
	parent := filepath.Dir(path)
	if parent != "" && parent != "." && parent != path {
		return absDialogPath(parent)
	}
	return absDialogPath(path)
}

type fileBackendTextFunc func(key string, params map[string]any) string

func fileBackendText(text fileBackendTextFunc, key string, params map[string]any) string {
	if text == nil {
		return key
	}
	return text(key, params)
}

func readSQLFileByPath(filePath string) connection.QueryResult {
	return readSQLFileByPathWithText(filePath, nil)
}

func resolveSQLFilePathInfoWithText(filePath string, text fileBackendTextFunc) (string, os.FileInfo, *connection.QueryResult) {
	selection := strings.TrimSpace(filePath)
	if selection == "" {
		result := connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.file_path_required", nil)}
		return "", nil, &result
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}

	fi, err := os.Stat(selection)
	if err != nil {
		data := map[string]interface{}{"filePath": selection}
		if os.IsNotExist(err) {
			data["errorCode"] = sqlFileErrorCodeNotFound
		}
		result := connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()}), Data: data}
		return "", nil, &result
	}
	if fi.IsDir() {
		result := connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil)}
		return "", nil, &result
	}
	return selection, fi, nil
}

func buildSQLFileSelectionMetadata(selection string, fileSize int64) map[string]interface{} {
	return map[string]interface{}{
		"filePath":   selection,
		"name":       filepath.Base(selection),
		"fileSize":   fileSize,
		"fileSizeMB": fmt.Sprintf("%.1f", float64(fileSize)/(1024*1024)),
	}
}

func readSQLFileByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	selection, fi, failed := resolveSQLFilePathInfoWithText(filePath, text)
	if failed != nil {
		return *failed
	}

	if fi.Size() > maxSQLFileSizeBytes {
		payload := buildSQLFileSelectionMetadata(selection, fi.Size())
		payload["isLargeFile"] = true
		return connection.QueryResult{
			Success: true,
			Data:    payload,
		}
	}

	content, err := os.ReadFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: string(content)}
}

func selectSQLFileForExecutionByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	selection, fi, failed := resolveSQLFilePathInfoWithText(filePath, text)
	if failed != nil {
		return *failed
	}
	return connection.QueryResult{
		Success: true,
		Data:    buildSQLFileSelectionMetadata(selection, fi.Size()),
	}
}

func sqlFileExecutionDialogFilters(text fileBackendTextFunc) []runtime.FileFilter {
	return sqlFileExecutionDialogFiltersForPlatform(text, goRuntime.GOOS)
}

func sqlFileExecutionDialogFiltersForPlatform(text fileBackendTextFunc, platform string) []runtime.FileFilter {
	pattern := "*.sql;*.sql.gz"
	includeAllFiles := true
	// Wails turns compound extensions into UTTypes on macOS. "sql.gz" is not
	// recognized and makes the native dialog abort; "gz" keeps gzip SQL selectable.
	if platform == "darwin" {
		pattern = "*.sql;*.gz"
		includeAllFiles = false
	}

	filters := []runtime.FileFilter{
		{
			DisplayName: fileBackendText(text, "file.backend.filter.sql_files", nil),
			Pattern:     pattern,
		},
	}
	if includeAllFiles {
		filters = append(filters, runtime.FileFilter{
			DisplayName: fileBackendText(text, "file.backend.filter.all_files_pattern", nil),
			Pattern:     "*.*",
		})
	}
	return filters
}

func readSQLFileWithMetadataByPath(filePath string) connection.QueryResult {
	return readSQLFileWithMetadataByPathWithText(filePath, nil)
}

func readSQLFileWithMetadataByPathWithText(filePath string, text fileBackendTextFunc) connection.QueryResult {
	result := readSQLFileByPathWithText(filePath, text)
	if !result.Success {
		return result
	}
	if data, ok := result.Data.(map[string]interface{}); ok {
		return connection.QueryResult{Success: true, Data: data}
	}
	selection := strings.TrimSpace(filePath)
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"content":  result.Data,
			"filePath": selection,
			"name":     filepath.Base(selection),
		},
	}
}

func writeSQLFileByPath(filePath string, content string) connection.QueryResult {
	return writeSQLFileByPathWithText(filePath, content, nil)
}

func writeSQLFileByPathWithText(filePath string, content string, text fileBackendTextFunc) connection.QueryResult {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.file_path_required", nil)}
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}

	info, err := os.Stat(target)
	if err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if info.IsDir() {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil)}
	}

	if err := os.WriteFile(target, []byte(content), info.Mode().Perm()); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target}}
}
