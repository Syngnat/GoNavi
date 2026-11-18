package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
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
	// Source and Fingerprint let the frontend detect that the legacy profile
	// changed after an earlier import (for example after a v2 rollback). The
	// migration marker stores the fingerprint instead of a boolean so a second
	// upgrade can re-import without overwriting settings edited in v3.
	Source      string `json:"source,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// legacyLocalStorageHandler serves the v2 -> v3 localStorage migration source.
// Current v3 builds pin the window to the v2 origin, so this is a no-op on the
// normal path. It remains for builds that still use the v3 default
// wails://localhost origin (macOS/Linux) and for first-boot migration from a
// genuine v2 profile. The frontend requests the old origin's values
// synchronously before the Zustand store is evaluated. Windows kept
// http://wails.localhost/, so it needs no migration.
func legacyLocalStorageHandler(application *App) http.Handler {
	return legacyLocalStorageHandlerWithHome(application, os.UserHomeDir)
}

func legacyLocalStorageHandlerWithHome(application *App, resolveHomeDir func() (string, error)) http.Handler {
	return legacyLocalStorageHandlerWithSource(application, func() (map[string]string, string, bool) {
		homeDir, err := resolveHomeDir()
		if err != nil {
			return map[string]string{}, "", false
		}
		return findLegacyLocalStorageForPlatform(
			runtimeGOOS(),
			homeDir,
			os.Getenv("XDG_DATA_HOME"),
			legacyExecutableName(),
		)
	})
}

func legacyLocalStorageHandlerWithSource(application *App, resolveSource func() (map[string]string, string, bool)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "application/json; charset=utf-8")

		if r.Method != http.MethodGet || !legacyLocalStorageRefererAllowed(r) {
			http.NotFound(w, r)
			return
		}

		items, source, found := resolveSource()
		if !found || len(items) == 0 {
			writeLegacyLocalStorageResponse(w, legacyLocalStorageResponse{Found: false, Items: map[string]string{}})
			return
		}
		writeLegacyLocalStorageResponse(w, legacyLocalStorageResponse{
			Found:               true,
			Items:               items,
			HasSavedConnections: backendHasSavedConnections(application),
			Source:              source,
			Fingerprint:         legacyLocalStorageFingerprint(items),
		})
	})
}

func findLegacyLocalStorageForPlatform(goos, homeDir, xdgDataHome, executableName string) (map[string]string, string, bool) {
	switch strings.TrimSpace(goos) {
	case "darwin":
		return findLegacyWebKitLocalStorage(homeDir)
	case "linux":
		return findLegacyLinuxLocalStorage(homeDir, xdgDataHome, executableName)
	default:
		return map[string]string{}, "", false
	}
}

func legacyExecutableName() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(filepath.Base(executable))
	return strings.TrimSuffix(name, filepath.Ext(name))
}

// legacyLocalStorageFingerprint hashes the payload the frontend may import.
// The frontend compares it with the marker written by the previous launch, so a
// changed v2 profile is not mistaken for "already migrated".
func legacyLocalStorageFingerprint(items map[string]string) string {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	hash := sha256.New()
	for _, key := range keys {
		hash.Write([]byte(key))
		hash.Write([]byte{0})
		hash.Write([]byte(items[key]))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
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
