package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadPackageFileIsBoundedAndPathSafe(t *testing.T) {
	m := testManager(t)
	source := writePackage(t, basicManifest("example.icon"))
	if err := os.MkdirAll(filepath.Join(source, "icons"), 0o700); err != nil {
		t.Fatal(err)
	}
	icon := filepath.Join(source, "icons", "provider.png")
	if err := os.WriteFile(icon, []byte("12345678"), 0o600); err != nil {
		t.Fatal(err)
	}
	status := installSource(t, m, source)
	data, err := m.ReadPackageFile(status.Manifest.ID, "icons/provider.png", 64)
	if err != nil || string(data) != "12345678" {
		t.Fatalf("read packaged icon: %q %v", data, err)
	}
	if _, err = m.ReadPackageFile(status.Manifest.ID, "icons/provider.png", 4); err == nil {
		t.Fatal("oversized package file accepted")
	}
	for _, unsafe := range []string{"../asset.txt", "/icons/provider.png", "icons/../asset.txt"} {
		if _, err = m.ReadPackageFile(status.Manifest.ID, unsafe, 64); err == nil {
			t.Fatalf("unsafe package path accepted: %s", unsafe)
		}
	}
	if _, err = m.ReadPackageFile(status.Manifest.ID, "icons/missing.png", 64); err == nil {
		t.Fatal("missing package file accepted")
	}
}
