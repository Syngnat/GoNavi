package nativewindow

import (
	"io"
	"net/http"
	"strconv"
	"strings"
)

// serveUIAsset serves the host-owned plugin UI SDK from the same loopback origin
// as the plugin window. Plugin packages import it through an import map; they
// never need to bundle React or antd, and they cannot read host files: only the
// embedded ui/ subtree is reachable.
func (c *PluginController) serveUIAsset(w http.ResponseWriter, r *http.Request) {
	if !pluginMethod(w, r, http.MethodGet) {
		return
	}
	relative := strings.TrimPrefix(r.URL.Path, pluginBridgePrefix+"ui/")
	name := "ui/" + relative
	if relative == "" || !strings.HasPrefix(name, "ui/") || !validPluginAssetName(name) {
		pluginHTTPError(w, http.StatusBadRequest, "invalid_asset_path")
		return
	}
	contentType := pluginAssetType(name)
	if contentType == "" || strings.HasPrefix(contentType, "text/html") {
		pluginHTTPError(w, http.StatusForbidden, "asset_type_denied")
		return
	}
	c.mu.Lock()
	assets := c.assets
	c.mu.Unlock()
	if assets == nil {
		http.NotFound(w, r)
		return
	}
	file, err := assets.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		pluginHTTPError(w, http.StatusNotFound, "asset_unavailable")
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Security-Policy", pluginContentSecurityPolicy())
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	_, _ = io.Copy(w, file)
}
