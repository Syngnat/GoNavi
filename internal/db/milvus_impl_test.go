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

func newMockMilvusServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func newTestMilvusDB(t *testing.T, serverURL string) *MilvusDB {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	host, port, ok := parseHostPortWithDefault(parsed.Host, defaultMilvusPort)
	if !ok {
		t.Fatalf("parse host port failed: %s", parsed.Host)
	}
	db := &MilvusDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:   "milvus",
		Host:   host,
		Port:   port,
		UseSSL: strings.EqualFold(parsed.Scheme, "https"),
		URI:    serverURL,
	}); err != nil {
		t.Fatalf("connect Milvus: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func writeMilvusJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 0, "data": value})
}

func decodeMilvusRequest(t *testing.T, r *http.Request) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if r.Body == nil {
		return body
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Fatalf("decode request body: %v", err)
	}
	return body
}

func isMilvusCollectionListRequest(r *http.Request) bool {
	return r.Method == http.MethodPost && r.URL.Path == milvusCollectionsListPath
}

func TestMilvusURIUsesDatabasePathAndBearerCredentials(t *testing.T) {
	var capturedPath string
	var capturedAuthorization string
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		if isMilvusCollectionListRequest(r) {
			capturedPath = r.URL.RequestURI()
			capturedAuthorization = r.Header.Get("Authorization")
			if body := decodeMilvusRequest(t, r); body["dbName"] != "analytics" {
				t.Fatalf("list body = %#v", body)
			}
			writeMilvusJSON(w, []string{})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	uri := "milvus://root:Milvus@" + strings.TrimPrefix(server.URL, "http://") + "/analytics"
	db := newTestMilvusDB(t, uri)
	if db.database != "analytics" {
		t.Fatalf("database = %q, want analytics", db.database)
	}
	if capturedPath != milvusCollectionsListPath {
		t.Fatalf("request URI = %q", capturedPath)
	}
	if capturedAuthorization != "Bearer root:Milvus" {
		t.Fatalf("Authorization = %q", capturedAuthorization)
	}
}

func TestMilvusFactoryAndBuiltinRegistration(t *testing.T) {
	db, err := NewDatabase("milvus-db")
	if err != nil {
		t.Fatalf("NewDatabase failed: %v", err)
	}
	if _, ok := db.(*MilvusDB); !ok {
		t.Fatalf("factory returned %T, want *MilvusDB", db)
	}
	if !IsBuiltinDriver("milvusdb") {
		t.Fatal("Milvus should be a builtin driver")
	}
	if supported, reason := DriverRuntimeSupportStatus("milvus"); !supported {
		t.Fatalf("Milvus should be available without installation, reason=%q", reason)
	}
}

func TestMilvusGetDatabasesPostsJSONObject(t *testing.T) {
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			_ = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusDatabasesListPath:
			if body := decodeMilvusRequest(t, r); len(body) != 0 {
				t.Fatalf("database list body = %#v, want {}", body)
			}
			writeMilvusJSON(w, []string{"default", "analytics"})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	databases, err := db.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases failed: %v", err)
	}
	if strings.Join(databases, ",") != "analytics,default" {
		t.Fatalf("databases = %v", databases)
	}
}

func TestMilvusGetDatabasesFallsBackWhenDatabaseListIsUnsupported(t *testing.T) {
	collectionListCalls := 0
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			collectionListCalls++
			if body := decodeMilvusRequest(t, r); body["dbName"] != defaultMilvusDatabase {
				t.Fatalf("list body = %#v", body)
			}
			writeMilvusJSON(w, []string{"products"})
		case r.Method == http.MethodPost && r.URL.Path == milvusDatabasesListPath:
			http.NotFound(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	databases, err := db.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases should fall back to the configured database: %v", err)
	}
	if strings.Join(databases, ",") != defaultMilvusDatabase {
		t.Fatalf("databases = %v, want [%s]", databases, defaultMilvusDatabase)
	}

	tables, err := db.GetTables(databases[0])
	if err != nil {
		t.Fatalf("GetTables failed after database fallback: %v", err)
	}
	if strings.Join(tables, ",") != "products" {
		t.Fatalf("tables = %v, want [products]", tables)
	}
	if collectionListCalls != 3 {
		t.Fatalf("collection list calls = %d, want 3", collectionListCalls)
	}
}

func TestMilvusGetTablesUsesRESTV2CollectionList(t *testing.T) {
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		if isMilvusCollectionListRequest(r) {
			if body := decodeMilvusRequest(t, r); body["dbName"] != "default" {
				t.Fatalf("list body = %#v", body)
			}
			writeMilvusJSON(w, []string{"products", "logs"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestMilvusDB(t, server.URL)
	tables, err := db.GetTables("")
	if err != nil {
		t.Fatalf("GetTables failed: %v", err)
	}
	if strings.Join(tables, ",") != "logs,products" {
		t.Fatalf("tables = %v", tables)
	}
}

func TestMilvusCreateCollectionBuildsV2Body(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusCollectionsCreatePath:
			capturedBody = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, map[string]interface{}{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	_, err := db.Exec(`{"create_collection":"products","dimension":3,"metric_type":"COSINE","primary_field_name":"id","vector_field_name":"embedding","id_type":"Int64"}`)
	if err != nil {
		t.Fatalf("create collection failed: %v", err)
	}
	if capturedBody["collectionName"] != "products" || capturedBody["dbName"] != "default" {
		t.Fatalf("collection body = %#v", capturedBody)
	}
	if intFromAny(capturedBody["dimension"], 0) != 3 || capturedBody["metricType"] != "COSINE" || capturedBody["vectorFieldName"] != "embedding" {
		t.Fatalf("collection body = %#v", capturedBody)
	}
}

func TestMilvusSelectConvertsToEntityQuery(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesQueryPath:
			capturedBody = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, []map[string]interface{}{{"id": 1, "vector": []float64{0.1, 0.2}, "category": "book"}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	rows, columns, err := db.Query(`SELECT id, vector FROM "products" WHERE id >= 1 LIMIT 10 OFFSET 5`)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if capturedBody["collectionName"] != "products" || capturedBody["filter"] != "id >= 1" {
		t.Fatalf("query body = %#v", capturedBody)
	}
	if intFromAny(capturedBody["limit"], 0) != 10 || intFromAny(capturedBody["offset"], 0) != 5 {
		t.Fatalf("query body = %#v", capturedBody)
	}
	fields := stringSliceFromAny(capturedBody["outputFields"], nil)
	if strings.Join(fields, ",") != "id,vector" {
		t.Fatalf("outputFields = %v", fields)
	}
	if len(rows) != 1 || rows[0]["id"] == nil || !containsString(columns, "vector") {
		t.Fatalf("rows=%#v columns=%v", rows, columns)
	}
}

func TestMilvusJSONSearchUsesVectorAPI(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesSearchPath:
			capturedBody = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, []map[string]interface{}{{"id": 1, "distance": 0.01, "category": "book"}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	rows, columns, err := db.Query(`{"search":"products","vector":[0.1,0.2,0.3],"anns_field":"embedding","limit":1,"output_fields":["id","category"]}`)
	if err != nil {
		t.Fatalf("search failed: %v", err)
	}
	if capturedBody["collectionName"] != "products" || capturedBody["annsField"] != "embedding" || intFromAny(capturedBody["limit"], 0) != 1 {
		t.Fatalf("search body = %#v", capturedBody)
	}
	data := anySlice(capturedBody["data"])
	if len(data) != 1 || len(anySlice(data[0])) != 3 {
		t.Fatalf("search data = %#v", capturedBody["data"])
	}
	if len(rows) != 1 || rows[0]["distance"] == nil || !containsString(columns, "category") {
		t.Fatalf("rows=%#v columns=%v", rows, columns)
	}
}

func TestMilvusMetadataUsesDescribeResponse(t *testing.T) {
	description := map[string]interface{}{
		"collectionName": "products",
		"fields": []map[string]interface{}{
			{"name": "id", "type": "Int64", "primaryKey": true},
			{"name": "embedding", "type": "FloatVector", "nullable": true, "description": "product vector"},
		},
		"indexes": []map[string]interface{}{{"indexName": "embedding_idx", "fieldName": "embedding", "metricType": "COSINE"}},
	}
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusCollectionsDescribePath:
			body := decodeMilvusRequest(t, r)
			if body["collectionName"] != "products" {
				t.Fatalf("describe body = %#v", body)
			}
			writeMilvusJSON(w, description)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	columns, err := db.GetColumns("", "products")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	if len(columns) != 2 || columns[0].Key != "PRI" || columns[1].Nullable != "YES" || columns[1].Comment != "product vector" {
		t.Fatalf("columns = %#v", columns)
	}
	indexes, err := db.GetIndexes("", "products")
	if err != nil {
		t.Fatalf("GetIndexes failed: %v", err)
	}
	if len(indexes) != 2 || indexes[0].IndexType != "PRIMARY" || indexes[1].Name != "embedding_idx" {
		t.Fatalf("indexes = %#v", indexes)
	}
}

func TestMilvusApplyChangesDeletesMergesUpdatesAndInserts(t *testing.T) {
	description := map[string]interface{}{
		"fields": []map[string]interface{}{
			{"name": "id", "type": "Int64", "primaryKey": true},
			{"name": "embedding", "type": "FloatVector"},
			{"name": "category", "type": "VarChar"},
		},
	}
	var deleteBody map[string]interface{}
	var upsertBody map[string]interface{}
	var insertBody map[string]interface{}
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusCollectionsDescribePath:
			writeMilvusJSON(w, description)
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesDeletePath:
			deleteBody = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, map[string]interface{}{})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesQueryPath:
			writeMilvusJSON(w, []map[string]interface{}{{"id": 2, "embedding": []float64{0.1, 0.2}, "category": "old"}})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesUpsertPath:
			upsertBody = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, map[string]interface{}{"upsertCount": 1})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesInsertPath:
			insertBody = decodeMilvusRequest(t, r)
			writeMilvusJSON(w, map[string]interface{}{"insertCount": 1})
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
		Inserts: []map[string]interface{}{{"id": 3, "embedding": []float64{0.3, 0.4}, "category": "new"}},
	})
	if err != nil {
		t.Fatalf("ApplyChanges failed: %v", err)
	}
	if deleteBody["filter"] != "id in [1]" {
		t.Fatalf("delete body = %#v", deleteBody)
	}
	upsertRows := milvusMapSlice(upsertBody["data"])
	if len(upsertRows) != 1 || upsertRows[0]["category"] != "updated" || upsertRows[0]["embedding"] == nil {
		t.Fatalf("upsert body = %#v", upsertBody)
	}
	insertRows := milvusMapSlice(insertBody["data"])
	if len(insertRows) != 1 || intFromAny(insertRows[0]["id"], 0) != 3 {
		t.Fatalf("insert body = %#v", insertBody)
	}
}

func TestMilvusApplyChangesRejectsDeletesWithoutPrimaryKey(t *testing.T) {
	description := map[string]interface{}{
		"fields": []map[string]interface{}{{"name": "id", "type": "Int64", "primaryKey": true}},
	}
	deleteRequests := 0
	insertRequests := 0
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case isMilvusCollectionListRequest(r):
			writeMilvusJSON(w, []string{})
		case r.Method == http.MethodPost && r.URL.Path == milvusCollectionsDescribePath:
			writeMilvusJSON(w, description)
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesInsertPath:
			insertRequests++
			writeMilvusJSON(w, map[string]interface{}{"insertCount": 1})
		case r.Method == http.MethodPost && r.URL.Path == milvusEntitiesDeletePath:
			deleteRequests++
			writeMilvusJSON(w, map[string]interface{}{})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestMilvusDB(t, server.URL)
	for _, test := range []struct {
		name    string
		deletes []map[string]interface{}
	}{
		{name: "empty id", deletes: []map[string]interface{}{{"id": ""}}},
		{name: "nil id", deletes: []map[string]interface{}{{"id": nil}}},
		{name: "missing id", deletes: []map[string]interface{}{{}}},
		{name: "mixed ids", deletes: []map[string]interface{}{{"id": 1}, {"id": ""}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			deleteRequests = 0
			insertRequests = 0
			err := db.ApplyChanges("products", connection.ChangeSet{
				Deletes: test.deletes,
				Inserts: []map[string]interface{}{{"id": 2}},
			})
			if err == nil {
				t.Fatal("ApplyChanges unexpectedly succeeded")
			}
			if err.Error() != `Milvus delete is missing primary key field "id"` {
				t.Fatalf("ApplyChanges error = %q", err)
			}
			if deleteRequests != 0 {
				t.Fatalf("delete requests = %d, want 0", deleteRequests)
			}
			if insertRequests != 0 {
				t.Fatalf("insert requests = %d, want 0", insertRequests)
			}
		})
	}
}

func TestMilvusResponseCodeFailureIsReturned(t *testing.T) {
	server := newMockMilvusServer(t, func(w http.ResponseWriter, r *http.Request) {
		if isMilvusCollectionListRequest(r) {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"code": 1100, "message": "collection access denied"})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	parsed, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	host, port, ok := parseHostPortWithDefault(parsed.Host, defaultMilvusPort)
	if !ok {
		t.Fatalf("parse host:port failed: %s", parsed.Host)
	}
	db := &MilvusDB{}
	err = db.Connect(connection.ConnectionConfig{Type: "milvus", Host: host, Port: port})
	if err == nil || !strings.Contains(err.Error(), "collection access denied") {
		t.Fatalf("Connect error = %v", err)
	}
}

func TestMilvusLiveSmoke(t *testing.T) {
	serverURL := strings.TrimSpace(os.Getenv("GONAVI_MILVUS_TEST_URL"))
	if serverURL == "" {
		t.Skip("set GONAVI_MILVUS_TEST_URL to run live Milvus smoke test")
	}

	db := newTestMilvusDB(t, serverURL)
	collection := "gonavi_smoke_live"
	_, _ = db.Exec(fmt.Sprintf(`{"drop_collection":%q}`, collection))
	if _, err := db.Exec(fmt.Sprintf(`{"create_collection":%q,"dimension":3,"metric_type":"COSINE"}`, collection)); err != nil {
		t.Fatalf("create live collection: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(fmt.Sprintf(`{"drop_collection":%q}`, collection)) })

	if err := db.ApplyChanges(collection, connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": 1, "vector": []float64{0.1, 0.2, 0.3}, "kind": "smoke"}},
	}); err != nil {
		t.Fatalf("insert live row: %v", err)
	}

	rows, columns, err := db.Query(fmt.Sprintf(`SELECT * FROM "%s" WHERE id >= 0 LIMIT 5`, collection))
	if err != nil {
		t.Fatalf("select live rows: %v", err)
	}
	if len(rows) == 0 || intFromAny(rows[0]["id"], 0) != 1 || !containsString(columns, "vector") {
		t.Fatalf("live rows=%#v columns=%v", rows, columns)
	}

	queryRows, queryColumns, err := db.Query(fmt.Sprintf(`{"search":%q,"vector":[0.1,0.2,0.3],"limit":1}`, collection))
	if err != nil {
		t.Fatalf("search live rows: %v", err)
	}
	if len(queryRows) == 0 || intFromAny(queryRows[0]["id"], 0) != 1 || !containsString(queryColumns, "distance") {
		t.Fatalf("live search rows=%#v columns=%v", queryRows, queryColumns)
	}
}
