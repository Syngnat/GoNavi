//go:build windows

package plugin

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// TestReplaceStateFileOutlastsATransientExclusiveHandle pins the retry budget to a hold that is
// longer than the old 250ms window: scanners on a loaded CI runner held state.json past it, the
// replace gave up, and the plugin was faulted with "persist plugin state: Access is denied.".
func TestReplaceStateFileOutlastsATransientExclusiveHandle(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "state.json")
	if err := os.WriteFile(destination, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, ".state-next")
	if err := os.WriteFile(source, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}

	name, err := windows.UTF16PtrFromString(destination)
	if err != nil {
		t.Fatal(err)
	}
	// No FILE_SHARE_DELETE: this is the shape of an antivirus/indexer handle that denies the
	// replacement until it closes.
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(400 * time.Millisecond)
		windows.CloseHandle(handle)
		close(released)
	}()

	if err := replaceStateFile(source, destination); err != nil {
		t.Fatalf("replace while the destination is held for 400ms: %v", err)
	}
	<-released

	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new" {
		t.Fatalf("destination content = %q, want %q", content, "new")
	}
}
