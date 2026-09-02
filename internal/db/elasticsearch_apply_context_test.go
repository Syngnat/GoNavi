//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestElasticsearchApplyChangesContextCancelsInFlightBulk(t *testing.T) {
	requestStarted := make(chan struct{})
	requestFinished := make(chan struct{})
	requestRelease := make(chan struct{})
	releaseRequest := func() {
		select {
		case <-requestRelease:
		default:
			close(requestRelease)
		}
	}
	t.Cleanup(releaseRequest)
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			close(requestStarted)
			select {
			case <-r.Context().Done():
			case <-requestRelease:
			}
			close(requestFinished)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestESDB(t, server.URL, "test-index")
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- db.ApplyChangesContext(ctx, "test-index", connection.ChangeSet{
			Inserts: []map[string]interface{}{{"message": "hello"}},
		})
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not reach the blocking Elasticsearch bulk request")
	}
	cancel()

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("ApplyChangesContext error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
	releaseRequest()
	select {
	case <-requestFinished:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked Elasticsearch handler did not exit after cancellation")
	}
}
