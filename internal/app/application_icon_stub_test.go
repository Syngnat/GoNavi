//go:build !darwin || !cgo

package app

import "testing"

func TestSetApplicationIconPNGIsExplicitlyUnsupportedOutsideMacOS(t *testing.T) {
	if err := setApplicationIconPNG([]byte{0x89}); err == nil {
		t.Fatal("expected unsupported-platform error")
	}
}
