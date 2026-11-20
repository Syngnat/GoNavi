package app

import (
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"
	runtime "GoNavi-Wails/internal/desktop"
)

// SelectScriptInputFile opens the desktop file picker for script input data.
// Browser sessions must use the authenticated script-input upload endpoint.
func (a *App) SelectScriptInputFile(currentPath string) connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "script workbench is unavailable"}
	}
	if a.webRuntime {
		return connection.QueryResult{
			Success: false,
			Message: "browser sessions must upload CSV, JSON, or XLSX input files",
		}
	}
	if a.ctx == nil {
		return connection.QueryResult{Success: false, Message: "native file dialog is unavailable before application startup"}
	}
	fallback := ""
	if home, err := os.UserHomeDir(); err == nil {
		fallback = home
	}
	defaultDir := resolveFileOpenDialogDirectory(currentPath, fallback)
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("script_workbench.action.add_file", nil),
		DefaultDirectory: defaultDir,
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.data_files", nil),
				Pattern:     "*.csv;*.json;*.xlsx",
			},
		},
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	selection = strings.TrimSpace(selection)
	if selection == "" {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.message.dialog_cancelled", nil)}
	}
	absolute, err := filepath.Abs(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	info, err := os.Stat(absolute)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if !info.Mode().IsRegular() {
		return connection.QueryResult{Success: false, Message: "selected path is not a regular file"}
	}
	switch strings.ToLower(filepath.Ext(absolute)) {
	case ".csv", ".json", ".xlsx":
	default:
		return connection.QueryResult{Success: false, Message: "select a CSV, JSON, or XLSX file"}
	}
	return connection.QueryResult{
		Success: true,
		Message: "OK",
		Data: map[string]any{
			"path": absolute,
			"name": filepath.Base(absolute),
		},
	}
}
