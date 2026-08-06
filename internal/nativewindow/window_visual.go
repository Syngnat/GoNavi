package nativewindow

import (
	"strings"

	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

type detachedWindowVisualOptions struct {
	backgroundColour *options.RGBA
	windows          *windows.Options
	mac              *mac.Options
	linux            *linux.Options
}

// Detached windows render their actual surface in the WebView. Keeping the
// native surface transparent prevents a stale white Wails background from
// showing through while a custom theme is being applied or around transparent
// WebView pixels.
func resolveDetachedWindowVisualOptions(goos string) detachedWindowVisualOptions {
	if strings.EqualFold(strings.TrimSpace(goos), "windows") {
		return detachedWindowVisualOptions{
			backgroundColour: &options.RGBA{A: 0},
			windows: &windows.Options{
				WebviewIsTransparent: true,
				WindowIsTranslucent:  true,
			},
		}
	}
	if strings.EqualFold(strings.TrimSpace(goos), "darwin") {
		return detachedWindowVisualOptions{
			backgroundColour: &options.RGBA{A: 0},
			mac: &mac.Options{
				WebviewIsTransparent: true,
				WindowIsTranslucent:  true,
			},
		}
	}
	if strings.EqualFold(strings.TrimSpace(goos), "linux") {
		return detachedWindowVisualOptions{
			backgroundColour: &options.RGBA{A: 0},
			linux:            &linux.Options{WindowIsTranslucent: true},
		}
	}
	return detachedWindowVisualOptions{
		backgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255},
	}
}
