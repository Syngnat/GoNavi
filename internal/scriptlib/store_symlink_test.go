package scriptlib

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreRejectsSymlinkLibraryFile(t *testing.T) {
	store := newTestStore(t)
	if err := os.MkdirAll(filepath.Dir(store.path()), 0o700); err != nil {
		t.Fatalf("mkdir store: %v", err)
	}
	target := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(target, []byte(`{"version":1,"scripts":[],"folders":[]}`), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, store.path()); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := store.Snapshot(writer("alice")); err == nil ||
		!strings.Contains(strings.ToLower(err.Error()), "symbolic link") {
		t.Fatalf("symlink load error = %v", err)
	}
}
