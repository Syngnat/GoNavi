package plugin

import (
	"os"
	"path/filepath"
	"testing"
)

// Plugin contracts are maintained by the market website; only a short pointer
// may remain here so source checkout users can find the published docs.
func TestPluginDocsPointer(t *testing.T) {
	directory := filepath.Join("..", "..", "docs", "plugins")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !entry.IsDir() && entry.Name() == "README.md" {
			return
		}
	}
	t.Fatal("docs/plugins/README.md pointer is missing")
}
