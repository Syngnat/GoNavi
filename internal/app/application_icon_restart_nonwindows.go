//go:build !windows

package app

import (
	"context"
	"errors"
)

func prepareWindowsBrandIconRestartPNG(_ []byte, _ string) error {
	return errors.New("Windows brand icon restart is only supported on Windows")
}

func applyPersistedWindowsApplicationIcon(_ context.Context, _ string) error {
	return nil
}

