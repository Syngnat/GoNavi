//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"net/http"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestElasticsearchApplyChangesMarksInvalidBulkJSONAsUnknown(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
			w.WriteHeader(http.StatusNotFound)
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("upstream proxy timeout"))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestESDB(t, server.URL, "test-index")
	err := db.ApplyChanges("test-index", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"message": "hello"}},
	})
	if err == nil || !strings.Contains(err.Error(), "解析 ES 批量操作响应失败") {
		t.Fatalf("ApplyChanges error = %v, want invalid JSON error", err)
	}
	if !IsWriteOutcomeUnknown(err) {
		t.Fatalf("ApplyChanges error = %v, want unknown write outcome", err)
	}
}
