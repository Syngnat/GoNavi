package app

import (
	"io/fs"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/backgroundgallery"
	"GoNavi-Wails/internal/fontgallery"

	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// GalleryAssetMiddleware intercepts gallery, font and plugin-page requests
// before the asset filesystem or Vite SPA fallback can replace missing paths
// with index.html. It is framework-neutral so the v2 AssetServer and the v3
// AssetOptions.Middleware can share one implementation.
func GalleryAssetMiddleware(a *App, assets fs.FS) func(http.Handler) http.Handler {
	gallery := BackgroundGalleryAssetHandler(a)
	fonts := FontGalleryAssetHandler(a)
	pageAssets := PluginPageAssetHandler(a, assets)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

// BackgroundGalleryAssetOptions wires the shared middleware into the v2
// AssetServer.
func BackgroundGalleryAssetOptions(a *App, assets fs.FS) *assetserver.Options {
	return &assetserver.Options{
		Assets:     assets,
		Middleware: GalleryAssetMiddleware(a, assets),
	}
}
