package app

import (
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"

	"GoNavi-Wails/internal/plugin"
)

const (
	// Page assets are package-relative files referenced by a sandboxed page.
	pluginPageAssetPrefix = "/__gonavi/plugin-page-assets/"
	// The page-side UI Kit bundle, served from the host's own dist.
	pluginPageUIPrefix = "/__gonavi/plugin-page-ui/"

	pluginPageAssetMaxBytes = 32 << 20
)

var pluginPageAssetTypes = map[string]string{
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".html":  "text/html; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".webp":  "image/webp",
	".gif":   "image/gif",
	".woff2": "font/woff2",
}

// PluginPageAssetHandler serves package-relative files to a sandboxed page and
// the host-owned page UI bundle. It never serves arbitrary host paths: plugin
// files resolve through the manager's package resolver, and the UI bundle only
// comes from the host's own dist.
func PluginPageAssetHandler(a *App, assets fs.FS) http.Handler {
	pageUI, _ := fs.Sub(assets, "plugin-page")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, pluginPageUIPrefix) {
			name := strings.TrimPrefix(r.URL.Path, pluginPageUIPrefix)
			servePluginPageFile(w, pageUI, name)
			return
		}
		rest := strings.TrimPrefix(r.URL.Path, pluginPageAssetPrefix)
		pluginID, relative, ok := strings.Cut(rest, "/")
		if !ok || !pluginPageIdentity(pluginID) || relative == "" {
			http.NotFound(w, r)
			return
		}
		manager, err := a.pluginManager(r.Context())
		if err != nil {
			http.NotFound(w, r)
			return
		}
		status, found := pluginPageStatusByID(manager.List(), pluginID)
		if !found || !status.DesiredEnabled || status.State != plugin.StateRunning {
			http.NotFound(w, r)
			return
		}
		assetPath, err := manager.AssetPath(pluginID, relative)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		servePluginPagePath(w, assetPath, relative)
	})
}

func pluginPageIdentity(value string) bool {
	return value != "" && len(value) <= 128 && !strings.ContainsAny(value, "/\\\x00")
}

func pluginPageStatusByID(statuses []plugin.Status, id string) (plugin.Status, bool) {
	for _, status := range statuses {
		if status.Manifest.ID == id {
			return status, true
		}
	}
	return plugin.Status{}, false
}

func servePluginPagePath(w http.ResponseWriter, assetPath, relative string) {
	info, err := os.Stat(assetPath)
	if err != nil || info.IsDir() {
		http.NotFound(w, nil)
		return
	}
	if info.Size() > pluginPageAssetMaxBytes {
		http.Error(w, "asset too large", http.StatusRequestEntityTooLarge)
		return
	}
	data, err := os.ReadFile(assetPath)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	servePluginPageBytes(w, relative, data)
}

func servePluginPageFile(w http.ResponseWriter, root fs.FS, name string) {
	if root == nil || name == "" || strings.Contains(name, "..") {
		http.NotFound(w, nil)
		return
	}
	clean := strings.TrimPrefix(path.Clean("/"+name), "/")
	info, err := fs.Stat(root, clean)
	if err != nil || info.IsDir() || info.Size() > pluginPageAssetMaxBytes {
		http.NotFound(w, nil)
		return
	}
	data, err := fs.ReadFile(root, clean)
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	servePluginPageBytes(w, clean, data)
}

func servePluginPageBytes(w http.ResponseWriter, name string, data []byte) {
	contentType, ok := pluginPageAssetTypes[strings.ToLower(path.Ext(name))]
	if !ok {
		http.Error(w, "unsupported asset type", http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
