package app

import (
	"context"
	"errors"
	"fmt"
	urlpkg "net/url"
	"os"
	"os/exec"
	"path/filepath"
	stdRuntime "runtime"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (a *App) quitForUpdate() {
	updateQuitSleep(updateQuitRequestDelay)
	a.ForceQuitApplication()
	// Leave enough time for shutdown transaction rollback before forcing the process down.
	updateQuitSleep(updateQuitForceExitDelay)
	updateExitProcess(0)
}

func (a *App) OpenDownloadedUpdateDirectory() connection.QueryResult {
	a.updateMu.Lock()
	staged := snapshotStagedUpdate(a.updateState.staged)
	a.updateMu.Unlock()
	if staged == nil {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.no_downloaded_package", nil)}
	}
	assetPath := strings.TrimSpace(staged.FilePath)
	if assetPath == "" {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.package_path_empty", nil)}
	}
	dirPath := strings.TrimSpace(filepath.Dir(assetPath))
	if dirPath == "" || dirPath == "." {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.package_directory_unresolved", nil)}
	}
	if stat, err := os.Stat(dirPath); err != nil || !stat.IsDir() {
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.package_directory_unavailable", nil)}
	}

	if openDirectoryNatively(dirPath) {
		return connection.QueryResult{
			Success: true,
			Message: a.appText("app.update.backend.message.opened_install_directory", map[string]any{"path": dirPath}),
			Data:    map[string]any{"path": dirPath},
		}
	}
	var cmd *exec.Cmd
	switch stdRuntime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dirPath)
	case "windows":
		cmd = exec.Command("explorer", dirPath)
	case "linux":
		cmd = exec.Command("xdg-open", dirPath)
	default:
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.open_directory_unsupported", map[string]any{"platform": stdRuntime.GOOS})}
	}
	if err := startBackgroundCommand(cmd, func(waitErr error) {
		if waitErr != nil {
			logger.Warnf("打开更新目录的后台进程退出异常：%v", waitErr)
		}
	}); err != nil {
		logger.Error(err, "打开更新目录失败")
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.open_directory_failed", map[string]any{"detail": err.Error()})}
	}
	return connection.QueryResult{
		Success: true,
		Message: a.appText("app.update.backend.message.opened_install_directory", map[string]any{"path": dirPath}),
		Data: map[string]any{
			"path": dirPath,
		},
	}
}

func (a *App) downloadAndStageUpdate(ctx context.Context, info UpdateInfo, expectedRevision uint64) (connection.QueryResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		// The only cancellation source for an update task is the user, so the
		// message is the canceled one rather than a generic failure.
		return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.download_canceled", nil)}, err
	}
	workspaceCandidates := resolveUpdateWorkspaceDirCandidatesForInstallMode(info.LatestVersion, updateInstallMode(info.InstallMode))
	workspaceDir, stagedDir, prepareErr := prepareUpdateWorkspaceAndStagingDirs(workspaceCandidates, info.Channel, info.LatestVersion)
	if prepareErr != nil {
		preferredDir := strings.TrimSpace(resolveUpdateWorkspaceDirForInstallMode(info.LatestVersion, updateInstallMode(info.InstallMode)))
		if preferredDir == "" {
			preferredDir = os.TempDir()
		}
		logger.Error(prepareErr, "创建更新工作区失败")
		errMsg := a.appText("app.update.backend.message.create_workspace_failed", map[string]any{"path": preferredDir})
		return connection.QueryResult{Success: false, Message: errMsg}, prepareErr
	}

	// 安装包本体放在工作区根级，staging 目录只保留更新脚本和临时展开物。
	assetPath := resolveUpdateAssetPath(workspaceDir, stagedDir, info.AssetName)
	progressCB := func(downloaded, total int64) {
		reportTotal := total
		if reportTotal <= 0 {
			reportTotal = info.AssetSize
		}
		a.emitUpdateDownloadProgress(&info, "downloading", downloaded, reportTotal, "")
	}
	if info.SHA256 == "" {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		message := a.appText("app.update.backend.message.checksum_missing", nil)
		return connection.QueryResult{Success: false, Message: message}, localizedUpdateError{key: "app.update.backend.message.checksum_missing"}
	}

	preferred := a.preferredDownloadSource()
	var err error
	if preferred == DownloadSourceCst {
		_, err = downloadUpdateAssetWithFallback(
			ctx,
			[]string{info.AssetURL, info.AssetAPIURL},
			assetPath,
			info.SHA256,
			info.AssetSize,
			progressCB,
		)
	} else {
		_, err = downloadUpdateAssetWithFallbackPreferred(
			ctx,
			[]string{info.AssetURL, info.AssetAPIURL},
			assetPath,
			info.SHA256,
			info.AssetSize,
			progressCB,
			preferred,
		)
	}
	if err != nil {
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		if errors.Is(err, context.Canceled) {
			// A user cancellation is not a download failure, so report it with the
			// canceled message that matches the task's terminal state.
			return connection.QueryResult{Success: false, Message: a.appText("app.update.backend.message.download_canceled", nil)}, err
		}
		if errors.Is(err, errUpdateChecksumMismatch) {
			message := a.appText("app.update.backend.message.checksum_failed", nil)
			return connection.QueryResult{Success: false, Message: message}, err
		}
		message := a.localizedUpdateError(err)
		return connection.QueryResult{Success: false, Message: message}, err
	}

	staged := &stagedUpdate{
		Channel:        updateChannel(info.Channel),
		Version:        info.LatestVersion,
		AssetName:      info.AssetName,
		WorkspaceDir:   workspaceDir,
		FilePath:       assetPath,
		StagedDir:      stagedDir,
		InstallLogPath: buildUpdateInstallLogPath(workspaceDir),
		InstallMode:    updateInstallMode(info.InstallMode),
		PackageType:    updatePackageType(info.PackageType),
		AutoRelaunch:   info.AutoRelaunch,
	}
	info.Downloaded = true
	info.DownloadPath = assetPath
	a.updateMu.Lock()
	if !a.updateState.downloading || a.updateState.revision != expectedRevision {
		a.updateMu.Unlock()
		_ = os.Remove(assetPath)
		_ = os.RemoveAll(stagedDir)
		err := localizedUpdateError{key: "app.update.backend.message.check_stale"}
		return connection.QueryResult{Success: false, Message: a.localizedUpdateError(err)}, err
	}
	a.updateState.lastCheck = snapshotUpdateInfo(&info)
	a.updateState.staged = staged
	a.updateState.revision++
	a.updateMu.Unlock()

	a.emitUpdateDownloadProgress(&info, "done", info.AssetSize, info.AssetSize, "")
	return connection.QueryResult{Success: true, Message: a.appText("app.update.backend.message.package_downloaded", nil), Data: buildUpdateDownloadResult(info, staged)}, nil
}

func downloadUpdateAssetWithFallback(
	ctx context.Context,
	candidates []string,
	assetPath string,
	expectedSHA256 string,
	expectedSize int64,
	onProgress func(downloaded, total int64),
) (string, error) {
	return downloadUpdateAssetWithFallbackUsing(
		ctx,
		candidates,
		assetPath,
		expectedSHA256,
		expectedSize,
		onProgress,
		DownloadSourceCst,
		false,
	)
}

func downloadUpdateAssetWithFallbackPreferred(
	ctx context.Context,
	candidates []string,
	assetPath string,
	expectedSHA256 string,
	expectedSize int64,
	onProgress func(downloaded, total int64),
	preferred DownloadSource,
) (string, error) {
	return downloadUpdateAssetWithFallbackUsing(
		ctx,
		candidates,
		assetPath,
		expectedSHA256,
		expectedSize,
		onProgress,
		preferred,
		true,
	)
}

func downloadUpdateAssetWithFallbackUsing(
	ctx context.Context,
	candidates []string,
	assetPath string,
	expectedSHA256 string,
	expectedSize int64,
	onProgress func(downloaded, total int64),
	preferred DownloadSource,
	usePreferredDownloader bool,
) (string, error) {
	seen := make(map[string]struct{}, len(candidates))
	urls := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		urls = append(urls, trimmed)
	}
	if len(urls) == 0 {
		return "", localizedUpdateError{
			key:    "app.update.backend.error.download_failed",
			params: map[string]any{"detail": "download URL is empty"},
		}
	}

	expectedHash := strings.TrimSpace(expectedSHA256)
	var lastErr error
	for index, candidate := range urls {
		// A cancellation must stop the fallback chain instead of quietly moving
		// on to the next download source.
		if ctxErr := ctx.Err(); ctxErr != nil {
			_ = os.Remove(assetPath)
			return "", ctxErr
		}
		candidate, requiresCurrentDevAsset := prepareUpdateDownloadCandidate(candidate, index == 0)
		_ = os.Remove(assetPath)
		var actualHash string
		var err error
		if usePreferredDownloader {
			actualHash, err = updateDownloadFileWithExpectedSizePreferred(ctx, candidate, assetPath, onProgress, expectedSize, preferred)
		} else {
			actualHash, err = updateDownloadFileWithExpectedSize(ctx, candidate, assetPath, onProgress, expectedSize)
		}
		if err == nil && expectedSize > 0 {
			stat, statErr := os.Stat(assetPath)
			if statErr != nil {
				err = statErr
			} else if stat.Size() != expectedSize {
				err = fmt.Errorf("update package size mismatch: expected=%d actual=%d", expectedSize, stat.Size())
			}
		}
		if err == nil && expectedHash != "" && !strings.EqualFold(expectedHash, actualHash) {
			err = errUpdateChecksumMismatch
		}
		if err == nil {
			return actualHash, nil
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			// Surface the context error rather than a transport error caused by it.
			_ = os.Remove(assetPath)
			return "", ctxErr
		}
		if errors.Is(err, errInvalidDownloadDispatcherURL) ||
			(requiresCurrentDevAsset && isCurrentDevAssetTerminalError(err)) {
			_ = os.Remove(assetPath)
			return "", err
		}
		lastErr = err
		if index+1 < len(urls) {
			logger.Warnf("更新包下载源失败，尝试下一下载源：attempt=%d err=%v", index+1, err)
		}
	}
	_ = os.Remove(assetPath)
	return "", lastErr
}

func prepareUpdateDownloadCandidate(rawURL string, primary bool) (string, bool) {
	candidate := strings.TrimSpace(rawURL)
	if !primary {
		return candidate, false
	}
	candidate = downloadDispatcherURLRequiringCurrentDevAsset(candidate)
	return candidate, dispatcherURLRequiresCurrentDevAsset(candidate)
}

func devUpdateDispatcherAssetURL(version string, assetName string) string {
	return updateDispatcherAssetURL(updateChannelDev, version, assetName)
}

func updateDispatcherAssetURL(channel updateChannel, version string, assetName string) string {
	version = strings.TrimSpace(version)
	assetName = strings.TrimSpace(assetName)
	if version == "" || assetName == "" {
		return ""
	}
	prefix := "/gonavi/releases/download/"
	if channel == updateChannelDev {
		prefix = "/gonavi/dev/releases/download/"
	}
	assetPath := prefix + urlpkg.PathEscape(version) + "/" + urlpkg.PathEscape(assetName)
	if err := validateDownloadDispatcherAssetPath(assetPath); err != nil {
		return ""
	}
	return downloadDispatcherURLForPath(assetPath)
}
