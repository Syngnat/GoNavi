package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func resolveManifestURLForView(manifestURL string) string {
	resolved, err := resolveDriverRepositoryURL(manifestURL)
	if err != nil {
		return strings.TrimSpace(manifestURL)
	}
	return resolved
}

func resolveManifestDriverPackages(manifestURL string) (map[string]pinnedDriverPackage, error) {
	resolvedURL, err := resolveDriverRepositoryURL(manifestURL)
	if err != nil {
		return nil, err
	}

	driverManifestCacheMu.RLock()
	cached, ok := driverManifestCache[resolvedURL]
	driverManifestCacheMu.RUnlock()
	if ok && time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if cached.LoadErr != nil {
			return nil, cached.LoadErr
		}
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(cached.Err)
		}
		return copyPinnedPackageMap(cached.Packages), nil
	}

	packages, versions, loadErr := loadManifestPackageAndVersions(resolvedURL)
	entry := driverManifestCacheEntry{
		LoadedAt: time.Now(),
		Packages: copyPinnedPackageMap(packages),
		Versions: copyVersionPackageMap(versions),
	}
	if loadErr != nil {
		entry.Err = errorMessage(loadErr)
		entry.LoadErr = loadErr
	}
	driverManifestCacheMu.Lock()
	driverManifestCache[resolvedURL] = entry
	driverManifestCacheMu.Unlock()

	if loadErr != nil {
		return nil, loadErr
	}
	return packages, nil
}

func resolveManifestDriverVersionPackages(manifestURL string) (map[string][]pinnedDriverPackage, error) {
	resolvedURL, err := resolveDriverRepositoryURL(manifestURL)
	if err != nil {
		return nil, err
	}

	driverManifestCacheMu.RLock()
	cached, ok := driverManifestCache[resolvedURL]
	driverManifestCacheMu.RUnlock()
	if ok && time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if cached.LoadErr != nil {
			return nil, cached.LoadErr
		}
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(cached.Err)
		}
		return copyVersionPackageMap(cached.Versions), nil
	}

	packages, versions, loadErr := loadManifestPackageAndVersions(resolvedURL)
	entry := driverManifestCacheEntry{
		LoadedAt: time.Now(),
		Packages: copyPinnedPackageMap(packages),
		Versions: copyVersionPackageMap(versions),
	}
	if loadErr != nil {
		entry.Err = errorMessage(loadErr)
		entry.LoadErr = loadErr
	}
	driverManifestCacheMu.Lock()
	driverManifestCache[resolvedURL] = entry
	driverManifestCacheMu.Unlock()

	if loadErr != nil {
		return nil, loadErr
	}
	return versions, nil
}

func loadManifestPackageAndVersions(resolvedURL string) (map[string]pinnedDriverPackage, map[string][]pinnedDriverPackage, error) {
	content, err := loadManifestContent(resolvedURL)
	if err != nil {
		return nil, nil, err
	}

	var manifest driverManifestFile
	if err := json.Unmarshal(content, &manifest); err != nil {
		return nil, nil, newLocalizedDriverBackendError("driver_manager.backend.error.manifest_parse_failed", nil, err)
	}
	defaultEngine := normalizeDriverEngine(manifest.Engine)
	if defaultEngine == "" {
		defaultEngine = normalizeDriverEngine(manifest.DefaultEngine)
	}
	if defaultEngine == "" {
		defaultEngine = normalizeDriverEngine(manifest.DefaultEngine2)
	}

	result := make(map[string]pinnedDriverPackage)
	versionResult := make(map[string][]pinnedDriverPackage)
	for driverType, item := range manifest.Drivers {
		normalizedType := normalizeDriverType(driverType)
		if normalizedType == "" {
			continue
		}
		base := normalizeManifestDriverPackage(item.Version, item.DownloadURL, item.DownloadURL2, item.SHA256, item.ChecksumPolicy, item.ChecksumPolicy2, item.Engine, defaultEngine)
		result[normalizedType] = base
		versions := normalizeManifestDriverVersionList(item, base, defaultEngine)
		if len(versions) == 0 {
			versions = append(versions, base)
		}
		versionResult[normalizedType] = versions
	}
	return result, versionResult, nil
}

func normalizeManifestDriverPackage(version, downloadURL, downloadURL2, sha256, policy, policy2, engine, defaultEngine string) pinnedDriverPackage {
	urlText := strings.TrimSpace(downloadURL)
	if urlText == "" {
		urlText = strings.TrimSpace(downloadURL2)
	}
	policyText := strings.TrimSpace(policy)
	if policyText == "" {
		policyText = strings.TrimSpace(policy2)
	}
	engineText := normalizeDriverEngine(engine)
	if engineText == "" {
		engineText = defaultEngine
	}
	return pinnedDriverPackage{
		Version:     strings.TrimSpace(version),
		DownloadURL: urlText,
		SHA256:      strings.TrimSpace(sha256),
		Policy:      normalizeDriverChecksumPolicy(policyText),
		Engine:      engineText,
	}
}

func normalizeManifestDriverVersionList(item driverManifestItem, fallback pinnedDriverPackage, defaultEngine string) []pinnedDriverPackage {
	rawVersions := make([]driverManifestVersionItem, 0, len(item.Versions)+len(item.VersionList)+len(item.VersionList2)+len(item.VersionOptions)+len(item.VersionOptions2))
	rawVersions = append(rawVersions, item.Versions...)
	rawVersions = append(rawVersions, item.VersionList...)
	rawVersions = append(rawVersions, item.VersionList2...)
	rawVersions = append(rawVersions, item.VersionOptions...)
	rawVersions = append(rawVersions, item.VersionOptions2...)
	if len(rawVersions) == 0 {
		return nil
	}

	result := make([]pinnedDriverPackage, 0, len(rawVersions))
	seen := make(map[string]struct{}, len(rawVersions))
	for _, versionItem := range rawVersions {
		pkg := normalizeManifestDriverPackage(
			versionItem.Version,
			versionItem.DownloadURL,
			versionItem.DownloadURL2,
			versionItem.SHA256,
			versionItem.ChecksumPolicy,
			versionItem.ChecksumPolicy2,
			versionItem.Engine,
			defaultEngine,
		)
		if pkg.Version == "" {
			pkg.Version = fallback.Version
		}
		if pkg.DownloadURL == "" {
			pkg.DownloadURL = fallback.DownloadURL
		}
		if pkg.SHA256 == "" {
			pkg.SHA256 = fallback.SHA256
		}
		if pkg.Policy == "" {
			pkg.Policy = fallback.Policy
		}
		if pkg.Engine == "" {
			pkg.Engine = fallback.Engine
		}
		if pkg.Version == "" && pkg.DownloadURL == "" {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(pkg.Version)) + "|" + strings.TrimSpace(pkg.DownloadURL)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, pkg)
	}
	return result
}

func loadManifestContent(resolvedURL string) ([]byte, error) {
	trimmed := strings.TrimSpace(resolvedURL)
	if trimmed == "" {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.manifest_url_empty", nil, nil)
	}
	parsed, err := url.Parse(trimmed)
	if err == nil {
		scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
		switch scheme {
		case "http", "https":
			client := newStrictHTTPClientWithGlobalProxy(12 * time.Second)
			req, reqErr := http.NewRequest(http.MethodGet, parsed.String(), nil)
			if reqErr != nil {
				return nil, reqErr
			}
			req.Header.Set("User-Agent", "GoNavi-DriverManifest")
			resp, doErr := client.Do(req)
			if doErr != nil {
				return nil, doErr
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				return nil, newLocalizedDriverBackendError("driver_manager.backend.error.manifest_fetch_failed", nil, fmt.Errorf("HTTP %d", resp.StatusCode))
			}
			limited := io.LimitReader(resp.Body, driverManifestMaxSize+1)
			body, readErr := io.ReadAll(limited)
			if readErr != nil {
				return nil, readErr
			}
			if int64(len(body)) > driverManifestMaxSize {
				return nil, newLocalizedDriverBackendError("driver_manager.backend.error.manifest_too_large", nil, nil)
			}
			return body, nil
		case "file":
			pathText := strings.TrimSpace(parsed.Path)
			if pathText == "" {
				return nil, newLocalizedDriverBackendError("driver_manager.backend.error.local_manifest_url_invalid", nil, nil)
			}
			body, readErr := os.ReadFile(pathText)
			if readErr != nil {
				return nil, readErr
			}
			if int64(len(body)) > driverManifestMaxSize {
				return nil, newLocalizedDriverBackendError("driver_manager.backend.error.manifest_too_large", nil, nil)
			}
			return body, nil
		case "builtin":
			if isBuiltinManifestURL(parsed) {
				return []byte(builtinDriverManifestJSON), nil
			}
			return nil, newLocalizedDriverBackendError("driver_manager.backend.message.unsupported_builtin_manifest_url", map[string]any{"url": parsed.String()}, nil)
		}
	}
	body, readErr := os.ReadFile(trimmed)
	if readErr != nil {
		return nil, readErr
	}
	if int64(len(body)) > driverManifestMaxSize {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.manifest_too_large", nil, nil)
	}
	return body, nil
}

func isBuiltinManifestURL(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	if strings.ToLower(strings.TrimSpace(parsed.Scheme)) != "builtin" {
		return false
	}
	if strings.ToLower(strings.TrimSpace(parsed.Host)) != "manifest" {
		return false
	}
	pathText := strings.TrimSpace(parsed.Path)
	return pathText == "" || pathText == "/"
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return strings.TrimSpace(err.Error())
}
