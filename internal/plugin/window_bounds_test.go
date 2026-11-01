package plugin

import (
	"strings"
	"testing"
)

func TestWindowBounds(t *testing.T) {
	manifest := basicManifest("example.window")
	manifest.Permissions = []string{CustomPanelPermission}
	manifest.Window = &Window{Entry: "bin/plugin", Title: strings.Repeat("中", 85), Width: 8192}
	if err := ValidateManifest(manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Window.Title = strings.Repeat("中", 86)
	if ValidateManifest(manifest) == nil {
		t.Fatal("window title over 256 bytes was accepted")
	}
	manifest.Window.Title = ""
	manifest.Window.Width = 8193
	if ValidateManifest(manifest) == nil {
		t.Fatal("window width over 8192 was accepted")
	}
	manifest.Window.Width = 0
	manifest.Window.Entry = "../plugin"
	if ValidateManifest(manifest) == nil {
		t.Fatal("parent window entry was accepted")
	}
}
