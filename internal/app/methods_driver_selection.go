package app

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func (a *App) SelectDriverDownloadDirectory(currentDir string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentDir)
	if defaultDir == "" {
		defaultDir = defaultDriverDownloadDirectory()
	} else if !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                a.appText("driver_manager.backend.dialog.select_download_directory", nil),
		DefaultDirectory:     defaultDir,
		CanCreateDirectories: true,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	resolved, err := resolveDriverDownloadDirectory(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"path":          resolved,
			"defaultPath":   defaultDriverDownloadDirectory(),
			"isDefaultPath": false,
		},
	}
}

func (a *App) SelectDriverPackageFile(currentPath string) connection.QueryResult {
	return a.selectDriverPackageFile(currentPath, false)
}

// SelectDriverPackageZipFile 只用于「导入驱动包（ZIP / 7z）」，方法名沿用已生成的绑定。
// 单驱动的本地文件选择仍走 SelectDriverPackageFile，因为那里还要能选非 Jar 的二进制。
func (a *App) SelectDriverPackageZipFile(currentPath string) connection.QueryResult {
	return a.selectDriverPackageFile(currentPath, true)
}

func driverPackageFileDialogOptions(title string, defaultDir string, zipOnly bool) runtime.OpenDialogOptions {
	options := runtime.OpenDialogOptions{
		Title:            title,
		DefaultDirectory: defaultDir,
	}
	if zipOnly {
		options.Filters = []runtime.FileFilter{{
			DisplayName: "ZIP / 7z (*.zip;*.7z)",
			Pattern:     "*.zip;*.7z",
		}}
	}
	return options
}

func (a *App) selectDriverPackageFile(currentPath string, zipOnly bool) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		defaultDir = defaultDriverDownloadDirectory()
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	titleKey := "driver_manager.backend.dialog.select_package_file"
	if zipOnly {
		titleKey = "driver_manager.backend.dialog.select_package_zip"
	}
	selection, err := runtime.OpenFileDialog(a.ctx, driverPackageFileDialogOptions(
		a.appText(titleKey, nil),
		defaultDir,
		zipOnly,
	))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}

	if abs, err := filepath.Abs(selection); err == nil {
		selection = abs
	}
	if zipOnly && !isDriverPackageArchivePath(selection) {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.error.package_not_zip", nil),
		}
	}
	if err := a.localizeLocalDriverPackagePathError(validateLocalDriverPackagePath(selection)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) SelectDriverPackageDirectory(currentPath string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentPath)
	if defaultDir == "" {
		defaultDir = defaultDriverDownloadDirectory()
	}
	if filepath.Ext(defaultDir) != "" {
		defaultDir = filepath.Dir(defaultDir)
	}
	if !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:            a.appText("driver_manager.backend.dialog.select_package_directory", nil),
		DefaultDirectory: defaultDir,
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
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": selection}}
}

func (a *App) OpenDriverDownloadDirectory(directory string) connection.QueryResult {
	resolved, err := resolveDriverDownloadDirectory(directory)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := os.MkdirAll(resolved, 0o755); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.create_directory_failed", map[string]any{"detail": err.Error()})}
	}

	var cmd *exec.Cmd
	switch stdRuntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", resolved)
	case "windows":
		cmd = exec.Command("explorer", resolved)
	case "linux":
		cmd = exec.Command("xdg-open", resolved)
	default:
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.open_directory_unsupported", map[string]any{"platform": stdRuntime.GOOS})}
	}
	if err := startBackgroundCommand(cmd, func(waitErr error) {
		if waitErr != nil {
			logger.Warnf("打开驱动目录的后台进程退出异常：%v", waitErr)
		}
	}); err != nil {
		logger.Error(err, "打开驱动目录失败")
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.open_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("driver_manager.backend.message.opened_directory", map[string]any{"path": resolved}),
		Data:    map[string]interface{}{"path": resolved},
	}
}

func (a *App) ResolveDriverDownloadDirectory(directory string) connection.QueryResult {
	resolved, err := resolveDriverDownloadDirectory(directory)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"path": resolved}}
}

func (a *App) ConfigureDriverRuntimeDirectory(directory string) connection.QueryResult {
	resolved, err := resolveDriverDownloadDirectory(directory)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	db.SetExternalDriverDownloadDirectory(resolved)
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"path":          resolved,
			"defaultPath":   defaultDriverDownloadDirectory(),
			"isDefaultPath": strings.TrimSpace(directory) == "",
		},
		Message: a.appText("driver_manager.backend.message.runtime_directory_configured", nil),
	}
}

func (a *App) ResolveDriverRepositoryURL(repositoryURL string) connection.QueryResult {
	resolved, err := resolveDriverRepositoryURL(repositoryURL)
	if err != nil {
		return connection.QueryResult{Success: false, Message: localizedDriverBackendErrorMessage(a, err)}
	}
	return connection.QueryResult{Success: true, Data: map[string]interface{}{"url": resolved}}
}

func (a *App) ResolveDriverPackageDownloadURL(driverType string, repositoryURL string) connection.QueryResult {
	effectivePackages, manifestErr := resolveEffectiveDriverPackages(repositoryURL)
	definition, ok := resolveDriverDefinitionWithPackages(driverType, effectivePackages)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.unsupported_driver_type", nil)}
	}
	engine := effectiveDriverEngine(definition)
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.builtin_download_not_required", nil)}
	}
	if err := a.localizeDriverSelectionError(definition, ensureOptionalDriverBuildAvailable(definition)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if engine == driverEngineGo && !definition.BuiltIn {
		urlText := strings.TrimSpace(definition.DefaultDownloadURL)
		if urlText == "" {
			urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(definition.Type))
		}
		data := map[string]interface{}{
			"url":           urlText,
			"driverType":    definition.Type,
			"driverName":    definition.Name,
			"engine":        engine,
			"manifestError": localizedDriverBackendErrorMessage(a, manifestErr),
		}
		if strings.TrimSpace(definition.DownloadSHA256) != "" {
			data["sha256"] = strings.TrimSpace(definition.DownloadSHA256)
		}
		return connection.QueryResult{Success: true, Data: data}
	}
	return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.optional_go_only", nil)}
}
