//go:build unix

package singleinstance

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRuntimeDirIsStableAcrossLauncherEnvironment(t *testing.T) {
	want := runtimeDir()
	t.Setenv("XDG_RUNTIME_DIR", filepath.Join(t.TempDir(), "xdg-runtime"))
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "tmp"))
	if got := runtimeDir(); got != want {
		t.Fatalf("runtime dir changed with launcher environment: %q != %q", got, want)
	}
}

func TestFileLockReleaseKeepsStableLockFile(t *testing.T) {
	name := uniqueName(t)
	path := lockFilePath(name)
	_ = os.Remove(path)
	t.Cleanup(func() { _ = os.Remove(path) })

	first := Acquire(name)
	if !first.Acquired {
		t.Fatalf("first acquire failed: %v", first.AcquireErr)
	}
	if err := first.Handle.Close(); err != nil {
		t.Fatalf("close first handle: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stable lock file disappeared after release: %v", err)
	}

	second := Acquire(name)
	if !second.Acquired {
		t.Fatalf("re-acquire failed: %v", second.AcquireErr)
	}
	if err := second.Handle.Close(); err != nil {
		t.Fatalf("close second handle: %v", err)
	}
}
