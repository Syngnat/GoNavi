//go:build wails3

package main

import (
	"os"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// resolveV3WindowChrome mirrors the v2 main-window chrome:
//   - Windows/Linux draw their own title bar (frameless) on an opaque surface.
//   - macOS keeps the native frame but hides the title bar and extends content
//     under it, with a translucent backdrop.
//
// A low-memory run keeps the opaque surface everywhere.
func resolveV3WindowChrome(goos string) (frameless bool, backgroundType application.BackgroundType, background application.RGBA, mac application.MacWindow) {
	lowMemory := isLowMemoryMode()
	if strings.EqualFold(strings.TrimSpace(goos), "darwin") {
		// Hidden title bar with full-size content, keeping the standard traffic
		// lights (the app computes their inset in the frontend).
		mac.TitleBar = application.MacTitleBarHidden
		if lowMemory {
			return false, application.BackgroundTypeSolid, application.NewRGBA(255, 255, 255, 255), mac
		}
		mac.Backdrop = application.MacBackdropTranslucent
		return false, application.BackgroundTypeTransparent, application.NewRGBA(0, 0, 0, 0), mac
	}
	return true, application.BackgroundTypeSolid, application.NewRGBA(255, 255, 255, 255), mac
}

// resolveV3StartURL pins every v3 window to the origin GoNavi v2 used:
// wails://wails/ on macOS/Linux and http://wails.localhost/ on Windows.
// Wails v3 defaults to wails://localhost and appends the Vite port in dev,
// which creates a different WebKit localStorage for v3 latest and for every
// dev run. The v2 origin is still served by the v3 asset server, and the
// runtime derives its API URL from window.location.origin, so this keeps v2
// latest, v3 latest and v3 dev on one settings store. The Vite port remains in
// FRONTEND_DEVSERVER_URL and is only used for asset proxying and HMR.
func resolveV3StartURL(goos string) string {
	switch strings.ToLower(strings.TrimSpace(goos)) {
	case "windows":
		return "http://wails.localhost/"
	case "darwin", "linux":
		return "wails://wails/"
	default:
		return "/"
	}
}

func isLowMemoryMode() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("GONAVI_LOW_MEMORY_MODE"))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
