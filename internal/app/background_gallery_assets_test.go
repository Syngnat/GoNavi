//go:build !wails3

package app

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"

	wailsassets "github.com/wailsapp/wails/v2/pkg/assetserver"
)

func TestBackgroundGalleryBypassesWailsViteSPAFallback(t *testing.T) {
	upstreamCalls := 0
	vite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls++
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html><div>Vite SPA</div>"))
	}))
	defer vite.Close()
	origin, err := url.Parse(vite.URL)
	if err != nil {
		t.Fatal(err)
	}
	a := &App{configDir: t.TempDir()}
	options := BackgroundGalleryAssetOptions(a, fstest.MapFS{"index.html": {Data: []byte("app")}})
	handler := wailsassets.NewExternalAssetsHandler(nil, *options, origin)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "/__gonavi/background-gallery/assets/"+strings.Repeat("a", 64)+".webp", nil))
		if response.Code != http.StatusNotFound || strings.Contains(response.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("gallery fell through to SPA: method=%s status=%d mime=%s", method, response.Code, response.Header().Get("Content-Type"))
		}
	}
	if upstreamCalls != 0 {
		t.Fatalf("gallery leaked %d requests to Vite", upstreamCalls)
	}
	normal := httptest.NewRecorder()
	handler.ServeHTTP(normal, httptest.NewRequest(http.MethodGet, "/src/main.tsx", nil))
	if normal.Code != http.StatusOK || upstreamCalls != 1 {
		t.Fatalf("normal frontend route interrupted: status=%d calls=%d", normal.Code, upstreamCalls)
	}
}
