package ocr

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The recognition engine has two halves that must be the same release: the
// tesseract.js API bundled into the frontend, and the worker and WebAssembly core
// this package downloads (pinned by hash). A worker of one release talking to an
// engine of another may fail, or worse, quietly misbehave. So the pins here must
// follow the frontend's dependency: upgrade tesseract.js and this test says which
// pins (version, sizes, hashes in component.go) have to be refreshed with it.
func TestThePinnedFilesAreTheReleaseTheFrontendBundles(t *testing.T) {
	frontend := filepath.Join("..", "..", "frontend")

	var manifest struct {
		Dependencies map[string]string `json:"dependencies"`
	}
	readJSON(t, filepath.Join(frontend, "package.json"), &manifest)
	if got := manifest.Dependencies["tesseract.js"]; got != tesseractVersion {
		t.Errorf("frontend depends on tesseract.js %q, but the downloaded worker is %s: re-pin component.go", got, tesseractVersion)
	}

	var lock struct {
		Packages map[string]struct {
			Version string `json:"version"`
		} `json:"packages"`
	}
	readJSON(t, filepath.Join(frontend, "package-lock.json"), &lock)
	if got := lock.Packages["node_modules/tesseract.js"].Version; got != tesseractVersion {
		t.Errorf("the lockfile resolves tesseract.js %q, want %s", got, tesseractVersion)
	}
	// The core is what tesseract.js asks for, not what npm calls "latest".
	if got := lock.Packages["node_modules/tesseract.js-core"].Version; got != coreVersion {
		t.Errorf("tesseract.js resolves tesseract.js-core %q, but the downloaded core is %s: re-pin component.go", got, coreVersion)
	}
}

func readJSON(t *testing.T, path string, into any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
