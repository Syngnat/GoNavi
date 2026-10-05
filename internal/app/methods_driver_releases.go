package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

func loadDriverReleaseListCached() ([]githubRelease, error) {
	driverReleaseListMu.RLock()
	cached := driverReleaseList
	driverReleaseListMu.RUnlock()
	if time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(strings.TrimSpace(cached.Err))
		}
		return append([]githubRelease(nil), cached.Releases...), nil
	}

	driverReleaseListMu.Lock()
	defer driverReleaseListMu.Unlock()

	cached = driverReleaseList
	if time.Since(cached.LoadedAt) < driverManifestCacheTTL {
		if strings.TrimSpace(cached.Err) != "" {
			return nil, errors.New(strings.TrimSpace(cached.Err))
		}
		return append([]githubRelease(nil), cached.Releases...), nil
	}

	releases, err := fetchDriverReleaseList()
	entry := driverManifestReleaseListCache{
		LoadedAt: time.Now(),
		Releases: append([]githubRelease(nil), releases...),
	}
	if err != nil {
		entry.Err = err.Error()
	}
	driverReleaseList = entry

	if err != nil {
		return nil, err
	}
	return releases, nil
}

func fetchDriverReleaseList() ([]githubRelease, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=30", driverReleaseRepo)
	client := newStrictHTTPClientWithGlobalProxy(driverReleaseListProbeTimeout)
	req, err := http.NewRequest(http.MethodGet, apiURL, nil)
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
			"driver_manager.backend.error.driver_version_list_fetch_failed",
			nil,
			fmt.Errorf("HTTP %d", resp.StatusCode),
		)
	}

	decoder := json.NewDecoder(io.LimitReader(resp.Body, 4<<20))
	var releases []githubRelease
	if err := decoder.Decode(&releases); err != nil {
		return nil, newLocalizedDriverBackendError("driver_manager.backend.error.driver_version_list_parse_failed", nil, err)
	}
	return releases, nil
}

func releaseContainsAnyAsset(release githubRelease, assetNames []string) bool {
	normalizedNames := make([]string, 0, len(assetNames))
	for _, assetName := range assetNames {
		name := strings.TrimSpace(assetName)
		if name == "" {
			continue
		}
		normalizedNames = append(normalizedNames, name)
	}
	if len(normalizedNames) == 0 {
		return false
	}
	for _, asset := range release.Assets {
		assetName := strings.TrimSpace(asset.Name)
		for _, expected := range normalizedNames {
			if strings.EqualFold(assetName, expected) {
				return true
			}
		}
	}
	return false
}

func resolveDriverInstallVersion(version, downloadURL string, definition driverDefinition) string {
	if selected := strings.TrimSpace(version); selected != "" {
		return selected
	}

	if inferred := inferDriverInstallVersionByDownloadURL(downloadURL); inferred != "" {
		return inferred
	}

	if pinned := strings.TrimSpace(definition.PinnedVersion); pinned != "" {
		return pinned
	}
	if effectiveDriverEngine(definition) == driverEngineGo {
		return "go-embedded"
	}
	return "unknown"
}

func inferDriverInstallVersionByDownloadURL(downloadURL string) string {
	urlText := strings.TrimSpace(downloadURL)
	if urlText == "" {
		return ""
	}
	parsed, err := url.Parse(urlText)
	if err == nil && parsed != nil {
		switch strings.ToLower(strings.TrimSpace(parsed.Scheme)) {
		case "builtin":
			return ""
		case "local":
			return "local"
		case "http", "https":
			if queryVersion := normalizeVersion(parsed.Query().Get("version")); queryVersion != "" {
				return queryVersion
			}
			if tag := extractReleaseTagFromPath(parsed.Path); tag != "" {
				return normalizeVersion(tag)
			}
		}
	}
	if tag := extractReleaseTagFromPath(urlText); tag != "" {
		return normalizeVersion(tag)
	}
	return ""
}

func extractReleaseTagFromPath(pathText string) string {
	segments := strings.Split(pathText, "/")
	for index := 0; index < len(segments)-1; index++ {
		if !strings.EqualFold(strings.TrimSpace(segments[index]), "download") {
			continue
		}
		tag := strings.TrimSpace(segments[index+1])
		if tag == "" || strings.EqualFold(tag, "latest") {
			continue
		}
		if decoded, err := url.PathUnescape(tag); err == nil && strings.TrimSpace(decoded) != "" {
			tag = strings.TrimSpace(decoded)
		}
		return tag
	}
	return ""
}

func resolveDriverRepositoryURL(repositoryURL string) (string, error) {
	urlText := strings.TrimSpace(repositoryURL)
	if urlText == "" {
		return defaultDriverManifestURLValue, nil
	}
	parsed, err := url.Parse(urlText)
	if err == nil && parsed.Scheme != "" {
		switch strings.ToLower(parsed.Scheme) {
		case "http", "https":
			return parsed.String(), nil
		case "file":
			if parsed.Path == "" {
				return "", newLocalizedDriverBackendError("driver_manager.backend.error.file_manifest_url_invalid", nil, nil)
			}
			return urlText, nil
		case "builtin":
			if isBuiltinManifestURL(parsed) {
				return defaultDriverManifestURLValue, nil
			}
			return "", newLocalizedDriverBackendError("driver_manager.backend.message.unsupported_builtin_manifest_url", map[string]any{"url": parsed.String()}, nil)
		default:
			return "", newLocalizedDriverBackendError("driver_manager.backend.error.manifest_scheme_unsupported", map[string]any{"scheme": parsed.Scheme}, nil)
		}
	}
	absPath, absErr := filepath.Abs(urlText)
	if absErr != nil {
		return "", absErr
	}
	return absPath, nil
}
