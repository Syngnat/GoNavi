package app

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"

	"golang.org/x/mod/semver"
)

func resolveRecentDriverVersionMetas(driverType string, limit int) []goModuleVersionMeta {
	if limit <= 0 {
		limit = driverRecentVersionLimit
	}
	normalized := normalizeDriverType(driverType)
	if normalized == "" {
		return nil
	}
	modulePaths := resolveDriverGoModulePaths(normalized)
	if len(modulePaths) > 0 {
		extraHistoryLimit := resolveDriverExtraHistoryLimit(normalized)
		primaryLimit := limit + extraHistoryLimit
		if primaryLimit <= 0 {
			primaryLimit = limit
		}
		result := make([]goModuleVersionMeta, 0, primaryLimit)
		seen := make(map[string]struct{}, primaryLimit)
		appendUnique := func(values []goModuleVersionMeta, maxAppend int) {
			if maxAppend <= 0 {
				return
			}
			appended := 0
			for _, meta := range values {
				version := normalizeVersion(strings.TrimSpace(meta.Version))
				if version == "" {
					continue
				}
				key := strings.ToLower(version)
				if _, ok := seen[key]; ok {
					continue
				}
				meta.Version = version
				result = append(result, meta)
				seen[key] = struct{}{}
				appended++
				if appended >= maxAppend {
					return
				}
			}
		}

		appendUnique(fetchGoModuleVersionMetasCached(modulePaths[0]), primaryLimit)

		extraLimit := extraHistoryLimit
		for _, modulePath := range modulePaths[1:] {
			if extraLimit <= 0 {
				break
			}
			before := len(result)
			appendUnique(fetchGoModuleVersionMetasCached(modulePath), extraLimit)
			extraLimit -= len(result) - before
		}
		if len(result) > 0 {
			return result
		}
	}

	fallbackLimit := limit + resolveDriverExtraHistoryLimit(normalized)
	if fallbackLimit <= 0 {
		fallbackLimit = limit
	}
	if fallback := fallbackRecentDriverVersionsMap[normalized]; len(fallback) > 0 {
		if len(fallback) > fallbackLimit {
			return append([]goModuleVersionMeta(nil), fallback[:fallbackLimit]...)
		}
		return append([]goModuleVersionMeta(nil), fallback...)
	}
	if fallback := normalizeVersion(strings.TrimSpace(latestDriverVersionMap[normalized])); fallback != "" {
		return []goModuleVersionMeta{{Version: fallback}}
	}
	return nil
}

func triggerDriverVersionMetadataWarmup(definitions []driverDefinition) {
	if len(definitions) == 0 {
		return
	}

	modulePaths := make([]string, 0, len(definitions))
	seenModule := make(map[string]struct{}, len(definitions))
	for _, definition := range definitions {
		if definition.BuiltIn {
			continue
		}
		driverType := normalizeDriverType(definition.Type)
		if driverType == "" || !db.IsOptionalGoDriver(driverType) {
			continue
		}
		for _, modulePath := range resolveDriverGoModulePaths(driverType) {
			if _, ok := seenModule[modulePath]; ok {
				continue
			}
			seenModule[modulePath] = struct{}{}
			modulePaths = append(modulePaths, modulePath)
		}
	}

	if len(modulePaths) == 0 {
		return
	}
	if !tryStartDriverVersionMetadataWarmup(time.Now()) {
		return
	}

	go func(paths []string, warmupDefinitions []driverDefinition) {
		defer finishDriverVersionMetadataWarmup()
		// 包大小和历史版本都属于辅助元数据，不能阻塞驱动状态首屏。
		_ = preloadOptionalDriverPackageSizes(warmupDefinitions)
		for _, modulePath := range paths {
			_ = fetchGoModuleVersionMetasCached(modulePath)
		}
	}(append([]string(nil), modulePaths...), append([]driverDefinition(nil), definitions...))
}

func resolveDriverGoModulePaths(driverType string) []string {
	normalized := normalizeDriverType(driverType)
	if normalized == "" {
		return nil
	}
	paths := make([]string, 0, 3)
	seen := make(map[string]struct{}, 3)
	appendPath := func(path string) {
		trimmed := strings.TrimSpace(path)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; ok {
			return
		}
		seen[trimmed] = struct{}{}
		paths = append(paths, trimmed)
	}

	appendPath(driverGoModulePathMap[normalized])
	for _, alias := range driverGoModuleAliasPathMap[normalized] {
		appendPath(alias)
	}
	return paths
}

func resolveDriverExtraHistoryLimit(driverType string) int {
	limit := driverExtraHistoryLimitMap[normalizeDriverType(driverType)]
	if limit < 0 {
		return 0
	}
	return limit
}

func tryStartDriverVersionMetadataWarmup(now time.Time) bool {
	driverVersionWarmupMu.Lock()
	defer driverVersionWarmupMu.Unlock()

	if driverVersionWarmup.Running {
		return false
	}
	if !driverVersionWarmup.LastStarted.IsZero() && now.Sub(driverVersionWarmup.LastStarted) < driverVersionWarmupMinInterval {
		return false
	}
	driverVersionWarmup.Running = true
	driverVersionWarmup.LastStarted = now
	return true
}

func finishDriverVersionMetadataWarmup() {
	driverVersionWarmupMu.Lock()
	driverVersionWarmup.Running = false
	driverVersionWarmupMu.Unlock()
}

func fetchGoModuleVersionMetasCached(modulePath string) []goModuleVersionMeta {
	key := strings.TrimSpace(modulePath)
	if key == "" {
		return nil
	}

	driverModuleVersionMu.RLock()
	cached, ok := driverModuleVersionMap[key]
	driverModuleVersionMu.RUnlock()
	if ok {
		ttl := driverModuleLatestCacheTTL
		if strings.TrimSpace(cached.Err) != "" {
			ttl = driverModuleLatestErrorCacheTTL
		}
		if time.Since(cached.LoadedAt) < ttl {
			if strings.TrimSpace(cached.Err) != "" {
				return nil
			}
			return append([]goModuleVersionMeta(nil), cached.Versions...)
		}
	}

	metas, err := fetchGoModuleVersionMetas(key)
	entry := goModuleVersionListCacheEntry{
		LoadedAt: time.Now(),
		Versions: append([]goModuleVersionMeta(nil), metas...),
	}
	if err != nil {
		entry.Err = err.Error()
	}

	driverModuleVersionMu.Lock()
	driverModuleVersionMap[key] = entry
	driverModuleVersionMu.Unlock()

	if err != nil {
		return nil
	}
	return append([]goModuleVersionMeta(nil), entry.Versions...)
}

func fetchGoModuleVersionMetas(modulePath string) ([]goModuleVersionMeta, error) {
	trimmed := strings.TrimSpace(modulePath)
	if trimmed == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.module_path_empty", nil, nil)
	}

	endpoint := fmt.Sprintf("https://proxy.golang.org/%s/@v/list", escapeGoModulePathForProxy(trimmed))
	client := newStrictHTTPClientWithGlobalProxy(driverModuleLatestProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GoNavi-DriverManager")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, newLocalizedDriverBackendError(
			"driver_manager.backend.error.module_version_list_fetch_failed",
			nil,
			fmt.Errorf("HTTP %d", resp.StatusCode),
		)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, driverModuleVersionListMaxSize))
	if err != nil {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.module_version_list_read_failed", nil, err)
	}

	lines := strings.Split(strings.TrimSpace(string(body)), "\n")
	versions := make([]string, 0, len(lines))
	seen := make(map[string]struct{}, len(lines))
	for _, line := range lines {
		version := normalizeVersion(strings.TrimSpace(line))
		if version == "" {
			continue
		}
		normalizedSemver := "v" + version
		if !semver.IsValid(normalizedSemver) {
			continue
		}
		if semver.Prerelease(normalizedSemver) != "" {
			continue
		}
		if _, ok := seen[version]; ok {
			continue
		}
		seen[version] = struct{}{}
		versions = append(versions, version)
	}
	if len(versions) == 0 {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.module_version_list_empty", nil, nil)
	}

	sort.SliceStable(versions, func(i, j int) bool {
		left := "v" + versions[i]
		right := "v" + versions[j]
		return semver.Compare(left, right) > 0
	})
	if len(versions) > driverModuleVersionFetchLimit {
		versions = versions[:driverModuleVersionFetchLimit]
	}

	metas := make([]goModuleVersionMeta, 0, len(versions))
	for _, version := range versions {
		metas = append(metas, goModuleVersionMeta{Version: version})
	}
	return metas, nil
}

func escapeGoModulePathForProxy(modulePath string) string {
	parts := strings.Split(modulePath, "/")
	for index, part := range parts {
		parts[index] = url.PathEscape(strings.TrimSpace(part))
	}
	return strings.Join(parts, "/")
}

func resolveDriverVersionOptionsFromReleases(definition driverDefinition) []driverVersionOptionItem {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return nil
	}

	releases, err := loadDriverReleaseListCached()
	if err != nil {
		return nil
	}

	result := make([]driverVersionOptionItem, 0, len(releases))
	for _, release := range releases {
		if release.Prerelease {
			continue
		}
		tag := strings.TrimSpace(release.TagName)
		version := normalizeVersion(tag)
		if tag == "" || version == "" {
			continue
		}
		assetName := optionalDriverReleaseZipAssetNameForVersion(driverType, version)
		assetNames := optionalDriverReleaseZipAssetNamesForVersion(driverType, version)
		if !releaseContainsAnyAsset(release, assetNames) {
			continue
		}
		result = append(result, driverVersionOptionItem{
			Version:     version,
			DownloadURL: driverReleaseDownloadURL(tag, assetName),
			Source:      "release",
		})
	}
	return result
}
