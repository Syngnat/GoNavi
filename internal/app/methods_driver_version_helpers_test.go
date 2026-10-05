package app

import (
	"archive/zip"
	"fmt"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

func seedReleaseAssetSizeCache(t *testing.T, cacheKey string, sizeByKey map[string]int64) {
	t.Helper()

	seedReleaseAssetCacheEntry(t, cacheKey, sizeByKey, sizeByKey)
}

func seedReleaseAssetCacheEntry(t *testing.T, cacheKey string, sizeByKey map[string]int64, publishedAssets map[string]int64) {
	t.Helper()

	driverReleaseSizeMu.Lock()
	original := cloneReleaseAssetSizeCache(driverReleaseSizeMap)
	driverReleaseSizeMap[cacheKey] = driverReleaseAssetSizeCacheEntry{
		LoadedAt:        time.Now(),
		SizeByKey:       cloneInt64Map(sizeByKey),
		PublishedAssets: cloneBoolMapFromSizes(publishedAssets),
	}
	driverReleaseSizeMu.Unlock()

	t.Cleanup(func() {
		driverReleaseSizeMu.Lock()
		driverReleaseSizeMap = original
		driverReleaseSizeMu.Unlock()
	})
}

func cloneReleaseAssetSizeCache(src map[string]driverReleaseAssetSizeCacheEntry) map[string]driverReleaseAssetSizeCacheEntry {
	cloned := make(map[string]driverReleaseAssetSizeCacheEntry, len(src))
	for key, value := range src {
		cloned[key] = driverReleaseAssetSizeCacheEntry{
			LoadedAt:           value.LoadedAt,
			SizeByKey:          cloneInt64Map(value.SizeByKey),
			PublishedAssets:    cloneBoolMap(value.PublishedAssets),
			MirrorDownloadURLs: cloneDriverStringMap(value.MirrorDownloadURLs),
			Err:                value.Err,
		}
	}
	return cloned
}

func cloneDriverStringMap(src map[string]string) map[string]string {
	if len(src) == 0 {
		return map[string]string{}
	}
	cloned := make(map[string]string, len(src))
	for key, value := range src {
		cloned[key] = value
	}
	return cloned
}

func cloneBoolMap(src map[string]bool) map[string]bool {
	if len(src) == 0 {
		return map[string]bool{}
	}
	cloned := make(map[string]bool, len(src))
	for key, value := range src {
		cloned[key] = value
	}
	return cloned
}

func cloneBoolMapFromSizes(src map[string]int64) map[string]bool {
	if len(src) == 0 {
		return map[string]bool{}
	}
	cloned := make(map[string]bool, len(src))
	for key := range src {
		cloned[key] = true
	}
	return cloned
}

func cloneInt64Map(src map[string]int64) map[string]int64 {
	if len(src) == 0 {
		return map[string]int64{}
	}
	cloned := make(map[string]int64, len(src))
	for key, value := range src {
		cloned[key] = value
	}
	return cloned
}

func seedGoModuleVersionCache(t *testing.T, modulePath string, versions []string) {
	t.Helper()

	driverModuleVersionMu.Lock()
	original := make(map[string]goModuleVersionListCacheEntry, len(driverModuleVersionMap))
	for key, value := range driverModuleVersionMap {
		original[key] = goModuleVersionListCacheEntry{
			LoadedAt: value.LoadedAt,
			Versions: append([]goModuleVersionMeta(nil), value.Versions...),
			Err:      value.Err,
		}
	}
	driverModuleVersionMap[modulePath] = goModuleVersionListCacheEntry{
		LoadedAt: time.Now(),
		Versions: mapVersionsToMetas(versions),
	}
	driverModuleVersionMu.Unlock()

	t.Cleanup(func() {
		driverModuleVersionMu.Lock()
		driverModuleVersionMap = original
		driverModuleVersionMu.Unlock()
	})
}

func mapVersionsToMetas(versions []string) []goModuleVersionMeta {
	result := make([]goModuleVersionMeta, 0, len(versions))
	for _, version := range versions {
		result = append(result, goModuleVersionMeta{Version: version})
	}
	return result
}

func containsVersion(versions []string, target string) bool {
	for _, version := range versions {
		if version == target {
			return true
		}
	}
	return false
}

func chdirTemp(t *testing.T) {
	t.Helper()

	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd failed: %v", err)
	}
	tempDir := t.TempDir()
	if err := os.Chdir(tempDir); err != nil {
		t.Fatalf("chdir temp failed: %v", err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(wd); err != nil {
			t.Fatalf("restore cwd failed: %v", err)
		}
	})
}

func assertNoDriverInstallStagingDirs(t *testing.T, driverDir string) {
	t.Helper()

	entries, err := os.ReadDir(driverDir)
	if err != nil {
		t.Fatalf("read driver directory: %v", err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gonavi-driver-install-") {
			t.Fatalf("driver install staging directory was not cleaned up: %s", entry.Name())
		}
	}
}

func mongoVersionedReleaseAssetName(major int) string {
	name := fmt.Sprintf("mongodb-driver-agent-v%d-%s-%s", major, runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func writeSelfExecutable(t *testing.T, targetPath string) {
	t.Helper()

	selfPath, err := os.Executable()
	if err != nil {
		t.Fatalf("executable path failed: %v", err)
	}
	content, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatalf("read self executable failed: %v", err)
	}
	if err := os.WriteFile(targetPath, content, 0o755); err != nil {
		t.Fatalf("write executable failed: %v", err)
	}
}

func writeZipWithSelfExecutable(t *testing.T, zipPath string, entryName string) {
	t.Helper()
	writeZipWithSelfExecutableEntries(t, zipPath, []string{entryName})
}

func writeZipWithSelfExecutableEntries(t *testing.T, zipPath string, entryNames []string) {
	t.Helper()

	selfPath, err := os.Executable()
	if err != nil {
		t.Fatalf("executable path failed: %v", err)
	}
	content, err := os.ReadFile(selfPath)
	if err != nil {
		t.Fatalf("read self executable failed: %v", err)
	}

	file, err := os.Create(zipPath)
	if err != nil {
		t.Fatalf("create zip failed: %v", err)
	}
	defer file.Close()

	writer := zip.NewWriter(file)
	for _, entryName := range entryNames {
		entry, err := writer.Create(entryName)
		if err != nil {
			t.Fatalf("create zip entry failed: %v", err)
		}
		if _, err := entry.Write(content); err != nil {
			t.Fatalf("write zip entry failed: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close zip writer failed: %v", err)
	}
}

func resetOptionalDriverBundleDownloadCacheForTest(t *testing.T) {
	t.Helper()
	reset := func() {
		optionalDriverBundleDownloadMu.Lock()
		paths := make([]string, 0, len(optionalDriverBundleDownloads))
		for _, state := range optionalDriverBundleDownloads {
			if state != nil && strings.TrimSpace(state.path) != "" {
				paths = append(paths, state.path)
			}
		}
		optionalDriverBundleDownloads = make(map[string]*optionalDriverBundleDownloadState)
		optionalDriverBundleDownloadMu.Unlock()
		for _, path := range paths {
			_ = os.Remove(path)
		}
	}
	reset()
	t.Cleanup(reset)
}
