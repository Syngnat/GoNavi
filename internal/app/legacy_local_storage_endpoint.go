package app

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const legacyLocalStorageEndpoint = "/__gonavi/legacy-local-storage"

type legacyLocalStorageResponse struct {
	Found bool              `json:"found"`
	Items map[string]string `json:"items"`
	// HasSavedConnections tells the frontend whether the v3 profile already
	// owns saved connections. In that case the legacy localStorage payload must
	// not resurrect connections that were deleted after the upgrade.
	HasSavedConnections bool `json:"hasSavedConnections"`
}

// legacyLocalStorageHandler serves the one-time macOS v2 -> v3 localStorage
// migration source. Wails v2 used wails://wails/ while v3 uses
// wails://localhost/, so WebKit gives the two versions different localStorage
// origins. The frontend requests the old origin's values synchronously before
// the Zustand store is evaluated.
func legacyLocalStorageHandler(application *App) http.Handler {
	return legacyLocalStorageHandlerWithHome(application, os.UserHomeDir)
}

func legacyLocalStorageHandlerWithHome(application *App, resolveHomeDir func() (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodGet || !legacyLocalStorageRefererAllowed(r) {
			http.NotFound(w, r)
			return
		}
		if runtimeGOOS() != "darwin" {
			writeLegacyLocalStorageResponse(w, legacyLocalStorageResponse{Found: false, Items: map[string]string{}})
			return
		}

		homeDir, err := resolveHomeDir()
		if err != nil {
			writeLegacyLocalStorageResponse(w, legacyLocalStorageResponse{Found: false, Items: map[string]string{}})
			return
		}
		items, _, found := findLegacyWebKitLocalStorage(homeDir)
		if !found {
			writeLegacyLocalStorageResponse(w, legacyLocalStorageResponse{Found: false, Items: map[string]string{}})
			return
		}
		writeLegacyLocalStorageResponse(w, legacyLocalStorageResponse{
			Found:               true,
			Items:               items,
			HasSavedConnections: backendHasSavedConnections(application),
		})
	})
}

func backendHasSavedConnections(application *App) bool {
	if application == nil {
		return false
	}
	items, err := application.savedConnectionRepository().List()
	return err == nil && len(items) > 0
}

func writeLegacyLocalStorageResponse(w http.ResponseWriter, response legacyLocalStorageResponse) {
	_ = json.NewEncoder(w).Encode(response)
}

func legacyLocalStorageRefererAllowed(r *http.Request) bool {
	if strings.EqualFold(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")), "cross-site") {
		return false
	}
	if dest := strings.TrimSpace(r.Header.Get("Sec-Fetch-Dest")); dest != "" && dest != "empty" {
		return false
	}
	raw := strings.TrimSpace(r.Header.Get("Referer"))
	// WKWebView may omit Referer for a custom-scheme XHR; the other fetch
	// metadata checks above still keep plugin-page documents out.
	if raw == "" {
		return true
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme != "wails" && parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	switch parsed.Path {
	case "", "/", "/index.html":
		return true
	default:
		return false
	}
}
