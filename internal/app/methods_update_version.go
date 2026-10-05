package app

import (
	"strings"
)

func resolveReleaseVersion(channel updateChannel, release *githubRelease) string {
	if release == nil {
		return ""
	}

	tagVersion := normalizeVersion(release.TagName)
	if channel != updateChannelDev && tagVersion != "" && !strings.EqualFold(tagVersion, updateDevReleaseTag) {
		return tagVersion
	}

	if nameVersion := extractVersionFromReleaseName(release.Name); nameVersion != "" {
		return nameVersion
	}
	if assetVersion := extractVersionFromReleaseAssets(release.Assets); assetVersion != "" {
		return assetVersion
	}
	if tagVersion != "" && !strings.EqualFold(tagVersion, updateDevReleaseTag) {
		return tagVersion
	}
	return ""
}

func extractVersionFromReleaseName(name string) string {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return ""
	}

	if strings.HasPrefix(strings.ToLower(trimmed), "dev-") {
		return normalizeVersion(trimmed)
	}

	if left := strings.LastIndex(trimmed, "("); left >= 0 && strings.HasSuffix(trimmed, ")") {
		candidate := strings.TrimSpace(trimmed[left+1 : len(trimmed)-1])
		if candidate != "" {
			return normalizeVersion(candidate)
		}
	}
	return ""
}

func extractVersionFromReleaseAssets(assets []githubAsset) string {
	const assetPrefix = "GoNavi-"
	osMarkers := []string{"-Windows-", "-MacOS-", "-Linux-"}

	for _, asset := range assets {
		name := strings.TrimSpace(asset.Name)
		if !strings.HasPrefix(name, assetPrefix) {
			continue
		}
		rest := strings.TrimPrefix(name, assetPrefix)
		for _, marker := range osMarkers {
			index := strings.Index(rest, marker)
			if index <= 0 {
				continue
			}
			candidate := normalizeVersion(rest[:index])
			if candidate != "" {
				return candidate
			}
		}
	}
	return ""
}

func sanitizeVersionForPath(version string) string {
	trimmed := strings.TrimSpace(version)
	if trimmed == "" {
		return "latest"
	}

	var builder strings.Builder
	lastDash := false
	for _, r := range trimmed {
		isAllowed := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if isAllowed {
			builder.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteRune('-')
			lastDash = true
		}
	}

	result := strings.Trim(builder.String(), "-")
	if result == "" || result == "." || result == ".." {
		return "latest"
	}
	return result
}

func normalizeVersion(version string) string {
	version = strings.TrimSpace(version)
	version = strings.TrimPrefix(version, "v")
	return version
}

func compareVersion(current, latest string) int {
	current = normalizeVersion(current)
	latest = normalizeVersion(latest)
	if current == "" {
		return -1
	}
	if current == latest {
		return 0
	}

	curParts := splitVersionParts(current)
	latParts := splitVersionParts(latest)
	max := len(curParts)
	if len(latParts) > max {
		max = len(latParts)
	}
	for i := 0; i < max; i++ {
		cur := 0
		lat := 0
		if i < len(curParts) {
			cur = curParts[i]
		}
		if i < len(latParts) {
			lat = latParts[i]
		}
		if cur < lat {
			return -1
		}
		if cur > lat {
			return 1
		}
	}
	return 0
}

func splitVersionParts(version string) []int {
	parts := strings.Split(version, ".")
	result := make([]int, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			result = append(result, 0)
			continue
		}
		num := 0
		for _, ch := range part {
			if ch < '0' || ch > '9' {
				break
			}
			num = num*10 + int(ch-'0')
		}
		result = append(result, num)
	}
	return result
}
