package app

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	legacyLinuxStorageMaxDepth      = 6
	legacyLinuxStorageMaxCandidates = 200
)

// legacyLinuxAppDirectoryNames covers the executable name and the historical
// Wails/GoNavi data directory names. WebKitGTK names its default data directory
// after the program name, which changes between a bare `go run` binary and a
// packaged build.
var legacyLinuxAppDirectoryNames = []string{
	"GoNavi",
	"gonavi",
	"com.wails.GoNavi",
}

// findLegacyLinuxLocalStorage locates the WebKitGTK localStorage databases left
// by the Wails v2 build. Both Wails versions use WebKitGTK's default web
// context, so the files share XDG_DATA_HOME/<program name>/. Earlier v3 builds
// changed the origin (wails://wails -> wails://localhost); current v3 builds
// pin the v2 origin again, so this scanner is only a fallback. WebKitGTK's directory layout
// differs across releases (localstorage/*.localstorage in older builds,
// Default/<hash>/<hash>/LocalStorage/localstorage.sqlite3 in newer ones), so the
// scanner accepts both instead of pinning one version.
func findLegacyLinuxLocalStorage(homeDir, xdgDataHome, executableName string) (map[string]string, string, bool) {
	var bestV2, bestAny map[string]string
	var bestV2Path, bestAnyPath string
	bestV2Score, bestAnyScore := -1, -1
	seenRoots := make(map[string]struct{})
	candidates := 0

	for _, root := range legacyLinuxStorageRoots(homeDir, xdgDataHome, executableName) {
		root = filepath.Clean(strings.TrimSpace(root))
		if root == "" || root == "." {
			continue
		}
		if _, exists := seenRoots[root]; exists {
			continue
		}
		seenRoots[root] = struct{}{}

		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue
		}

		_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil
			}
			if entry.IsDir() {
				if path != root && legacyLinuxStorageDepth(root, path) >= legacyLinuxStorageMaxDepth {
					return filepath.SkipDir
				}
				if isLegacyLinuxStorageCacheDir(entry.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if candidates >= legacyLinuxStorageMaxCandidates {
				return filepath.SkipAll
			}
			if !isLegacyLinuxStorageDatabase(entry.Name()) {
				return nil
			}
			candidates++

			items, err := readLegacyWebKitLocalStorage(path)
			if err != nil {
				return nil
			}
			score := legacyLocalStorageScore(items)
			if score > bestAnyScore {
				bestAny, bestAnyPath, bestAnyScore = items, path, score
			}
			if legacyLocalStorageIsV2Origin(path) && score > bestV2Score {
				bestV2, bestV2Path, bestV2Score = items, path, score
			}
			return nil
		})
	}

	if bestV2Score >= 0 {
		return bestV2, bestV2Path, true
	}
	if bestAnyScore >= 0 {
		return bestAny, bestAnyPath, true
	}
	return map[string]string{}, "", false
}

func legacyLinuxStorageRoots(homeDir, xdgDataHome, executableName string) []string {
	dataHome := strings.TrimSpace(xdgDataHome)
	if dataHome == "" {
		dataHome = strings.TrimSpace(os.Getenv("XDG_DATA_HOME"))
	}
	if dataHome == "" && strings.TrimSpace(homeDir) != "" {
		dataHome = filepath.Join(homeDir, ".local", "share")
	}
	if dataHome == "" {
		return nil
	}

	names := make([]string, 0, len(legacyLinuxAppDirectoryNames)+2)
	if name := strings.TrimSpace(executableName); name != "" {
		names = append(names, name, strings.ToLower(name))
	}
	names = append(names, legacyLinuxAppDirectoryNames...)

	roots := make([]string, 0, len(names)+2)
	for _, name := range names {
		if name = strings.TrimSpace(name); name != "" {
			roots = append(roots, filepath.Join(dataHome, name))
		}
	}
	// Wails has historically stored WebKit data under a shared wails directory
	// as well as wails/<executable>; cover both without scanning unrelated apps.
	roots = append(roots, filepath.Join(dataHome, "wails"))
	if name := strings.TrimSpace(executableName); name != "" {
		roots = append(roots, filepath.Join(dataHome, "wails", name))
	}
	return roots
}

func legacyLinuxStorageDepth(root, path string) int {
	relative, err := filepath.Rel(root, path)
	if err != nil {
		return legacyLinuxStorageMaxDepth
	}
	return strings.Count(relative, string(os.PathSeparator))
}

func isLegacyLinuxStorageDatabase(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	return lower == "localstorage.sqlite3" || strings.HasSuffix(lower, ".localstorage")
}

func isLegacyLinuxStorageCacheDir(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "cache", "caches", "code cache", "gpucache", "network", "service worker",
		"serviceworkers", "indexeddb", "indexeddbblob", "databases", "session storage",
		"sessions", "blob_storage", "media cache", "webkitcache":
		return true
	default:
		return false
	}
}
