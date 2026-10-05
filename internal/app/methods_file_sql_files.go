package app

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func buildSQLDirectoryEntries(directory string) ([]SQLDirectoryEntry, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}

	result := make([]SQLDirectoryEntry, 0, len(entries))
	for _, entry := range entries {
		entryPath := filepath.Join(directory, entry.Name())
		if entry.IsDir() {
			children, childErr := buildSQLDirectoryEntries(entryPath)
			if childErr != nil {
				return nil, childErr
			}
			result = append(result, SQLDirectoryEntry{
				Name:     entry.Name(),
				Path:     entryPath,
				IsDir:    true,
				Children: children,
			})
			continue
		}
		if !strings.EqualFold(filepath.Ext(entry.Name()), ".sql") {
			continue
		}
		result = append(result, SQLDirectoryEntry{
			Name:  entry.Name(),
			Path:  entryPath,
			IsDir: false,
		})
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].IsDir != result[j].IsDir {
			return result[i].IsDir
		}
		return strings.ToLower(result[i].Name) < strings.ToLower(result[j].Name)
	})
	return result, nil
}

func (a *App) OpenSQLFile() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: a.appText("file.backend.dialog.select_sql_file", nil),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.sql_files", nil),
				Pattern:     "*.sql",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files_pattern", nil),
				Pattern:     "*.*",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	return readSQLFileWithMetadataByPathWithText(selection, a.appText)
}

func (a *App) SelectSQLFileForExecution() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:   a.appText("file.backend.dialog.select_sql_file", nil),
		Filters: sqlFileExecutionDialogFilters(a.appText),
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	return selectSQLFileForExecutionByPathWithText(selection, a.appText)
}

func (a *App) SelectSQLDirectory(currentDir string) connection.QueryResult {
	restoreFocus, focusGuardErr := suspendWailsWebViewFocus(a.ctx)
	if focusGuardErr != nil {
		logger.Warnf("安装 SQL 目录选择焦点保护失败：%v", focusGuardErr)
	} else {
		defer func() {
			if err := restoreFocus(); err != nil {
				logger.Warnf("恢复 SQL 目录选择焦点处理失败：%v", err)
			}
		}()
	}
	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("file.backend.dialog.select_sql_directory", nil),
		DefaultDirectory: normalizeDirectoryDialogPath(currentDir),
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	name := filepath.Base(selection)
	if name == "." || name == string(filepath.Separator) {
		name = selection
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection, "name": name}}
}

func (a *App) ListSQLDirectory(directory string) connection.QueryResult {
	target := strings.TrimSpace(directory)
	if target == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.directory_path_required", nil)}
	}
	if abs, err := filepath.Abs(target); err == nil {
		target = abs
	}

	info, err := os.Stat(target)
	if err != nil {
		data := map[string]interface{}{"directoryPath": target}
		if os.IsNotExist(err) {
			data["errorCode"] = sqlDirectoryErrorCodeNotFound
		}
		return connection.QueryResult{Success: false, Message: err.Error(), Data: data}
	}
	if !info.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.selected_path_not_directory", nil)}
	}

	entries, err := buildSQLDirectoryEntries(target)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: entries}
}

func (a *App) ReadSQLFile(filePath string) connection.QueryResult {
	return readSQLFileByPathWithText(filePath, a.appText)
}

func (a *App) WriteSQLFile(filePath string, content string) connection.QueryResult {
	return writeSQLFileByPathWithText(filePath, content, a.appText)
}

func (a *App) CreateSQLFile(directoryPath string, name string) connection.QueryResult {
	return createSQLFileInDirectoryWithText(directoryPath, name, a.appText)
}

func (a *App) CreateSQLDirectory(directoryPath string, name string) connection.QueryResult {
	return createSQLDirectoryInDirectoryWithText(directoryPath, name, a.appText)
}

func (a *App) DeleteSQLFile(filePath string) connection.QueryResult {
	return deleteSQLFileByPathWithText(filePath, a.appText)
}

func (a *App) DeleteSQLDirectory(directoryPath string) connection.QueryResult {
	return deleteSQLDirectoryByPathWithText(directoryPath, a.appText)
}

func (a *App) RenameSQLFile(filePath string, name string) connection.QueryResult {
	return renameSQLFileByPathWithText(filePath, name, a.appText)
}

func (a *App) RenameSQLDirectory(directoryPath string, name string) connection.QueryResult {
	return renameSQLDirectoryByPathWithText(directoryPath, name, a.appText)
}

func (a *App) ExportSQLFile(defaultName string, content string) connection.QueryResult {
	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("query_editor.action.export_sql_file", nil),
		DefaultFilename: normalizeSQLExportDefaultFilename(defaultName),
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.sql_files", nil),
				Pattern:     "*.sql",
			},
			{
				DisplayName: a.appText("file.backend.filter.all_files_pattern", nil),
				Pattern:     "*.*",
			},
		},
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	result := writeExportedSQLFileByPathWithText(filename, content, a.appText)
	if result.Success {
		result.Message = a.appText("query_editor.message.export_sql_file_success", nil)
	}
	return result
}
