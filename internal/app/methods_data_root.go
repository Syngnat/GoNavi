package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

var dataRootMigrationExcludedEntries = map[string]struct{}{
	filepath.Base(appdata.BootstrapPath()):     {},
	filepath.Base(appdata.BootstrapLockPath()): {},
}

type dataRootTextFunc func(string, map[string]any) string

type dataRootLocalizedError struct {
	message string
	cause   error
}

func (e dataRootLocalizedError) Error() string {
	return e.message
}

func (e dataRootLocalizedError) Unwrap() error {
	return e.cause
}

func dataRootText(text dataRootTextFunc, key string, params map[string]any) string {
	if text != nil {
		return text(key, params)
	}
	return defaultAppText(key, params)
}

func dataRootError(text dataRootTextFunc, key string, params map[string]any) error {
	return errors.New(dataRootText(text, key, params))
}

func dataRootErrorWithDetail(text dataRootTextFunc, key string, detail string, cause error, params map[string]any) error {
	resolved := make(map[string]any, len(params)+1)
	for name, value := range params {
		resolved[name] = value
	}
	resolved["detail"] = detail
	message := dataRootText(text, key, resolved)
	if cause == nil {
		return errors.New(message)
	}
	return dataRootLocalizedError{message: message, cause: cause}
}

func dataRootWrapError(text dataRootTextFunc, key string, cause error, params map[string]any) error {
	if cause == nil {
		return dataRootError(text, key, params)
	}
	return dataRootErrorWithDetail(text, key, cause.Error(), cause, params)
}

func dataRootLocalizeSetActiveRootError(text dataRootTextFunc, err error) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, appdata.ErrSetActiveRootCreateDataDirectory):
		detail := appdata.SetActiveRootErrorDetail(err)
		if detail == nil {
			detail = err
		}
		return dataRootErrorWithDetail(text, "app.data_root.backend.error.create_data_directory_failed", detail.Error(), err, nil)
	case errors.Is(err, appdata.ErrSetActiveRootCreateBootstrapDirectory):
		detail := appdata.SetActiveRootErrorDetail(err)
		if detail == nil {
			detail = err
		}
		return dataRootErrorWithDetail(text, "app.data_root.backend.error.create_bootstrap_directory_failed", detail.Error(), err, nil)
	default:
		return err
	}
}

func (a *App) GetDataRootDirectoryInfo() connection.QueryResult {
	return connection.QueryResult{Success: true, Message: "OK", Data: dataRootInfoPayload(a.configDir)}
}

func (a *App) SelectDataRootDirectory(currentDir string) connection.QueryResult {
	defaultDir := strings.TrimSpace(currentDir)
	if defaultDir == "" {
		defaultDir = appdata.MustResolveActiveRoot()
	}
	if !filepath.IsAbs(defaultDir) {
		if abs, err := filepath.Abs(defaultDir); err == nil {
			defaultDir = abs
		}
	}

	selection, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title:                a.appText("app.data_root.backend.dialog.select_directory", nil),
		DefaultDirectory:     defaultDir,
		CanCreateDirectories: true,
	})
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if strings.TrimSpace(selection) == "" {
		return connection.QueryResult{Success: false, Message: "已取消"}
	}
	resolved, err := appdata.ResolveRoot(selection)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: dataRootInfoPayload(resolved)}
}

func (a *App) ApplyDataRootDirectory(directory string, migrate bool) connection.QueryResult {
	a.dataRootApplyMu.Lock()
	defer a.dataRootApplyMu.Unlock()

	currentRoot := appdata.MustResolveActiveRoot()
	targetRoot, err := appdata.ResolveRoot(directory)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if filepath.Clean(currentRoot) == filepath.Clean(targetRoot) {
		a.configDir = targetRoot
		db.SetExternalDriverDownloadDirectory(appdata.DriverRoot(targetRoot))
		return connection.QueryResult{
			Success: true,
			Message: a.appText("app.data_root.backend.message.unchanged", nil),
			Data:    dataRootInfoPayload(targetRoot),
		}
	}

	// The audit database uses SQLite WAL journaling. Pause it and checkpoint/close
	// every audit connection before copying or switching the data root so the
	// migration never copies a live database or an incomplete WAL sidecar.
	resumeSQLAudit, suspendErr := a.suspendSQLAudit()
	if suspendErr != nil {
		a.resumeSQLAudit(resumeSQLAudit)
		return connection.QueryResult{
			Success: false,
			Message: dataRootErrorWithDetail(
				a.appText,
				"app.data_root.backend.error.migrate_directory_failed",
				suspendErr.Error(),
				suspendErr,
				map[string]any{"entry": "audit"},
			).Error(),
		}
	}
	defer a.resumeSQLAudit(resumeSQLAudit)

	if migrate {
		if err := migrateDataRootContentsWithText(currentRoot, targetRoot, a.appText); err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
	}

	appliedRoot, err := appdata.SetActiveRoot(targetRoot)
	if err != nil {
		return connection.QueryResult{Success: false, Message: dataRootLocalizeSetActiveRootError(a.appText, err).Error()}
	}
	a.configDir = appliedRoot
	db.SetExternalDriverDownloadDirectory(appdata.DriverRoot(appliedRoot))
	message := a.appText("app.data_root.backend.message.updated_restart", nil)
	if migrate {
		message = a.appText("app.data_root.backend.message.migrated_restart", nil)
	}
	return connection.QueryResult{Success: true, Message: message, Data: dataRootInfoPayload(appliedRoot)}
}

func (a *App) OpenDataRootDirectory() connection.QueryResult {
	root := appdata.MustResolveActiveRoot()
	if stat, err := os.Stat(root); err != nil || !stat.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.backend.error.directory_unavailable", nil)}
	}
	var cmd *exec.Cmd
	switch stdRuntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", root)
	case "windows":
		cmd = exec.Command("explorer", root)
	case "linux":
		cmd = exec.Command("xdg-open", root)
	default:
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.backend.error.open_directory_unsupported", map[string]any{"platform": stdRuntime.GOOS})}
	}
	if err := cmd.Start(); err != nil {
		logger.Error(err, "打开数据目录失败")
		return connection.QueryResult{Success: false, Message: a.appText("app.data_root.backend.error.open_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{Success: true, Message: a.appText("app.data_root.backend.message.opened", nil), Data: dataRootInfoPayload(root)}
}

func migrateDataRootContents(sourceRoot string, targetRoot string) error {
	return migrateDataRootContentsWithText(sourceRoot, targetRoot, nil)
}

func migrateDataRootContentsWithText(sourceRoot string, targetRoot string, text dataRootTextFunc) error {
	sourceRoot = strings.TrimSpace(sourceRoot)
	targetRoot = strings.TrimSpace(targetRoot)
	if sourceRoot == "" || targetRoot == "" {
		return dataRootError(text, "app.data_root.backend.error.directory_empty", nil)
	}
	sourceAbs, err := filepath.Abs(sourceRoot)
	if err != nil {
		return dataRootWrapError(text, "app.data_root.backend.error.resolve_source_failed", err, nil)
	}
	targetAbs, err := filepath.Abs(targetRoot)
	if err != nil {
		return dataRootWrapError(text, "app.data_root.backend.error.resolve_target_failed", err, nil)
	}
	if filepath.Clean(sourceAbs) == filepath.Clean(targetAbs) {
		return nil
	}
	if rel, err := filepath.Rel(sourceAbs, targetAbs); err == nil && rel != "." && rel != "" && !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel) {
		return dataRootError(text, "app.data_root.backend.error.target_inside_source", nil)
	}
	sourceRoot = sourceAbs
	targetRoot = targetAbs
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		return dataRootWrapError(text, "app.data_root.backend.error.create_target_failed", err, nil)
	}
	entries, err := os.ReadDir(sourceRoot)
	if err != nil {
		return dataRootWrapError(text, "app.data_root.backend.error.read_source_root_failed", err, nil)
	}
	for _, entry := range entries {
		name := strings.TrimSpace(entry.Name())
		if name == "" {
			continue
		}
		if _, excluded := dataRootMigrationExcludedEntries[name]; excluded {
			continue
		}
		if name == "audit" {
			// The SQLite audit store is copied as an exact directory snapshot
			// after every other migration step succeeds. Merging it would leave
			// stale WAL/SHM or health sidecars from an existing target root.
			continue
		}
		sourcePath := filepath.Join(sourceRoot, name)
		targetPath := filepath.Join(targetRoot, name)
		info, err := entry.Info()
		if err != nil {
			return dataRootWrapError(text, "app.data_root.backend.error.read_source_failed", err, map[string]any{"entry": name})
		}
		if info.IsDir() {
			if err := copyDir(sourcePath, targetPath); err != nil {
				return dataRootWrapError(text, "app.data_root.backend.error.migrate_directory_failed", err, map[string]any{"entry": name})
			}
			continue
		}
		if err := copyFile(sourcePath, targetPath, info.Mode()); err != nil {
			return dataRootWrapError(text, "app.data_root.backend.error.migrate_file_failed", err, map[string]any{"entry": name})
		}
	}
	if err := rewriteMigratedDataRootStateWithText(targetRoot, text); err != nil {
		return err
	}
	if err := replaceMigratedAuditDirectory(sourceRoot, targetRoot); err != nil {
		return dataRootWrapError(text, "app.data_root.backend.error.migrate_directory_failed", err, map[string]any{"entry": "audit"})
	}
	return nil
}

func replaceMigratedAuditDirectory(sourceRoot string, targetRoot string) error {
	sourceAudit := filepath.Join(sourceRoot, "audit")
	targetAudit := filepath.Join(targetRoot, "audit")

	sourceInfo, sourceErr := os.Stat(sourceAudit)
	sourceExists := sourceErr == nil
	if sourceErr != nil && !os.IsNotExist(sourceErr) {
		return fmt.Errorf("inspect source audit directory: %w", sourceErr)
	}
	if sourceExists && !sourceInfo.IsDir() {
		return errors.New("source audit path is not a directory")
	}

	stagePath := ""
	if sourceExists {
		var err error
		stagePath, err = os.MkdirTemp(targetRoot, ".gonavi-audit-stage-")
		if err != nil {
			return fmt.Errorf("create audit migration stage: %w", err)
		}
		defer func() { _ = os.RemoveAll(stagePath) }()
		if err := copyDir(sourceAudit, stagePath); err != nil {
			return fmt.Errorf("stage audit directory: %w", err)
		}
	}

	targetInfo, targetErr := os.Lstat(targetAudit)
	targetExists := targetErr == nil
	if targetErr != nil && !os.IsNotExist(targetErr) {
		return fmt.Errorf("inspect target audit directory: %w", targetErr)
	}
	if targetExists && targetInfo == nil {
		return errors.New("target audit path is unavailable")
	}

	backupPath := ""
	if targetExists {
		reserved, err := os.MkdirTemp(targetRoot, ".gonavi-audit-backup-")
		if err != nil {
			return fmt.Errorf("reserve audit migration backup: %w", err)
		}
		if err := os.Remove(reserved); err != nil {
			return fmt.Errorf("prepare audit migration backup: %w", err)
		}
		backupPath = reserved
		if err := os.Rename(targetAudit, backupPath); err != nil {
			return fmt.Errorf("backup target audit directory: %w", err)
		}
	}

	rollback := func(cause error) error {
		if backupPath == "" {
			return cause
		}
		if restoreErr := os.Rename(backupPath, targetAudit); restoreErr != nil {
			return errors.Join(cause, fmt.Errorf("restore target audit directory: %w", restoreErr))
		}
		backupPath = ""
		return cause
	}

	if sourceExists {
		if err := os.Rename(stagePath, targetAudit); err != nil {
			return rollback(fmt.Errorf("activate staged audit directory: %w", err))
		}
		stagePath = ""
	}
	if backupPath != "" {
		if err := os.RemoveAll(backupPath); err != nil {
			logger.Warnf("清理数据目录迁移的旧审计备份失败：path=%s err=%v", backupPath, err)
		}
	}
	return nil
}

func rewriteMigratedDataRootState(targetRoot string) error {
	return rewriteMigratedDataRootStateWithText(targetRoot, nil)
}

func rewriteMigratedDataRootStateWithText(targetRoot string, text dataRootTextFunc) error {
	if err := rewriteSecurityUpdateBackupPathsWithText(targetRoot, text); err != nil {
		return err
	}
	return nil
}

func rewriteSecurityUpdateBackupPaths(targetRoot string) error {
	return rewriteSecurityUpdateBackupPathsWithText(targetRoot, nil)
}

func rewriteSecurityUpdateBackupPathsWithText(targetRoot string, text dataRootTextFunc) error {
	repo := newSecurityUpdateStateRepository(targetRoot)
	marker, err := repo.readMarker()
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return dataRootWrapError(text, "app.data_root.backend.error.read_migrated_security_update_state_failed", err, nil)
	}

	migrationID := strings.TrimSpace(marker.MigrationID)
	if migrationID == "" {
		return nil
	}

	targetBackupPath := repo.backupPath(migrationID)
	marker.BackupPath = targetBackupPath
	if err := repo.writeMarker(marker); err != nil {
		return dataRootWrapError(text, "app.data_root.backend.error.write_migrated_security_update_state_failed", err, nil)
	}

	manifestPath := repo.manifestPath(migrationID)
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return dataRootWrapError(text, "app.data_root.backend.error.read_migrated_security_update_manifest_failed", err, nil)
		}
	} else {
		var manifest securityUpdateBackupManifest
		if err := json.Unmarshal(manifestData, &manifest); err != nil {
			return dataRootWrapError(text, "app.data_root.backend.error.parse_migrated_security_update_manifest_failed", err, nil)
		}
		manifest.BackupPath = targetBackupPath
		if err := securityUpdateWriteJSONFile(manifestPath, manifest); err != nil {
			return dataRootWrapError(text, "app.data_root.backend.error.write_migrated_security_update_manifest_failed", err, nil)
		}
	}

	resultPath := repo.resultPath(migrationID)
	resultData, err := os.ReadFile(resultPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return dataRootWrapError(text, "app.data_root.backend.error.read_migrated_security_update_result_failed", err, nil)
		}
	} else {
		var result SecurityUpdateStatus
		if err := json.Unmarshal(resultData, &result); err != nil {
			return dataRootWrapError(text, "app.data_root.backend.error.parse_migrated_security_update_result_failed", err, nil)
		}
		result.BackupPath = targetBackupPath
		result.BackupAvailable = strings.TrimSpace(targetBackupPath) != ""
		if err := securityUpdateWriteJSONFile(resultPath, result); err != nil {
			return dataRootWrapError(text, "app.data_root.backend.error.write_migrated_security_update_result_failed", err, nil)
		}
	}

	return nil
}

func copyDir(sourceDir string, targetDir string) error {
	return filepath.WalkDir(sourceDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relativePath, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return err
		}
		targetPath := filepath.Join(targetDir, relativePath)
		if entry.IsDir() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			return os.MkdirAll(targetPath, info.Mode())
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		return copyFile(path, targetPath, info.Mode())
	})
}

func copyFile(sourcePath string, targetPath string, mode os.FileMode) (err error) {
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	sourceFile, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	targetFile, err := os.Create(targetPath)
	if err != nil {
		return err
	}
	// 迁移是写路径：网络盘回写缓存与配额耗尽常常直到 close(2) 才报 ENOSPC/EIO，
	// 此时 io.Copy 已返回成功。丢弃 Close 错误会让被截断的副本被判定为迁移成功，
	// 随后 SetActiveRoot 把活动数据根切到这份损坏的连接配置/审计库上。
	defer func() {
		if closeErr := targetFile.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	if _, err := io.Copy(targetFile, sourceFile); err != nil {
		return err
	}
	if err := targetFile.Sync(); err != nil {
		return err
	}
	return os.Chmod(targetPath, mode)
}
