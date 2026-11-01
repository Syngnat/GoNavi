package plugin

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestInstallRepairsCorruptStoreEntry covers the repair path for a published store entry that
// was damaged after installation (antivirus quarantine, power loss). Reinstalling the same
// digest must succeed, keep the damaged copy for post-mortem, and leave a verifiable package.
func TestInstallRepairsCorruptStoreEntry(t *testing.T) {
	m := testManager(t)
	source := writePackage(t, basicManifest("example.repair"))
	inspection, err := m.Inspect(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	status, err := m.Install(context.Background(), InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(m.root, "store", status.Digest)
	if err = os.RemoveAll(target); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(target, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(target, "damaged.bin"), []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}

	repaired, err := m.Install(context.Background(), InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatalf("reinstall over a corrupt store entry: %v", err)
	}
	if repaired.Digest != inspection.Digest {
		t.Fatalf("digest = %s, want %s", repaired.Digest, inspection.Digest)
	}
	verified, err := m.Inspect(context.Background(), target)
	if err != nil || verified.Digest != inspection.Digest {
		t.Fatalf("store entry was not repaired: %v", err)
	}
	preserved, err := filepath.Glob(target + ".corrupt-*")
	if err != nil || len(preserved) != 1 {
		t.Fatalf("damaged copy was not preserved: %v %v", preserved, err)
	}
}
