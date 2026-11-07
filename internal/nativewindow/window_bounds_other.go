//go:build !darwin || !cgo

package nativewindow

import (
	"context"

	wailsRuntime "GoNavi-Wails/internal/desktop"
)

func applyDetachedWindowBounds(ctx context.Context, x, y, width, height int) {
	wailsRuntime.WindowSetSize(ctx, width, height)
	wailsRuntime.WindowSetPosition(ctx, x, y)
}

func activeDetachedDisplayBounds() []WindowBounds {
	return nil
}
