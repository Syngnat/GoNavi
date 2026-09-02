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

func newMockQdrantServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server
}

func newTestQdrantDB(t *testing.T, serverURL string) *QdrantDB {
	t.Helper()
	parsed, err := url.Parse(serverURL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	host, port, ok := parseHostPortWithDefault(parsed.Host, defaultQdrantPort)
	if !ok {
		t.Fatalf("parse host port failed: %s", parsed.Host)
	}
	db := &QdrantDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:   "qdrant",
		Host:   host,
		Port:   port,
		UseSSL: strings.EqualFold(parsed.Scheme, "https"),
	}); err != nil {
		t.Fatalf("connect qdrant: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func writeQdrantJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func TestQdrantGetTables(t *testing.T) {
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/collections" {
			writeQdrantJSON(w, map[string]interface{}{
				"result": map[string]interface{}{
					"collections": []map[string]interface{}{
						{"name": "products"},
						{"name": "logs"},
					},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestQdrantDB(t, server.URL)
	tables, err := db.GetTables("")
	if err != nil {
		t.Fatalf("GetTables failed: %v", err)
	}
	if strings.Join(tables, ",") != "logs,products" {
		t.Fatalf("tables = %v", tables)
	}
}

func TestQdrantCreateCollectionBuildsVectorsBody(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPut && r.URL.Path == "/collections/products":
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			writeQdrantJSON(w, map[string]interface{}{"result": true})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestQdrantDB(t, server.URL)
	if _, err := db.Exec(`{"create_collection":"products","size":3,"distance":"Cosine","on_disk_payload":true}`); err != nil {
		t.Fatalf("create collection failed: %v", err)
	}
	vectors, _ := capturedBody["vectors"].(map[string]interface{})
	if intFromAny(vectors["size"], 0) != 3 || vectors["distance"] != "Cosine" || capturedBody["on_disk_payload"] != true {
		t.Fatalf("captured body = %#v", capturedBody)
	}
}

func TestQdrantSelectConvertsToScroll(t *testing.T) {
	var capturedBody map[string]interface{}
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/scroll":
			_ = json.NewDecoder(r.Body).Decode(&capturedBody)
			writeQdrantJSON(w, map[string]interface{}{
				"result": map[string]interface{}{
					"points": []map[string]interface{}{
						{
							"id":      1,
							"payload": map[string]interface{}{"category": "book", "price": 19.5},
							"vector":  []float64{0.1, 0.2, 0.3},
						},
					},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestQdrantDB(t, server.URL)
	rows, columns, err := db.Query(`SELECT id, vector FROM "products" LIMIT 10 OFFSET 5`)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if intFromAny(capturedBody["limit"], 0) != 10 || capturedBody["offset"] != float64(5) && capturedBody["offset"] != int64(5) {
		t.Fatalf("captured body = %#v", capturedBody)
	}
	if len(rows) != 1 || rows[0]["id"] == nil || rows[0]["payload.category"] != "book" {
		t.Fatalf("rows = %#v", rows)
	}
	if !containsString(columns, "payload.category") || !containsString(columns, "vector") {
		t.Fatalf("columns = %v", columns)
	}
}

func TestQdrantGetColumnsUsesCollectionSchemaWithoutReadingPoints(t *testing.T) {
	pointReadRequests := 0
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodGet && r.URL.Path == "/collections/products":
			writeQdrantJSON(w, map[string]interface{}{
				"result": map[string]interface{}{
					"payload_schema": map[string]interface{}{
						"category": map[string]interface{}{"data_type": "keyword"},
						"price":    map[string]interface{}{"data_type": "float"},
					},
				},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/scroll":
			pointReadRequests++
			w.WriteHeader(http.StatusInternalServerError)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestQdrantDB(t, server.URL)
	columns, err := db.GetColumns("default", "products")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	if pointReadRequests != 0 {
		t.Fatalf("GetColumns must not read Qdrant points, requests=%d", pointReadRequests)
	}
	if got := columnDefinitionNames(columns); strings.Join(got, ",") != "id,vector,payload,payload.category,payload.price" {
		t.Fatalf("columns = %v", got)
	}
	if columns[3].Type != "keyword" || columns[4].Type != "float" {
		t.Fatalf("payload schema types = %#v", columns[3:])
	}
}

func TestQdrantSelectPassesWhereToScrollAndCount(t *testing.T) {
	var bodies []map[string]interface{}
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPost && (strings.HasSuffix(r.URL.Path, "/points/scroll") || strings.HasSuffix(r.URL.Path, "/points/count")):
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			bodies = append(bodies, body)
			if strings.HasSuffix(r.URL.Path, "/points/count") {
				writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"count": 0}})
			} else {
				writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"points": []interface{}{}}})
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	db := newTestQdrantDB(t, server.URL)

	queries := []string{
		`SeLeCt * FrOm "products" WhErE payload.category = 'book' AND price >= 10 LIMIT 10 OFFSET point-2`,
		"select count(*) from `products` where active != false OR price < 5",
	}
	for _, query := range queries {
		if _, _, err := db.Query(query); err != nil {
			t.Fatalf("Query(%q) failed: %v", query, err)
		}
	}
	if len(bodies) != 2 || bodies[0]["filter"] == nil || bodies[1]["filter"] == nil {
		t.Fatalf("WHERE was not passed to Qdrant: %#v", bodies)
	}
	first := bodies[0]["filter"].(map[string]interface{})
	if first["must"] == nil {
		t.Fatalf("compound WHERE = %#v, want must", first)
	}
	second := bodies[1]["filter"].(map[string]interface{})
	if second["should"] == nil {
		t.Fatalf("COUNT WHERE = %#v, want should", second)
	}
}

func TestQdrantSelectRejectsUnsupportedWhereWithoutDataRequest(t *testing.T) {
	db := &QdrantDB{client: &http.Client{Transport: vectorWhereRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("unsupported WHERE must not make an HTTP request")
		return nil, nil
	})}}
	if _, _, err := db.Query(`SELECT * FROM products WHERE category LIKE 'book%'`); err == nil || !strings.Contains(err.Error(), "不支持") {
		t.Fatalf("error = %v, want unsupported syntax error", err)
	}
}

func TestQdrantJSONSearchFlattensResults(t *testing.T) {
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/search":
			writeQdrantJSON(w, map[string]interface{}{
				"result": []map[string]interface{}{
					{
						"id":      1,
						"score":   0.98,
						"payload": map[string]interface{}{"category": "book"},
						"vector":  []float64{0.1, 0.2, 0.3},
					},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestQdrantDB(t, server.URL)
	rows, columns, err := db.Query(`{"search":"products","vector":[0.1,0.2,0.3],"limit":1}`)
	if err != nil {
		t.Fatalf("Query failed: %v", err)
	}
	if len(rows) != 1 || rows[0]["score"] == nil || rows[0]["payload.category"] != "book" {
		t.Fatalf("rows = %#v", rows)
	}
	if !containsString(columns, "score") || !containsString(columns, "payload.category") {
		t.Fatalf("columns = %v", columns)
	}
}

func TestQdrantApplyChangesUpsertPayloadAndDelete(t *testing.T) {
	var upsertBody map[string]interface{}
	var payloadBody map[string]interface{}
	var deleteBody map[string]interface{}
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPut && r.URL.Path == "/collections/products/points":
			_ = json.NewDecoder(r.Body).Decode(&upsertBody)
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 1}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/payload":
			_ = json.NewDecoder(r.Body).Decode(&payloadBody)
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 2}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/delete":
			_ = json.NewDecoder(r.Body).Decode(&deleteBody)
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 3}})
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
		Inserts: []map[string]interface{}{
			{"id": 2, "vector": []float64{0.1, 0.2, 0.3}, "payload.kind": "new"},
		},
	})
	if err != nil {
		t.Fatalf("ApplyChanges failed: %v", err)
	}
	if points := anySlice(deleteBody["points"]); len(points) != 1 || intFromAny(points[0], 0) != 9 {
		t.Fatalf("delete body = %#v", deleteBody)
	}
	if points := anySlice(payloadBody["points"]); len(points) != 1 || intFromAny(points[0], 0) != 1 {
		t.Fatalf("payload body = %#v", payloadBody)
	}
	payload, _ := payloadBody["payload"].(map[string]interface{})
	if payload["category"] != "updated" {
		t.Fatalf("payload body = %#v", payloadBody)
	}
	points := anySlice(upsertBody["points"])
	if len(points) != 1 {
		t.Fatalf("upsert body = %#v", upsertBody)
	}
	point, _ := points[0].(map[string]interface{})
	pointPayload, _ := point["payload"].(map[string]interface{})
	if intFromAny(point["id"], 0) != 2 || pointPayload["kind"] != "new" {
		t.Fatalf("upsert body = %#v", upsertBody)
	}
}

func TestQdrantApplyChangesRejectsDeletesWithoutID(t *testing.T) {
	deleteRequests := 0
	upsertRequests := 0
	server := newMockQdrantServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/collections":
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"collections": []interface{}{}}})
		case r.Method == http.MethodPut && r.URL.Path == "/collections/products/points":
			upsertRequests++
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 1}})
		case r.Method == http.MethodPost && r.URL.Path == "/collections/products/points/delete":
			deleteRequests++
			writeQdrantJSON(w, map[string]interface{}{"result": map[string]interface{}{"operation_id": 1}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestQdrantDB(t, server.URL)
	for _, test := range []struct {
		name    string
		deletes []map[string]interface{}
	}{
		{name: "empty id", deletes: []map[string]interface{}{{"id": ""}}},
		{name: "nil id", deletes: []map[string]interface{}{{"id": nil}}},
		{name: "missing id", deletes: []map[string]interface{}{{}}},
		{name: "mixed ids", deletes: []map[string]interface{}{{"id": 9}, {"id": ""}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			deleteRequests = 0
			upsertRequests = 0
			err := db.ApplyChanges("products", connection.ChangeSet{
				Deletes: test.deletes,
				Inserts: []map[string]interface{}{{"id": 1, "vector": []float64{0.1, 0.2}}},
			})
			if err == nil {
				t.Fatal("ApplyChanges unexpectedly succeeded")
			}
			if err.Error() != "Qdrant 删除行缺少 id" {
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

func TestQdrantLiveSmoke(t *testing.T) {
	serverURL := strings.TrimSpace(os.Getenv("GONAVI_QDRANT_TEST_URL"))
	if serverURL == "" {
		t.Skip("set GONAVI_QDRANT_TEST_URL to run live Qdrant smoke test")
	}

	db := newTestQdrantDB(t, serverURL)
	collection := "gonavi_smoke_live"
	_, _ = db.Exec(fmt.Sprintf(`{"delete_collection":%q}`, collection))
	if _, err := db.Exec(fmt.Sprintf(`{"create_collection":%q,"size":3,"distance":"Cosine"}`, collection)); err != nil {
		t.Fatalf("create live collection: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(fmt.Sprintf(`{"delete_collection":%q}`, collection)) })

	if err := db.ApplyChanges(collection, connection.ChangeSet{
		Inserts: []map[string]interface{}{{
			"id":           1,
			"vector":       []float64{0.1, 0.2, 0.3},
			"payload.kind": "smoke",
		}},
	}); err != nil {
		t.Fatalf("upsert live row: %v", err)
	}

	rows, columns, err := db.Query(fmt.Sprintf(`SELECT id, vector FROM "%s" LIMIT 5`, collection))
	if err != nil {
		t.Fatalf("select live rows: %v", err)
	}
	if len(rows) == 0 || intFromAny(rows[0]["id"], 0) != 1 || rows[0]["payload.kind"] != "smoke" {
		t.Fatalf("live rows = %#v", rows)
	}
	if !containsString(columns, "payload.kind") {
		t.Fatalf("live columns missing payload.kind: %v", columns)
	}

	queryRows, queryColumns, err := db.Query(fmt.Sprintf(`{"search":%q,"vector":[0.1,0.2,0.3],"limit":1}`, collection))
	if err != nil {
		t.Fatalf("search live rows: %v", err)
	}
	if len(queryRows) == 0 || intFromAny(queryRows[0]["id"], 0) != 1 || !containsString(queryColumns, "score") {
		t.Fatalf("live query rows = %#v columns = %v", queryRows, queryColumns)
	}
}
