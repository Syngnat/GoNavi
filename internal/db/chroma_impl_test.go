package db

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func newMockChromaServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func newTestChromaDB(t *testing.T, serverURL string) *ChromaDB {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	host, port, ok := parseHostPortWithDefault(parsed.Host, defaultChromaPort)
	if !ok {
		t.Fatalf("parse host port failed: %s", parsed.Host)
	}
	db := &ChromaDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type: "chroma",
		Host: host,
		Port: port,
	}); err != nil {
		t.Fatalf("connect chroma: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func writeChromaJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func columnDefinitionNames(columns []connection.ColumnDefinition) []string {
	names := make([]string, 0, len(columns))
	for _, column := range columns {
		names = append(names, column.Name)
	}
	return names
}

func TestChromaConnectDetectsV2(t *testing.T) {
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/api/v2/heartbeat" {
			writeChromaJSON(w, map[string]interface{}{"nanosecond heartbeat": 1})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestChromaDB(t, server.URL)
	if db.apiVersion != 2 {
		t.Fatalf("apiVersion = %d, want 2", db.apiVersion)
	}
}

func TestChromaConnectFallsBackToV1(t *testing.T) {
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v2/heartbeat" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method == http.MethodGet && r.URL.Path == "/api/v1/heartbeat" {
			writeChromaJSON(w, map[string]interface{}{"nanosecond heartbeat": 1})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestChromaDB(t, server.URL)
	if db.apiVersion != 1 {
		t.Fatalf("apiVersion = %d, want 1", db.apiVersion)
	}
}

func TestChromaGetDatabasesAndTablesV2(t *testing.T) {
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case "/api/v2/tenants/default_tenant/databases":
			writeChromaJSON(w, []map[string]interface{}{
				{"name": "analytics"},
				{"name": "default_database"},
			})
		case "/api/v2/tenants/default_tenant/databases/default_database/collections":
			writeChromaJSON(w, []chromaCollection{
				{ID: "col-products", Name: "products", Database: "default_database", Tenant: "default_tenant"},
				{ID: "col-logs", Name: "logs", Database: "default_database", Tenant: "default_tenant"},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	dbs, err := db.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases failed: %v", err)
	}
	if strings.Join(dbs, ",") != "analytics,default_database" {
		t.Fatalf("databases = %v", dbs)
	}
	tables, err := db.GetTables("")
	if err != nil {
		t.Fatalf("GetTables failed: %v", err)
	}
	if strings.Join(tables, ",") != "logs,products" {
		t.Fatalf("tables = %v", tables)
	}
}

func TestChromaGetDatabasesV2PropagatesHTTPFailure(t *testing.T) {
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case "/api/v2/tenants/default_tenant/databases":
			http.Error(w, "database service unavailable", http.StatusServiceUnavailable)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	dbs, err := db.GetDatabases()
	if err == nil {
		t.Fatalf("GetDatabases unexpectedly succeeded with databases %v", dbs)
	}
	if dbs != nil {
		t.Fatalf("databases = %v, want nil on HTTP failure", dbs)
	}
	if !strings.Contains(err.Error(), "database service unavailable") {
		t.Fatalf("GetDatabases error = %q, want server error context", err)
	}
}

func TestChromaSelectConvertsToGetRows(t *testing.T) {
	var capturedPath string
	var capturedBody map[string]interface{}
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.URL.Path == "/api/v2/tenants/default_tenant/databases/default_database/collections":
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/get"):
			capturedPath = r.URL.Path
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			writeChromaJSON(w, chromaGetResponse{
				IDs:       []string{"p1"},
				Documents: []interface{}{"first product"},
				Metadatas: []map[string]interface{}{{"category": "book", "price": json.Number("19.5")}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	rows, columns, err := db.Query(`SELECT * FROM "products" LIMIT 10 OFFSET 5`)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if capturedPath == "" {
		t.Fatal("expected get endpoint to be called")
	}
	if intFromAny(capturedBody["limit"], 0) != 10 || intFromAny(capturedBody["offset"], -1) != 5 {
		t.Fatalf("captured body = %#v", capturedBody)
	}
	if len(rows) != 1 || rows[0]["id"] != "p1" || rows[0]["metadata.category"] != "book" {
		t.Fatalf("rows = %#v", rows)
	}
	if !containsString(columns, "metadata.category") {
		t.Fatalf("columns missing metadata.category: %v", columns)
	}
}

func TestChromaSelectPassesWhereToGetAndCount(t *testing.T) {
	var bodies []map[string]interface{}
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/collections"):
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products"}})
		case strings.HasSuffix(r.URL.Path, "/collections/col-products/get"):
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			bodies = append(bodies, body)
			writeChromaJSON(w, chromaGetResponse{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	db := newTestChromaDB(t, server.URL)

	queries := []string{
		`SELECT * FROM "products" WHERE metadata.category = 'book' AND price >= 10 LIMIT 10 OFFSET 2`,
		"select count(*) from `products` where active = true OR price < 5",
	}
	for _, query := range queries {
		if _, _, err := db.Query(query); err != nil {
			t.Fatalf("Query(%q) failed: %v", query, err)
		}
	}
	if len(bodies) != 2 || bodies[0]["where"] == nil || bodies[1]["where"] == nil {
		t.Fatalf("WHERE was not passed to Chroma: %#v", bodies)
	}
	first := bodies[0]["where"].(map[string]interface{})
	if first["$and"] == nil {
		t.Fatalf("compound WHERE = %#v, want $and", first)
	}
	second := bodies[1]["where"].(map[string]interface{})
	if second["$or"] == nil {
		t.Fatalf("COUNT WHERE = %#v, want $or", second)
	}
}

func TestChromaCountWithWherePaginatesBeyondOneMillion(t *testing.T) {
	const matchingDocuments = 1_000_001
	var offsets []int
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/collections"):
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products"}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/get"):
			var body map[string]interface{}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode count request: %v", err)
			}
			if body["where"] == nil {
				t.Fatal("count request must keep WHERE filter")
			}
			if include, ok := body["include"].([]interface{}); !ok || len(include) != 0 {
				t.Fatalf("count request must not fetch documents, include = %#v", body["include"])
			}
			offset := intFromAny(body["offset"], -1)
			limit := intFromAny(body["limit"], 0)
			if offset < 0 || limit != chromaFilteredCountPageSize {
				t.Fatalf("count request offset=%d limit=%d", offset, limit)
			}
			offsets = append(offsets, offset)
			remaining := matchingDocuments - offset
			if remaining < 0 {
				remaining = 0
			}
			count := min(limit, remaining)
			ids := make([]string, count)
			for i := range ids {
				ids[i] = fmt.Sprintf("doc-%d", offset+i)
			}
			writeChromaJSON(w, chromaGetResponse{IDs: ids})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	rows, columns, err := db.Query("SELECT count(*) FROM products WHERE active = true")
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if len(rows) != 1 || len(columns) != 1 || columns[0] != "total" {
		t.Fatalf("count result = %#v, columns = %v", rows, columns)
	}
	if total, ok := rows[0]["total"].(int64); !ok || total != matchingDocuments {
		t.Fatalf("count total = %#v, want %d", rows[0]["total"], matchingDocuments)
	}
	wantPages := (matchingDocuments + chromaFilteredCountPageSize - 1) / chromaFilteredCountPageSize
	if len(offsets) != wantPages {
		t.Fatalf("count pages = %d, want %d", len(offsets), wantPages)
	}
	for page, offset := range offsets {
		if want := page * chromaFilteredCountPageSize; offset != want {
			t.Fatalf("page %d offset = %d, want %d", page, offset, want)
		}
	}
}

func TestChromaSelectRejectsUnsupportedWhereWithoutDataRequest(t *testing.T) {
	db := &ChromaDB{client: &http.Client{Transport: vectorWhereRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("unsupported WHERE must not make an HTTP request")
		return nil, nil
	})}}
	if _, _, err := db.Query(`SELECT * FROM products WHERE category LIKE 'book%'`); err == nil || !strings.Contains(err.Error(), "不支持") {
		t.Fatalf("error = %v, want unsupported syntax error", err)
	}
}

func TestChromaJSONQueryFlattensResults(t *testing.T) {
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.URL.Path == "/api/v2/tenants/default_tenant/databases/default_database/collections":
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/query"):
			writeChromaJSON(w, map[string]interface{}{
				"ids":       [][]string{{"p1", "p2"}},
				"documents": [][]string{{"first", "second"}},
				"distances": [][]float64{{0.1, 0.2}},
				"metadatas": [][]map[string]interface{}{{{"category": "book"}, {"category": "tool"}}},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	rows, columns, err := db.Query(`{"query":"products","query_embeddings":[[0.1,0.2]],"n_results":2}`)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if len(rows) != 2 || rows[1]["id"] != "p2" || rows[1]["distance"] == nil {
		t.Fatalf("rows = %#v", rows)
	}
	if !containsString(columns, "distance") || !containsString(columns, "metadata.category") {
		t.Fatalf("columns = %v", columns)
	}
}

func TestChromaGetColumnsDoesNotReadDocumentsOrEmbeddings(t *testing.T) {
	dataReadRequests := 0
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case strings.HasSuffix(r.URL.Path, "/collections"):
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
		case strings.HasSuffix(r.URL.Path, "/get"):
			dataReadRequests++
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	columns, err := db.GetColumns("default_database", "products")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	if dataReadRequests != 0 {
		t.Fatalf("GetColumns must not read Chroma documents or embeddings, requests=%d", dataReadRequests)
	}
	if got := columnDefinitionNames(columns); strings.Join(got, ",") != "id,document,metadata,embedding" {
		t.Fatalf("columns = %v", got)
	}
}

func TestChromaApplyChangesUpsertAndDelete(t *testing.T) {
	var upsertBody map[string]interface{}
	var deleteBody map[string]interface{}
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.URL.Path == "/api/v2/tenants/default_tenant/databases/default_database/collections":
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/upsert"):
			_ = json.NewDecoder(r.Body).Decode(&upsertBody)
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/delete"):
			_ = json.NewDecoder(r.Body).Decode(&deleteBody)
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	err := db.ApplyChanges("products", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": "old"}},
		Inserts: []map[string]interface{}{
			{"id": "new", "document": "hello", "metadata.kind": "demo", "score": 9},
		},
	})
	if err != nil {
		t.Fatalf("ApplyChanges failed: %v", err)
	}
	if ids := anySlice(deleteBody["ids"]); len(ids) != 1 || ids[0] != "old" {
		t.Fatalf("delete body = %#v", deleteBody)
	}
	if ids := anySlice(upsertBody["ids"]); len(ids) != 1 || ids[0] != "new" {
		t.Fatalf("upsert body = %#v", upsertBody)
	}
	metas := anySlice(upsertBody["metadatas"])
	if len(metas) != 1 {
		t.Fatalf("metadatas = %#v", upsertBody["metadatas"])
	}
	meta, _ := metas[0].(map[string]interface{})
	if meta["kind"] != "demo" || meta["score"] == nil {
		t.Fatalf("metadata = %#v", meta)
	}
}

func TestChromaApplyChangesRejectsDeletesWithoutID(t *testing.T) {
	deleteRequests := 0
	upsertRequests := 0
	server := newMockChromaServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v2/heartbeat":
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.URL.Path == "/api/v2/tenants/default_tenant/databases/default_database/collections":
			writeChromaJSON(w, []chromaCollection{{ID: "col-products", Name: "products", Database: "default_database"}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/upsert"):
			upsertRequests++
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/collections/col-products/delete"):
			deleteRequests++
			writeChromaJSON(w, map[string]interface{}{"ok": true})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestChromaDB(t, server.URL)
	for _, test := range []struct {
		name    string
		deletes []map[string]interface{}
	}{
		{name: "empty id", deletes: []map[string]interface{}{{"id": ""}}},
		{name: "nil id", deletes: []map[string]interface{}{{"id": nil}}},
		{name: "typed nil id", deletes: []map[string]interface{}{{"id": (*string)(nil)}}},
		{name: "missing id", deletes: []map[string]interface{}{{}}},
		{name: "mixed ids", deletes: []map[string]interface{}{{"id": "old"}, {"id": ""}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			deleteRequests = 0
			upsertRequests = 0
			err := db.ApplyChanges("products", connection.ChangeSet{
				Deletes: test.deletes,
				Inserts: []map[string]interface{}{{"id": "new", "document": "should not be written"}},
			})
			if err == nil {
				t.Fatal("ApplyChanges unexpectedly succeeded")
			}
			if err.Error() != "Chroma 删除行缺少 id" {
				t.Fatalf("ApplyChanges error = %q", err)
			}
			if deleteRequests != 0 {
				t.Fatalf("delete requests = %d, want 0", deleteRequests)
			}
			if upsertRequests != 0 {
				t.Fatalf("upsert requests = %d, want 0", upsertRequests)
			}
		})
	}
}

func TestChromaLiveSmoke(t *testing.T) {
	serverURL := strings.TrimSpace(os.Getenv("GONAVI_CHROMA_TEST_URL"))
	if serverURL == "" {
		t.Skip("set GONAVI_CHROMA_TEST_URL to run live Chroma smoke test")
	}

	db := newTestChromaDB(t, serverURL)
	collection := "gonavi_smoke_live"
	_, _ = db.Exec(fmt.Sprintf(`{"delete_collection":%q}`, collection))
	if _, err := db.Exec(fmt.Sprintf(`{"create_collection":%q,"get_or_create":true}`, collection)); err != nil {
		t.Fatalf("create live collection: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(fmt.Sprintf(`{"delete_collection":%q}`, collection)) })

	if err := db.ApplyChanges(collection, connection.ChangeSet{
		Inserts: []map[string]interface{}{{
			"id":            "doc-1",
			"document":      "GoNavi Chroma live smoke",
			"metadata.kind": "smoke",
			"embedding":     []float64{0.1, 0.2, 0.3},
		}},
	}); err != nil {
		t.Fatalf("upsert live row: %v", err)
	}

	rows, columns, err := db.Query(fmt.Sprintf(`SELECT * FROM "%s" LIMIT 5`, collection))
	if err != nil {
		t.Fatalf("select live rows: %v", err)
	}
	if len(rows) == 0 || rows[0]["id"] != "doc-1" || rows[0]["metadata.kind"] != "smoke" {
		t.Fatalf("live rows = %#v", rows)
	}
	if !containsString(columns, "metadata.kind") {
		t.Fatalf("live columns missing metadata.kind: %v", columns)
	}

	queryRows, queryColumns, err := db.Query(fmt.Sprintf(`{"query":%q,"query_embeddings":[[0.1,0.2,0.3]],"n_results":1}`, collection))
	if err != nil {
		t.Fatalf("query live rows: %v", err)
	}
	if len(queryRows) == 0 || queryRows[0]["id"] != "doc-1" || !containsString(queryColumns, "distance") {
		t.Fatalf("live query rows = %#v columns = %v", queryRows, queryColumns)
	}
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}
