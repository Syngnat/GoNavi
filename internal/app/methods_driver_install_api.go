package app

import (
	"context"
	"os"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (a *App) InstallLocalDriverPackage(driverType string, filePath string, downloadDir string, version string) connection.QueryResult {
	// 按驱动类型加锁：本地导入的不同驱动可并行。
	release := a.driverInstallLock.lockDriver(normalizeDriverType(driverType))
	defer release()

	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.unsupported_driver_type", nil)}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.builtin_install_not_required", nil)}
	}
	if err := a.localizeLocalDriverPackagePathError(validateLocalDriverPackagePath(filePath)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := a.localizeDriverSelectionError(definition, ensureOptionalDriverBuildAvailable(definition)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	engine := effectiveDriverEngine(definition)
	if !(engine == driverEngineGo && !definition.BuiltIn) {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.optional_go_only", nil)}
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	// resolvedDir 全程显式传参（installOptionalDriverAgentFromLocalPath /
	// writeInstalledDriverPackage / driverInstallDir），无需写全局目录。

	a.emitDriverDownloadProgress(definition.Type, "start", 0, 100, a.appText("driver_manager.progress.local_package_start", nil))
	selectedVersion := resolveDriverInstallVersion(version, "local://manual", definition)
	if err := a.localizeDriverSelectionError(definition, validateDriverSelectedVersion(definition, selectedVersion)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	meta, installErr := installOptionalDriverAgentFromLocalPath(a, definition, filePath, resolvedDir, selectedVersion)
	if installErr != nil {
		errText := localizedDriverBackendErrorMessage(a, installErr)
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
		return connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.message.local_import_failed_detail", map[string]any{
				"detail": a.driverOperationErrorMessage(installErr, "failed to import local driver package, driver=%s file=%s", definition.Type, strings.TrimSpace(filePath)),
			}),
		}
	}
	a.emitDriverDownloadProgress(definition.Type, "downloading", 90, 100, a.appText("driver_manager.progress.metadata_write", nil))
	if err := writeInstalledDriverPackage(resolvedDir, definition.Type, meta); err != nil {
		errText := localizedDriverBackendErrorMessage(a, err)
		a.emitDriverDownloadProgress(definition.Type, "error", 0, 0, errText)
		return connection.QueryResult{
			Success: false,
			Message: a.appText("driver_manager.backend.message.metadata_write_failed_detail", map[string]any{
				"detail": a.driverOperationErrorMessage(err, "failed to write local driver metadata, driver=%s", definition.Type),
			}),
		}
	}
	a.emitDriverDownloadProgress(definition.Type, "done", 100, 100, a.appText("driver_manager.progress.local_package_done", nil))

	return connection.QueryResult{Success: true, Message: a.appText("driver_manager.backend.message.driver_install_success", nil), Data: map[string]interface{}{
		"driverType": definition.Type,
		"driverName": definition.Name,
		"engine":     engine,
	}}
}

func (a *App) DownloadDriverPackage(driverType string, version string, downloadURL string, downloadDir string) connection.QueryResult {
	return a.downloadDriverPackage(context.Background(), driverType, version, downloadURL, downloadDir)
}

func (a *App) RemoveDriverPackage(driverType string, downloadDir string) connection.QueryResult {
	// 按驱动类型加锁：删除不同类型驱动可并行。
	release := a.driverInstallLock.lockDriver(normalizeDriverType(driverType))
	defer release()

	definition, ok := resolveDriverDefinition(driverType)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.unsupported_driver_type", nil)}
	}
	if definition.BuiltIn {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.builtin_remove_not_allowed", nil)}
	}

	resolvedDir, err := resolveDriverDownloadDirectory(downloadDir)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	// 同上：删除只用到 resolvedDir 拼出的 driverDir，不必改全局目录。

	driverDir := driverInstallDir(resolvedDir, definition.Type)
	if err := os.RemoveAll(driverDir); err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("driver_manager.backend.error.remove_package_failed", map[string]any{
			"detail": a.driverOperationErrorMessage(err, "failed to remove driver package, driver=%s path=%s", definition.Type, driverDir),
		})}
	}

	return connection.QueryResult{Success: true, Message: a.appText("driver_manager.backend.message.package_removed", nil), Data: map[string]interface{}{
		"driverType": definition.Type,
		"driverName": definition.Name,
	}}
}
