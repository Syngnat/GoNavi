package app

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
	"time"

	"GoNavi-Wails/internal/logger"
)

func resolveUpdateWorkspaceDir(version string) string {
	return resolveUpdateWorkspaceDirForInstallMode(version, updateResolveInstallMode())
}

func resolveUpdateWorkspaceDirForInstallMode(version string, installMode updateInstallMode) string {
	cacheDir, _ := os.UserCacheDir()
	return resolveUpdateWorkspaceDirForPlatform(
		stdRuntime.GOOS,
		version,
		installMode,
		"",
		cacheDir,
	)
}

func resolveUpdateWorkspaceDirCandidatesForInstallMode(version string, installMode updateInstallMode) []string {
	preferredDir := resolveUpdateWorkspaceDirForInstallMode(version, installMode)
	fallbackDir := resolveUpdateWorkspaceDirForPlatform(stdRuntime.GOOS, version, installMode, "", "")
	candidates := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	for _, candidate := range []string{preferredDir, fallbackDir} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		key := normalizeUpdatePathForPrefixCheck(candidate)
		if stdRuntime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, candidate)
	}
	return candidates
}

func resolveUpdateWorkspaceDirForPlatform(_ string, version string, _ updateInstallMode, _ string, userCacheDir string) string {
	baseDir := strings.TrimSpace(userCacheDir)
	if baseDir == "" {
		baseDir = strings.TrimSpace(os.TempDir())
	}
	if baseDir == "" {
		return ""
	}
	return filepath.Join(baseDir, "GoNavi", "updates", sanitizeVersionForPath(version))
}

func prepareUpdateWorkspaceAndStagingDirs(workspaceCandidates []string, channel string, version string) (string, string, error) {
	var prepareErrors []error
	for _, candidate := range workspaceCandidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		if err := os.MkdirAll(candidate, 0o755); err != nil {
			prepareErrors = append(prepareErrors, fmt.Errorf("create %s: %w", candidate, err))
			continue
		}

		stagedDir := resolveUpdateStagedDir(candidate, channel, version)
		stageBaseDir := filepath.Dir(stagedDir)
		// Windows 上文件可能被杀毒软件或索引服务短暂占用，需要重试。
		for retry := 0; retry < 5; retry++ {
			err := os.RemoveAll(stagedDir)
			if err == nil {
				break
			}
			if retry < 4 {
				time.Sleep(time.Duration(retry+1) * 500 * time.Millisecond)
			} else {
				stagedDir = filepath.Join(stageBaseDir, fmt.Sprintf("%s-%d", buildUpdateStageDirName(channel, version), time.Now().UnixNano()))
			}
		}
		if err := os.MkdirAll(stagedDir, 0o755); err != nil {
			prepareErrors = append(prepareErrors, fmt.Errorf("create %s: %w", stagedDir, err))
			continue
		}
		return candidate, stagedDir, nil
	}
	if len(prepareErrors) == 0 {
		return "", "", errors.New("no update workspace candidates")
	}
	return "", "", errors.Join(prepareErrors...)
}

func resolveUpdateAssetPath(workspaceDir string, stagedDir string, assetName string) string {
	name := strings.TrimSpace(assetName)
	if shouldStoreUpdateAssetInWorkspaceRoot(stdRuntime.GOOS) {
		return filepath.Join(workspaceDir, name)
	}
	return filepath.Join(stagedDir, name)
}

func shouldStoreUpdateAssetInWorkspaceRoot(goos string) bool {
	switch strings.TrimSpace(strings.ToLower(goos)) {
	case "darwin", "windows", "linux":
		return true
	default:
		return false
	}
}

func resolveUpdateStagedDir(workspaceDir string, channel string, version string) string {
	return resolveUpdateStagedDirForPlatform(stdRuntime.GOOS, workspaceDir, channel, version)
}

func resolveUpdateStagedDirForPlatform(goos string, workspaceDir string, channel string, version string) string {
	baseDir := strings.TrimSpace(workspaceDir)
	if baseDir == "" {
		return ""
	}
	return filepath.Join(baseDir, buildUpdateStageDirNameForPlatform(goos, channel, version))
}

func normalizeUpdatePathForPrefixCheck(path string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(path), "\\", "/")
	normalized = filepath.ToSlash(filepath.Clean(normalized))
	if normalized == "." {
		return ""
	}
	return strings.TrimRight(normalized, "/")
}

func updatePathsEqualForPlatform(goos string, left string, right string) bool {
	left = normalizeUpdatePathForPrefixCheck(left)
	right = normalizeUpdatePathForPrefixCheck(right)
	if left == "" || right == "" {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(goos), "windows") {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func absoluteUpdatePath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("path is empty")
	}
	cleaned := filepath.Clean(path)
	if cleaned == "." {
		return "", errors.New("path resolves to current directory")
	}
	absPath, err := filepath.Abs(cleaned)
	if err != nil {
		return "", err
	}
	return filepath.Clean(absPath), nil
}

func isUpdatePathStrictlyInsideDir(path string, dir string) bool {
	absPath, err := absoluteUpdatePath(path)
	if err != nil {
		return false
	}
	absDir, err := absoluteUpdatePath(dir)
	if err != nil {
		return false
	}
	relPath, err := filepath.Rel(absDir, absPath)
	if err != nil || relPath == "." || filepath.IsAbs(relPath) {
		return false
	}
	return relPath != ".." && !strings.HasPrefix(relPath, ".."+string(filepath.Separator))
}

func isDirectChildUpdatePath(path string, parentDir string) bool {
	absPath, err := absoluteUpdatePath(path)
	if err != nil {
		return false
	}
	absParent, err := absoluteUpdatePath(parentDir)
	if err != nil {
		return false
	}
	relPath, err := filepath.Rel(absParent, absPath)
	if err != nil || relPath == "." || relPath == ".." || filepath.IsAbs(relPath) {
		return false
	}
	return filepath.Dir(relPath) == "."
}

func allowedUpdateRootDirs() []string {
	cacheDir, _ := os.UserCacheDir()
	baseDirs := []string{cacheDir, os.TempDir()}
	roots := make([]string, 0, len(baseDirs))
	seen := make(map[string]struct{}, len(baseDirs))
	for _, baseDir := range baseDirs {
		baseDir = strings.TrimSpace(baseDir)
		if baseDir == "" {
			continue
		}
		rootDir := filepath.Join(baseDir, "GoNavi", "updates")
		key := normalizeUpdatePathForPrefixCheck(rootDir)
		if stdRuntime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		roots = append(roots, rootDir)
	}
	return roots
}

func validateStagedUpdateWorkspace(staged *stagedUpdate) error {
	if staged == nil {
		return errors.New("staged update is nil")
	}
	workspaceDir := strings.TrimSpace(staged.WorkspaceDir)
	version := strings.TrimSpace(staged.Version)
	if workspaceDir == "" || version == "" {
		return errors.New("update workspace or version is empty")
	}
	if filepath.Base(filepath.Clean(workspaceDir)) != sanitizeVersionForPath(version) {
		return fmt.Errorf("update workspace does not match version %q", version)
	}
	allowed := false
	for _, rootDir := range allowedUpdateRootDirs() {
		if isDirectChildUpdatePath(workspaceDir, rootDir) {
			allowed = true
			break
		}
	}
	if !allowed {
		return fmt.Errorf("update workspace %q is outside the cache roots", workspaceDir)
	}
	for label, path := range map[string]string{
		"package": staged.FilePath,
		"staging": staged.StagedDir,
		"log":     staged.InstallLogPath,
	} {
		if !isUpdatePathStrictlyInsideDir(path, workspaceDir) {
			return fmt.Errorf("%s path %q is outside update workspace %q", label, path, workspaceDir)
		}
	}
	return nil
}

func resolveUpdateCleanupDir(workspaceDir string) string {
	workspaceDir = strings.TrimSpace(workspaceDir)
	if workspaceDir == "" {
		return ""
	}
	return filepath.Dir(filepath.Clean(workspaceDir))
}

func isUpdateAssetPathInsideStagedDir(filePath string, stagedDir string) bool {
	normalizedFilePath := normalizeUpdatePathForPrefixCheck(filePath)
	normalizedStagedDir := normalizeUpdatePathForPrefixCheck(stagedDir)
	if normalizedFilePath == "" || normalizedStagedDir == "" {
		return false
	}
	return normalizedFilePath == normalizedStagedDir || strings.HasPrefix(normalizedFilePath, normalizedStagedDir+"/")
}

func buildReusableUpdatePathCandidatesForPlatform(goos string, preferredWorkspaceDir string, fallbackWorkspaceDir string, channel string, version string, assetName string) []updatePathCandidate {
	preferredWorkspaceDir = strings.TrimSpace(preferredWorkspaceDir)
	fallbackWorkspaceDir = strings.TrimSpace(fallbackWorkspaceDir)
	assetName = strings.TrimSpace(assetName)
	workspaceCandidates := []string{preferredWorkspaceDir, fallbackWorkspaceDir}
	seenWorkspace := make(map[string]struct{}, len(workspaceCandidates))
	candidates := make([]updatePathCandidate, 0, len(workspaceCandidates))

	for _, workspaceDir := range workspaceCandidates {
		workspaceDir = strings.TrimSpace(workspaceDir)
		if workspaceDir == "" {
			continue
		}
		if _, exists := seenWorkspace[workspaceDir]; exists {
			continue
		}
		seenWorkspace[workspaceDir] = struct{}{}
		if shouldStoreUpdateAssetInWorkspaceRoot(goos) {
			candidates = append(candidates, updatePathCandidate{
				workspaceDir: workspaceDir,
				stagedDir:    resolveUpdateStagedDirForPlatform(goos, workspaceDir, channel, version),
				assetPath:    filepath.Join(workspaceDir, assetName),
			})
		}
	}
	return candidates
}

func isExistingDownloadedAsset(filePath string, expectedSize int64) bool {
	path := strings.TrimSpace(filePath)
	if path == "" {
		return false
	}
	stat, err := os.Stat(path)
	if err != nil || stat.IsDir() {
		return false
	}
	if expectedSize > 0 && stat.Size() != expectedSize {
		return false
	}
	return true
}

func resolveReusableStagedUpdate(info UpdateInfo, current *stagedUpdate) *stagedUpdate {
	workspaceDirs := resolveUpdateWorkspaceDirCandidatesForInstallMode(strings.TrimSpace(info.LatestVersion), updateInstallMode(info.InstallMode))
	preferredWorkspaceDir := ""
	fallbackWorkspaceDir := ""
	if len(workspaceDirs) > 0 {
		preferredWorkspaceDir = workspaceDirs[0]
	}
	if len(workspaceDirs) > 1 {
		fallbackWorkspaceDir = workspaceDirs[1]
	}
	return resolveReusableStagedUpdateForPlatform(
		stdRuntime.GOOS,
		preferredWorkspaceDir,
		fallbackWorkspaceDir,
		info,
		current,
	)
}

func resolveReusableStagedUpdateForPlatform(goos string, preferredWorkspaceDir string, fallbackWorkspaceDir string, info UpdateInfo, current *stagedUpdate) *stagedUpdate {
	channel, err := normalizeUpdateChannel(info.Channel)
	if err != nil {
		channel = updateChannelLatest
	}
	version := strings.TrimSpace(info.LatestVersion)
	assetName := strings.TrimSpace(info.AssetName)
	if version == "" || assetName == "" {
		return nil
	}
	candidates := buildReusableUpdatePathCandidatesForPlatform(
		goos,
		preferredWorkspaceDir,
		fallbackWorkspaceDir,
		string(channel),
		version,
		assetName,
	)

	if current != nil {
		currentChannel := current.Channel
		if currentChannel == "" {
			currentChannel = updateChannelLatest
		}
		if currentChannel == channel && strings.TrimSpace(current.Version) == version &&
			strings.TrimSpace(current.AssetName) == assetName &&
			current.InstallMode == updateInstallMode(info.InstallMode) &&
			current.PackageType == updatePackageType(info.PackageType) {
			currentPath := strings.TrimSpace(current.FilePath)
			if isExistingDownloadedAsset(currentPath, info.AssetSize) {
				for _, candidate := range candidates {
					if !updatePathsEqualForPlatform(goos, currentPath, candidate.assetPath) ||
						!isUpdatePathStrictlyInsideDir(current.StagedDir, candidate.workspaceDir) {
						continue
					}
					current.WorkspaceDir = candidate.workspaceDir
					if !isUpdatePathStrictlyInsideDir(current.InstallLogPath, candidate.workspaceDir) {
						current.InstallLogPath = buildUpdateInstallLogPath(candidate.workspaceDir)
					}
					current.Channel = channel
					current.AssetName = assetName
					current.InstallMode = updateInstallMode(info.InstallMode)
					current.PackageType = updatePackageType(info.PackageType)
					current.AutoRelaunch = info.AutoRelaunch
					return current
				}
			}
		}
	}

	for _, candidate := range candidates {
		if !isExistingDownloadedAsset(candidate.assetPath, info.AssetSize) {
			continue
		}
		return &stagedUpdate{
			Channel:        channel,
			Version:        version,
			AssetName:      assetName,
			WorkspaceDir:   candidate.workspaceDir,
			FilePath:       candidate.assetPath,
			StagedDir:      candidate.stagedDir,
			InstallLogPath: buildUpdateInstallLogPath(candidate.workspaceDir),
			InstallMode:    updateInstallMode(info.InstallMode),
			PackageType:    updatePackageType(info.PackageType),
			AutoRelaunch:   info.AutoRelaunch,
		}
	}

	return nil
}

func resolveUpdateInstallTarget() string {
	exePath, err := resolveExecutablePath(os.Executable, filepath.EvalSymlinks)
	if err != nil {
		return ""
	}
	if stdRuntime.GOOS == "darwin" {
		return resolveMacUpdateTarget(exePath)
	}
	return exePath
}

func resolveExecutablePath(
	executable func() (string, error),
	evalSymlinks func(string) (string, error),
) (string, error) {
	exePath, err := executable()
	if err != nil {
		return "", err
	}
	exePath = strings.TrimSpace(exePath)
	if exePath == "" {
		return "", localizedUpdateError{key: "app.update.backend.error.install_target_unresolved"}
	}
	if resolved, evalErr := evalSymlinks(exePath); evalErr == nil {
		if resolved = strings.TrimSpace(resolved); resolved != "" {
			exePath = resolved
		}
	}
	return exePath, nil
}

func ensureWindowsUpdateTargetWritable(targetExe string) error {
	targetExe = strings.TrimSpace(targetExe)
	targetDir := strings.TrimSpace(filepath.Dir(targetExe))
	if targetExe == "" || targetDir == "" || targetDir == "." {
		return localizedUpdateError{key: "app.update.backend.error.install_target_unresolved"}
	}

	probePath := filepath.Join(targetDir, fmt.Sprintf(".gonavi-update-write-probe-%d.tmp", time.Now().UnixNano()))
	file, err := os.OpenFile(probePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return localizedUpdateError{
			key: "app.update.backend.error.install_target_not_writable",
			params: map[string]any{
				"path":   targetDir,
				"detail": err.Error(),
			},
		}
	}
	if closeErr := file.Close(); closeErr != nil {
		logger.Warnf("关闭 Windows 更新写入探针失败：%v", closeErr)
	}
	if removeErr := os.Remove(probePath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		logger.Warnf("清理 Windows 更新写入探针失败：%v", removeErr)
	}
	return nil
}
