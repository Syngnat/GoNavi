package db

import (
	"net/http"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestChromaApplyChangesClassifiesPartialWrites(t *testing.T) {
	tests := []struct {
		name        string
		failDelete  bool
		wantUnknown bool
	}{
		{name: "first write fails", failDelete: true},
		{name: "update fails after delete", wantUnknown: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.URL.Path == "/api/v2/heartbeat":
					writeChromaJSON(w, map[string]interface{}{"ok": true})
				case r.URL.Path == "/api/v2/tenants/default_tenant/databases/default_database/collections":
					writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/delete"):
					if test.failDelete {
						http.Error(w, "forced delete failure", http.StatusInternalServerError)
						return
					}
					writeChromaJSON(w, map[string]interface{}{"ok": true})
				case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/upsert"):
					http.Error(w, "forced update failure", http.StatusInternalServerError)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})

			db := newTestChromaDB(t, server.URL)
			err := db.ApplyChanges("products", connection.ChangeSet{
				Deletes: []map[string]interface{}{{"id": "old"}},
				Updates: []connection.UpdateRow{{
					Keys:   map[string]interface{}{"id": "existing"},
					Values: map[string]interface{}{"document": "updated"},
				}},
			})
			if err == nil {
				t.Fatal("ApplyChanges succeeded, want failure")
			}
			if IsWriteOutcomeUnknown(err) != test.wantUnknown {
				t.Fatalf("ApplyChanges unknown outcome = %t, want %t: %v", IsWriteOutcomeUnknown(err), test.wantUnknown, err)
			}
		})
	}
}

func TestQdrantApplyChangesClassifiesPartialWrites(t *testing.T) {
	tests := []struct {
		name        string
		failDelete  bool
		wantUnknown bool
	}{
		{name: "first write fails", failDelete: true},
		{name: "update fails after delete", wantUnknown: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/collections":
					writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
				case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/delete":
					if test.failDelete {
						http.Error(w, "forced delete failure", http.StatusInternalServerError)
						return
					}
					writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 1}})
				case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/payload":
					http.Error(w, "forced update failure", http.StatusInternalServerError)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})

			db := newTestQdrantDB(t, server.URL)
			err := db.ApplyChanges("products", connection.ChangeSet{
				Deletes: []map[string]interface{}{{"id": 9}},
				Updates: []connection.UpdateRow{{
					Keys:   map[string]interface{}{"id": 1},
					Values: map[string]interface{}{"payload.category": "updated"},
				}},
			})
			if err == nil {
				t.Fatal("ApplyChanges succeeded, want failure")
			}
			if IsWriteOutcomeUnknown(err) != test.wantUnknown {
				t.Fatalf("ApplyChanges unknown outcome = %t, want %t: %v", IsWriteOutcomeUnknown(err), test.wantUnknown, err)
			}
		})
	}
}

func TestMilvusApplyChangesClassifiesPartialWrites(t *testing.T) {
	description := map[string]interface{}{
		"fields": []map[string]interface{}{
			{"name": "id", "type": "Int64", "primaryKey": true},
			{"name": "category", "type": "VarChar"},
		},
	}
	tests := []struct {
		name        string
		failDelete  bool
		wantUnknown bool
	}{
		{name: "first write fails", failDelete: true},
		{name: "update fails after delete", wantUnknown: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case isMilvusCollectionListRequest(r):
					writeMilvusJSON(w, []string{})
				case r.Method == http.MethodPost && r.URL.Path == milvusCollectionsDescribePath:
					writeMilvusJSON(w, description)
				case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesDeletePath:
					if test.failDelete {
						http.Error(w, "forced delete failure", http.StatusInternalServerError)
						return
					}
					writeMilvusJSON(w, map[string]interface{}{})
				case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesQueryPath:
					writeMilvusJSON(w, []map[string]interface{}{{"id": 2, "category": "old"}})
				case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesUpsertPath:
					http.Error(w, "forced update failure", http.StatusInternalServerError)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})

			db := newTestMilvusDB(t, server.URL)
			err := db.ApplyChanges("products", connection.ChangeSet{
				Deletes: []map[string]interface{}{{"id": 1}},
				Updates: []connection.UpdateRow{{
					Keys:   map[string]interface{}{"id": 2},
					Values: map[string]interface{}{"category": "updated"},
				}},
			})
			if err == nil {
				t.Fatal("ApplyChanges succeeded, want failure")
			}
			if IsWriteOutcomeUnknown(err) != test.wantUnknown {
				t.Fatalf("ApplyChanges unknown outcome = %t, want %t: %v", IsWriteOutcomeUnknown(err), test.wantUnknown, err)
			}
		})
	}
}
