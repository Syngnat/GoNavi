//go:build !wails3

package app

import (
	"io/fs"

	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

// BackgroundGalleryAssetOptions wires the shared middleware into the v2
// AssetServer.
func BackgroundGalleryAssetOptions(a *App, assets fs.FS) *assetserver.Options {
	return &assetserver.Options{
		Assets:     assets,
		Middleware: GalleryAssetMiddleware(a, assets),
	}
}
