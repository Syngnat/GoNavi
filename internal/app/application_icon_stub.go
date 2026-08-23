//go:build !darwin || !cgo

package app

import "errors"

func setApplicationIconPNG(png []byte) error {
	_ = png
	return errors.New("application icon updates are only supported on macOS")
}
