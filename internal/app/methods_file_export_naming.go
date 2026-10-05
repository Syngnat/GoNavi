package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var exportFileNameSanitizer = strings.NewReplacer(
	"/", "_",
	"\\", "_",
	":", "_",
	"*", "_",
	"?", "_",
	"\"", "_",
	"<", "_",
	">", "_",
	"|", "_",
)

func sanitizeExportFileStem(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "export"
	}
	value = exportFileNameSanitizer.Replace(value)
	value = strings.Trim(value, ". ")
	if value == "" {
		return "export"
	}
	return value
}

func resolveSQLExportSuffix(includeSchema bool, includeData bool) string {
	if includeSchema && includeData {
		return "backup"
	}
	if includeData {
		return "data"
	}
	return "schema"
}

func normalizeExportNameList(names []string) []string {
	normalized := make([]string, 0, len(names))
	seen := make(map[string]struct{}, len(names))
	for _, name := range names {
		safeName := strings.TrimSpace(name)
		if safeName == "" {
			continue
		}
		if _, ok := seen[safeName]; ok {
			continue
		}
		seen[safeName] = struct{}{}
		normalized = append(normalized, safeName)
	}
	return normalized
}

func buildTablesExportDefaultFilename(dbName string, objectNames []string, includeSchema bool, includeData bool) string {
	suffix := resolveSQLExportSuffix(includeSchema, includeData)
	if len(objectNames) == 1 {
		return fmt.Sprintf("%s_%s.sql", sanitizeExportFileStem(objectNames[0]), suffix)
	}
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		safeDbName = "export"
	}
	return fmt.Sprintf("%s_%s_%dtables.sql", sanitizeExportFileStem(safeDbName), suffix, len(objectNames))
}

func buildDatabaseExportDefaultFilename(dbName string, includeData bool) string {
	suffix := "schema"
	if includeData {
		suffix = "backup"
	}
	return fmt.Sprintf("%s_%s.sql", sanitizeExportFileStem(dbName), suffix)
}

func resolveBatchObjectsTargetName(dbName string, objectNames []string) string {
	return resolveBatchObjectsTargetNameWithText(dbName, objectNames, nil)
}

func resolveBatchObjectsTargetNameWithText(dbName string, objectNames []string, text fileBackendTextFunc) string {
	if len(objectNames) == 1 {
		return objectNames[0]
	}
	safeDbName := strings.TrimSpace(dbName)
	if safeDbName == "" {
		safeDbName = fileBackendText(text, "data_export.workbench.target.current_database", nil)
	}
	return fileBackendText(text, "data_export.workbench.target.batch_tables", map[string]any{
		"database": safeDbName,
		"count":    len(objectNames),
	})
}

func normalizeSQLExportDefaultFilename(rawName string) string {
	name := strings.TrimSpace(rawName)
	if name == "" {
		name = "query"
	}
	if idx := strings.LastIndexAny(name, `/\`); idx >= 0 {
		name = name[idx+1:]
	}
	if name == "." || name == string(filepath.Separator) {
		name = "query"
	}
	name = strings.NewReplacer(
		"/", "_",
		"\\", "_",
		":", "_",
		"*", "_",
		"?", "_",
		"\"", "_",
		"<", "_",
		">", "_",
		"|", "_",
	).Replace(strings.TrimSpace(name))
	if name == "" {
		name = "query"
	}
	if !strings.EqualFold(filepath.Ext(name), ".sql") {
		name += ".sql"
	}
	return name
}

func exportFormatExtension(format string) string {
	switch normalized := strings.ToLower(strings.TrimSpace(format)); normalized {
	case "csv", "xlsx", "json", "md", "html", "sql":
		return "." + normalized
	default:
		return ""
	}
}

func normalizeExportTargetPath(filePath string, format string) string {
	target := strings.TrimSpace(filePath)
	if target == "" {
		return ""
	}
	if extension := exportFormatExtension(format); extension != "" && !strings.EqualFold(filepath.Ext(target), extension) {
		target += extension
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}
	return target
}

type exportTargetOverwriteConfirmationError struct {
	targetPath string
	extension  string
}

func (e *exportTargetOverwriteConfirmationError) Error() string {
	return fmt.Sprintf("target file already exists after adding %s: %s", e.extension, e.targetPath)
}

func resolveExportTargetPath(filePath string, format string) (string, error) {
	selected := strings.TrimSpace(filePath)
	target := normalizeExportTargetPath(selected, format)
	if selected == "" || target == "" {
		return target, nil
	}
	if abs, err := filepath.Abs(selected); err == nil {
		selected = abs
	}
	if filepath.Clean(selected) == filepath.Clean(target) {
		return target, nil
	}
	if _, err := os.Stat(target); err == nil {
		return "", &exportTargetOverwriteConfirmationError{
			targetPath: target,
			extension:  exportFormatExtension(format),
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return target, nil
}

func exportTargetPathErrorMessage(err error, text fileBackendTextFunc) string {
	var overwriteErr *exportTargetOverwriteConfirmationError
	if errors.As(err, &overwriteErr) {
		return fileBackendText(text, "file.backend.error.target_file_overwrite_confirmation_required", map[string]any{
			"extension": overwriteErr.extension,
			"path":      overwriteErr.targetPath,
		})
	}
	return fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})
}

func (a *App) resolveExportDialogTargetPath(filePath string, format string) (string, error) {
	target, err := resolveExportTargetPath(filePath, format)
	if err != nil {
		return "", errors.New(exportTargetPathErrorMessage(err, a.appText))
	}
	return target, nil
}

func exportFileDialogFilters(format string) []runtime.FileFilter {
	extension := exportFormatExtension(format)
	if extension == "" {
		return nil
	}
	return []runtime.FileFilter{{
		DisplayName: strings.ToUpper(strings.TrimPrefix(extension, ".")),
		Pattern:     "*" + extension,
	}}
}

func normalizeSQLExportTargetPath(filePath string) string {
	return normalizeExportTargetPath(filePath, "sql")
}

func writeExportedSQLFileByPath(filePath string, content string) connection.QueryResult {
	return writeExportedSQLFileByPathWithText(filePath, content, nil)
}

func writeExportedSQLFileByPathWithText(filePath string, content string, text fileBackendTextFunc) connection.QueryResult {
	target, targetErr := resolveExportTargetPath(filePath, "sql")
	if targetErr != nil {
		return connection.QueryResult{Success: false, Message: exportTargetPathErrorMessage(targetErr, text)}
	}
	if target == "" {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.file_path_required", nil)}
	}
	if info, err := os.Stat(target); err == nil && info.IsDir() {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.selected_path_not_sql_file", nil)}
	} else if err != nil && !os.IsNotExist(err) {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.read_file_info_failed", map[string]any{"detail": err.Error()})}
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: fileBackendText(text, "file.backend.error.write_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"filePath": target}}
}
