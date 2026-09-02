package db

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestChromaApplyChangesContextCancelsInFlightRequest(t *testing.T) {
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
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.URL.Path == "/api/v2/tenants/default_tenant/databases/default_database/collections":
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/delete"):
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/upsert"):
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

	db := newTestChromaDB(t, server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- db.ApplyChangesContext(ctx, "products", connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": "old"}},
			Updates: []connection.UpdateRow{{
				Keys:   map[string]interface{}{"id": "existing"},
				Values: map[string]interface{}{"document": "updated"},
			}},
		})
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not reach the blocking Chroma request")
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
		t.Fatal("blocked Chroma handler did not exit after cancellation")
	}
}

func TestQdrantApplyChangesContextCancelsInFlightRequest(t *testing.T) {
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
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/delete":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 1}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/payload":
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

	db := newTestQdrantDB(t, server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- db.ApplyChangesContext(ctx, "products", connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": 9}},
			Updates: []connection.UpdateRow{{
				Keys:   map[string]interface{}{"id": 1},
				Values: map[string]interface{}{"payload.category": "updated"},
			}},
		})
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not reach the blocking Qdrant request")
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
		t.Fatal("blocked Qdrant handler did not exit after cancellation")
	}
}

func TestMilvusApplyChangesContextCancelsInFlightRequest(t *testing.T) {
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
	description := map[string]interface{}{
		"fields": []map[string]interface{}{
			{"name": "id", "type": "Int64", "primaryKey": true},
			{"name": "category", "type": "VarChar"},
		},
	}
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusCollectionsDescribePath:
			writeMilvusJSON(w, description)
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesDeletePath:
			writeMilvusJSON(w, map[string]interface{}{})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesQueryPath:
			writeMilvusJSON(w, []map[string]interface{}{{"id": 2, "category": "old"}})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesUpsertPath:
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

	db := newTestMilvusDB(t, server.URL)
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- db.ApplyChangesContext(ctx, "products", connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": 1}},
			Updates: []connection.UpdateRow{{
				Keys:   map[string]interface{}{"id": 2},
				Values: map[string]interface{}{"category": "updated"},
			}},
		})
	}()

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("ApplyChangesContext did not reach the blocking Milvus request")
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
		t.Fatal("blocked Milvus handler did not exit after cancellation")
	}
}
