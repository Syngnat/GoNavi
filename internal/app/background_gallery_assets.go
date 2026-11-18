package app

import (
	"io/fs"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/backgroundgallery"
	"GoNavi-Wails/internal/fontgallery"
)

// GalleryAssetMiddleware intercepts gallery, font and plugin-page requests
// before the asset filesystem or Vite SPA fallback can replace missing paths
// with index.html. It is framework-neutral so the v2 AssetServer and the v3
// AssetOptions.Middleware can share one implementation.
func GalleryAssetMiddleware(a *App, assets fs.FS) func(http.Handler) http.Handler {
	gallery := BackgroundGalleryAssetHandler(a)
	fonts := FontGalleryAssetHandler(a)
	pageAssets := PluginPageAssetHandler(a, assets)
	legacyLocalStorage := legacyLocalStorageHandler(a)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == legacyLocalStorageEndpoint {
				legacyLocalStorage.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(r.URL.Path, pluginPageAssetPrefix) || strings.HasPrefix(r.URL.Path, pluginPageUIPrefix) {
				pageAssets.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(r.URL.Path, backgroundgallery.AssetURLPrefix) {
				gallery.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(r.URL.Path, fontgallery.AssetURLPrefix) {
				fonts.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
