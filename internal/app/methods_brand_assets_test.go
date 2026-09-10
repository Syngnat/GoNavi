package app

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGetBrandIconDataURLDownloadsAndCachesVerifiedAsset(t *testing.T) {
	asset := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><text>01</text></svg>`)
	digest := sha256.Sum256(asset)
	definition := brandAssetDefinitions["01"]
	definition.SHA256 = hex.EncodeToString(digest[:])
	brandAssetDefinitions["01"] = definition
	t.Cleanup(func() {
		definition.SHA256 = "3cab076e113e1722ae6f1dce9f295f3a1d404e4cfb11e76944452e149fcc7b04"
		brandAssetDefinitions["01"] = definition
	})

	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests.Add(1)
		if request.URL.Path != "/01-ribbon-graphite-air.svg" {
			t.Fatalf("path = %s", request.URL.Path)
		}
		writer.Write(asset)
	}))
	defer server.Close()
	oldBaseURL := brandAssetRemoteBaseURLForTests
	brandAssetRemoteBaseURLForTests = server.URL
	t.Cleanup(func() { brandAssetRemoteBaseURLForTests = oldBaseURL })

	app := &App{configDir: t.TempDir()}
	dataURL, err := app.GetBrandIconDataURL("01")
	if err != nil {
		t.Fatalf("download asset: %v", err)
	}
	if !strings.HasPrefix(dataURL, "data:image/svg+xml;base64,") {
		t.Fatalf("unexpected data URL: %s", dataURL)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests after first load = %d, want 1", requests.Load())
	}
	cachePath := filepath.Join(app.configDir, brandAssetCacheDirName, "v1", definition.FileName)
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("cache file: %v", err)
	}
	if _, err := app.GetBrandIconDataURL("01"); err != nil {
		t.Fatalf("read cached asset: %v", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("requests after cache hit = %d, want 1", requests.Load())
	}
}

func TestGetBrandIconDataURLRejectsUnknownAndTamperedCache(t *testing.T) {
	app := &App{configDir: t.TempDir()}
	if _, err := app.GetBrandIconDataURL("unknown"); err != errBrandAssetUnknownID {
		t.Fatalf("unknown id error = %v", err)
	}
	definition := brandAssetDefinitions["02"]
	cacheDir := filepath.Join(app.configDir, brandAssetCacheDirName, "v1")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(cacheDir, definition.FileName)
	if err := os.WriteFile(cachePath, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldBaseURL := brandAssetRemoteBaseURLForTests
	brandAssetRemoteBaseURLForTests = "http://127.0.0.1:1"
	t.Cleanup(func() { brandAssetRemoteBaseURLForTests = oldBaseURL })
	if _, err := app.GetBrandIconDataURL("02"); err == nil || !strings.Contains(err.Error(), "download brand asset") {
		t.Fatalf("tampered cache error = %v", err)
	}
}
