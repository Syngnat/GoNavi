package app

import (
	"testing"
)

func TestResolveRecentDriverVersionMetasIncludesHistoricalTDengineVersionsFromCache(t *testing.T) {
	seedGoModuleVersionCache(t, "github.com/taosdata/driver-go/v3", []string{
		"3.8.0",
		"3.7.8",
		"3.7.7",
		"3.7.6",
		"3.7.5",
		"3.7.4",
		"3.7.3",
		"3.7.2",
		"3.7.1",
		"3.7.0",
		"3.6.0",
		"3.5.8",
		"3.5.7",
		"3.5.6",
		"3.5.5",
		"3.5.4",
		"3.5.3",
		"3.5.2",
		"3.5.1",
		"3.5.0",
		"3.3.1",
		"3.1.0",
		"3.0.4",
		"3.0.3",
		"3.0.2",
		"3.0.1",
		"3.0.0",
	})

	metas := resolveRecentDriverVersionMetas("tdengine", driverRecentVersionLimit)
	versions := make([]string, 0, len(metas))
	for _, meta := range metas {
		versions = append(versions, meta.Version)
	}

	if !containsVersion(versions, "3.5.8") {
		t.Fatalf("expected tdengine historical version 3.5.8 to remain selectable, got %v", versions)
	}
	if !containsVersion(versions, "3.3.1") {
		t.Fatalf("expected tdengine historical version 3.3.1 to remain selectable, got %v", versions)
	}
}

func TestResolveRecentDriverVersionMetasFallsBackToHistoricalTDengineMatrix(t *testing.T) {
	driverModuleVersionMu.Lock()
	original := driverModuleVersionMap
	driverModuleVersionMap = map[string]goModuleVersionListCacheEntry{}
	driverModuleVersionMu.Unlock()
	t.Cleanup(func() {
		driverModuleVersionMu.Lock()
		driverModuleVersionMap = original
		driverModuleVersionMu.Unlock()
	})

	metas := resolveRecentDriverVersionMetas("tdengine", driverRecentVersionLimit)
	versions := make([]string, 0, len(metas))
	for _, meta := range metas {
		versions = append(versions, meta.Version)
	}

	if !containsVersion(versions, "3.5.8") {
		t.Fatalf("expected tdengine fallback list to include 3.5.8, got %v", versions)
	}
	if !containsVersion(versions, "3.3.1") {
		t.Fatalf("expected tdengine fallback list to include 3.3.1, got %v", versions)
	}
}
