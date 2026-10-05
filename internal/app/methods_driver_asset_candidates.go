package app

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

type optionalDriverDownloadCandidate struct {
	URL         string
	MetadataURL string
}

func optionalDriverRequestURLKey(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return trimmed
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Fragment = ""
	return parsed.String()
}

func expandOptionalDriverDownloadCandidates(urls []string) ([]optionalDriverDownloadCandidate, error) {
	candidates := make([]optionalDriverDownloadCandidate, 0, len(urls)+2)
	seen := make(map[string]struct{}, len(urls)+2)
	appendCandidate := func(rawURL string, metadataURL string) {
		trimmed := strings.TrimSpace(rawURL)
		if trimmed == "" {
			return
		}
		key := optionalDriverRequestURLKey(trimmed)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		candidates = append(candidates, optionalDriverDownloadCandidate{
			URL:         trimmed,
			MetadataURL: strings.TrimSpace(metadataURL),
		})
	}

	for _, rawURL := range urls {
		trimmed := strings.TrimSpace(rawURL)
		expanded, err := staticDriverDispatcherDownloadCandidates(trimmed)
		if err == nil {
			for _, candidateURL := range expanded {
				appendCandidate(candidateURL, trimmed)
			}
			continue
		}
		if !errors.Is(err, errNotImmutableDriverDispatcherAsset) {
			return nil, err
		}
		appendCandidate(trimmed, trimmed)
	}
	return candidates, nil
}

func reorderOptionalDriverDownloadCandidates(candidates []optionalDriverDownloadCandidate, preferred DownloadSource) []optionalDriverDownloadCandidate {
	urls := make([]string, 0, len(candidates))
	byURL := make(map[string]optionalDriverDownloadCandidate, len(candidates))
	for _, candidate := range candidates {
		urls = append(urls, candidate.URL)
		byURL[optionalDriverRequestURLKey(candidate.URL)] = candidate
	}
	orderedURLs := reorderDownloadCandidates(urls, preferred)
	result := make([]optionalDriverDownloadCandidate, 0, len(orderedURLs))
	for _, rawURL := range orderedURLs {
		if candidate, ok := byURL[optionalDriverRequestURLKey(rawURL)]; ok {
			result = append(result, candidate)
		}
	}
	return result
}

func keepOptionalDriverDownloadURLOrder(urls []string) []string {
	candidates, err := expandOptionalDriverDownloadCandidates(urls)
	if err != nil {
		return nil
	}
	result := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		result = append(result, candidate.URL)
	}
	return result
}

func isDriverMirrorDownloadURL(rawURL string) bool {
	if _, ok := downloadDispatcherAssetPath(rawURL); ok {
		return true
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	return err == nil && strings.EqualFold(parsed.Hostname(), "download.syngnat.top")
}

func resolveMirrorDriverDownloadURLForTagAsset(tag string, assetName string) string {
	tag = strings.TrimSpace(tag)
	assetName = strings.TrimSpace(assetName)
	if tag == "" || assetName == "" {
		return ""
	}
	if !strings.EqualFold(tag, driverReleaseDevTag) {
		return driverMirrorReleaseDownloadURL(tag, assetName)
	}
	if mirrorURL := readReleaseMirrorDownloadURLFromCache("tag:"+tag, assetName); mirrorURL != "" {
		return mirrorURL
	}

	// dev-latest is a mutable GitHub alias while the mirror stores each
	// publication under an immutable physical tag. Resolve that tag from the
	// mirror index when the release metadata cache is cold; a failure here must
	// leave the original GitHub URL usable as the final fallback.
	release, err := fetchMirrorDriverReleaseByTagForDriverDownload(tag)
	if err != nil {
		return ""
	}
	asset, found := findReleaseAssetByName(release, []string{assetName})
	if !found || !isDriverMirrorDownloadURL(asset.BrowserDownloadURL) {
		return ""
	}
	return strings.TrimSpace(asset.BrowserDownloadURL)
}

func resolveMirrorDriverDownloadURLForGitHubURL(rawURL string) string {
	tag, assetName, ok := driverReleaseDownloadCoordinates(rawURL)
	if !ok {
		return ""
	}
	return resolveMirrorDriverDownloadURLForTagAsset(tag, assetName)
}

func resolveOptionalDriverAgentDownloadURLs(definition driverDefinition, rawURL string, selectedVersion string) []string {
	candidates := make([]string, 0, 6)
	seen := make(map[string]struct{}, 6)
	driverType := normalizeDriverType(definition.Type)
	appendURL := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || !isOptionalDriverDownloadZipURL(trimmed) {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}

	restrictToExplicitArtifact := shouldRestrictToExplicitVersionArtifact(definition, selectedVersion)
	appendPublishedURL := func(tag string, publishedURL string) {
		releaseTag := strings.TrimSpace(tag)
		assetName := driverReleaseAssetNameFromURL(publishedURL)
		if isDriverMirrorDownloadURL(publishedURL) {
			appendURL(publishedURL)
			appendURL(driverReleaseDownloadURL(releaseTag, assetName))
			return
		}
		mirrorTag := releaseTag
		if publishedTag, publishedAsset, ok := driverReleaseDownloadCoordinates(publishedURL); ok {
			mirrorTag = publishedTag
			assetName = publishedAsset
		}
		if mirrorTag != "" && assetName != "" {
			if strings.EqualFold(releaseTag, driverReleaseDevTag) {
				appendURL(resolveMirrorDriverDownloadURLForTagAsset(releaseTag, assetName))
			} else {
				appendURL(driverMirrorReleaseDownloadURL(mirrorTag, assetName))
			}
		}
		appendURL(publishedURL)
	}
	appendPublishedURLs := func() {
		if tag := currentDriverReleaseTag(); tag != "" {
			if publishedURL, ok := resolvePublishedDriverDownloadURLForTag(definition, selectedVersion, tag); ok {
				appendPublishedURL(tag, publishedURL)
			}
		}
		if publishedURL, ok := resolveLatestPublishedDriverDownloadURLForVersion(definition, selectedVersion); ok {
			appendPublishedURL(currentDriverReleaseTag(), publishedURL)
		}
	}

	if !restrictToExplicitArtifact && shouldPreferPublishedOptionalDriverDownloads(driverType) {
		appendPublishedURLs()
	}

	if parsed, err := url.Parse(strings.TrimSpace(rawURL)); err == nil && isOptionalDriverDownloadZipURL(parsed.String()) {
		switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
		case "http", "https":
			if _, _, ok := driverReleaseDownloadCoordinates(parsed.String()); ok &&
				!isDriverMirrorDownloadURL(parsed.String()) {
				appendURL(resolveMirrorDriverDownloadURLForGitHubURL(parsed.String()))
			}
			appendURL(parsed.String())
		}
	}
	if restrictToExplicitArtifact {
		return candidates
	}

	if !shouldPreferPublishedOptionalDriverDownloads(driverType) {
		appendPublishedURLs()
	}
	return candidates
}

func findExistingOptionalDriverAgentCandidate(definition driverDefinition, targetPath string) (string, bool) {
	driverType := normalizeDriverType(definition.Type)
	targetAbs, _ := filepath.Abs(targetPath)
	candidates := resolveOptionalDriverAgentCandidatePaths(definition)
	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		absPath, err := filepath.Abs(candidate)
		if err != nil || absPath == "" {
			continue
		}
		if targetAbs != "" && absPath == targetAbs {
			continue
		}
		info, statErr := os.Stat(absPath)
		if statErr != nil || info.IsDir() {
			continue
		}
		if validateErr := validateOptionalDriverAgentExecutableFunc(driverType, absPath); validateErr != nil {
			continue
		}
		if !isReusableOptionalDriverAgentRevisionCurrent(driverType, absPath) {
			continue
		}
		return absPath, true
	}
	return "", false
}

func isReusableOptionalDriverAgentRevisionCurrent(driverType string, executablePath string) bool {
	expected := strings.TrimSpace(db.OptionalDriverAgentRevision(driverType))
	if expected == "" {
		return true
	}
	actual, current, err := optionalDriverAgentRevisionCurrent(driverType, executablePath)
	displayName := resolveDriverDisplayName(driverDefinition{Type: driverType})
	if err != nil {
		logger.Warnf("跳过可复用 %s 驱动代理候选：版本元数据不可用 path=%s err=%v", displayName, executablePath, err)
		return false
	}
	if !current {
		logger.Warnf("跳过可复用 %s 驱动代理候选：revision 不匹配 path=%s actual=%s expected=%s", displayName, executablePath, strings.TrimSpace(actual), expected)
		return false
	}
	return true
}

func resolveOptionalDriverAgentCandidatePaths(definition driverDefinition) []string {
	driverType := normalizeDriverType(definition.Type)
	names := optionalDriverExecutableBaseNames(driverType)
	assetNames := optionalDriverReleaseAssetNames(driverType)
	pathTypeNames := make([]string, 0, 2)
	seenPathType := make(map[string]struct{}, 2)
	appendPathType := func(typeName string) {
		trimmed := strings.TrimSpace(typeName)
		if trimmed == "" {
			return
		}
		if _, ok := seenPathType[trimmed]; ok {
			return
		}
		seenPathType[trimmed] = struct{}{}
		pathTypeNames = append(pathTypeNames, trimmed)
	}
	appendPathType(optionalDriverPublicTypeName(driverType))

	candidates := make([]string, 0, 12)
	appendPath := func(pathText string) {
		trimmed := strings.TrimSpace(pathText)
		if trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}

	if exePath, err := os.Executable(); err == nil && strings.TrimSpace(exePath) != "" {
		resolved := exePath
		if evalPath, evalErr := filepath.EvalSymlinks(exePath); evalErr == nil && strings.TrimSpace(evalPath) != "" {
			resolved = evalPath
		}
		exeDir := filepath.Dir(resolved)
		for _, name := range names {
			appendPath(filepath.Join(exeDir, name))
		}
		for _, assetName := range assetNames {
			appendPath(filepath.Join(exeDir, assetName))
		}
		for _, typeName := range pathTypeNames {
			for _, name := range names {
				appendPath(filepath.Join(exeDir, "drivers", typeName, name))
			}
			for _, assetName := range assetNames {
				appendPath(filepath.Join(exeDir, "drivers", typeName, assetName))
			}
		}

		resourcesDir := filepath.Clean(filepath.Join(exeDir, "..", "Resources"))
		for _, typeName := range pathTypeNames {
			for _, name := range names {
				appendPath(filepath.Join(resourcesDir, "drivers", typeName, name))
			}
			for _, assetName := range assetNames {
				appendPath(filepath.Join(resourcesDir, "drivers", typeName, assetName))
			}
		}
	}
	if wd, err := os.Getwd(); err == nil && strings.TrimSpace(wd) != "" {
		for _, assetName := range assetNames {
			appendPath(filepath.Join(wd, "dist", assetName))
			appendPath(filepath.Join(wd, assetName))
		}
	}

	unique := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, item := range candidates {
		if _, ok := seen[item]; ok {
			continue
		}
		seen[item] = struct{}{}
		unique = append(unique, item)
	}
	return unique
}

func resolveDriverDisplayName(definition driverDefinition) string {
	if strings.TrimSpace(definition.Name) != "" {
		return strings.TrimSpace(definition.Name)
	}
	if strings.TrimSpace(definition.Type) != "" {
		return strings.TrimSpace(definition.Type)
	}
	return defaultAppText("driver_manager.backend.driver_fallback_name", nil)
}
