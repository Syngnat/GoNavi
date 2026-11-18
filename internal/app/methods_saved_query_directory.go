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

func (a *App) SelectSavedQueryDirectory(currentDirectory string) connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.saved_query_directory.backend.error.desktop_only", nil)}
	}

	defaultDirectory := strings.TrimSpace(currentDirectory)
	if defaultDirectory == "" {
		resolved, err := appdata.ResolveSavedQueryDirectory(a.configDir)
		if err == nil {
			defaultDirectory = resolved
		}
	}
	if defaultDirectory == "" {
		defaultDirectory = appdata.DefaultSavedQueryDirectory(a.configDir)
	}
	if !filepath.IsAbs(defaultDirectory) {
		if abs, err := filepath.Abs(defaultDirectory); err == nil {
			defaultDirectory = abs
		}
	}

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                a.appText("app.data_root.saved_query_directory.backend.dialog.select_directory", nil),
		DefaultDirectory:     defaultDirectory,
		CanCreateDirectories: true,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{
			Success: false,
			Data:    map[string]interface{}{"cancelled": true},
		}
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

func (a *App) ApplySavedQueryDirectory(directory string) connection.QueryResult {
	a.dataRootApplyMu.Lock()
	defer a.dataRootApplyMu.Unlock()

	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.saved_query_directory.backend.error.desktop_only", nil)}
	}

	defaultDirectory := appdata.DefaultSavedQueryDirectory(a.configDir)
	target := strings.TrimSpace(directory)
	if target == "" {
		target = defaultDirectory
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.save_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	target = filepath.Clean(abs)

	currentDirectory, err := appdata.ResolveSavedQueryDirectory(a.configDir)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.save_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	changed := !directoriesEqual(currentDirectory, target)
	configuredTarget := target
	if directoriesEqual(target, defaultDirectory) {
		configuredTarget = ""
	}
	var migrateErr error
	var saveErr error
	func() {
		savedQueriesMu.Lock()
		defer savedQueriesMu.Unlock()
		if changed {
			migrateErr = a.savedQueryRepository().migrateSQLDirectoryLocked(target)
			if migrateErr != nil {
				return
			}
		}
		_, saveErr = appdata.SetConfiguredSavedQueryDirectory(configuredTarget)
	}()
	if migrateErr != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.migrate_failed", map[string]any{
				"detail": migrateErr.Error(),
			}),
		}
	}
	if saveErr != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.save_failed", map[string]any{
				"detail": saveErr.Error(),
			}),
		}
	}

	messageKey := "app.data_root.saved_query_directory.backend.message.updated"
	if !changed {
		messageKey = "app.data_root.saved_query_directory.backend.message.unchanged"
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText(messageKey, nil),
		Data:    dataRootInfoPayload(a.configDir),
	}
}

func (a *App) OpenSavedQueryDirectory() connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.saved_query_directory.backend.error.desktop_only", nil)}
	}

	directory, err := appdata.ResolveSavedQueryDirectory(a.configDir)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.open_directory_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.open_directory_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	if stat, err := os.Stat(directory); err != nil || !stat.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.saved_query_directory.backend.error.directory_unavailable", nil)}
	}

	if openDirectoryNatively(directory) {
		return connection.QueryResult{
			Success: true,
			Message: a.appText("app.data_root.saved_query_directory.backend.message.opened", nil),
			Data:    dataRootInfoPayload(a.configDir),
		}
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
			Message: a.appText("app.data_root.saved_query_directory.backend.error.open_directory_unsupported", map[string]any{
				"platform": stdRuntime.GOOS,
			}),
		}
	}
	if err := cmd.Start(); err != nil {
		logger.Errorf("打开已存查询目录失败：%v", err)
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.open_directory_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.data_root.saved_query_directory.backend.message.opened", nil),
		Data:    dataRootInfoPayload(a.configDir),
	}
}

func savedQueryRevealCommand(platform string, filePath string) *exec.Cmd {
	switch platform {
	case "darwin":
		return exec.Command("open", "-R", filePath)
	case "windows":
		return exec.Command("explorer.exe", "/select,"+filePath)
	case "linux":
		return exec.Command("xdg-open", filepath.Dir(filePath))
	default:
		return nil
	}
}

var startSavedQueryRevealCommand = func(cmd *exec.Cmd) error {
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		_ = cmd.Wait()
	}()
	return nil
}

func (a *App) RevealSavedQueryInFolder(id string) connection.QueryResult {
	if a.webRuntime {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.saved_query_directory.backend.error.desktop_only", nil)}
	}

	targetID := strings.TrimSpace(id)
	if targetID == "" {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.saved_query_directory.backend.error.query_id_required", nil)}
	}

	a.dataRootApplyMu.Lock()
	defer a.dataRootApplyMu.Unlock()

	savedQueriesMu.Lock()
	defer savedQueriesMu.Unlock()

	filePath, found, err := a.savedQueryRepository().findSQLPath(targetID)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.reveal_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	if !found {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.query_not_found", map[string]any{
				"id": targetID,
			}),
		}
	}
	filePath, err = filepath.Abs(filePath)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.reveal_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	if stat, statErr := os.Stat(filePath); statErr != nil || !stat.Mode().IsRegular() {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.query_file_unavailable", map[string]any{
				"path": filePath,
			}),
		}
	}

	if revealFileNatively(filePath) {
		return connection.QueryResult{
			Success: true,
			Message: a.appText("app.data_root.saved_query_directory.backend.message.revealed", map[string]any{
				"path": filePath,
			}),
			Data: map[string]any{"id": targetID, "path": filePath},
		}
	}
	cmd := savedQueryRevealCommand(stdRuntime.GOOS, filePath)
	if cmd == nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.reveal_unsupported", map[string]any{
				"platform": stdRuntime.GOOS,
			}),
		}
	}
	if err := startSavedQueryRevealCommand(cmd); err != nil {
		logger.Errorf("在文件夹中显示已存查询失败：%v", err)
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.data_root.saved_query_directory.backend.error.reveal_failed", map[string]any{
				"detail": err.Error(),
			}),
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.data_root.saved_query_directory.backend.message.revealed", map[string]any{
			"path": filePath,
		}),
		Data: map[string]any{
			"id":   targetID,
			"path": filePath,
		},
	}
}
