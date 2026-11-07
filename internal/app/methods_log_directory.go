package app

import (
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"

	runtime "GoNavi-Wails/internal/desktop"
)

func directoriesEqual(left string, right string) bool {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if left == "" || right == "" {
		return left == right
	}
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if stdRuntime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func logDirectoryInfoPayload() map[string]interface{} {
	directory, managedByEnvironment := logger.ConfiguredDirectory()
	return buildLogDirectoryInfoPayload(directory, logger.DefaultDirectory(), logger.Path(), managedByEnvironment)
}

func buildLogDirectoryInfoPayload(directory string, defaultDirectory string, logFilePath string, managedByEnvironment bool) map[string]interface{} {
	directory = strings.TrimSpace(directory)
	defaultDirectory = strings.TrimSpace(defaultDirectory)
	logFilePath = strings.TrimSpace(logFilePath)
	activeDirectory := ""
	if logFilePath != "" {
		activeDirectory = filepath.Dir(logFilePath)
	}
	source := "custom"
	if managedByEnvironment {
		source = "environment"
	} else if directoriesEqual(directory, defaultDirectory) {
		source = "default"
	}
	return map[string]interface{}{
		"logDirectory":                directory,
		"activeLogDirectory":          activeDirectory,
		"logFilePath":                 logFilePath,
		"defaultLogDirectory":         defaultDirectory,
		"logDirectorySource":          source,
		"logDirectoryEditable":        !managedByEnvironment,
		"logDirectoryRestartRequired": !directoriesEqual(activeDirectory, directory),
	}
}

func (a *App) SelectLogDirectory(currentDirectory string) connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.log_directory.backend.error.desktop_only", nil)}
	}
	configuredDirectory, managedByEnvironment := logger.ConfiguredDirectory()
	if managedByEnvironment {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.log_directory.backend.error.environment_managed", nil)}
	}
	defaultDirectory := strings.TrimSpace(currentDirectory)
	if defaultDirectory == "" {
		defaultDirectory = configuredDirectory
	}
	if !filepath.IsAbs(defaultDirectory) {
		if abs, err := filepath.Abs(defaultDirectory); err == nil {
			defaultDirectory = abs
		}
	}

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                a.appText("app.data_root.log_directory.backend.dialog.select_directory", nil),
		DefaultDirectory:     defaultDirectory,
		CanCreateDirectories: true,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	resolved, err := filepath.Abs(strings.TrimSpace(selection))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{
		Success: true,
		Data: map[string]interface{}{
			"directory": filepath.Clean(resolved),
		},
	}
}

func (a *App) ApplyLogDirectory(directory string) connection.QueryResult {
	a.dataRootApplyMu.Lock()
	defer a.dataRootApplyMu.Unlock()

	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.log_directory.backend.error.desktop_only", nil)}
	}
	currentDirectory, managedByEnvironment := logger.ConfiguredDirectory()
	if managedByEnvironment {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.log_directory.backend.error.environment_managed", nil)}
	}

	target := strings.TrimSpace(directory)
	if directoriesEqual(target, logger.DefaultDirectory()) {
		target = ""
	}
	savedDirectory, err := appdata.SetConfiguredLogDirectory(target)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.log_directory.backend.error.save_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	if savedDirectory == "" {
		savedDirectory = logger.DefaultDirectory()
	}
	message := a.appText("app.data_root.log_directory.backend.message.updated_restart", nil)
	if directoriesEqual(currentDirectory, savedDirectory) {
		message = a.appText("app.data_root.log_directory.backend.message.unchanged", nil)
	}
	return connection.QueryResult{
		Success: true,
		Message: message,
		Data:    dataRootInfoPayload(a.configDir),
	}
}

func (a *App) OpenLogDirectory() connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.log_directory.backend.error.desktop_only", nil)}
	}
	logFilePath := strings.TrimSpace(logger.Path())
	directory := ""
	if logFilePath != "" {
		directory = filepath.Dir(logFilePath)
	}
	if directory == "" {
		directory, _ = logger.ConfiguredDirectory()
	}
	if stat, err := os.Stat(directory); err != nil || !stat.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.log_directory.backend.error.directory_unavailable", nil)}
	}

	var cmd *exec.Cmd
	switch stdRuntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", directory)
	case "windows":
		cmd = exec.Command("explorer", directory)
	case "linux":
		cmd = exec.Command("xdg-open", directory)
	default:
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.log_directory.backend.error.open_directory_unsupported", map[string]any{
				"platform": stdRuntime.GOOS,
			}),
		}
	}
	if err := cmd.Start(); err != nil {
		logger.Error(err, "打开日志目录失败")
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.log_directory.backend.error.open_directory_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.data_root.log_directory.backend.message.opened", nil),
		Data:    dataRootInfoPayload(a.configDir),
	}
}
