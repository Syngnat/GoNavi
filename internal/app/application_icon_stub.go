//go:build !windows && (!darwin || !cgo)

package app

import (
	"context"
	"errors"
)

func setApplicationIconPNG(png []byte, _ string, _ context.Context) error {
	_ = png
	return errors.New("application icon updates are only supported on macOS and Windows")
}
