package app

import (
	"fmt"
	"path/filepath"
	stdRuntime "runtime"
	"strings"
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
