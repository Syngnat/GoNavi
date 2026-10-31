package plugin

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const pngSignature = "\x89PNG\r\n\x1a\n"

func TestManifestIconMustBePackagedRasterFile(t *testing.T) {
	m := aiProviderManifest()
	m.Icon = "icons/logo.png"
	dir := t.TempDir()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, manifestName), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "plugin"), []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(dir, "icons"), 0o700); err != nil {
		t.Fatal(err)
	}
	logo := filepath.Join(dir, "icons", "logo.png")
	if err = os.WriteFile(logo, []byte(pngSignature), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = InspectPackage(context.Background(), dir); err != nil {
		t.Fatalf("packaged plugin icon rejected: %v", err)
	}
	if err = os.WriteFile(logo, make([]byte, maxPackageIconBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err = InspectPackage(context.Background(), dir); err == nil {
		t.Fatal("oversized declared plugin icon accepted")
	}
	if err = os.WriteFile(logo, []byte(pngSignature), 0o600); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(logo); err != nil {
		t.Fatal(err)
	}
	if _, err = InspectPackage(context.Background(), dir); err == nil {
		t.Fatal("missing declared plugin icon accepted")
	}
}

func TestManifestIconRejectsUnsafePaths(t *testing.T) {
	for name, icon := range map[string]string{
		"svg":       "icons/logo.svg",
		"absolute":  "/icons/logo.png",
		"traversal": "../logo.png",
		"backslash": "icons\\logo.png",
		"too long":  strings.Repeat("a", 253) + ".png",
	} {
		t.Run(name, func(t *testing.T) {
			m := aiProviderManifest()
			m.Icon = icon
			if err := ValidateManifest(m); err == nil {
				t.Fatalf("unsafe plugin icon accepted: %q", icon)
			}
		})
	}
}

func TestIconPathFallsBackToProviderIcon(t *testing.T) {
	m := aiProviderManifest()
	if got := m.IconPath(); got != "" {
		t.Fatalf("manifest without any icon should have no logo, got %q", got)
	}
	m.Contributes.AIProviders[0].Icon = "icons/provider.png"
	if got := m.IconPath(); got != "icons/provider.png" {
		t.Fatalf("provider icon fallback lost, got %q", got)
	}
	m.Icon = "icons/logo.png"
	if got := m.IconPath(); got != "icons/logo.png" {
		t.Fatalf("manifest icon must win, got %q", got)
	}
}

func TestRasterIconDataURLSniffsContent(t *testing.T) {
	if got := RasterIconDataURL([]byte(pngSignature + "payload")); !strings.HasPrefix(got, "data:image/png;base64,") {
		t.Fatalf("png signature not recognised: %q", got)
	}
	for name, data := range map[string][]byte{
		"empty": nil,
		"text":  []byte("plain text, not an image"),
		"svg":   []byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`),
	} {
		if got := RasterIconDataURL(data); got != "" {
			t.Fatalf("%s content accepted as raster: %q", name, got)
		}
	}
}
