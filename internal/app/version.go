package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

var AppVersion = "0.0.0"
var AppBuildTime = ""

func getCurrentVersion() string {
	version := strings.TrimSpace(AppVersion)
	if version == "" || version == "0.0.0" {
		if env := strings.TrimSpace(os.Getenv("GONAVI_VERSION")); env != "" {
			version = env
		} else if pkgVersion, err := readPackageVersion(); err == nil && pkgVersion != "" {
			version = pkgVersion
		}
	}
	return normalizeVersion(version)
}

func readPackageVersion() (string, error) {
	paths := []string{
		filepath.Join("frontend", "package.json"),
	}
	exe, err := os.Executable()
	if err == nil {
		base := filepath.Dir(exe)
		paths = append(paths, filepath.Join(base, "frontend", "package.json"))
		paths = append(paths, filepath.Join(base, "..", "frontend", "package.json"))
	}

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var payload struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(data, &payload); err != nil {
			continue
		}
		if strings.TrimSpace(payload.Version) != "" {
			return strings.TrimSpace(payload.Version), nil
		}
	}

	return "", os.ErrNotExist
}
