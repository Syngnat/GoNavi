//go:build windows && wails3

package app

import "context"

// v3.1.0 does not expose the WebView2 focus controller, so the v2 reflection
// guard cannot be applied. Returning a no-op restore keeps the native file
// dialog path working without a spurious warning.
func suspendWailsWebViewFocus(context.Context) (func() error, error) {
	return func() error { return nil }, nil
}
