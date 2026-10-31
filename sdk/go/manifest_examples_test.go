package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseManifestAcceptsShippedExamples(t *testing.T) {
	root := filepath.Join("..", "..", "examples", "plugins")
	var count int
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || entry.Name() != "gonavi.plugin.json" {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		manifest, err := ParseManifest(raw)
		if err != nil || manifest.ID == "" {
			t.Fatalf("%s: %v", entry.Name(), err)
		}
		count++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count != 11 {
		t.Fatalf("parsed %d manifests, want 11", count)
	}
}
