package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDownloadPluginAssetUsesTheDirectURL(t *testing.T) {
	previousProxy := currentGlobalProxyConfig()
	if _, err := setGlobalProxyConfig(false, connection.ProxyConfig{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = setGlobalProxyConfig(previousProxy.Enabled, previousProxy.Proxy)
	})
	payload := []byte("plugin-archive")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/asset.zip" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/zip")
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "asset.zip")
	hash, err := downloadPluginAsset(context.Background(), server.URL+"/asset.zip", path)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(payload)
	if hash != hex.EncodeToString(want[:]) {
		t.Fatalf("hash = %s", hash)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != string(payload) {
		t.Fatalf("file = %q, err = %v", data, err)
	}
}
