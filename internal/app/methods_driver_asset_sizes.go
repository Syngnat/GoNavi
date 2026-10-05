package app

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
)

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
