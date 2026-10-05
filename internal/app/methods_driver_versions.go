package app

import (
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"strings"

	"GoNavi-Wails/internal/db"
)

func resolveDriverVersionOptions(definition driverDefinition, repositoryURL string, text func(string, map[string]any) string) ([]driverVersionOptionItem, error) {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return nil, errors.New(driverManagerLocalizedText(text, "driver_manager.backend.error.driver_type_empty", nil, "Driver type is empty"))
	}

	optionMap := make(map[string]driverVersionOptionItem)
	optionKeys := make([]string, 0, 16)
	appendOption := func(version, downloadURL, sha256, source, year string) {
		versionText := strings.TrimSpace(version)
		urlText := strings.TrimSpace(downloadURL)
		if urlText == "" {
			urlText = strings.TrimSpace(definition.DefaultDownloadURL)
		}
		if urlText == "" && effectiveDriverEngine(definition) == driverEngineGo {
			urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(driverType))
		}
		if versionText == "" {
			versionText = resolveDriverInstallVersion("", urlText, definition)
		}
		if versionText == "" && urlText == "" {
			return
		}
		if versionText != "" {
			if err := validateDriverSelectedVersion(definition, versionText); err != nil {
				return
			}
		}
		versionKey := normalizeVersion(versionText)
		key := ""
		if versionKey != "" {
			key = "v:" + strings.ToLower(versionKey)
		} else {
			key = "u:" + urlText
		}
		if existing, ok := optionMap[key]; ok {
			if existing.Year == "" && strings.TrimSpace(year) != "" {
				existing.Year = strings.TrimSpace(year)
				optionMap[key] = existing
			}
			return
		}
		optionMap[key] = driverVersionOptionItem{
			Version:     versionText,
			DownloadURL: urlText,
			SHA256:      strings.TrimSpace(sha256),
			Source:      strings.TrimSpace(source),
			Year:        strings.TrimSpace(year),
		}
		optionKeys = append(optionKeys, key)
	}

	manifestVersions, _ := resolveManifestDriverVersionPackages(repositoryURL)
	if values := manifestVersions[driverType]; len(values) > 0 {
		expectedEngine := effectiveDriverEngine(definition)
		for _, value := range values {
			engine := normalizeDriverEngine(value.Engine)
			if engine != "" && expectedEngine != "" && engine != expectedEngine {
				continue
			}
			appendOption(value.Version, value.DownloadURL, value.SHA256, "manifest", "")
		}
	}

	appendOption(definition.PinnedVersion, definition.DefaultDownloadURL, definition.DownloadSHA256, "pinned", "")
	for _, recent := range resolveRecentDriverVersionOptions(definition, driverRecentVersionLimit) {
		if sameDriverVersion(recent.Version, definition.PinnedVersion) {
			continue
		}
		appendOption(recent.Version, recent.DownloadURL, recent.SHA256, recent.Source, recent.Year)
	}

	if len(optionKeys) == 0 {
		return nil, errors.New(driverManagerLocalizedText(text, "driver_manager.backend.error.no_driver_versions", nil, "No available driver versions were found"))
	}

	recommendedVersion := strings.TrimSpace(definition.PinnedVersion)
	recommendedIndex := -1
	if recommendedVersion != "" {
		for index, key := range optionKeys {
			option := optionMap[key]
			if strings.EqualFold(strings.TrimSpace(option.Version), recommendedVersion) {
				recommendedIndex = index
				break
			}
		}
	}
	if recommendedIndex == -1 {
		recommendedIndex = 0
	}

	result := make([]driverVersionOptionItem, 0, len(optionKeys))
	for index, key := range optionKeys {
		option := optionMap[key]
		option.Recommended = index == recommendedIndex
		sizeBytes := resolveDriverVersionPackageSizeBytes(definition, option)
		if sizeBytes > 0 {
			option.PackageSizeBytes = sizeBytes
			option.PackageSizeText = formatSizeMB(sizeBytes)
		}
		option.DisplayLabel = buildDriverVersionDisplayLabel(option, text)
		result = append(result, option)
	}
	return result, nil
}

func buildDriverVersionDisplayLabel(option driverVersionOptionItem, text func(string, map[string]any) string) string {
	label := strings.TrimSpace(option.Version)
	if label == "" {
		label = driverManagerLocalizedText(text, "driver_manager.version.unlabeled", nil, "Unlabeled version")
	}
	if strings.EqualFold(strings.TrimSpace(option.Source), "latest") {
		label += driverManagerLocalizedText(text, "driver_manager.version.latest_suffix", nil, " (latest)")
	}
	if option.Recommended {
		label += driverManagerLocalizedText(text, "driver_manager.version.recommended_suffix", nil, " (recommended)")
	}
	return label
}

func resolveRecentDriverVersionOptions(definition driverDefinition, limit int) []driverVersionOptionItem {
	metas := resolveRecentDriverVersionMetas(definition.Type, limit)
	if len(metas) == 0 {
		return nil
	}
	result := make([]driverVersionOptionItem, 0, len(metas))
	for index, meta := range metas {
		source := "history"
		if index == 0 {
			source = "latest"
		}
		versionText, urlText, ok := resolveVersionedDriverOption(definition, meta.Version, source)
		if !ok {
			continue
		}
		result = append(result, driverVersionOptionItem{
			Version:     versionText,
			DownloadURL: urlText,
			Source:      source,
			Year:        strings.TrimSpace(meta.Year),
		})
	}
	return result
}

func resolveVersionedDriverOption(definition driverDefinition, version string, source string) (string, string, bool) {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" {
		return "", "", false
	}
	versionText := normalizeVersion(strings.TrimSpace(version))
	if versionText == "" {
		return "", "", false
	}
	if err := validateDriverSelectedVersion(definition, versionText); err != nil {
		return "", "", false
	}

	if publishedURL, ok := resolvePublishedDriverDownloadURL(definition, versionText); ok {
		return versionText, publishedURL, true
	}
	if !optionalDriverSourceBuildAvailable(definition, versionText) {
		return "", "", false
	}

	urlText := strings.TrimSpace(definition.DefaultDownloadURL)
	if urlText == "" && effectiveDriverEngine(definition) == driverEngineGo {
		urlText = fmt.Sprintf("builtin://activate/%s", optionalDriverPublicTypeName(driverType))
	}
	if urlText == "" {
		return "", "", false
	}

	parsed, err := url.Parse(urlText)
	if err != nil || parsed == nil {
		return versionText, urlText, true
	}
	query := parsed.Query()
	channel := strings.TrimSpace(source)
	if channel == "" {
		channel = "history"
	}
	query.Set("channel", channel)
	query.Set("version", versionText)
	parsed.RawQuery = query.Encode()
	return versionText, parsed.String(), true
}

func sameDriverVersion(left, right string) bool {
	a := normalizeVersion(strings.TrimSpace(left))
	b := normalizeVersion(strings.TrimSpace(right))
	return a != "" && a == b
}

func validateDriverSelectedVersion(definition driverDefinition, version string) error {
	driverType := normalizeDriverType(definition.Type)
	versionText := normalizeVersion(strings.TrimSpace(version))
	if driverType == "" || versionText == "" {
		return nil
	}

	switch driverType {
	case "mongodb":
		if strings.HasPrefix(versionText, "2.") {
			return nil
		}
		if strings.HasPrefix(versionText, "1.17.") {
			return nil
		}
		return &driverVersionValidationError{
			DriverType: driverType,
			Version:    versionText,
		}
	default:
		return nil
	}
}

func shouldRestrictToExplicitVersionArtifact(definition driverDefinition, selectedVersion string) bool {
	versionText := normalizeVersion(strings.TrimSpace(selectedVersion))
	if versionText == "" {
		return false
	}
	return !sameDriverVersion(versionText, definition.PinnedVersion)
}

func optionalDriverSourceBuildAvailable(definition driverDefinition, selectedVersion string) bool {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" || !db.IsOptionalGoDriver(driverType) {
		return false
	}
	if _, err := optionalDriverBuildTags(driverType, selectedVersion); err != nil {
		return false
	}
	if _, err := exec.LookPath("go"); err != nil {
		return false
	}
	if _, err := locateProjectRootForAgentBuild(); err != nil {
		return false
	}
	return true
}

func resolvePublishedDriverDownloadURL(definition driverDefinition, version string) (string, bool) {
	versionText := normalizeVersion(strings.TrimSpace(version))
	if versionText == "" {
		return "", false
	}

	return resolvePublishedDriverDownloadURLForTag(definition, versionText, "v"+versionText)
}

func resolvePublishedDriverDownloadURLForTag(definition driverDefinition, selectedVersion string, tag string) (string, bool) {
	driverType := normalizeDriverType(definition.Type)
	tagName := strings.TrimSpace(tag)
	if driverType == "" || tagName == "" {
		return "", false
	}

	assetName, ok := resolvePublishedDriverReleaseAssetName(driverType, selectedVersion, tagName)
	if !ok {
		return "", false
	}
	if strings.EqualFold(tagName, driverReleaseDevTag) {
		if mirrorURL := readReleaseMirrorDownloadURLFromCache("tag:"+tagName, assetName); mirrorURL != "" {
			return mirrorURL, true
		}
	}
	return driverReleaseDownloadURL(tagName, assetName), true
}

func resolvePublishedDriverReleaseAssetName(driverType string, version string, tag string) (string, bool) {
	assetNames := optionalDriverReleaseZipAssetNamesForVersion(driverType, version)
	if len(assetNames) == 0 {
		return "", false
	}

	cacheKey := "tag:" + strings.TrimSpace(tag)
	if sizeByAsset, publishedAssets, ok := readReleaseAssetSizesFromCache(cacheKey); ok {
		for _, assetName := range assetNames {
			if publishedAssets[assetName] && sizeByAsset[assetName] > 0 {
				return assetName, true
			}
		}
		return "", false
	}

	sizeByAsset, publishedAssets, err := loadReleaseAssetSizesCached(cacheKey, func() (*githubRelease, error) {
		return fetchReleaseByTag(tag)
	})
	if err != nil {
		return "", false
	}
	for _, assetName := range assetNames {
		if publishedAssets[assetName] && sizeByAsset[assetName] > 0 {
			return assetName, true
		}
	}
	return "", false
}

func resolveDriverVersionPackageSizeBytes(definition driverDefinition, option driverVersionOptionItem) int64 {
	driverType := normalizeDriverType(definition.Type)
	if driverType == "" || definition.BuiltIn {
		return 0
	}
	if !db.IsOptionalGoDriver(driverType) {
		return 0
	}

	version := normalizeVersion(strings.TrimSpace(option.Version))
	if version == "" {
		return 0
	}
	assetNames := optionalDriverReleaseZipAssetNamesForVersion(driverType, version)
	if len(assetNames) == 0 {
		return 0
	}

	tag := "v" + version
	if sizeByAsset, _, ok := readReleaseAssetSizesFromCache("tag:" + tag); ok {
		return resolveOptionalDriverAssetSizeForVersion(sizeByAsset, driverType, version)
	}

	// 下拉版本列表要求快速返回：仅复用已有缓存，不在这里触发网络请求。
	if strings.EqualFold(strings.TrimSpace(option.Source), "latest") {
		if sizeByAsset, _, ok := readReleaseAssetSizesFromCache("latest"); ok {
			return resolveOptionalDriverAssetSizeForVersion(sizeByAsset, driverType, version)
		}
	}
	return 0
}
