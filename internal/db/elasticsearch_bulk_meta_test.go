//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestElasticsearchBulkActionTypeFollowsServerMajor(t *testing.T) {
	for _, tc := range []struct {
		name        string
		serverMajor int
		wantType    bool
	}{
		{name: "es6 requires type", serverMajor: 6, wantType: true},
		{name: "es7 and opensearch omit type", serverMajor: 7, wantType: false},
		{name: "es8 rejects type", serverMajor: 8, wantType: false},
		{name: "unknown version omits type", serverMajor: 0, wantType: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var actions []map[string]map[string]interface{}
			var refresh string
			server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/_alias/test-index":
					w.WriteHeader(http.StatusNotFound)
				case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
					refresh = r.URL.Query().Get("refresh")
					body, _ := io.ReadAll(r.Body)
					actions = readBulkActionLines(t, body)
					writeJSON(w, map[string]interface{}{"errors": false, "items": []interface{}{}})
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})

			db := newTestESDB(t, server.URL, "test-index")
			db.serverMajor = tc.serverMajor
			err := db.ApplyChanges("test-index", connection.ChangeSet{
				Inserts: []map[string]interface{}{{"_id": "new", "note": "hello"}},
				Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": "old"}, Values: map[string]interface{}{"note": "edited"}}},
				Deletes: []map[string]interface{}{{"_id": "gone"}},
			})
			if err != nil {
				t.Fatalf("ApplyChanges() error = %v", err)
			}
			if len(actions) != 3 {
				t.Fatalf("bulk action lines = %d, want 3: %v", len(actions), actions)
			}
			// 网格提交后立即重查，必须让改动马上对搜索可见。
			if refresh != "true" {
				t.Fatalf("bulk refresh = %q, want true", refresh)
			}
			for _, action := range actions {
				for op, meta := range action {
					_, hasType := meta["_type"]
					if hasType != tc.wantType || meta["_index"] != "test-index" {
						t.Fatalf("%s metadata = %v, want _type present=%v", op, meta, tc.wantType)
					}
				}
			}
		})
	}
}

// readBulkActionLines 取出 NDJSON 请求体里的 action 行（跳过紧随 index / update 的文档行）。
func readBulkActionLines(t *testing.T, body []byte) []map[string]map[string]interface{} {
	t.Helper()
	var actions []map[string]map[string]interface{}
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		var action map[string]map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &action); err != nil {
			t.Fatalf("bulk line %q is not an action: %v", scanner.Text(), err)
		}
		actions = append(actions, action)
		if _, isDelete := action["delete"]; !isDelete {
			scanner.Scan()
		}
	}
	return actions
}
