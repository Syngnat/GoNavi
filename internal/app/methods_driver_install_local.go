package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

type optionalDriverInstallSnapshot struct {
	path       string
	backupPath string
	existed    bool
	isDir      bool
	mode       os.FileMode
}

func optionalDriverInstallTargetPaths(driverType string, installPath string, runtimePath string) []string {
	targets := []string{installPath, runtimePath}
	for _, supportName := range optionalDriverSupportFileNames(driverType) {
		targets = append(targets,
			filepath.Join(filepath.Dir(installPath), supportName),
			filepath.Join(filepath.Dir(runtimePath), supportName),
		)
	}

	unique := make([]string, 0, len(targets))
	seen := make(map[string]struct{}, len(targets))
	for _, target := range targets {
		cleaned := filepath.Clean(strings.TrimSpace(target))
		if cleaned == "." || cleaned == "" {
			continue
		}
		key := cleaned
		if stdRuntime.GOOS == "windows" {
			key = strings.ToLower(key)
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, cleaned)
	}
	return unique
}

func snapshotOptionalDriverInstallTargets(stagingDir string, targetPaths []string) ([]optionalDriverInstallSnapshot, error) {
	snapshots := make([]optionalDriverInstallSnapshot, 0, len(targetPaths))
	for index, targetPath := range targetPaths {
		snapshot := optionalDriverInstallSnapshot{path: targetPath}
		info, err := os.Stat(targetPath)
		if os.IsNotExist(err) {
			snapshots = append(snapshots, snapshot)
			continue
		}
		if err != nil {
			return nil, err
		}
		snapshot.existed = true
		snapshot.isDir = info.IsDir()
		snapshot.mode = info.Mode()
		if !snapshot.isDir {
			snapshot.backupPath = filepath.Join(stagingDir, fmt.Sprintf(".backup-%d", index))
			if err := copyOptionalDriverSupportFile(targetPath, snapshot.backupPath); err != nil {
				return nil, err
			}
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

func restoreOptionalDriverInstallTargets(snapshots []optionalDriverInstallSnapshot) error {
	var restoreErrs []error
	for index := len(snapshots) - 1; index >= 0; index-- {
		snapshot := snapshots[index]
		if !snapshot.existed {
			if err := os.RemoveAll(snapshot.path); err != nil {
				restoreErrs = append(restoreErrs, err)
			}
			continue
		}
		if snapshot.isDir {
			if info, err := os.Stat(snapshot.path); err == nil && info.IsDir() {
				continue
			}
			if err := os.RemoveAll(snapshot.path); err != nil {
				restoreErrs = append(restoreErrs, err)
				continue
			}
			if err := os.MkdirAll(snapshot.path, snapshot.mode.Perm()); err != nil {
				restoreErrs = append(restoreErrs, err)
			}
			continue
		}
		if err := os.RemoveAll(snapshot.path); err != nil {
			restoreErrs = append(restoreErrs, err)
			continue
		}
		if err := copyOptionalDriverSupportFile(snapshot.backupPath, snapshot.path); err != nil {
			restoreErrs = append(restoreErrs, err)
			continue
		}
		if err := os.Chmod(snapshot.path, snapshot.mode.Perm()); err != nil && stdRuntime.GOOS != "windows" {
			restoreErrs = append(restoreErrs, err)
		}
	}
	return errors.Join(restoreErrs...)
}

func localizeOptionalDriverActivateError(displayName string, activateErr error) error {
	if activateErr == nil {
		return nil
	}
	wrapped := wrapDriverInstallReplaceError(activateErr)
	var localized *localizedDriverBackendError
	if errors.As(wrapped, &localized) && localized != nil && strings.TrimSpace(localized.key) != "" {
		return wrapped
	}
	name := strings.TrimSpace(displayName)
	if name == "" {
		name = "driver"
	}
	return newLocalizedDriverBackendError("driver_manager.backend.error.activate_agent_failed", map[string]any{"name": name}, wrapped)
}

func promoteOptionalDriverAgentFromStaging(a *App, driverType string, stagingPath string, installPath string, runtimePath string, selectedVersion string) error {
	targetPaths := optionalDriverInstallTargetPaths(driverType, installPath, runtimePath)
	snapshots, err := snapshotOptionalDriverInstallTargets(filepath.Dir(stagingPath), targetPaths)
	if err != nil {
		return err
	}
	if a != nil {
		_, finish, prepareErr := a.beginOptionalDriverReplacement(driverType, targetPaths)
		if prepareErr != nil {
			return prepareErr
		}
		defer finish()
	}
	rollback := func(installErr error) error {
		if restoreErr := restoreOptionalDriverInstallTargets(snapshots); restoreErr != nil {
			wrappedInstall := wrapDriverInstallReplaceError(installErr)
			wrappedRestore := wrapDriverInstallReplaceError(restoreErr)
			if isDriverInstallFileBusyError(wrappedInstall) || isDriverInstallFileBusyError(wrappedRestore) {
				if isDriverInstallFileBusyError(wrappedInstall) {
					return wrappedInstall
				}
				return wrappedRestore
			}
			return errors.Join(wrappedInstall, fmt.Errorf("restore previous driver installation: %w", wrappedRestore))
		}
		return wrapDriverInstallReplaceError(installErr)
	}

	if err := activateOptionalDriverAgentBinary(driverType, stagingPath, installPath); err != nil {
		return rollback(err)
	}
	if err := activateOptionalDriverAgentBinary(driverType, installPath, runtimePath); err != nil {
		return rollback(err)
	}
	if _, err := verifyInstalledOptionalDriverAgentRevision(driverType, runtimePath, selectedVersion); err != nil {
		return rollback(err)
	}
	return nil
}

func installOptionalDriverAgentPackage(ctx context.Context, a *App, definition driverDefinition, selectedVersion string, resolvedDir string, downloadURL string) (installedDriverPackage, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	driverType := normalizeDriverType(definition.Type)
	installPath, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(resolvedDir, driverType, selectedVersion)
	if err != nil {
		return installedDriverPackage{}, err
	}
	runtimePath, err := db.ResolveOptionalDriverAgentExecutablePath(resolvedDir, driverType)
	if err != nil {
		return installedDriverPackage{}, err
	}
	if err := os.MkdirAll(filepath.Dir(installPath), 0o755); err != nil {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.create_named_directory_failed", map[string]any{"name": resolveDriverDisplayName(definition)}, err)
	}
	stagingDir, err := os.MkdirTemp(filepath.Dir(installPath), ".gonavi-driver-install-*")
	if err != nil {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.create_named_directory_failed", map[string]any{"name": resolveDriverDisplayName(definition)}, err)
	}
	defer os.RemoveAll(stagingDir)
	stagingPath := filepath.Join(stagingDir, filepath.Base(installPath))

	downloadSource, hash, err := ensureOptionalDriverAgentBinary(ctx, a, definition, stagingPath, downloadURL, selectedVersion)
	if err != nil {
		return installedDriverPackage{}, err
	}
	if ctx.Err() != nil {
		// Never activate a binary for a task the user has already canceled.
		return installedDriverPackage{}, driverDownloadCanceledError(ctx)
	}
	agentRevision, revisionErr := verifyInstalledOptionalDriverAgentRevision(driverType, stagingPath, selectedVersion)
	if revisionErr != nil {
		return installedDriverPackage{}, revisionErr
	}
	if strings.TrimSpace(hash) == "" {
		hash, err = hashFileSHA256(stagingPath)
		if err != nil {
			return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.named_agent_hash_failed", map[string]any{"name": resolveDriverDisplayName(definition)}, err)
		}
	}
	if activateErr := promoteOptionalDriverAgentFromStaging(a, driverType, stagingPath, installPath, runtimePath, selectedVersion); activateErr != nil {
		return installedDriverPackage{}, localizeOptionalDriverActivateError(resolveDriverDisplayName(definition), activateErr)
	}
	if strings.TrimSpace(downloadSource) == "" {
		downloadSource = strings.TrimSpace(downloadURL)
	}
	return installedDriverPackage{
		DriverType:     driverType,
		Version:        strings.TrimSpace(selectedVersion),
		AgentRevision:  agentRevision,
		FilePath:       installPath,
		FileName:       filepath.Base(installPath),
		ExecutablePath: runtimePath,
		DownloadURL:    strings.TrimSpace(downloadSource),
		SHA256:         hash,
		DownloadedAt:   time.Now().Format(time.RFC3339),
	}, nil
}

func installOptionalDriverAgentFromLocalPath(a *App, definition driverDefinition, filePath string, resolvedDir string, selectedVersion string) (installedDriverPackage, error) {
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	pathText := strings.TrimSpace(filePath)
	if pathText == "" {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.local_package_path_empty", nil, nil)
	}
	if absPath, absErr := filepath.Abs(pathText); absErr == nil {
		pathText = absPath
	}
	info, statErr := os.Stat(pathText)
	if statErr != nil {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.read_local_package_failed", nil, statErr)
	}

	installPath, err := db.ResolveOptionalDriverAgentExecutablePathForVersion(resolvedDir, driverType, selectedVersion)
	if err != nil {
		return installedDriverPackage{}, err
	}
	runtimePath, err := db.ResolveOptionalDriverAgentExecutablePath(resolvedDir, driverType)
	if err != nil {
		return installedDriverPackage{}, err
	}
	if mkErr := os.MkdirAll(filepath.Dir(installPath), 0o755); mkErr != nil {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.create_named_directory_failed", map[string]any{"name": displayName}, mkErr)
	}
	stagingDir, err := os.MkdirTemp(filepath.Dir(installPath), ".gonavi-driver-install-*")
	if err != nil {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.create_named_directory_failed", map[string]any{"name": displayName}, err)
	}
	defer os.RemoveAll(stagingDir)
	stagingPath := filepath.Join(stagingDir, filepath.Base(installPath))

	sourcePath := pathText
	sourceName := filepath.Base(pathText)
	downloadSource := fmt.Sprintf("local://manual/%s", filepath.Base(pathText))
	if info.IsDir() {
		matchedPath, matchedEntry, resolveErr := resolveLocalDriverAgentFromLocalDirectory(pathText, driverType, selectedVersion)
		if resolveErr != nil {
			return installedDriverPackage{}, resolveErr
		}
		sourcePath = matchedPath
		sourceName = filepath.Base(matchedPath)
		downloadSource = fmt.Sprintf("local://manual-dir/%s", filepath.Base(pathText))
		if strings.TrimSpace(matchedEntry) != "" {
			downloadSource = downloadSource + "#" + matchedEntry
		}
	}

	if !info.IsDir() && isDriverPackageArchivePath(pathText) {
		entryName, extractErr := installOptionalDriverAgentFromLocalArchive(pathText, definition, stagingPath, selectedVersion)
		if extractErr != nil {
			return installedDriverPackage{}, extractErr
		}
		if strings.TrimSpace(entryName) != "" {
			downloadSource = downloadSource + "#" + entryName
		}
	} else {
		if copyErr := copyAgentBinary(sourcePath, stagingPath); copyErr != nil {
			return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.import_local_agent_failed", nil, copyErr)
		}
		if supportErr := copyOptionalDriverSupportFilesFromDirectory(driverType, filepath.Dir(sourcePath), stagingDir); supportErr != nil {
			return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.import_local_agent_runtime_failed", nil, supportErr)
		}
	}
	if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, stagingPath); validateErr != nil {
		return installedDriverPackage{}, validateErr
	}

	agentRevision, revisionErr := verifyInstalledOptionalDriverAgentRevision(driverType, stagingPath, selectedVersion)
	if revisionErr != nil {
		return installedDriverPackage{}, revisionErr
	}
	hash, hashErr := hashFileSHA256(stagingPath)
	if hashErr != nil {
		return installedDriverPackage{}, newLocalizedDriverBackendError("driver_manager.backend.error.named_agent_hash_failed", map[string]any{"name": displayName}, hashErr)
	}
	if activateErr := promoteOptionalDriverAgentFromStaging(a, driverType, stagingPath, installPath, runtimePath, selectedVersion); activateErr != nil {
		return installedDriverPackage{}, localizeOptionalDriverActivateError(displayName, activateErr)
	}
	return installedDriverPackage{
		DriverType:     driverType,
		Version:        strings.TrimSpace(selectedVersion),
		AgentRevision:  agentRevision,
		FilePath:       sourcePath,
		FileName:       sourceName,
		ExecutablePath: runtimePath,
		DownloadURL:    downloadSource,
		SHA256:         hash,
		DownloadedAt:   time.Now().Format(time.RFC3339),
	}, nil
}

func probeInstalledOptionalDriverAgentRevision(driverType string, executablePath string) string {
	expectedRevision := db.OptionalDriverAgentRevision(driverType)
	if strings.TrimSpace(expectedRevision) == "" {
		return ""
	}
	actualRevision, _, err := optionalDriverAgentRevisionCurrent(driverType, executablePath)
	if err != nil {
		logger.Warnf("%s 驱动代理未返回版本元数据：%v", resolveDriverDisplayName(driverDefinition{Type: driverType}), err)
		return ""
	}
	return strings.TrimSpace(actualRevision)
}

type localDriverCandidate struct {
	absPath       string
	relativePath  string
	depth         int
	inPlatformDir bool
}

func resolveLocalDriverAgentFromLocalDirectory(directoryPath string, driverType string, selectedVersion string) (string, string, error) {
	root := strings.TrimSpace(directoryPath)
	if root == "" {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.local_directory_path_empty", nil, nil)
	}
	if absPath, absErr := filepath.Abs(root); absErr == nil {
		root = absPath
	}
	info, statErr := os.Stat(root)
	if statErr != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.read_local_directory_failed", nil, statErr)
	}
	if !info.IsDir() {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.local_directory_not_directory", map[string]any{"path": root}, nil)
	}

	normalizedType := normalizeDriverType(driverType)
	displayDefinition, found := resolveDriverDefinition(normalizedType)
	if !found {
		displayDefinition = driverDefinition{Type: normalizedType, Name: normalizedType}
	}
	displayName := resolveDriverDisplayName(displayDefinition)
	platformDir := optionalDriverBundlePlatformDir(stdRuntime.GOOS)
	assetNameCandidates := optionalDriverReleaseAssetNamesForVersion(normalizedType, selectedVersion)
	baseNameCandidates := optionalDriverExecutableBaseNamesForVersion(normalizedType, selectedVersion)
	assetName := optionalDriverReleaseAssetNameForVersion(normalizedType, selectedVersion)

	exactRelativePath := filepath.ToSlash(filepath.Join(platformDir, assetName))
	for _, candidateName := range assetNameCandidates {
		exactPath := filepath.Join(root, platformDir, candidateName)
		if exactInfo, err := os.Stat(exactPath); err == nil && !exactInfo.IsDir() {
			return exactPath, filepath.ToSlash(filepath.Join(platformDir, candidateName)), nil
		}
	}

	for _, candidateName := range assetNameCandidates {
		rootAssetPath := filepath.Join(root, candidateName)
		if rootAssetInfo, err := os.Stat(rootAssetPath); err == nil && !rootAssetInfo.IsDir() {
			return rootAssetPath, filepath.ToSlash(candidateName), nil
		}
	}

	assetCandidates := make([]localDriverCandidate, 0, 8)
	baseCandidates := make([]localDriverCandidate, 0, 8)
	visited := 0
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		visited++
		if visited > localDriverDirectoryScanMaxEntries {
			return errLocalDriverDirScanLimit
		}
		if d.IsDir() {
			return nil
		}
		name := strings.TrimSpace(d.Name())
		if name == "" {
			return nil
		}

		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			relative = name
		}
		normalizedRelative := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(relative), "./"))
		if normalizedRelative == "" {
			normalizedRelative = name
		}
		normalizedLower := strings.ToLower(normalizedRelative)
		platformPrefix := strings.ToLower(platformDir) + "/"
		inPlatformDir := normalizedLower == strings.ToLower(platformDir) || strings.HasPrefix(normalizedLower, platformPrefix)
		depth := strings.Count(normalizedRelative, "/")
		candidate := localDriverCandidate{
			absPath:       path,
			relativePath:  normalizedRelative,
			depth:         depth,
			inPlatformDir: inPlatformDir,
		}

		for _, candidateName := range assetNameCandidates {
			if strings.EqualFold(name, candidateName) {
				assetCandidates = append(assetCandidates, candidate)
				return nil
			}
		}
		for _, candidateName := range baseNameCandidates {
			if strings.EqualFold(name, candidateName) {
				baseCandidates = append(baseCandidates, candidate)
				return nil
			}
		}
		return nil
	})
	if errors.Is(walkErr, errLocalDriverDirScanLimit) {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.local_directory_scan_limit", map[string]any{"max": localDriverDirectoryScanMaxEntries}, nil)
	}
	if walkErr != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.scan_local_directory_failed", nil, walkErr)
	}

	selectBest := func(candidates []localDriverCandidate) (localDriverCandidate, bool) {
		if len(candidates) == 0 {
			return localDriverCandidate{}, false
		}
		sort.Slice(candidates, func(i, j int) bool {
			left := candidates[i]
			right := candidates[j]
			if left.inPlatformDir != right.inPlatformDir {
				return left.inPlatformDir
			}
			if left.depth != right.depth {
				return left.depth < right.depth
			}
			leftRelative := strings.ToLower(left.relativePath)
			rightRelative := strings.ToLower(right.relativePath)
			if leftRelative != rightRelative {
				return leftRelative < rightRelative
			}
			return strings.ToLower(left.absPath) < strings.ToLower(right.absPath)
		})
		return candidates[0], true
	}

	if candidate, ok := selectBest(assetCandidates); ok {
		return candidate.absPath, candidate.relativePath, nil
	}
	if candidate, ok := selectBest(baseCandidates); ok {
		return candidate.absPath, candidate.relativePath, nil
	}

	return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.local_directory_entry_missing", map[string]any{
		"name":            displayName,
		"path":            exactRelativePath,
		"assetCandidates": strings.Join(assetNameCandidates, " | "),
		"baseCandidates":  strings.Join(baseNameCandidates, " | "),
	}, nil)
}
