package app

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	stdRuntime "runtime"
	"sort"
	"strings"
	"time"
)

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
	// 缓存文件按总包格式命名，便于排查；读取时仍按文件头识别格式。
	extension := ".zip"
	if strings.Contains(strings.ToLower(bundleURL), ".7z") {
		extension = ".7z"
	}
	return filepath.Join(cacheDir, hex.EncodeToString(sum[:])+extension), nil
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
		if !isDriverPackageArchivePath(name) {
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
	archive, err := openDriverPackageArchive(cachePath)
	if err != nil {
		_ = os.Remove(cachePath)
		return "", fmt.Errorf("open driver bundle failed: %w", err)
	}
	if err := archive.Close(); err != nil {
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
