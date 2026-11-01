package app

import (
	"context"
	"time"

	"GoNavi-Wails/internal/plugin"
)

// downloadPluginAsset fetches a third-party plugin archive directly from its
// validated GitHub/npm URL. Plugin artifacts must not be routed through the
// GoNavi update/driver dispatcher, which only understands GoNavi release assets.
// The client still inherits the global proxy or the platform/environment proxy.
func downloadPluginAsset(ctx context.Context, rawURL, filePath string) (string, error) {
	client := newStrictDownloadHTTPClientWithContext(ctx, 10*time.Minute)
	return downloadFileWithHashSequentialLimit(client, rawURL, filePath, nil, plugin.MaxPackageBytes)
}
