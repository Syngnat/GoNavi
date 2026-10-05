package app

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/logger"
)

func localizedDriverProgressText(text func(string, map[string]any) string, key string, params map[string]any) string {
	if text == nil {
		localizer := newAppLocalizer()
		if localizer == nil {
			return key
		}
		return localizer.T(key, params)
	}
	return text(key, params)
}

func driverProgressText(a *App) func(string, map[string]any) string {
	if a == nil {
		localizer := newAppLocalizer()
		if localizer == nil {
			return func(key string, _ map[string]any) string { return key }
		}
		return localizer.T
	}
	return a.appText
}

func buildOptionalDriverInstallPlanMessage(text func(string, map[string]any) string, displayName string, selectedVersion string, forceSourceBuild bool, preferSourceBuildBeforeDownload bool, requireSourceBuildBeforeDownload bool, restrictToExplicitArtifact bool, directURLCount int, bundleURLCount int) string {
	name := strings.TrimSpace(displayName)
	if name == "" {
		name = localizedDriverProgressText(text, "driver_manager.backend.driver_fallback_name", nil)
	}
	versionText := normalizeVersion(strings.TrimSpace(selectedVersion))
	if versionText == "" {
		versionText = localizedDriverProgressText(text, "driver_manager.backend.version.unlabeled", nil)
	}
	params := map[string]any{
		"name":    name,
		"version": versionText,
		"direct":  directURLCount,
		"bundle":  bundleURLCount,
	}

	if forceSourceBuild {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.source_only", params)
	}
	if requireSourceBuildBeforeDownload {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.require_source_first", params)
	}
	if preferSourceBuildBeforeDownload {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.source_first", params)
	}
	if directURLCount > 0 && !restrictToExplicitArtifact && bundleURLCount > 0 {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.direct_then_bundle", params)
	}
	if directURLCount > 0 && restrictToExplicitArtifact {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.explicit_direct", params)
	}
	if directURLCount > 0 {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.direct_only", params)
	}
	if !restrictToExplicitArtifact && bundleURLCount > 0 {
		return localizedDriverProgressText(text, "driver_manager.progress.plan.bundle_only", params)
	}
	return localizedDriverProgressText(text, "driver_manager.progress.plan.source_fallback", params)
}

func buildOptionalDriverFallbackProgressMessage(text func(string, map[string]any) string, displayName string, directURLCount int, bundleURLCount int, restrictToExplicitArtifact bool) string {
	name := strings.TrimSpace(displayName)
	if name == "" {
		name = localizedDriverProgressText(text, "driver_manager.backend.driver_fallback_name", nil)
	}
	params := map[string]any{"name": name, "bundle": bundleURLCount}
	if directURLCount > 0 && !restrictToExplicitArtifact && bundleURLCount > 0 {
		return localizedDriverProgressText(text, "driver_manager.progress.fallback.direct_to_bundle", params)
	}
	if directURLCount > 0 && restrictToExplicitArtifact {
		return localizedDriverProgressText(text, "driver_manager.progress.fallback.explicit_skip_bundle", params)
	}
	if !restrictToExplicitArtifact && bundleURLCount > 0 {
		return localizedDriverProgressText(text, "driver_manager.progress.fallback.bundle_available", params)
	}
	return localizedDriverProgressText(text, "driver_manager.progress.fallback.source_build", params)
}

var downloadOptionalDriverAgentBinaryForInstall = downloadOptionalDriverAgentBinaryWithMetadata

var fetchMirrorDriverReleaseByTagForDriverDownload = fetchMirrorDriverReleaseByTag

func ensureOptionalDriverAgentBinary(ctx context.Context, a *App, definition driverDefinition, executablePath string, downloadURL string, selectedVersion string) (string, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	driverType := normalizeDriverType(definition.Type)
	displayName := resolveDriverDisplayName(definition)
	if _, recognized, dispatcherErr := parseDownloadDispatcherAssetPath(downloadURL); recognized && dispatcherErr != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.download_failed", nil, dispatcherErr)
	}
	forceSourceBuild := shouldForceSourceBuildForResolvedDownload(driverType, selectedVersion, downloadURL)
	buildType := ""
	if a != nil {
		buildType = currentBuildType(a.ctx)
	}
	preferSourceBuildBeforeDownload := shouldPreferSourceBuildBeforeDownloadForBuildType(buildType, driverType, selectedVersion)
	requireSourceBuildBeforeDownload := shouldRequireSourceBuildBeforeDownloadForBuildType(buildType, driverType, selectedVersion)
	skipReuseCandidate := shouldSkipReusableAgentCandidate(driverType, selectedVersion)
	restrictToExplicitArtifact := shouldRestrictToExplicitVersionArtifact(definition, selectedVersion)
	downloadURLs := []string{}
	downloadCandidates := []optionalDriverDownloadCandidate{}
	bundleURLs := []string{}
	if !forceSourceBuild {
		rawDownloadURLs := resolveOptionalDriverAgentDownloadURLs(definition, downloadURL, selectedVersion)
		var expandErr error
		downloadCandidates, expandErr = expandOptionalDriverDownloadCandidates(rawDownloadURLs)
		if expandErr != nil {
			return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.download_failed", nil, expandErr)
		}
		preferredSource := DownloadSourceCst
		if a != nil {
			preferredSource = a.preferredDownloadSource()
		}
		downloadCandidates = reorderOptionalDriverDownloadCandidates(downloadCandidates, preferredSource)
		downloadURLs = make([]string, 0, len(downloadCandidates))
		for _, candidate := range downloadCandidates {
			downloadURLs = append(downloadURLs, candidate.URL)
		}
		if shouldUseOptionalDriverBundleFallback(driverType, restrictToExplicitArtifact, len(downloadURLs)) {
			// Bundle candidates keep the Dispatcher URL first. The preferred source is
			// applied inside its gated candidate resolution, while the direct GitHub
			// URL remains the final fallback if the dispatcher is unavailable.
			bundleURLs = resolveOptionalDriverBundleDownloadURLs()
		}
	}
	text := driverProgressText(a)
	planMessage := buildOptionalDriverInstallPlanMessage(text, displayName, selectedVersion, forceSourceBuild, preferSourceBuildBeforeDownload, requireSourceBuildBeforeDownload, restrictToExplicitArtifact, len(downloadURLs), len(bundleURLs))
	logger.Infof("%s，driver=%s version=%s direct_candidates=%d bundle_candidates=%d force_source_build=%v require_source_build=%v restrict_explicit=%v prefer_source_first=%v", planMessage, driverType, normalizeVersion(selectedVersion), len(downloadURLs), len(bundleURLs), forceSourceBuild, requireSourceBuildBeforeDownload, restrictToExplicitArtifact, preferSourceBuildBeforeDownload)

	info, err := os.Stat(executablePath)
	if err == nil && !info.IsDir() {
		if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, executablePath); validateErr != nil {
			_ = os.Remove(executablePath)
		} else {
			// 用户点击“安装/重装”时应强制刷新驱动代理，避免沿用旧二进制导致修复不生效。
			if removeErr := os.Remove(executablePath); removeErr != nil {
				return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.remove_installed_agent_failed", map[string]any{"name": displayName}, removeErr)
			}
		}
	}
	if err == nil && info.IsDir() {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.agent_path_occupied_by_directory", map[string]any{"name": displayName, "path": executablePath}, nil)
	}

	if mkErr := os.MkdirAll(filepath.Dir(executablePath), 0o755); mkErr != nil {
		return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.create_named_directory_failed", map[string]any{"name": displayName}, mkErr)
	}
	cleanupCandidate := func() {
		_ = os.Remove(executablePath)
		for _, supportName := range optionalDriverSupportFileNames(driverType) {
			_ = os.Remove(filepath.Join(filepath.Dir(executablePath), supportName))
		}
	}
	validateCandidateRevision := func() error {
		if _, revisionErr := verifyInstalledOptionalDriverAgentRevision(driverType, executablePath, selectedVersion); revisionErr != nil {
			cleanupCandidate()
			return revisionErr
		}
		return nil
	}
	var downloadErrs []string
	if !skipReuseCandidate {
		if sourcePath, ok := findExistingOptionalDriverAgentCandidate(definition, executablePath); ok {
			if copyErr := copyAgentBinary(sourcePath, executablePath); copyErr != nil {
				return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.copy_bundled_agent_failed", map[string]any{"name": displayName}, copyErr)
			}
			if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, executablePath); validateErr != nil {
				_ = os.Remove(executablePath)
				return "", "", validateErr
			}
			hash, hashErr := hashFileSHA256(executablePath)
			if hashErr != nil {
				return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.bundled_agent_hash_failed", map[string]any{"name": displayName}, hashErr)
			}
			if revisionErr := validateCandidateRevision(); revisionErr != nil {
				logger.Warnf("预置 %s 驱动代理 revision 校验失败，source=%s err=%v", displayName, sourcePath, revisionErr)
				downloadErrs = appendOptionalDriverAttemptError(a, downloadErrs, "file://"+sourcePath, revisionErr)
			} else {
				return "file://" + sourcePath, hash, nil
			}
		}
	}

	var sourceBuildAttempted bool
	var sourceBuildErr error

	if !forceSourceBuild && preferSourceBuildBeforeDownload {
		sourceBuildAttempted = true
		if a != nil {
			a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", 16, 100, a.appText("driver_manager.progress.source_build_preferred", map[string]any{"name": displayName}))
		}
		hash, buildErr := buildOptionalDriverAgentFromSource(ctx, definition, executablePath, selectedVersion)
		if buildErr == nil {
			if revisionErr := validateCandidateRevision(); revisionErr == nil {
				return fmt.Sprintf("local://go-build/%s-driver-agent", driverType), hash, nil
			} else {
				buildErr = revisionErr
			}
		} else {
			cleanupCandidate()
		}
		if ctx.Err() != nil {
			return "", "", driverDownloadCanceledError(ctx)
		}
		sourceBuildErr = buildErr
		if requireSourceBuildBeforeDownload {
			_ = os.Remove(executablePath)
			logger.Warnf("开发态本地构建 %s 驱动代理失败，跳过发布包兜底：%v", displayName, buildErr)
			return "", "", newLocalizedDriverBackendError("driver_manager.backend.error.source_build_failed", nil, buildErr)
		}
		logger.Warnf("预先本地构建 %s 驱动代理失败，将继续尝试下载预编译包：%v", displayName, buildErr)
	}

	if !forceSourceBuild {
		if len(downloadCandidates) > 0 {
			for _, candidate := range downloadCandidates {
				if ctx.Err() != nil {
					return "", "", driverDownloadCanceledError(ctx)
				}
				candidateURL := candidate.URL
				if a != nil {
					a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", 20, 100, a.appText("driver_manager.progress.download_prebuilt_agent", map[string]any{"name": displayName}))
				}
				hash, dlErr := downloadOptionalDriverAgentBinaryForInstall(ctx, a, definition, candidateURL, candidate.MetadataURL, executablePath, selectedVersion)
				if dlErr == nil {
					if revisionErr := validateCandidateRevision(); revisionErr != nil {
						logger.Warnf("预编译 %s 驱动代理 revision 校验失败，url=%s err=%v", displayName, candidateURL, revisionErr)
						downloadErrs = appendOptionalDriverAttemptError(a, downloadErrs, candidateURL, revisionErr)
						continue
					}
					return candidateURL, hash, nil
				}
				logger.Warnf("下载预编译 %s 驱动代理失败，url=%s err=%v", displayName, candidateURL, dlErr)
				downloadErrs = appendOptionalDriverAttemptError(a, downloadErrs, candidateURL, dlErr)
			}
		}
		if len(bundleURLs) > 0 {
			fallbackMessage := buildOptionalDriverFallbackProgressMessage(text, displayName, len(downloadURLs), len(bundleURLs), restrictToExplicitArtifact)
			logger.Infof("%s，driver=%s version=%s", fallbackMessage, driverType, normalizeVersion(selectedVersion))
			if a != nil {
				a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", 20, 100, fallbackMessage)
			}
			for _, bundleURL := range bundleURLs {
				if ctx.Err() != nil {
					return "", "", driverDownloadCanceledError(ctx)
				}
				if a != nil {
					a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", 20, 100, a.appText("driver_manager.progress.extract_agent_from_bundle", map[string]any{"name": displayName}))
				}
				source, hash, bundleErr := downloadOptionalDriverAgentFromBundle(a, definition, bundleURL, executablePath)
				if bundleErr == nil {
					if revisionErr := validateCandidateRevision(); revisionErr != nil {
						logger.Warnf("驱动总包 %s 代理 revision 校验失败，source=%s err=%v", displayName, source, revisionErr)
						downloadErrs = appendOptionalDriverAttemptError(a, downloadErrs, source, revisionErr)
						continue
					}
					return source, hash, nil
				}
				logger.Warnf("从驱动总包提取 %s 驱动代理失败，url=%s err=%v", displayName, bundleURL, bundleErr)
				downloadErrs = appendOptionalDriverAttemptError(a, downloadErrs, bundleURL, bundleErr)
			}
		} else if len(downloadURLs) > 0 || restrictToExplicitArtifact {
			fallbackMessage := buildOptionalDriverFallbackProgressMessage(text, displayName, len(downloadURLs), 0, restrictToExplicitArtifact)
			logger.Infof("%s，driver=%s version=%s", fallbackMessage, driverType, normalizeVersion(selectedVersion))
			if a != nil {
				a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", 20, 100, fallbackMessage)
			}
		}
	}
	if ctx.Err() != nil {
		// A canceled download must not fall through to the local source build.
		return "", "", driverDownloadCanceledError(ctx)
	}
	if a != nil {
		a.emitDriverDownloadProgressContext(ctx, driverType, "downloading", 92, 100, a.appText("driver_manager.progress.dev_build_fallback", nil))
	}

	var buildErr error
	if sourceBuildAttempted {
		buildErr = sourceBuildErr
	} else {
		hash, runErr := buildOptionalDriverAgentFromSource(ctx, definition, executablePath, selectedVersion)
		buildErr = runErr
		if buildErr == nil {
			if revisionErr := validateCandidateRevision(); revisionErr == nil {
				return fmt.Sprintf("local://go-build/%s-driver-agent", driverType), hash, nil
			} else {
				buildErr = revisionErr
			}
		} else {
			cleanupCandidate()
		}
		if ctx.Err() != nil {
			return "", "", driverDownloadCanceledError(ctx)
		}
	}

	var parts []string
	if len(downloadErrs) > 0 {
		parts = append(parts, localizedDriverBackendText(a, "driver_manager.backend.error.prebuilt_downloads_failed", map[string]any{"detail": strings.Join(downloadErrs, "；")}))
	}
	parts = append(parts, localizedDriverBackendText(a, "driver_manager.backend.error.source_build_failed", map[string]any{"detail": localizedDriverBackendErrorMessage(a, buildErr)}))
	return "", "", errors.New(strings.Join(parts, "；"))
}

func appendOptionalDriverAttemptError(a *App, entries []string, source string, err error) []string {
	text := formatOptionalDriverAttemptError(a, source, err)
	if text == "" {
		return entries
	}
	for _, existing := range entries {
		if existing == text {
			return entries
		}
	}
	return append(entries, text)
}

func formatOptionalDriverAttemptError(a *App, source string, err error) string {
	message := localizedDriverBackendErrorMessage(a, err)
	if message == "" {
		return ""
	}
	source = strings.TrimSpace(source)
	if source == "" {
		return message
	}
	duplicatedPrefix := source + ":"
	if strings.HasPrefix(message, duplicatedPrefix) {
		message = strings.TrimSpace(strings.TrimPrefix(message, duplicatedPrefix))
	}
	if message == "" {
		return source
	}
	return source + ": " + message
}

func shouldUseOptionalDriverBundleFallback(driverType string, restrictToExplicitArtifact bool, directURLCount int) bool {
	_ = driverType
	_ = restrictToExplicitArtifact
	_ = directURLCount
	return false
}

func isOptionalDriverDownloadZipURL(urlText string) bool {
	trimmedURL := strings.TrimSpace(urlText)
	if trimmedURL == "" {
		return false
	}
	if assetPath, ok := downloadDispatcherAssetPath(trimmedURL); ok {
		return isDriverPackageArchivePath(assetPath)
	}
	if parsed, err := url.Parse(trimmedURL); err == nil {
		if strings.TrimSpace(parsed.Path) != "" && isDriverPackageArchivePath(parsed.Path) {
			return true
		}
		if strings.TrimSpace(parsed.Fragment) != "" && isDriverPackageArchivePath(parsed.Fragment) {
			return true
		}
		return false
	}
	return isDriverPackageArchivePath(trimmedURL)
}
