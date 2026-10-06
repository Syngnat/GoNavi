package app

import (
	"os"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// InstallUpdateAndRestart drains saved tasks before replacing the executable.
// A rejected or failed installer handoff restores the previous task runtime.
func (a *App) InstallUpdateAndRestart(closeAllWindowsInstancesConfirmed bool) connection.QueryResult {
	a.updateMu.Lock()
	staged := snapshotStagedUpdate(a.updateState.staged)
	a.updateMu.Unlock()
	if staged == nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.no_downloaded_package", nil)}
	}
	if strings.TrimSpace(staged.InstallLogPath) == "" {
		staged.InstallLogPath = buildUpdateInstallLogPath(staged.WorkspaceDir)
	}
	installTarget := ""
	if stdRuntime.GOOS == "windows" {
		installTarget = strings.TrimSpace(updateResolveInstallTarget())
		if installTarget == "" {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.appText("app.update.backend.error.install_target_unresolved", nil),
				}),
			}
		}
	}
	if err := validateUpdatePackageForCurrentInstallMode(stdRuntime.GOOS, staged.InstallMode, staged.PackageType, staged.FilePath); err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
				"detail": a.localizedUpdateError(err),
			}),
		}
	}
	resumeSyncJobs, err := a.suspendDataSyncJobs()
	installStarted := false
	defer func() {
		if !installStarted {
			resumeSyncJobs()
		}
	}()
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{"detail": err.Error()})}
	}
	if stdRuntime.GOOS == "windows" {
		maintenanceLease, err := updateAcquireWindowsMaintenance(installTarget)
		if err != nil {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.appText("app.update.backend.error.maintenance_lock_failed", map[string]any{"detail": err.Error()}),
				}),
			}
		}
		defer func() {
			if maintenanceLease.Release != nil {
				maintenanceLease.Release()
			}
		}()
		staged.MaintenanceEventName = maintenanceLease.Name

		if result := a.prepareWindowsUpdateInstances(staged, installTarget, closeAllWindowsInstancesConfirmed); !result.Success {
			return result
		}

	}

	if err := updateLaunchInstallScript(staged); err != nil {
		logger.Error(err, "启动更新脚本失败")
		detail := a.localizedUpdateError(err)
		msg := a.appText("app.update.backend.message.install_launch_failed", map[string]any{"detail": detail})
		if staged.InstallLogPath != "" {
			msg = a.appText("app.update.backend.message.install_launch_failed_with_log", map[string]any{
				"detail": detail,
				"path":   staged.InstallLogPath,
			})
		}
		return connection.QueryResult{
			Success: false,
			Message: msg,
			Data: map[string]any{
				"logPath":      staged.InstallLogPath,
				"installMode":  string(staged.InstallMode),
				"packageType":  string(staged.PackageType),
				"autoRelaunch": staged.AutoRelaunch,
			},
		}
	}
	installStarted = true
	go a.quitForUpdate()

	msg := a.appText("app.update.backend.message.install_started", nil)
	if staged.InstallLogPath != "" {
		msg = a.appText("app.update.backend.message.install_started_with_log", map[string]any{"path": staged.InstallLogPath})
	}
	return connection.QueryResult{
		Success: true,
		Message: msg,
		Data: map[string]any{
			"logPath":      staged.InstallLogPath,
			"installMode":  string(staged.InstallMode),
			"packageType":  string(staged.PackageType),
			"autoRelaunch": staged.AutoRelaunch,
		},
	}
}

func (a *App) prepareWindowsUpdateInstances(staged *stagedUpdate, installTarget string, confirmed bool) connection.QueryResult {
	finalTarget := resolveWindowsUpdateFinalTargetPath(installTarget, staged.FilePath)
	runningInstances, err := updateFindOtherWindowsInstances([]string{installTarget, finalTarget}, os.Getpid())
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
				"detail": a.appText("app.update.backend.error.close_instances_failed", map[string]any{"detail": err.Error()}),
			}),
		}
	}
	// 只有带界面窗口的其他实例才需要确认（可能有未保存内容）；自家的无头后台进程
	// （运行时清理进程、MCP 服务）不计数，下面直接随安装关闭。
	interactiveInstances := interactiveWindowsUpdateProcesses(runningInstances)
	if windowsUpdateCloseConfirmationRequired(stdRuntime.GOOS, confirmed, len(interactiveInstances)) {
		return connection.QueryResult{
			Success: false,
			Data: map[string]any{
				"requiresCloseConfirmation": true,
				"instanceCount":             len(interactiveInstances),
				"runningPids":               otherWindowsUpdateProcessIDs(interactiveInstances),
			},
		}
	}

	if staged.InstallMode == updateInstallModePortable {
		if err := ensureWindowsUpdateTargetWritable(installTarget); err != nil {
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.localizedUpdateError(err),
				}),
			}
		}
	}

	if confirmed || len(runningInstances) > 0 {
		closedPIDs, closeErr := closeOtherWindowsUpdateInstancesForInstall([]string{installTarget, finalTarget}, os.Getpid())
		if closeErr != nil {
			logger.Warnf("关闭 Windows 更新相关实例失败 current=%s target=%s pids=%v error=%v", installTarget, finalTarget, closedPIDs, closeErr)
			return connection.QueryResult{
				Success: false,
				Message: a.appText("app.update.backend.message.install_launch_failed", map[string]any{
					"detail": a.appText("app.update.backend.error.close_instances_failed", map[string]any{"detail": closeErr.Error()}),
				}),
				Data: map[string]any{
					"runningPids": closedPIDs,
				},
			}
		}
		if len(closedPIDs) > 0 {
			logger.Infof("Windows 更新已关闭其他 GoNavi 实例 current=%s target=%s pids=%v", installTarget, finalTarget, closedPIDs)
		}
	}
	return connection.QueryResult{Success: true}
}
