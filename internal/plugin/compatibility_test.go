package plugin

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Install previously accepted a package whose minHostVersion this build does not
// satisfy. The record then existed but could never run: reconcile blocked it, so
// the user got a plugin that only ever produced "blocked" and had to remove it.
// Refusing at install time makes the reason visible where the user acts.
func TestInstallRejectsPackageRequiringNewerHost(t *testing.T) {
	manifest := basicManifest("example.future")
	// managerAt uses HostVersion 1.0.0.
	manifest.MinHostVersion = "9.9.9"
	source := writePackage(t, manifest)
	manager := managerAt(t, t.TempDir())
	inspection, err := manager.Inspect(context.Background(), source)
	if err != nil {
		t.Fatalf("inspection must still describe the package: %v", err)
	}
	_, err = manager.Install(context.Background(), InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true})
	if !errors.Is(err, ErrHostTooOld) {
		t.Fatalf("install error = %v, want ErrHostTooOld", err)
	}
	if len(manager.List()) != 0 {
		t.Fatal("a refused package left a record behind")
	}
}

func TestInstallAcceptsPackageForCurrentOrOlderHost(t *testing.T) {
	for _, minimum := range []string{"", "1.0.0", "0.9.0"} {
		manifest := basicManifest("example.current")
		manifest.MinHostVersion = minimum
		source := writePackage(t, manifest)
		manager := managerAt(t, t.TempDir())
		inspection, err := manager.Inspect(context.Background(), source)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = manager.Install(context.Background(), InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true}); err != nil {
			t.Fatalf("minimum %q was rejected by a satisfying host: %v", minimum, err)
		}
	}
}

func TestDevelopmentHostInstallsAnyMinimum(t *testing.T) {
	// A dev build tracks the newest source, so it must not be locked out of a
	// package that only a released minimum would reject.
	manifest := basicManifest("example.future")
	manifest.MinHostVersion = "9.9.9"
	source := writePackage(t, manifest)
	manager, err := NewManager(Options{Root: t.TempDir(), HostVersion: "dev-abc1234", ReconcileInterval: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	inspection, err := manager.Inspect(context.Background(), source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Install(context.Background(), InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true}); err != nil {
		t.Fatalf("development host refused a newer minimum: %v", err)
	}
}
