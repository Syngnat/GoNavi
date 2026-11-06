package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func pageAssetTestHandler(t *testing.T) http.Handler {
	t.Helper()
	a := newPluginTestApp(t)
	assets := fstest.MapFS{
		"plugin-page/ui/page-ui.js": &fstest.MapFile{Data: []byte("window.GoNaviUI = {};")},
		"plugin-page/ui/style.css":  &fstest.MapFile{Data: []byte("body{}")},
	}
	return PluginPageAssetHandler(a, assets)
}

func TestPluginPageUIServesTheBundle(t *testing.T) {
	handler := pageAssetTestHandler(t)
	for _, path := range []string{"/__gonavi/plugin-page-ui/ui/page-ui.js", "/__gonavi/plugin-page-ui/ui/style.css"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d", path, response.Code)
		}
		if response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("%s: missing no-store", path)
		}
	}
}

func TestPluginPageAssetsRejectUnknownPaths(t *testing.T) {
	handler := pageAssetTestHandler(t)
	cases := []struct {
		method string
		path   string
		status int
	}{
		{http.MethodPost, "/__gonavi/plugin-page-ui/ui/page-ui.js", http.StatusMethodNotAllowed},
		{http.MethodGet, "/__gonavi/plugin-page-ui/../secret.js", http.StatusNotFound},
		{http.MethodGet, "/__gonavi/plugin-page-ui/ui/missing.js", http.StatusNotFound},
		{http.MethodGet, "/__gonavi/plugin-page-assets/unknown/plugin.js", http.StatusNotFound},
		{http.MethodGet, "/__gonavi/plugin-page-assets/../plugin.js", http.StatusNotFound},
	}
	for _, test := range cases {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
		if response.Code != test.status {
			t.Fatalf("%s %s: got %d want %d", test.method, test.path, response.Code, test.status)
		}
	}
}
