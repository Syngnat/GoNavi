package app

import (
	"strings"
	"testing"
)

func TestGetDriverStatusListDefersReleaseMetadataWarmup(t *testing.T) {
	source := methodsDriverSource(t)
	statusStart := strings.Index(source, "func (a *App) GetDriverStatusList")
	statusEnd := strings.Index(source, "func (a *App) CheckDriverNetworkStatus")
	if statusStart < 0 || statusEnd <= statusStart {
		t.Fatal("GetDriverStatusList function boundary not found")
	}
	statusBody := source[statusStart:statusEnd]
	if !strings.Contains(statusBody, "packageSizeBytesMap := readCachedOptionalDriverPackageSizes(definitions)") {
		t.Fatal("GetDriverStatusList must only read cached package sizes on the synchronous status path")
	}
	if strings.Contains(statusBody, "packageSizeBytesMap := preloadOptionalDriverPackageSizes(definitions)") {
		t.Fatal("GetDriverStatusList must not synchronously preload release metadata")
	}

	cacheBody := methodsDriverFunctionSource(t, source, "func readCachedOptionalDriverPackageSizes")
	for _, forbidden := range []string{
		"loadReleaseAssetSizesCached(",
		"fetchReleaseByTag(",
		"fetchLatestReleaseForDriverAssets(",
	} {
		if strings.Contains(cacheBody, forbidden) {
			t.Fatalf("cache-only package-size helper must not call %s", forbidden)
		}
	}

	warmupStart := strings.Index(source, "func triggerDriverVersionMetadataWarmup")
	warmupEnd := strings.Index(source, "func resolveDriverGoModulePaths")
	if warmupStart < 0 || warmupEnd <= warmupStart {
		t.Fatal("triggerDriverVersionMetadataWarmup function boundary not found")
	}
	warmupBody := source[warmupStart:warmupEnd]
	preloadIndex := strings.Index(warmupBody, "_ = preloadOptionalDriverPackageSizes(warmupDefinitions)")
	if preloadIndex < 0 {
		t.Fatal("background warmup must continue populating package-size metadata")
	}
	goRoutineIndex := strings.Index(warmupBody, "go func(")
	if goRoutineIndex < 0 || preloadIndex <= goRoutineIndex {
		t.Fatal("package-size preload must remain inside the background warmup goroutine")
	}
}
