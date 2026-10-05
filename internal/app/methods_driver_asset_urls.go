package app

import (
	"fmt"
	"net/url"
	"strings"
)

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
