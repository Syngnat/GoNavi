package pluginmarket

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDownloadSourceIDDetectsSourceSwitchBackAroundDownload(t *testing.T) {
	payload := fixtureArchive(t, "zip")
	sourceA, digestA, _ := artifactServer(t, payload, nil, nil)
	defer sourceA.Close()
	sourceB, digestB, _ := artifactServer(t, payload, nil, nil)
	defer sourceB.Close()
	if digestA != digestB {
		t.Fatal("fixture must serve identical archive bytes from both sources")
	}
	service := newTestService(t, sourceA.URL, false)
	before, err := service.Settings()
	if err != nil {
		t.Fatal(err)
	}

	// Configuration changes after a host pre-check, but before Download captures its source.
	if _, err = service.Configure(t.Context(), sourceB.URL); err != nil {
		t.Fatal(err)
	}
	path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digestA)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()

	// Configuration returns to A after Download, before the host's commit-time settings check.
	if _, err = service.Configure(t.Context(), sourceA.URL); err != nil {
		t.Fatal(err)
	}
	after, err := service.Settings()
	if err != nil {
		t.Fatal(err)
	}
	if before.SourceID != after.SourceID {
		t.Fatal("fixture did not reproduce the A-B-A settings snapshot")
	}
	actual, err := service.DownloadSourceID(path)
	if err != nil {
		t.Fatal(err)
	}
	if actual != sourceID(sourceB.URL) || actual == before.SourceID {
		t.Fatalf("receipt source = %q, expected B rather than selected A", actual)
	}
}

func TestDownloadSourceIDAcceptsOnlyLiveReceiptsFromSameService(t *testing.T) {
	payload := fixtureArchive(t, "zip")
	server, digest, _ := artifactServer(t, payload, nil, nil)
	defer server.Close()
	service := newTestService(t, server.URL, false)
	path, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	actual, err := service.DownloadSourceID(path)
	if err != nil || actual != sourceID(server.URL) {
		t.Fatalf("receipt lookup = %q, %v", actual, err)
	}

	copiedPath := filepath.Join(t.TempDir(), "identical.zip")
	if err = os.WriteFile(copiedPath, payload, 0600); err != nil {
		t.Fatal(err)
	}
	for _, candidate := range []string{"", "not-issued", copiedPath} {
		t.Run(candidate, func(t *testing.T) {
			source, err := service.DownloadSourceID(candidate)
			assertErrorIs(t, err, ErrInvalidRequest)
			if source != "" {
				t.Fatal("unissued path leaked a source identity")
			}
		})
	}
	restarted, err := NewService(Options{Root: service.root})
	if err != nil {
		t.Fatal(err)
	}
	_, err = restarted.DownloadSourceID(path)
	assertErrorIs(t, err, ErrInvalidRequest)

	cleanup()
	_, err = service.DownloadSourceID(path)
	assertErrorIs(t, err, ErrInvalidRequest)
	// Recreating identical bytes at the old path cannot recreate its consumed receipt.
	if err = os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	_, err = service.DownloadSourceID(path)
	assertErrorIs(t, err, ErrInvalidRequest)
}
