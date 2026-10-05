package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

var AppVersion = "0.0.0"
var AppBuildTime = ""
var developmentVersionPathResolver = defaultDevelopmentVersionPaths
var packageVersionPathResolver = defaultPackageVersionPaths

func getCurrentVersion() string {
	version := strings.TrimSpace(AppVersion)
	if version == "" || version == "0.0.0" {
		if env := strings.TrimSpace(os.Getenv("GONAVI_VERSION")); env != "" {
			version = env
		} else if devVersion, err := readDevelopmentVersion(); err == nil && devVersion != "" {
			version = devVersion
		} else if pkgVersion, err := readPackageVersion(); err == nil && pkgVersion != "" {
			version = pkgVersion
		}
	}
	return normalizeVersion(version)
}

func defaultDevelopmentVersionPaths() []string {
	paths := []string{
		filepath.Join("version", "dev-version.txt"),
	}
	exe, err := os.Executable()
	if err == nil {
		base := filepath.Dir(exe)
		paths = append(paths, filepath.Join(base, "version", "dev-version.txt"))
		paths = append(paths, filepath.Join(base, "..", "version", "dev-version.txt"))
	}
	return paths
}

func defaultPackageVersionPaths() []string {
	paths := []string{
		filepath.Join("frontend", "package.json"),
	}
	exe, err := os.Executable()
	if err == nil {
		base := filepath.Dir(exe)
		paths = append(paths, filepath.Join(base, "frontend", "package.json"))
		paths = append(paths, filepath.Join(base, "..", "frontend", "package.json"))
	}
	return paths
}

func readDevelopmentVersion() (string, error) {
	return readPlainVersionFromPaths(developmentVersionPathResolver())
}

func readPackageVersion() (string, error) {
	return readJSONVersionFromPaths(packageVersionPathResolver())
}

func readPlainVersionFromPaths(paths []string) (string, error) {
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		if version := strings.TrimSpace(string(data)); version != "" {
			return version, nil
		}
	}

	return "", os.ErrNotExist
}

func readJSONVersionFromPaths(paths []string) (string, error) {
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

// CurrentVersion is the running build's version, for components outside this
// package that identify themselves to a remote service.
func CurrentVersion() string { return getCurrentVersion() }
