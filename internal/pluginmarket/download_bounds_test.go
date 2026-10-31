package pluginmarket

import (
	"net/http"
	"testing"
)

func TestConcurrentDownloadsAreBoundedBeforeNetworkIO(t *testing.T) {
	payload := fixtureArchive(t, "zip")
	// Four notifications match the four permitted active downloads, allowing every handler to report readiness.
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	server, digest, hits := artifactServer(t, payload, nil, func(w http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-release
		if _, err := w.Write(payload); err != nil {
			t.Error(err)
		}
	})
	defer server.Close()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	service := newTestService(t, server.URL, false)
	// Each worker sends one completion; none may block cleanup if another assertion fails.
	done := make(chan error, 4)
	for i := 0; i < 4; i++ {
		go func() {
			_, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
			cleanup()
			done <- err
		}()
	}
	for i := 0; i < 4; i++ {
		<-entered
	}
	_, cleanup, err := service.Download(t.Context(), "publisher.plugin", "1.0.0", digest)
	cleanup()
	assertErrorIs(t, err, ErrBusy)
	if hits.Load() != 4 {
		t.Fatalf("overflow sent network request: %d", hits.Load())
	}
	close(release)
	for i := 0; i < 4; i++ {
		if err = <-done; err != nil {
			t.Error(err)
		}
	}
}
