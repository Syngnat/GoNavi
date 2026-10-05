package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func readImportedConnectionConfigFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > connectionImportMaxFileBytes {
		return "", errConnectionImportFileTooLarge
	}

	content, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(content), nil
}

func (a *App) ImportConfigFile() connection.QueryResult {
	selection, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Select Config File",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "GoNavi Connection Package (*.gonavi-conn)",
				Pattern:     "*.gonavi-conn",
			},
			{
				DisplayName: "JSON Files (*.json)",
				Pattern:     "*.json",
			},
			{
				DisplayName: "MySQL Workbench Connections (*.xml)",
				Pattern:     "*.xml",
			},
			{
				DisplayName: "Navicat Connections (*.ncx)",
				Pattern:     "*.ncx",
			},
			{
				DisplayName: a.appText("app.connection_package.excel.filter", nil),
				Pattern:     "*.xlsx",
			},
		},
	})

	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if selection == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	// Excel 是二进制格式，无法走文本导入通道：此处直接完成导入并以显式
	// 信封返回结果，由前端按信封标记分流到 Excel 落位逻辑。
	if strings.EqualFold(filepath.Ext(selection), ".xlsx") {
		if err := validateConnectionsExcelFileSize(selection); err != nil {
			return connection.QueryResult{Success: false, Message: localizedConnectionPackageMessage(a.appText, err)}
		}
		result, err := a.importConnectionsExcelFile(selection)
		if err != nil {
			return connection.QueryResult{Success: false, Message: localizedExcelImportError(a.appText, err)}
		}
		envelope, err := json.Marshal(connectionsExcelImportEnvelope{GonaviExcelImport: true, Result: result})
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Data: string(envelope)}
	}

	content, err := readImportedConnectionConfigFile(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageMessage(a.appText, err)}
	}

	return connection.QueryResult{Success: true, Data: content}
}

func (a *App) ExportConnectionsPackage(options ConnectionExportOptions) connection.QueryResult {
	filename, err := a.showSaveFileDialog(runtime.SaveDialogOptions{
		Title:           a.appText("file.backend.dialog.export_connections", nil),
		DefaultFilename: "connections" + connectionPackageExtension,
		Filters: []runtime.FileFilter{
			{
				DisplayName: a.appText("file.backend.filter.connection_package", nil),
				Pattern:     "*.gonavi-conn",
			},
			{
				DisplayName: a.appText("app.connection_package.excel.filter", nil),
				Pattern:     "*.xlsx",
			},
		},
	})
	if err != nil || strings.TrimSpace(filename) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	if strings.EqualFold(filepath.Ext(filename), ".xlsx") {
		return a.exportConnectionsExcelToPath(filename, options)
	}
	filename = normalizeConnectionPackageExportFilename(filename)

	content, err := a.buildExportedConnectionPackage(options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, err)}
	}
	if len(content) > connectionImportMaxFileBytes {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, errConnectionImportFileTooLarge)}
	}
	if err := os.WriteFile(filename, content, 0o644); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.export_completed", nil)}
}

// ExportConnectionsPayload builds a recovery package for browser clients. The browser is
// responsible for saving it locally because a Web Server process cannot open its file dialog.
func (a *App) ExportConnectionsPayload(options ConnectionExportOptions) connection.QueryResult {
	content, err := a.buildExportedConnectionPackage(options)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, err)}
	}
	if len(content) > connectionImportMaxFileBytes {
		return connection.QueryResult{Success: false, Message: localizedConnectionPackageExportMessage(a.appText, errConnectionImportFileTooLarge)}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("file.backend.message.export_completed", nil),
		Data:    string(content),
	}
}

func normalizeConnectionPackageExportFilename(filename string) string {
	trimmed := strings.TrimSpace(filename)
	if trimmed == "" {
		return ""
	}
	if strings.EqualFold(filepath.Ext(trimmed), connectionPackageExtension) {
		return trimmed
	}
	return trimmed + connectionPackageExtension
}
