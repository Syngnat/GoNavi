package app

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func optionalDriverPublicTypeName(driverType string) string {
	switch normalizeDriverType(driverType) {
	case "diros":
		return "doris"
	default:
		return normalizeDriverType(driverType)
	}
}

func optionalDriverExecutableBaseNameForType(typeName string) string {
	base := strings.TrimSpace(typeName)
	if base == "" {
		base = "unknown"
	}
	name := fmt.Sprintf("%s-driver-agent", base)
	if stdRuntime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func optionalDriverReleaseAssetNameForType(typeName string, goos string, goarch string) string {
	base := strings.TrimSpace(typeName)
	if base == "" {
		base = "unknown"
	}
	name := fmt.Sprintf("%s-driver-agent-%s-%s", base, goos, goarch)
	if strings.EqualFold(goos, "windows") {
		return name + ".exe"
	}
	return name
}

func optionalDriverReleaseZipAssetName(assetName string) string {
	name := strings.TrimSpace(assetName)
	if name == "" {
		return ""
	}
	if strings.EqualFold(filepath.Ext(name), ".exe") {
		name = name[:len(name)-len(filepath.Ext(name))]
	}
	return name + ".zip"
}

func optionalDriverNameStemCandidates(driverType string, selectedVersion string) []string {
	candidates := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	appendStem := func(stem string) {
		trimmed := strings.TrimSpace(stem)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}

	base := fmt.Sprintf("%s-driver-agent", optionalDriverPublicTypeName(driverType))
	if normalizeDriverType(driverType) == "mongodb" {
		switch resolveMongoDriverMajorFromVersion(selectedVersion) {
		case 1:
			appendStem(base + "-v1")
		case 2:
			appendStem(base + "-v2")
			appendStem(base)
		default:
			appendStem(base)
		}
		return candidates
	}

	appendStem(base)
	return candidates
}

func optionalDriverExecutableBaseNamesForVersion(driverType string, selectedVersion string) []string {
	names := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	appendName := func(stem string) {
		name := strings.TrimSpace(stem)
		if strings.TrimSpace(name) == "" {
			return
		}
		if stdRuntime.GOOS == "windows" {
			name += ".exe"
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}

	for _, stem := range optionalDriverNameStemCandidates(driverType, selectedVersion) {
		appendName(stem)
	}
	return names
}

func optionalDriverExecutableBaseNames(driverType string) []string {
	return optionalDriverExecutableBaseNamesForVersion(driverType, "")
}

func optionalDriverReleaseAssetNamesForVersion(driverType string, selectedVersion string) []string {
	names := make([]string, 0, 2)
	seen := make(map[string]struct{}, 2)
	appendName := func(stem string) {
		trimmedStem := strings.TrimSpace(stem)
		if trimmedStem == "" {
			return
		}
		name := fmt.Sprintf("%s-%s-%s", trimmedStem, stdRuntime.GOOS, stdRuntime.GOARCH)
		if strings.EqualFold(stdRuntime.GOOS, "windows") {
			name += ".exe"
		}
		if strings.TrimSpace(name) == "" {
			return
		}
		if _, ok := seen[name]; ok {
			return
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}

	for _, stem := range optionalDriverNameStemCandidates(driverType, selectedVersion) {
		appendName(stem)
	}
	return names
}

func optionalDriverReleaseAssetNames(driverType string) []string {
	return optionalDriverReleaseAssetNamesForVersion(driverType, "")
}

func optionalDriverReleaseZipAssetNamesForVersion(driverType string, selectedVersion string) []string {
	rawNames := optionalDriverReleaseAssetNamesForVersion(driverType, selectedVersion)
	names := make([]string, 0, len(rawNames))
	seen := make(map[string]struct{}, len(rawNames))
	for _, rawName := range rawNames {
		name := optionalDriverReleaseZipAssetName(rawName)
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	return names
}

func optionalDriverReleaseZipAssetNames(driverType string) []string {
	return optionalDriverReleaseZipAssetNamesForVersion(driverType, "")
}

func optionalDriverReleaseZipAssetNameForVersion(driverType string, selectedVersion string) string {
	names := optionalDriverReleaseZipAssetNamesForVersion(driverType, selectedVersion)
	if len(names) == 0 {
		return optionalDriverReleaseZipAssetName(optionalDriverReleaseAssetNameForType("", stdRuntime.GOOS, stdRuntime.GOARCH))
	}
	return names[0]
}

func optionalDriverExecutableBaseName(driverType string) string {
	names := optionalDriverExecutableBaseNames(driverType)
	if len(names) == 0 {
		return optionalDriverExecutableBaseNameForType("")
	}
	return names[0]
}

func optionalDriverReleaseAssetName(driverType string) string {
	names := optionalDriverReleaseAssetNames(driverType)
	if len(names) == 0 {
		return optionalDriverReleaseAssetNameForType("", stdRuntime.GOOS, stdRuntime.GOARCH)
	}
	return names[0]
}

func optionalDriverReleaseAssetNameForVersion(driverType string, selectedVersion string) string {
	names := optionalDriverReleaseAssetNamesForVersion(driverType, selectedVersion)
	if len(names) == 0 {
		return optionalDriverReleaseAssetNameForType("", stdRuntime.GOOS, stdRuntime.GOARCH)
	}
	return names[0]
}

func currentDriverReleaseTag() string {
	currentVersion := normalizeVersion(getCurrentVersion())
	if currentVersion == "" || currentVersion == "0.0.0" {
		return ""
	}
	if isDevelopmentDriverReleaseVersion(currentVersion) {
		return driverReleaseDevTag
	}
	return "v" + currentVersion
}

func isDevelopmentDriverReleaseVersion(version string) bool {
	normalized := strings.ToLower(strings.TrimSpace(normalizeVersion(version)))
	if normalized == "" || normalized == "0.0.0" {
		return false
	}
	if strings.HasPrefix(normalized, "dev-") {
		return true
	}
	for _, marker := range []string{"-dev", "-test", "-local", "-snapshot"} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}

func driverReleaseDownloadURL(tag string, assetName string) string {
	tagName := strings.TrimSpace(tag)
	asset := strings.TrimSpace(assetName)
	if tagName == "" || asset == "" {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", driverReleaseRepo, url.PathEscape(tagName), url.PathEscape(asset))
}

func driverMirrorReleaseDownloadURL(tag string, assetName string) string {
	tagName := strings.TrimSpace(tag)
	asset := strings.TrimSpace(assetName)
	if tagName == "" || asset == "" {
		return ""
	}
	assetPath := fmt.Sprintf("/drivers/releases/download/%s/%s", tagName, asset)
	return downloadDispatcherURLForPath(assetPath)
}

func driverMirrorDevReleaseDownloadURL(tag string, assetName string) string {
	tagName := strings.TrimSpace(tag)
	asset := strings.TrimSpace(assetName)
	if tagName == "" || asset == "" {
		return ""
	}
	assetPath := fmt.Sprintf("/drivers/dev/releases/download/%s/%s", tagName, asset)
	return downloadDispatcherURLForPath(assetPath)
}

func driverMirrorReleaseDownloadURLForTags(releaseTag string, mirrorTag string, assetName string) string {
	logicalTag := strings.TrimSpace(releaseTag)
	physicalTag := strings.TrimSpace(mirrorTag)
	if physicalTag == "" {
		physicalTag = logicalTag
	}
	if strings.EqualFold(logicalTag, driverReleaseDevTag) {
		return driverMirrorDevReleaseDownloadURL(physicalTag, assetName)
	}
	return driverMirrorReleaseDownloadURL(physicalTag, assetName)
}

func driverReleaseDownloadCoordinates(rawURL string) (string, string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", "", false
	}
	if assetPath, ok := downloadDispatcherAssetPath(rawURL); ok {
		parsed, err = url.Parse("https://download.syngnat.top" + assetPath)
		if err != nil {
			return "", "", false
		}
	}
	segments := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	host := strings.ToLower(strings.TrimSpace(parsed.Hostname()))
	knownSource := false
	switch host {
	case "github.com":
		knownSource = len(segments) >= 2 && strings.EqualFold(segments[0], "Syngnat") && strings.EqualFold(segments[1], "GoNavi-DriverAgents")
	case "download.syngnat.top":
		knownSource = len(segments) >= 1 && strings.EqualFold(segments[0], "drivers")
	}
	if !knownSource {
		return "", "", false
	}
	for index := 0; index+3 < len(segments); index++ {
		if !strings.EqualFold(segments[index], "releases") || !strings.EqualFold(segments[index+1], "download") {
			continue
		}
		tagName, tagErr := url.PathUnescape(segments[index+2])
		assetName, assetErr := url.PathUnescape(strings.Join(segments[index+3:], "/"))
		if tagErr != nil || assetErr != nil || strings.TrimSpace(tagName) == "" || strings.TrimSpace(assetName) == "" {
			return "", "", false
		}
		return tagName, assetName, true
	}
	return "", "", false
}

func driverReleaseAssetNameFromURL(rawURL string) string {
	if _, assetName, ok := driverReleaseDownloadCoordinates(rawURL); ok {
		return assetName
	}
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	if fragment := strings.TrimSpace(parsed.Fragment); fragment != "" {
		return fragment
	}
	segments := strings.Split(strings.Trim(parsed.EscapedPath(), "/"), "/")
	if len(segments) == 0 {
		return ""
	}
	assetName, err := url.PathUnescape(segments[len(segments)-1])
	if err != nil {
		return ""
	}
	return strings.TrimSpace(assetName)
}

func driverReleaseLatestDownloadURL(assetName string) string {
	asset := strings.TrimSpace(assetName)
	if asset == "" {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/releases/latest/download/%s", driverReleaseRepo, url.PathEscape(asset))
}

func driverReleaseLatestDownloadURLForCurrentChannel(assetName string) string {
	if strings.EqualFold(currentDriverReleaseTag(), driverReleaseDevTag) {
		return driverReleaseDownloadURL(driverReleaseDevTag, assetName)
	}
	return driverReleaseLatestDownloadURL(assetName)
}

func findReleaseAssetByName(release *githubRelease, assetNames []string) (githubAsset, bool) {
	if release == nil || len(release.Assets) == 0 || len(assetNames) == 0 {
		return githubAsset{}, false
	}
	for _, expected := range assetNames {
		trimmed := strings.TrimSpace(expected)
		if trimmed == "" {
			continue
		}
		for _, asset := range release.Assets {
			if strings.EqualFold(strings.TrimSpace(asset.Name), trimmed) {
				return asset, true
			}
		}
	}
	return githubAsset{}, false
}

func driverReleaseAssetAPIURL(asset githubAsset) string {
	urlText := strings.TrimSpace(asset.URL)
	if urlText != "" {
		name := strings.TrimSpace(asset.Name)
		if name == "" {
			return urlText
		}
		parsed, err := url.Parse(urlText)
		if err != nil {
			return urlText
		}
		parsed.Fragment = name
		return parsed.String()
	}
	urlText = strings.TrimSpace(asset.BrowserDownloadURL)
	if urlText == "" {
		return ""
	}
	return urlText
}

func optionalDriverBundlePlatformDir(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return "Windows"
	case "darwin":
		return "MacOS"
	case "linux":
		return "Linux"
	default:
		return "Unknown"
	}
}

func optionalDriverBundleEntryPathsForVersion(driverType string, selectedVersion string) []string {
	platformDir := optionalDriverBundlePlatformDir(stdRuntime.GOOS)
	assetNames := optionalDriverReleaseAssetNamesForVersion(driverType, selectedVersion)
	result := make([]string, 0, len(assetNames))
	seen := make(map[string]struct{}, len(assetNames))
	for _, assetName := range assetNames {
		entry := filepath.ToSlash(filepath.Join(platformDir, assetName))
		if _, ok := seen[entry]; ok {
			continue
		}
		seen[entry] = struct{}{}
		result = append(result, entry)
	}
	return result
}

func optionalDriverBundleEntryPaths(driverType string) []string {
	return optionalDriverBundleEntryPathsForVersion(driverType, "")
}

func optionalDriverBundleEntryPathForVersion(driverType string, selectedVersion string) string {
	paths := optionalDriverBundleEntryPathsForVersion(driverType, selectedVersion)
	if len(paths) == 0 {
		return filepath.ToSlash(filepath.Join(optionalDriverBundlePlatformDir(stdRuntime.GOOS), optionalDriverReleaseAssetNameForVersion(driverType, selectedVersion)))
	}
	return paths[0]
}

func optionalDriverBundleEntryPath(driverType string) string {
	return optionalDriverBundleEntryPathForVersion(driverType, "")
}

func resolveOptionalDriverAssetSize(sizeByAsset map[string]int64, driverType string) int64 {
	if len(sizeByAsset) == 0 {
		return 0
	}
	for _, assetName := range optionalDriverReleaseZipAssetNames(driverType) {
		sizeBytes := sizeByAsset[assetName]
		if sizeBytes > 0 {
			return sizeBytes
		}
	}
	return 0
}

func resolveOptionalDriverAssetSizeForVersion(sizeByAsset map[string]int64, driverType string, version string) int64 {
	if len(sizeByAsset) == 0 {
		return 0
	}
	for _, assetName := range optionalDriverReleaseZipAssetNamesForVersion(driverType, version) {
		sizeBytes := sizeByAsset[assetName]
		if sizeBytes > 0 {
			return sizeBytes
		}
	}
	return 0
}

func resolveOptionalDriverBundleDownloadURLs() []string {
	candidates := make([]string, 0, 6)
	seen := make(map[string]struct{}, 6)
	appendURL := func(value string) {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		candidates = append(candidates, trimmed)
	}

	tag := currentDriverReleaseTag()
	if tag != "" {
		if strings.EqualFold(tag, driverReleaseDevTag) {
			if release, err := fetchMirrorDriverReleaseByTag(tag); err == nil {
				if asset, ok := findReleaseAssetByName(release, []string{optionalDriverBundleAssetName}); ok {
					appendURL(asset.BrowserDownloadURL)
				}
			}
		} else {
			appendURL(driverMirrorReleaseDownloadURL(tag, optionalDriverBundleAssetName))
		}
		appendURL(driverReleaseDownloadURL(tag, optionalDriverBundleAssetName))
	}
	if !strings.EqualFold(tag, driverReleaseDevTag) {
		appendURL(driverReleaseLatestDownloadURL(optionalDriverBundleAssetName))
	}
	return candidates
}

func optionalDriverBundleCacheDir() (string, error) {
	cacheDir := filepath.Join(os.TempDir(), "gonavi-driver-bundle-cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		return "", err
	}
	return cacheDir, nil
}

func optionalDriverBundleCachePath(bundleURL string) (string, error) {
	cacheDir, err := optionalDriverBundleCacheDir()
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(bundleURL)))
	return filepath.Join(cacheDir, hex.EncodeToString(sum[:])+".zip"), nil
}

func cleanupOptionalDriverBundleCache(keepPaths ...string) {
	cacheDir, err := optionalDriverBundleCacheDir()
	if err != nil {
		return
	}

	keep := make(map[string]struct{}, len(keepPaths)+4)
	for _, path := range keepPaths {
		if strings.TrimSpace(path) != "" {
			keep[filepath.Clean(path)] = struct{}{}
		}
	}
	optionalDriverBundleDownloadMu.Lock()
	for _, state := range optionalDriverBundleDownloads {
		if state != nil && strings.TrimSpace(state.path) != "" {
			keep[filepath.Clean(state.path)] = struct{}{}
		}
	}
	optionalDriverBundleDownloadMu.Unlock()

	type cacheFile struct {
		path    string
		modTime time.Time
	}
	cacheFiles := make([]cacheFile, 0)
	now := time.Now()
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(cacheDir, entry.Name())
		cleanPath := filepath.Clean(path)
		if _, ok := keep[cleanPath]; ok {
			continue
		}
		info, statErr := entry.Info()
		if statErr != nil {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(entry.Name()))
		if strings.HasSuffix(name, ".tmp") {
			if now.Sub(info.ModTime()) > 24*time.Hour {
				_ = os.Remove(path)
			}
			continue
		}
		if !strings.HasSuffix(name, ".zip") {
			continue
		}
		if now.Sub(info.ModTime()) > optionalDriverBundleCacheMaxAge {
			_ = os.Remove(path)
			continue
		}
		cacheFiles = append(cacheFiles, cacheFile{path: path, modTime: info.ModTime()})
	}
	if len(cacheFiles) <= optionalDriverBundleCacheMaxFiles {
		return
	}
	sort.Slice(cacheFiles, func(i, j int) bool {
		return cacheFiles[i].modTime.After(cacheFiles[j].modTime)
	})
	for _, item := range cacheFiles[optionalDriverBundleCacheMaxFiles:] {
		_ = os.Remove(item.path)
	}
}

func downloadOptionalDriverBundleToCache(bundleURL string, onProgress func(downloaded, total int64)) (string, error) {
	return downloadOptionalDriverBundleToCachePreferred(bundleURL, onProgress, DownloadSourceCst)
}

func downloadOptionalDriverBundleToCachePreferred(bundleURL string, onProgress func(downloaded, total int64), preferred DownloadSource) (string, error) {
	cachePath, err := optionalDriverBundleCachePath(bundleURL)
	if err != nil {
		return "", err
	}
	tempPath := cachePath + fmt.Sprintf(".%d.tmp", time.Now().UnixNano())
	_ = os.Remove(tempPath)
	var downloadErr error
	if preferred == DownloadSourceCst {
		_, downloadErr = downloadFileWithHashWithTimeout(bundleURL, tempPath, onProgress, optionalDriverBundleDownloadTimeout)
	} else {
		_, downloadErr = downloadFileWithHashWithTimeoutPreferred(bundleURL, tempPath, onProgress, optionalDriverBundleDownloadTimeout, preferred)
	}
	if downloadErr != nil {
		_ = os.Remove(tempPath)
		return "", downloadErr
	}
	if err := os.Remove(cachePath); err != nil && !os.IsNotExist(err) {
		_ = os.Remove(tempPath)
		return "", err
	}
	if err := os.Rename(tempPath, cachePath); err != nil {
		_ = os.Remove(tempPath)
		return "", err
	}
	reader, err := zip.OpenReader(cachePath)
	if err != nil {
		_ = os.Remove(cachePath)
		return "", fmt.Errorf("open driver bundle failed: %w", err)
	}
	if err := reader.Close(); err != nil {
		_ = os.Remove(cachePath)
		return "", fmt.Errorf("close driver bundle failed: %w", err)
	}
	cleanupOptionalDriverBundleCache(cachePath)
	return cachePath, nil
}

func acquireOptionalDriverBundlePath(bundleURL string, onProgress func(downloaded, total int64), onWaiting func()) (string, error) {
	if strings.TrimSpace(bundleURL) == "" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.bundle_url_empty", nil, nil)
	}
	return acquireOptionalDriverBundlePathPreferred(bundleURL, onProgress, onWaiting, DownloadSourceCst)
}

func acquireOptionalDriverBundlePathPreferred(bundleURL string, onProgress func(downloaded, total int64), onWaiting func(), preferred DownloadSource) (string, error) {
	trimmedURL := strings.TrimSpace(bundleURL)
	if trimmedURL == "" {
		return "", newLocalizedDriverBackendError("driver_manager.backend.error.bundle_url_empty", nil, nil)
	}

	for {
		optionalDriverBundleDownloadMu.Lock()
		state, ok := optionalDriverBundleDownloads[trimmedURL]
		if ok {
			if state.finished {
				path := strings.TrimSpace(state.path)
				err := state.err
				if err == nil && path != "" && fileExists(path) {
					optionalDriverBundleDownloadMu.Unlock()
					return path, nil
				}
				delete(optionalDriverBundleDownloads, trimmedURL)
				optionalDriverBundleDownloadMu.Unlock()
				continue
			}
			done := state.done
			optionalDriverBundleDownloadMu.Unlock()
			if onWaiting != nil {
				onWaiting()
			}
			<-done
			optionalDriverBundleDownloadMu.Lock()
			path := strings.TrimSpace(state.path)
			err := state.err
			if err == nil && path != "" && fileExists(path) {
				optionalDriverBundleDownloadMu.Unlock()
				return path, nil
			}
			if current, exists := optionalDriverBundleDownloads[trimmedURL]; exists && current == state {
				delete(optionalDriverBundleDownloads, trimmedURL)
			}
			optionalDriverBundleDownloadMu.Unlock()
			if err == nil {
				err = fmt.Errorf("driver bundle cache file is unavailable")
			}
			return "", err
		}

		state = &optionalDriverBundleDownloadState{done: make(chan struct{})}
		optionalDriverBundleDownloads[trimmedURL] = state
		optionalDriverBundleDownloadMu.Unlock()

		path, err := downloadOptionalDriverBundleToCachePreferred(trimmedURL, onProgress, preferred)
		optionalDriverBundleDownloadMu.Lock()
		state.path = path
		state.err = err
		state.finished = true
		if err != nil {
			delete(optionalDriverBundleDownloads, trimmedURL)
		}
		close(state.done)
		optionalDriverBundleDownloadMu.Unlock()

		if err != nil {
			return "", err
		}
		return path, nil
	}
}

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

func activateOptionalDriverAgentBinary(driverType string, installPath string, runtimePath string) error {
	source := strings.TrimSpace(installPath)
	target := strings.TrimSpace(runtimePath)
	if source == "" || target == "" {
		return fmt.Errorf("agent path is empty")
	}
	if source == target {
		return nil
	}

	absSource := source
	absTarget := target
	if value, err := filepath.Abs(source); err == nil && strings.TrimSpace(value) != "" {
		absSource = value
	}
	if value, err := filepath.Abs(target); err == nil && strings.TrimSpace(value) != "" {
		absTarget = value
	}
	if strings.EqualFold(absSource, absTarget) {
		return nil
	}
	if err := copyAgentBinary(source, target); err != nil {
		return err
	}
	return copyOptionalDriverSupportFilesFromDirectory(driverType, filepath.Dir(source), filepath.Dir(target))
}

func copyAgentBinary(sourcePath, targetPath string) error {
	src, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer src.Close()

	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if chmodErr := os.Chmod(tempPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		_ = os.Remove(tempPath)
		return chmodErr
	}
	if err := renameTempFileOverTarget(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if chmodErr := os.Chmod(targetPath, 0o755); chmodErr != nil && stdRuntime.GOOS != "windows" {
		return chmodErr
	}
	return nil
}

func extractZipFileToPath(file *zip.File, targetPath string) error {
	if file == nil {
		return newLocalizedDriverBackendError("driver_manager.backend.error.zip_entry_empty", nil, nil)
	}
	src, err := file.Open()
	if err != nil {
		return err
	}
	defer src.Close()
	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := renameTempFileOverTarget(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func copyOptionalDriverSupportFile(sourcePath, targetPath string) error {
	src, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer src.Close()

	tempPath := targetPath + ".tmp"
	_ = os.Remove(tempPath)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	dst, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Sync(); err != nil {
		dst.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := renameTempFileOverTarget(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func renameTempFileOverTarget(tempPath, targetPath string) error {
	if err := os.Rename(tempPath, targetPath); err == nil {
		return nil
	} else {
		firstErr := err
		if removeErr := os.Remove(targetPath); removeErr != nil && !os.IsNotExist(removeErr) {
			return firstErr
		}
		if retryErr := os.Rename(tempPath, targetPath); retryErr != nil {
			return retryErr
		}
		return nil
	}
}

func copyOptionalDriverSupportFilesFromDirectory(driverType string, sourceDir string, targetDir string) error {
	names := optionalDriverSupportFileNames(driverType)
	if len(names) == 0 {
		return nil
	}
	sourceRoot := strings.TrimSpace(sourceDir)
	targetRoot := strings.TrimSpace(targetDir)
	if sourceRoot == "" || targetRoot == "" {
		return newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_directory_empty", nil, nil)
	}
	for _, name := range names {
		sourcePath := filepath.Join(sourceRoot, name)
		targetPath := filepath.Join(targetRoot, name)
		if err := copyOptionalDriverSupportFile(sourcePath, targetPath); err != nil {
			return newLocalizedDriverBackendError("driver_manager.backend.error.copy_runtime_dependency_entry_failed", map[string]any{"name": name}, err)
		}
	}
	return nil
}

func findOptionalDriverSupportFileInZip(files []*zip.File, agentEntryName string, supportName string) *zip.File {
	normalizedAgent := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(agentEntryName), "./"))
	agentDir := filepath.ToSlash(filepath.Dir(normalizedAgent))
	if agentDir == "." {
		agentDir = ""
	}
	candidatePaths := []string{}
	if agentDir != "" {
		candidatePaths = append(candidatePaths, filepath.ToSlash(filepath.Join(agentDir, supportName)))
	}
	candidatePaths = append(candidatePaths, supportName)

	for _, candidate := range candidatePaths {
		for _, file := range files {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			if name == candidate {
				return file
			}
		}
		for _, file := range files {
			name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
			if strings.EqualFold(name, candidate) {
				return file
			}
		}
	}
	for _, file := range files {
		name := filepath.ToSlash(strings.TrimPrefix(strings.TrimSpace(file.Name), "./"))
		if strings.EqualFold(filepath.Base(name), supportName) {
			return file
		}
	}
	return nil
}

func extractOptionalDriverSupportFilesFromZip(files []*zip.File, driverType string, agentEntryName string, targetDir string) error {
	names := optionalDriverSupportFileNames(driverType)
	if len(names) == 0 {
		return nil
	}
	targetRoot := strings.TrimSpace(targetDir)
	if targetRoot == "" {
		return newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_target_directory_empty", nil, nil)
	}
	for _, name := range names {
		entry := findOptionalDriverSupportFileInZip(files, agentEntryName, name)
		if entry == nil {
			return newLocalizedDriverBackendError("driver_manager.backend.error.runtime_dependency_entry_missing", map[string]any{"name": name}, nil)
		}
		if err := extractZipFileToPath(entry, filepath.Join(targetRoot, name)); err != nil {
			return newLocalizedDriverBackendError("driver_manager.backend.error.extract_runtime_dependency_failed", map[string]any{"name": name}, err)
		}
	}
	return nil
}

func scaleProgress(downloaded, total, start, end int64) (int64, int64) {
	if end <= start {
		return end, 100
	}
	if total <= 0 {
		return start, 100
	}
	if downloaded < 0 {
		downloaded = 0
	}
	if downloaded > total {
		downloaded = total
	}
	span := end - start
	return start + ((downloaded * span) / total), 100
}

func optionalDriverTypesForPackageSizes(definitions []driverDefinition) []string {
	needed := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		normalizedType := normalizeDriverType(definition.Type)
		if normalizedType == "" || definition.BuiltIn {
			continue
		}
		if !db.IsOptionalGoDriver(normalizedType) {
			continue
		}
		if !db.IsOptionalGoDriverBuildIncluded(normalizedType) {
			continue
		}
		needed = append(needed, normalizedType)
	}
	return needed
}

func fillOptionalDriverPackageSizes(result map[string]int64, sizeByAsset map[string]int64, driverTypes []string) []string {
	missing := make([]string, 0, len(driverTypes))
	for _, driverType := range driverTypes {
		sizeBytes := resolveOptionalDriverAssetSize(sizeByAsset, driverType)
		if sizeBytes > 0 {
			result[driverType] = sizeBytes
			continue
		}
		missing = append(missing, driverType)
	}
	return missing
}

func readCachedOptionalDriverPackageSizes(definitions []driverDefinition) map[string]int64 {
	result := make(map[string]int64)
	pending := optionalDriverTypesForPackageSizes(definitions)
	if len(pending) == 0 {
		return result
	}

	if tag := currentDriverReleaseTag(); tag != "" {
		if sizeByAsset, _, ok := readReleaseAssetSizesFromCache("tag:" + tag); ok {
			pending = fillOptionalDriverPackageSizes(result, sizeByAsset, pending)
		}
	}
	if len(pending) == 0 {
		return result
	}
	if sizeByAsset, _, ok := readReleaseAssetSizesFromCache("latest"); ok {
		_ = fillOptionalDriverPackageSizes(result, sizeByAsset, pending)
	}
	return result
}

func preloadOptionalDriverPackageSizes(definitions []driverDefinition) map[string]int64 {
	result := make(map[string]int64)
	pending := optionalDriverTypesForPackageSizes(definitions)
	if len(pending) == 0 {
		return result
	}

	tag := currentDriverReleaseTag()
	if tag != "" {
		if sizeByAsset, _, err := loadReleaseAssetSizesCached("tag:"+tag, func() (*githubRelease, error) {
			return fetchReleaseByTag(tag)
		}); err == nil {
			pending = fillOptionalDriverPackageSizes(result, sizeByAsset, pending)
		}
	}
	if len(pending) == 0 {
		return result
	}
	if sizeByAsset, _, err := loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets); err == nil {
		_ = fillOptionalDriverPackageSizes(result, sizeByAsset, pending)
	}
	return result
}

func loadReleaseAssetSizesCached(cacheKey string, fetch func() (*githubRelease, error)) (map[string]int64, map[string]bool, error) {
	key := strings.TrimSpace(cacheKey)
	if key == "" {
		return nil, nil, newLocalizedDriverBackendError("driver_manager.backend.error.cache_key_empty", nil, nil)
	}

	driverReleaseSizeMu.RLock()
	cached, ok := driverReleaseSizeMap[key]
	driverReleaseSizeMu.RUnlock()
	if ok {
		ttl := driverReleaseAssetSizeCacheTTL
		if strings.TrimSpace(cached.Err) != "" {
			ttl = driverReleaseAssetSizeErrorCacheTTL
		}
		if time.Since(cached.LoadedAt) < ttl {
			if strings.TrimSpace(cached.Err) != "" {
				return nil, nil, errors.New(strings.TrimSpace(cached.Err))
			}
			return cached.SizeByKey, cached.PublishedAssets, nil
		}
	}

	release, err := fetch()
	entry := driverReleaseAssetSizeCacheEntry{
		LoadedAt:           time.Now(),
		SizeByKey:          map[string]int64{},
		SHA256ByKey:        map[string]string{},
		PublishedAssets:    map[string]bool{},
		MirrorDownloadURLs: map[string]string{},
	}
	if err != nil {
		entry.Err = err.Error()
	} else {
		entry.SizeByKey = buildReleaseAssetSizeMap(release)
		entry.PublishedAssets = buildReleaseAssetNameMap(release)
		entry.MirrorDownloadURLs = buildReleaseMirrorDownloadURLMap(release)
		if index, indexErr := fetchDriverBundleAssetIndex(release); indexErr == nil {
			for name, size := range index.Assets {
				trimmedName := strings.TrimSpace(name)
				if trimmedName == "" || size <= 0 {
					continue
				}
				entry.SizeByKey[trimmedName] = size
			}
			for name, digest := range index.AssetSHA256 {
				trimmedName := strings.TrimSpace(name)
				normalized := normalizeGitHubAssetSHA256(digest)
				if trimmedName != "" && len(normalized) == 64 {
					entry.SHA256ByKey[trimmedName] = normalized
				}
			}
		}
	}

	driverReleaseSizeMu.Lock()
	driverReleaseSizeMap[key] = entry
	driverReleaseSizeMu.Unlock()

	if err != nil {
		return nil, nil, err
	}
	return entry.SizeByKey, entry.PublishedAssets, nil
}

func buildReleaseMirrorDownloadURLMap(release *githubRelease) map[string]string {
	urls := make(map[string]string)
	if release == nil {
		return urls
	}
	for _, asset := range release.Assets {
		name := strings.TrimSpace(asset.Name)
		downloadURL := strings.TrimSpace(asset.BrowserDownloadURL)
		if name == "" || !isDriverMirrorDownloadURL(downloadURL) {
			continue
		}
		urls[name] = downloadURL
	}
	return urls
}

func readReleaseMirrorDownloadURLFromCache(cacheKey string, assetName string) string {
	key := strings.TrimSpace(cacheKey)
	name := strings.TrimSpace(assetName)
	if key == "" || name == "" {
		return ""
	}
	driverReleaseSizeMu.RLock()
	cached, ok := driverReleaseSizeMap[key]
	driverReleaseSizeMu.RUnlock()
	if !ok || time.Since(cached.LoadedAt) >= driverReleaseAssetSizeCacheTTL {
		return ""
	}
	return strings.TrimSpace(cached.MirrorDownloadURLs[name])
}

func readReleaseAssetMetadataFromCache(cacheKey string, assetName string) (int64, string, bool) {
	key := strings.TrimSpace(cacheKey)
	name := strings.TrimSpace(assetName)
	if key == "" || name == "" {
		return 0, "", false
	}
	driverReleaseSizeMu.RLock()
	cached, ok := driverReleaseSizeMap[key]
	driverReleaseSizeMu.RUnlock()
	if !ok || time.Since(cached.LoadedAt) >= driverReleaseAssetSizeCacheTTL {
		return 0, "", false
	}
	size := cached.SizeByKey[name]
	digest := normalizeGitHubAssetSHA256(cached.SHA256ByKey[name])
	return size, digest, size > 0 && len(digest) == 64
}

func expectedDriverReleaseAssetMetadata(rawURL string) (int64, string, bool) {
	tag, assetName, ok := driverReleaseDownloadCoordinates(rawURL)
	if !ok {
		return 0, "", false
	}
	cacheKeys := []string{"tag:" + tag, "tag:" + currentDriverReleaseTag(), "latest"}
	seen := map[string]struct{}{}
	for _, cacheKey := range cacheKeys {
		if _, exists := seen[cacheKey]; exists {
			continue
		}
		seen[cacheKey] = struct{}{}
		if size, digest, found := readReleaseAssetMetadataFromCache(cacheKey, assetName); found {
			return size, digest, true
		}
	}
	return 0, "", false
}

func readReleaseAssetSizesFromCache(cacheKey string) (map[string]int64, map[string]bool, bool) {
	key := strings.TrimSpace(cacheKey)
	if key == "" {
		return nil, nil, false
	}

	driverReleaseSizeMu.RLock()
	cached, ok := driverReleaseSizeMap[key]
	driverReleaseSizeMu.RUnlock()
	if !ok {
		return nil, nil, false
	}

	ttl := driverReleaseAssetSizeCacheTTL
	if strings.TrimSpace(cached.Err) != "" {
		ttl = driverReleaseAssetSizeErrorCacheTTL
	}
	if time.Since(cached.LoadedAt) >= ttl {
		return nil, nil, false
	}
	if strings.TrimSpace(cached.Err) != "" {
		return nil, nil, false
	}
	return cached.SizeByKey, cached.PublishedAssets, true
}

func buildReleaseAssetSizeMap(release *githubRelease) map[string]int64 {
	sizes := make(map[string]int64)
	if release == nil {
		return sizes
	}
	for _, asset := range release.Assets {
		name := strings.TrimSpace(asset.Name)
		if name == "" || asset.Size <= 0 {
			continue
		}
		sizes[name] = asset.Size
	}
	return sizes
}

func buildReleaseAssetNameMap(release *githubRelease) map[string]bool {
	names := make(map[string]bool)
	if release == nil {
		return names
	}
	for _, asset := range release.Assets {
		name := strings.TrimSpace(asset.Name)
		if name == "" {
			continue
		}
		names[name] = true
	}
	return names
}

func fetchDriverBundleAssetSizeIndex(release *githubRelease) (map[string]int64, error) {
	index, err := fetchDriverBundleAssetIndex(release)
	if err != nil {
		return nil, err
	}
	return index.Assets, nil
}

func fetchDriverBundleAssetIndex(release *githubRelease) (driverBundleAssetIndex, error) {
	if release == nil {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.release_empty", nil, nil)
	}
	indexURL := ""
	for _, asset := range release.Assets {
		if strings.EqualFold(strings.TrimSpace(asset.Name), optionalDriverBundleIndexAssetName) {
			indexURL = strings.TrimSpace(asset.BrowserDownloadURL)
			break
		}
	}
	if indexURL == "" {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_asset_missing", nil, nil)
	}

	client := newStrictHTTPClientWithGlobalProxy(driverReleaseAssetSizeProbeTimeout)
	candidates, resolveErr := resolveDispatcherDownloadCandidates(client, indexURL)
	if resolveErr != nil {
		if errors.Is(resolveErr, errInvalidDownloadDispatcherURL) {
			return driverBundleAssetIndex{}, resolveErr
		}
		candidates = []string{indexURL}
	}
	failures := make([]error, 0, len(candidates)+1)
	if resolveErr != nil {
		failures = append(failures, resolveErr)
	}
	for _, candidate := range candidates {
		index, err := fetchDriverBundleAssetIndexCandidate(client, candidate)
		if err == nil {
			return index, nil
		}
		failures = append(failures, fmt.Errorf("%s: %w", redactDownloadURL(candidate), err))
	}
	return driverBundleAssetIndex{}, errors.Join(failures...)
}

func fetchDriverBundleAssetIndexCandidate(client *http.Client, indexURL string) (driverBundleAssetIndex, error) {
	req, err := http.NewRequest(http.MethodGet, indexURL, nil)
	if err != nil {
		return driverBundleAssetIndex{}, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return driverBundleAssetIndex{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError(
			"driver_manager.backend.error.bundle_index_fetch_failed",
			nil,
			fmt.Errorf("HTTP %d", resp.StatusCode),
		)
	}

	limited := io.LimitReader(resp.Body, driverBundleIndexMaxSize)
	decoder := json.NewDecoder(limited)
	var index driverBundleAssetIndex
	if err := decoder.Decode(&index); err != nil {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_parse_failed", nil, err)
	}
	if len(index.Assets) == 0 {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_empty", nil, nil)
	}
	if len(index.AssetSHA256) != len(index.Assets) {
		return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_parse_failed", nil, errors.New("driver asset SHA256 metadata is incomplete"))
	}
	for name, size := range index.Assets {
		digest := normalizeGitHubAssetSHA256(index.AssetSHA256[name])
		if strings.TrimSpace(name) == "" || size <= 0 || len(digest) != 64 {
			return driverBundleAssetIndex{}, newLocalizedDriverBackendError("driver_manager.backend.error.bundle_index_parse_failed", nil, errors.New("driver asset metadata is invalid"))
		}
		index.AssetSHA256[name] = digest
	}
	return index, nil
}

func fetchLatestReleaseForDriverAssets() (*githubRelease, error) {
	if strings.EqualFold(currentDriverReleaseTag(), driverReleaseDevTag) {
		return fetchReleaseByTag(driverReleaseDevTag)
	}
	if release, err := fetchDriverReleaseIndexByURL("", driverReleaseMirrorLatestIndexURL); err == nil {
		return release, nil
	}
	return fetchDriverReleaseByURL(driverReleaseLatestAPIURL)
}

func resolveLatestPublishedDriverDownloadURL(definition driverDefinition) (string, bool) {
	return resolveLatestPublishedDriverDownloadURLForVersion(definition, "")
}

func resolveLatestPublishedDriverDownloadURLForVersion(definition driverDefinition, selectedVersion string) (string, bool) {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return "", false
	}
	assetNames := optionalDriverReleaseZipAssetNamesForVersion(driverType, selectedVersion)
	if len(assetNames) == 0 {
		return "", false
	}

	if sizeByAsset, publishedAssets, ok := readReleaseAssetSizesFromCache("latest"); ok {
		for _, assetName := range assetNames {
			if publishedAssets[assetName] && sizeByAsset[assetName] > 0 {
				if release, err := fetchLatestReleaseForDriverAssets(); err == nil {
					if asset, found := findReleaseAssetByName(release, []string{assetName}); found {
						return driverReleaseAssetAPIURL(asset), true
					}
				}
				return driverReleaseLatestDownloadURLForCurrentChannel(assetName), true
			}
		}
		return driverReleaseLatestDownloadURLForCurrentChannel(assetNames[0]), true
	}

	sizeByAsset, publishedAssets, err := loadReleaseAssetSizesCached("latest", fetchLatestReleaseForDriverAssets)
	if err != nil {
		return driverReleaseLatestDownloadURLForCurrentChannel(assetNames[0]), true
	}
	for _, assetName := range assetNames {
		if publishedAssets[assetName] && sizeByAsset[assetName] > 0 {
			if release, relErr := fetchLatestReleaseForDriverAssets(); relErr == nil {
				if asset, found := findReleaseAssetByName(release, []string{assetName}); found {
					return driverReleaseAssetAPIURL(asset), true
				}
			}
			return driverReleaseLatestDownloadURLForCurrentChannel(assetName), true
		}
	}
	return driverReleaseLatestDownloadURLForCurrentChannel(assetNames[0]), true
}

func fetchReleaseByTag(tag string) (*githubRelease, error) {
	tagName := strings.TrimSpace(tag)
	if tagName == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.tag_empty", nil, nil)
	}
	if release, err := fetchMirrorDriverReleaseByTag(tagName); err == nil {
		return release, nil
	}
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases/tags/%s", driverReleaseRepo, url.PathEscape(tagName))
	return fetchDriverReleaseByURL(apiURL)
}

func fetchMirrorDriverReleaseByTag(tag string) (*githubRelease, error) {
	tagName := strings.TrimSpace(tag)
	if tagName == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.tag_empty", nil, nil)
	}
	if strings.EqualFold(tagName, driverReleaseDevTag) {
		return fetchDriverReleaseIndexByURL(tagName, driverReleaseMirrorDevLatestIndexURL)
	}
	return fetchDriverReleaseIndexByURL(
		tagName,
		driverMirrorReleaseDownloadURL(tagName, optionalDriverBundleIndexAssetName),
	)
}

func fetchDriverReleaseIndexByURL(tag string, indexURL string) (*githubRelease, error) {
	fallbackTag := strings.TrimSpace(tag)
	indexRelease := &githubRelease{
		TagName: fallbackTag,
		Assets: []githubAsset{{
			Name:               optionalDriverBundleIndexAssetName,
			BrowserDownloadURL: strings.TrimSpace(indexURL),
		}},
	}
	index, err := fetchDriverBundleAssetIndex(indexRelease)
	if err != nil {
		return nil, err
	}
	tagName := strings.TrimSpace(index.TagName)
	if tagName == "" {
		tagName = fallbackTag
	}
	if strings.EqualFold(fallbackTag, driverReleaseDevTag) {
		// dev alias 的逻辑 GitHub 标签固定为 dev-latest；mirrorTagName 仅控制镜像物理路径。
		tagName = driverReleaseDevTag
	}
	if tagName == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.tag_empty", nil, nil)
	}
	mirrorTagName := strings.TrimSpace(index.MirrorTagName)
	if mirrorTagName == "" {
		mirrorTagName = tagName
	}
	sizes := index.Assets
	names := make([]string, 0, len(sizes))
	for name := range sizes {
		names = append(names, name)
	}
	sort.Strings(names)
	assets := make([]githubAsset, 0, len(names))
	for _, name := range names {
		trimmedName := strings.TrimSpace(name)
		if trimmedName == "" {
			continue
		}
		assets = append(assets, githubAsset{
			Name:               trimmedName,
			BrowserDownloadURL: driverMirrorReleaseDownloadURLForTags(tagName, mirrorTagName, trimmedName),
			URL:                driverReleaseDownloadURL(tagName, trimmedName),
			Size:               sizes[name],
		})
	}
	return &githubRelease{TagName: tagName, Assets: assets}, nil
}

func fetchDriverReleaseByURL(apiURL string) (*githubRelease, error) {
	urlText := strings.TrimSpace(apiURL)
	if urlText == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.api_url_empty", nil, nil)
	}

	client := newStrictHTTPClientWithGlobalProxy(driverReleaseAssetSizeProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, urlText, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, newLocalizedDriverBackendError(
			"driver_manager.backend.error.release_info_fetch_failed",
			nil,
			fmt.Errorf("HTTP %d", resp.StatusCode),
		)
	}

	var release githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&release); err != nil {
		return nil, err
	}
	return &release, nil
}

func resolveDriverPackageSizeText(definition driverDefinition, pkg installedDriverPackage, packageMetaExists bool, packageSizeBytesMap map[string]int64, text func(string, map[string]any) string) string {
	if definition.BuiltIn {
		return driverManagerLocalizedText(text, "driver_manager.package_size.built_in", nil, "Built-in")
	}

	normalizedType := normalizeDriverType(definition.Type)
	if packageMetaExists {
		sizeBytes := readInstalledPackageSizeBytes(pkg)
		if sizeBytes > 0 {
			return formatSizeMB(sizeBytes)
		}
	}
	if sizeBytes, ok := packageSizeBytesMap[normalizedType]; ok && sizeBytes > 0 {
		return formatSizeMB(sizeBytes)
	}

	if !db.IsOptionalGoDriverBuildIncluded(normalizedType) {
		return driverManagerLocalizedText(text, "driver_manager.package_size.pending_release", nil, "Pending release")
	}
	return "-"
}

func driverManagerLocalizedText(text func(string, map[string]any) string, key string, params map[string]any, fallback string) string {
	if text == nil {
		return fallback
	}
	localized := text(key, params)
	if localized == "" {
		return fallback
	}
	return localized
}

func readInstalledPackageSizeBytes(pkg installedDriverPackage) int64 {
	pathText := strings.TrimSpace(pkg.ExecutablePath)
	if pathText == "" {
		pathText = strings.TrimSpace(pkg.FilePath)
	}
	if pathText == "" {
		return 0
	}
	info, err := os.Stat(pathText)
	if err != nil || info.IsDir() {
		return 0
	}
	return info.Size()
}

func formatSizeMB(sizeBytes int64) string {
	if sizeBytes <= 0 {
		return "-"
	}
	sizeMB := float64(sizeBytes) / (1024 * 1024)
	return fmt.Sprintf("%.2f MB", sizeMB)
}
