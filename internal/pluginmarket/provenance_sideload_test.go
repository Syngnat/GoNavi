package pluginmarket

import (
	"testing"
)

// A plugin installed outside the marketplace carries no provenance record. That is not a
// hijack signal: there is no earlier source binding to protect, and the replacement still
// passes a fresh inspection plus the user's explicit trust. Such packages must be able to
// update online, otherwise every locally installed plugin is stuck forever.
func TestSideloadedPackageIsUpdatableFromMarket(t *testing.T) {
	server, digest, _ := artifactServer(t, fixtureArchive(t, "zip"), nil, nil)
	defer server.Close()
	service := newTestService(t, server.URL, false)
	canonical := archiveDigest([]byte("locally installed content"))

	if err := service.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatalf("sideloaded package must be updatable: %v", err)
	}
	// The update itself must still be the marketplace artifact, not local bytes.
	// The fixture archive declares version 1.0.0 and id publisher.plugin.
	path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
	if err != nil {
		t.Fatalf("market download for a sideloaded package: %v", err)
	}
	defer cleanup()
	if err = service.RecordInstall(t.Context(), "publisher.plugin", path, canonical); err != nil {
		t.Fatalf("record provenance after the market update: %v", err)
	}
	// From now on the package is bound to this source, and the binding is enforced.
	if err = service.VerifyInstallSource(t.Context(), "publisher.plugin", canonical); err != nil {
		t.Fatalf("recorded binding must verify: %v", err)
	}
	if err = service.VerifyInstallSource(t.Context(), "publisher.plugin", digest); err == nil {
		t.Fatal("a changed canonical digest must still be refused")
	}
}

// A package already bound to another source keeps being refused: the relaxation is limited to
// the "no record at all" case.
func TestBoundPackageStillRejectsForeignSource(t *testing.T) {
	server, _, _ := artifactServer(t, fixtureArchive(t, "zip"), nil, nil)
	defer server.Close()
	service := newTestService(t, server.URL, false)
	canonical := archiveDigest([]byte("bound content"))
	service.state.Installs["publisher.bound"] = installedSource{
		SourceID:      sourceID("https://other.example"),
		Version:       "1.0.0",
		ContentDigest: canonical,
	}
	assertErrorIs(t, service.VerifyInstallSource(t.Context(), "publisher.bound", canonical), ErrSourceMismatch)
}
