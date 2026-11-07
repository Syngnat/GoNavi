//go:build windows && wails3

package app

import (
	"context"
	"errors"
)

// v3 replaces both reflection patches with the desktop facade (SetZoom /
// SetBounds); these stubs keep the shared fallback call sites compiling and
// make an accidental v2 path fail loudly.
func resetWebViewZoomFactor(context.Context, float64) error {
	return errors.New("v3 uses desktop.ResetWebViewZoom")
}

func refreshWebViewBounds(context.Context) error {
	return errors.New("v3 uses desktop.RefreshWebViewBounds")
}
