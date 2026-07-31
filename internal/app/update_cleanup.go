package app

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/logger"
)

func launchWindowsMSIUpdate(staged *stagedUpdate, targetExe string, pid int, waitForHandoff func() error) error {
	if staged == nil {
		return localizedUpdateError{key: "app.update.backend.message.no_downloaded_package"}
	}
	if !isUpdatePackageCompatibleWithInstallMode("windows", staged.InstallMode, staged.PackageType, staged.FilePath) {
		return localizedUpdateError{
			key:    "app.update.backend.error.online_update_unsupported",
			params: map[string]any{"platform": "windows/" + string(staged.InstallMode) + "/" + string(staged.PackageType)},
		}
	}
	if err := os.MkdirAll(staged.StagedDir, 0o755); err != nil {
		return err
	}

	originalSourceDir := strings.TrimSpace(filepath.Dir(staged.FilePath))
	preparedSource, err := prepareWindowsStagedUpdateAsset(staged.FilePath, staged.StagedDir)
	if err != nil {
		return err
	}
	staged.FilePath = preparedSource
	staged.InstallLogPath = buildUpdateInstallLogPath(staged.StagedDir)
	msiLogPath := strings.TrimSuffix(staged.InstallLogPath, filepath.Ext(staged.InstallLogPath)) + "-msi.log"

	cleanupWindowsUpdateArtifacts([]string{
		originalSourceDir,
		strings.TrimSpace(filepath.Dir(staged.StagedDir)),
	}, map[string]struct{}{
		cleanComparablePath(staged.FilePath):  {},
		cleanComparablePath(staged.StagedDir): {},
	})

	scriptPath := filepath.Join(staged.StagedDir, "update-msi.ps1")
	if err := os.WriteFile(scriptPath, []byte(buildWindowsMSIUpdatePowerShellScript()), 0o644); err != nil {
		return err
	}
	msiExecPath := resolveWindowsMSIExecPath(os.Getenv)
	context := windowsMSIUpdateLaunchContext{
		SourcePath:           staged.FilePath,
		TargetPath:           strings.TrimSpace(targetExe),
		UpdatesDir:           resolveUpdateCleanupDir(staged.WorkspaceDir),
		StagedDir:            staged.StagedDir,
		LogPath:              staged.InstallLogPath,
		MSILogPath:           msiLogPath,
		MSIExecPath:          msiExecPath,
		MaintenanceEventName: staged.MaintenanceEventName,
		HandoffEventName:     staged.UpdateHandoffEventName,
		PID:                  pid,
	}
	logger.Infof("启动 Windows MSI 更新器：target=%s script=%s log=%s msi_log=%s package=%s", targetExe, scriptPath, staged.InstallLogPath, msiLogPath, staged.FilePath)
	cmd := buildWindowsMSILaunchCommand(scriptPath, context)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start Windows MSI updater: %w", err)
	}
	if waitForHandoff != nil {
		if err := waitForHandoff(); err != nil {
			if cmd.Process != nil {
				if killErr := cmd.Process.Kill(); killErr == nil {
					_, _ = cmd.Process.Wait()
				} else {
					_ = cmd.Process.Release()
				}
			}
			return err
		}
	}
	if cmd.Process != nil {
		if err := cmd.Process.Release(); err != nil {
			logger.Warnf("释放 Windows MSI 更新脚本进程句柄失败：%v", err)
		}
	}
	return nil
}

func resolveWindowsMSIExecPath(getenv func(string) string) string {
	if getenv != nil {
		if overridden := strings.TrimSpace(getenv("GONAVI_UPDATE_MSIEXEC_PATH")); overridden != "" {
			return overridden
		}
		if systemRoot := strings.TrimSpace(getenv("SystemRoot")); systemRoot != "" {
			return filepath.Join(systemRoot, "System32", "msiexec.exe")
		}
	}
	return filepath.Join(`C:\Windows`, "System32", "msiexec.exe")
}

func launchWindowsUpdateWithCleanup(staged *stagedUpdate, targetExe string, pid int, waitForHandoff func() error) error {
	if staged == nil {
		return localizedUpdateError{key: "app.update.backend.message.no_downloaded_package"}
	}
	if err := os.MkdirAll(staged.StagedDir, 0o755); err != nil {
		return err
	}

	currentTargetExe := strings.TrimSpace(targetExe)
	originalSourceDir := strings.TrimSpace(filepath.Dir(staged.FilePath))
	preparedSource, err := prepareWindowsStagedUpdateAsset(staged.FilePath, staged.StagedDir)
	if err != nil {
		return err
	}
	staged.FilePath = preparedSource
	staged.InstallLogPath = buildUpdateInstallLogPath(staged.StagedDir)
	finalTargetExe := resolveWindowsUpdateFinalTargetPath(currentTargetExe, staged.FilePath)

	cleanupWindowsUpdateArtifacts([]string{
		originalSourceDir,
		strings.TrimSpace(filepath.Dir(staged.StagedDir)),
		strings.TrimSpace(filepath.Dir(currentTargetExe)),
		strings.TrimSpace(filepath.Dir(finalTargetExe)),
	}, map[string]struct{}{
		cleanComparablePath(currentTargetExe): {},
		cleanComparablePath(finalTargetExe):   {},
		cleanComparablePath(staged.FilePath):  {},
		cleanComparablePath(staged.StagedDir): {},
	})

	scriptPath := filepath.Join(staged.StagedDir, "update.ps1")
	content := buildWindowsPowerShellScript()
	if err := os.WriteFile(scriptPath, []byte(content), 0o644); err != nil {
		return err
	}

	launchContext := windowsUpdateLaunchContext{
		SourcePath:           staged.FilePath,
		TargetPath:           finalTargetExe,
		CurrentTargetPath:    currentTargetExe,
		UpdatesDir:           resolveUpdateCleanupDir(staged.WorkspaceDir),
		StagedDir:            staged.StagedDir,
		LogPath:              staged.InstallLogPath,
		MaintenanceEventName: staged.MaintenanceEventName,
		HandoffEventName:     staged.UpdateHandoffEventName,
		PID:                  pid,
	}
	logger.Infof("启动 Windows PowerShell 更新器：current=%s target=%s script=%s log=%s", currentTargetExe, finalTargetExe, scriptPath, staged.InstallLogPath)
	cmd := buildWindowsLaunchCommand(scriptPath, launchContext)
	if err := cmd.Start(); err != nil {
		return err
	}
	if waitForHandoff != nil {
		if err := waitForHandoff(); err != nil {
			if cmd.Process != nil {
				if killErr := cmd.Process.Kill(); killErr == nil {
					_, _ = cmd.Process.Wait()
				} else {
					_ = cmd.Process.Release()
				}
			}
			return err
		}
	}
	if cmd.Process != nil {
		if err := cmd.Process.Release(); err != nil {
			logger.Warnf("释放 Windows 更新脚本进程句柄失败：%v", err)
		}
	}
	return nil
}

func resolveWindowsUpdateFinalTargetPath(currentTarget string, sourcePath string) string {
	currentTarget = strings.TrimSpace(currentTarget)
	if currentTarget == "" {
		return currentTarget
	}
	currentName := filepath.Base(currentTarget)
	sourceName := filepath.Base(strings.TrimSpace(sourcePath))
	sourceExecutableName := resolveVersionedWindowsUpdateExecutableName(sourceName)
	if isVersionedWindowsUpdatePackageName(currentName) && sourceExecutableName != "" {
		return filepath.Join(filepath.Dir(currentTarget), sourceExecutableName)
	}
	return currentTarget
}

func isVersionedWindowsUpdatePackageName(name string) bool {
	trimmed := strings.TrimSpace(name)
	lower := strings.ToLower(trimmed)
	return strings.HasPrefix(trimmed, "GoNavi-") &&
		strings.Contains(trimmed, "-Windows-") &&
		strings.HasSuffix(lower, ".exe")
}

func resolveVersionedWindowsUpdateExecutableName(name string) string {
	trimmed := strings.TrimSpace(name)
	if !strings.HasPrefix(trimmed, "GoNavi-") || !strings.Contains(trimmed, "-Windows-") {
		return ""
	}
	extension := filepath.Ext(trimmed)
	switch strings.ToLower(extension) {
	case ".exe":
		return trimmed
	case ".zip":
		return strings.TrimSuffix(trimmed, extension) + ".exe"
	default:
		return ""
	}
}

func prepareWindowsStagedUpdateAsset(sourcePath string, stagedDir string) (string, error) {
	sourcePath = strings.TrimSpace(sourcePath)
	stagedDir = strings.TrimSpace(stagedDir)
	if sourcePath == "" || stagedDir == "" {
		return sourcePath, nil
	}
	if isUpdateAssetPathInsideStagedDir(sourcePath, stagedDir) {
		return sourcePath, nil
	}
	if err := os.MkdirAll(stagedDir, 0o755); err != nil {
		return "", err
	}
	targetPath := filepath.Join(stagedDir, filepath.Base(sourcePath))
	if cleanComparablePath(sourcePath) == cleanComparablePath(targetPath) {
		return sourcePath, nil
	}
	_ = os.Remove(targetPath)
	if err := os.Rename(sourcePath, targetPath); err == nil {
		return targetPath, nil
	}
	if err := copyFileForWindowsUpdate(sourcePath, targetPath); err != nil {
		return "", err
	}
	_ = os.Remove(sourcePath)
	return targetPath, nil
}

func copyFileForWindowsUpdate(sourcePath string, targetPath string) error {
	in, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

func cleanupWindowsUpdateArtifacts(dirs []string, keep map[string]struct{}) {
	seen := map[string]struct{}{}
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" || dir == "." {
			continue
		}
		cleanDir := cleanComparablePath(dir)
		if cleanDir == "" {
			continue
		}
		if _, ok := seen[cleanDir]; ok {
			continue
		}
		seen[cleanDir] = struct{}{}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			path := filepath.Join(dir, entry.Name())
			cleanPath := cleanComparablePath(path)
			if cleanPath == "" {
				continue
			}
			if _, ok := keep[cleanPath]; ok {
				continue
			}
			if shouldRemoveWindowsUpdateArtifact(entry.Name(), entry.IsDir()) {
				if entry.IsDir() {
					_ = os.RemoveAll(path)
				} else {
					_ = os.Remove(path)
				}
			}
		}
	}
}

func shouldRemoveWindowsUpdateArtifact(name string, isDir bool) bool {
	trimmed := strings.TrimSpace(name)
	lower := strings.ToLower(trimmed)
	if trimmed == "" {
		return false
	}
	if isDir {
		return strings.HasPrefix(lower, ".gonavi-update-")
	}
	if strings.HasPrefix(lower, "gonavi-update-") && strings.HasSuffix(lower, ".log") {
		return true
	}
	if !strings.HasPrefix(trimmed, "GoNavi-") {
		return false
	}
	if !strings.Contains(trimmed, "-Windows-") {
		return false
	}
	return strings.HasSuffix(lower, ".exe") || strings.HasSuffix(lower, ".msi") || strings.HasSuffix(lower, ".zip")
}

func cleanComparablePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	cleaned := filepath.Clean(path)
	if cleaned == "." {
		return ""
	}
	if stdRuntime.GOOS == "windows" {
		return strings.ToLower(cleaned)
	}
	return cleaned
}
