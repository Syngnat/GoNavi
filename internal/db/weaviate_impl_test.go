//go:build gonavi_full_drivers || gonavi_weaviate_driver

package db

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type weaviateMockRequest struct {
	method string
	path   string
	query  url.Values
	body   string
}

// weaviateMock 模拟 /v1/meta、/v1/schema、租户、GraphQL 与对象写入接口，记录收到的请求。
type weaviateMock struct {
	mu       sync.Mutex
	version  string
	classes  []map[string]interface{}
	tenants  map[string][]string
	graphQL  func(query string) interface{}
	batch    interface{}
	requests []weaviateMockRequest
}

func newWeaviateTestDB(t *testing.T, mock *weaviateMock, database string) *WeaviateDB {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mock.mu.Lock()
		mock.requests = append(mock.requests, weaviateMockRequest{method: r.Method, path: r.URL.Path, query: r.URL.Query(), body: string(body)})
		mock.mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer secret-key" {
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":[{"message":"anonymous access not enabled"}]}`))
			return
		}
		writeJSON := func(value interface{}) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(value)
		}
		switch {
		case r.URL.Path == "/v1/meta":
			writeJSON(map[string]interface{}{"version": mock.version})
		case r.URL.Path == "/v1/schema":
			writeJSON(map[string]interface{}{"classes": mock.classes})
		case strings.HasPrefix(r.URL.Path, "/v1/schema/") && strings.HasSuffix(r.URL.Path, "/tenants"):
			class := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/schema/"), "/tenants")
			items := make([]map[string]string, 0)
			for _, name := range mock.tenants[class] {
				items = append(items, map[string]string{"name": name, "activityStatus": "HOT"})
			}
			writeJSON(items)
		case r.URL.Path == "/v1/graphql":
			var payload struct {
				Query string `json:"query"`
			}
			_ = json.Unmarshal(body, &payload)
			writeJSON(mock.graphQL(payload.Query))
		case r.URL.Path == "/v1/batch/objects":
			writeJSON(mock.batch)
		case strings.HasPrefix(r.URL.Path, "/v1/objects/") && strings.HasSuffix(r.URL.Path, "/missing"):
			w.WriteHeader(http.StatusNotFound)
		case strings.HasPrefix(r.URL.Path, "/v1/objects/") && r.Method == http.MethodGet:
			writeJSON(map[string]interface{}{"class": "Article", "id": "a1", "properties": map[string]interface{}{"title": "old", "views": 1}, "vector": []float64{0.1, 0.2}})
		case strings.HasPrefix(r.URL.Path, "/v1/objects/"):
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	parsed, _ := url.Parse(server.URL)
	client := &WeaviateDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "weaviate", URI: "weaviate://" + parsed.Host, Password: "secret-key", Database: database}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func weaviateTestClasses() []map[string]interface{} {
	return []map[string]interface{}{
		{
			"class": "Article", "vectorIndexType": "hnsw", "vectorIndexConfig": map[string]interface{}{"distance": "cosine"},
			"properties": []map[string]interface{}{
				{"name": "title", "dataType": []string{"text"}, "tokenization": "word", "indexFilterable": true, "indexSearchable": true},
				{"name": "views", "dataType": []string{"int"}, "indexFilterable": true, "indexRangeFilters": true},
				{"name": "score", "dataType": []string{"number"}},
				{"name": "published", "dataType": []string{"date"}},
				{"name": "tags", "dataType": []string{"text[]"}},
				{"name": "author", "dataType": []string{"Author"}},
				{"name": "meta", "dataType": []string{"object"}, "nestedProperties": []map[string]interface{}{{"name": "source", "dataType": []string{"text"}}}},
			},
		},
		{"class": "Author", "properties": []map[string]interface{}{{"name": "name", "dataType": []string{"text"}}}},
		{"class": "TenantDoc", "multiTenancyConfig": map[string]interface{}{"enabled": true}, "properties": []map[string]interface{}{{"name": "body", "dataType": []string{"text"}}}},
	}
}

func renderTestFilter(t *testing.T, client *WeaviateDB, where string) string {
	t.Helper()
	class, err := client.findClass(t.Context(), "Article")
	if err != nil {
		t.Fatalf("findClass() error = %v", err)
	}
	node, err := parseRegistryWhere(where)
	if err != nil {
		t.Fatalf("parseRegistryWhere(%q) error = %v", where, err)
	}
	filter, err := client.renderFilter(class, node)
	if err != nil {
		t.Fatalf("renderFilter(%q) error = %v", where, err)
	}
	var b strings.Builder
	renderGraphQLValue(&b, filter)
	return b.String()
}

func TestWeaviateWhereTranslatesGridFilters(t *testing.T) {
	client := newWeaviateTestDB(t, &weaviateMock{version: "1.39.8", classes: weaviateTestClasses()}, "")
	for where, want := range map[string]string{
		`("views" > '5') AND ("title" LIKE '%ell%')`:   `{operator: And, operands: [{path: ["views"], operator: GreaterThan, valueInt: 5}, {path: ["title"], operator: Like, valueText: "*ell*"}]}`,
		`"views" IN ('1', '2')`:                        `{operator: Or, operands: [{path: ["views"], operator: Equal, valueInt: 1}, {path: ["views"], operator: Equal, valueInt: 2}]}`,
		`"title" NOT IN ('a')`:                         `{path: ["title"], operator: NotEqual, valueText: "a"}`,
		`"score" BETWEEN '1.5' AND '3'`:                `{operator: And, operands: [{path: ["score"], operator: GreaterThanEqual, valueNumber: 1.5}, {path: ["score"], operator: LessThanEqual, valueNumber: 3}]}`,
		`"views" NOT BETWEEN 1 AND 3`:                  `{operator: Or, operands: [{path: ["views"], operator: LessThan, valueInt: 1}, {path: ["views"], operator: GreaterThan, valueInt: 3}]}`,
		`("title" IS NULL OR "title" = '')`:            `{operator: Or, operands: [{path: ["title"], operator: IsNull, valueBoolean: true}, {path: ["title"], operator: Equal, valueText: ""}]}`,
		`"title" NOT LIKE 'It''s_'`:                    `{operator: Not, operands: [{path: ["title"], operator: Like, valueText: "It's?"}]}`,
		`_id = '00000000-0000-0000-0000-000000000001'`: `{path: ["id"], operator: Equal, valueText: "00000000-0000-0000-0000-000000000001"}`,
		`"published" >= '2026-01-02'`:                  `{path: ["published"], operator: GreaterThanEqual, valueDate: "2026-01-02T00:00:00Z"}`,
		`NOT ("views" <> 3)`:                           `{operator: Not, operands: [{path: ["views"], operator: NotEqual, valueInt: 3}]}`,
	} {
		if got := renderTestFilter(t, client, where); got != want {
			t.Errorf("filter %s\n got  %s\n want %s", where, got, want)
		}
	}
}

func TestWeaviateWhereRejectsInvalidFilters(t *testing.T) {
	client := newWeaviateTestDB(t, &weaviateMock{version: "1.39.8", classes: weaviateTestClasses()}, "")
	class, _ := client.findClass(t.Context(), "Article")
	for _, where := range []string{`"views" > 'many'`, `"missing" = 1`, `"author" = 'x'`, `"title" = `, `("views" > 1`} {
		node, err := parseRegistryWhere(where)
		if err == nil {
			_, err = client.renderFilter(class, node)
		}
		if err == nil {
			t.Errorf("filter %q must be rejected", where)
		}
	}
}

func TestWeaviateLegacyFiltersUseValueString(t *testing.T) {
	classes := weaviateTestClasses()
	classes[0]["properties"] = append(classes[0]["properties"].([]map[string]interface{}), map[string]interface{}{"name": "code", "dataType": []string{"string"}})
	client := newWeaviateTestDB(t, &weaviateMock{version: "1.17.6", classes: classes}, "")
	if got := renderTestFilter(t, client, `"code" = 'A1' AND _id = 'x'`); got != `{operator: And, operands: [{path: ["code"], operator: Equal, valueString: "A1"}, {path: ["id"], operator: Equal, valueString: "x"}]}` {
		t.Fatalf("legacy filter = %s", got)
	}
	if variant, _ := client.DriverVariantInfo(); variant != "v1" {
		t.Fatalf("1.17 variant = %q, want v1", variant)
	}
}

func TestWeaviateSelectBuildsGraphQLAndFlattensRows(t *testing.T) {
	var captured string
	mock := &weaviateMock{version: "1.39.8", classes: weaviateTestClasses(), graphQL: func(query string) interface{} {
		captured = query
		return map[string]interface{}{"data": map[string]interface{}{"Get": map[string]interface{}{"Article": []interface{}{
			map[string]interface{}{
				"title": "Hello", "views": 10, "tags": []string{"a"},
				"author":      []interface{}{map[string]interface{}{"_additional": map[string]interface{}{"id": "au-1"}}},
				"_additional": map[string]interface{}{"id": "a1", "creationTimeUnix": "1700000000000", "lastUpdateTimeUnix": "1700000000001"},
			},
		}}}}
	}}
	client := newWeaviateTestDB(t, mock, "")
	rows, columns, err := client.Query(`SELECT * FROM "Article" WHERE ("views" > '5') ORDER BY "views" DESC LIMIT 20 OFFSET 40`)
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	for _, fragment := range []string{
		`Article(limit: 20, offset: 40, where: {path: ["views"], operator: GreaterThan, valueInt: 5}, sort: [{path: ["views"], order: desc}])`,
		`author { ... on Author { _additional { id } } }`,
		`meta { source }`,
		`_additional { id creationTimeUnix lastUpdateTimeUnix }`,
	} {
		if !strings.Contains(captured, fragment) {
			t.Fatalf("GraphQL %q missing %q", captured, fragment)
		}
	}
	wantColumns := []string{"_id", "title", "views", "score", "published", "tags", "author", "meta", "_creationTimeUnix", "_lastUpdateTimeUnix"}
	if strings.Join(columns, ",") != strings.Join(wantColumns, ",") {
		t.Fatalf("columns = %v, want %v", columns, wantColumns)
	}
	row := rows[0]
	if row["_id"] != "a1" || row["_creationTimeUnix"] != int64(1700000000000) || row["views"] != int64(10) {
		t.Fatalf("row = %#v", row)
	}
	if ids, ok := row["author"].([]interface{}); !ok || len(ids) != 1 || ids[0] != "au-1" {
		t.Fatalf("reference ids = %#v", row["author"])
	}
}

func TestWeaviateMultiTenantClassesUseSelectedTenant(t *testing.T) {
	var queries []string
	mock := &weaviateMock{
		version: "1.23.16",
		classes: weaviateTestClasses(),
		tenants: map[string][]string{"TenantDoc": {"tenantB", "tenantA"}},
		graphQL: func(query string) interface{} {
			queries = append(queries, query)
			return map[string]interface{}{"data": map[string]interface{}{"Aggregate": map[string]interface{}{"TenantDoc": []interface{}{map[string]interface{}{"meta": map[string]interface{}{"count": 7}}}}}}
		},
	}
	root := newWeaviateTestDB(t, mock, "")
	databases, err := root.GetDatabases()
	if err != nil || strings.Join(databases, ",") != "default,tenantA,tenantB" {
		t.Fatalf("GetDatabases() = %v, %v", databases, err)
	}
	if tables, _ := root.GetTables("default"); strings.Join(tables, ",") != "Article,Author" {
		t.Fatalf("default tables = %v", tables)
	}
	if tables, _ := root.GetTables("tenantA"); strings.Join(tables, ",") != "TenantDoc" {
		t.Fatalf("tenant tables = %v", tables)
	}
	if _, _, err := root.Query(`SELECT COUNT(*) FROM "TenantDoc"`); err == nil {
		t.Fatal("querying a multi-tenant collection without a tenant must fail")
	}

	tenant := newWeaviateTestDB(t, mock, "tenantA")
	rows, _, err := tenant.Query(`SELECT COUNT(*) FROM "TenantDoc" WHERE "body" LIKE 'x%'`)
	if err != nil || rows[0]["total"] != int64(7) {
		t.Fatalf("count rows = %v, %v", rows, err)
	}
	if last := queries[len(queries)-1]; !strings.Contains(last, `TenantDoc(where: {path: ["body"], operator: Like, valueText: "x*"}, tenant: "tenantA") { meta { count } }`) {
		t.Fatalf("aggregate query = %s", last)
	}
}

func TestWeaviateTenantsHiddenBeforeMultiTenancy(t *testing.T) {
	client := newWeaviateTestDB(t, &weaviateMock{version: "1.19.13", classes: weaviateTestClasses(), tenants: map[string][]string{"TenantDoc": {"x"}}}, "")
	if databases, err := client.GetDatabases(); err != nil || strings.Join(databases, ",") != "default" {
		t.Fatalf("1.19 databases = %v, %v", databases, err)
	}
}

func TestWeaviateRESTRowsFlattenObjectsAndSchema(t *testing.T) {
	rows, columns := weaviateRESTRows([]byte(`{"objects":[{"class":"Article","id":"a1","creationTimeUnix":1,"properties":{"title":"Hi","views":2},"vector":[0.5]}],"totalResults":1}`))
	if strings.Join(columns, ",") != "_class,_id,title,views,_creationTimeUnix,_vector" || rows[0]["views"] != int64(2) || rows[0]["_id"] != "a1" {
		t.Fatalf("objects rows = %v columns = %v", rows, columns)
	}
	rows, columns = weaviateRESTRows([]byte(`{"classes":[{"class":"Article","vectorizer":"none"},{"class":"Author"}]}`))
	if len(rows) != 2 || strings.Join(columns, ",") != "class,vectorizer" {
		t.Fatalf("schema rows = %v columns = %v", rows, columns)
	}
	if value, ok := rows[1]["vectorizer"]; !ok || value != nil {
		t.Fatalf("missing fields must be filled with nil so the grid shows NULL: %#v", rows[1])
	}
	rows, columns = weaviateRESTRows([]byte(`{"version":"1.39.8","hostname":"node"}`))
	if len(rows) != 1 || strings.Join(columns, ",") != "hostname,version" {
		t.Fatalf("meta rows = %v columns = %v", rows, columns)
	}
}

func TestWeaviateApplyChangesCoercesValuesAndReportsBatchFailures(t *testing.T) {
	mock := &weaviateMock{version: "1.39.8", classes: weaviateTestClasses(), batch: []interface{}{
		map[string]interface{}{"id": "n1", "result": map[string]interface{}{"status": "SUCCESS"}},
		map[string]interface{}{"id": "n2", "result": map[string]interface{}{"status": "FAILED", "errors": map[string]interface{}{"error": []interface{}{map[string]interface{}{"message": "invalid integer"}}}}},
	}}
	client := newWeaviateTestDB(t, mock, "")
	err := client.ApplyChanges("Article", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": "d1"}},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"_id": "u1"}, Values: map[string]interface{}{"views": "11", "tags": `["x","y"]`, "published": "2026-02-03"}},
			{Keys: map[string]interface{}{"_id": "u2"}, Values: map[string]interface{}{"title": nil}},
		},
		Inserts: []map[string]interface{}{{"_id": "n1", "title": "new", "views": "3"}, {"_id": "n2", "views": "x3"}},
	})
	if err == nil {
		t.Fatal("ApplyChanges() must fail on an uncoercible insert value")
	}
	mock.requests = nil
	err = client.ApplyChanges("Article", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": "d1"}},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"_id": "u1"}, Values: map[string]interface{}{"views": "11", "tags": `["x","y"]`, "published": "2026-02-03"}},
			{Keys: map[string]interface{}{"_id": "u2"}, Values: map[string]interface{}{"title": nil}},
		},
		Inserts: []map[string]interface{}{{"_id": "n1", "title": "new", "views": "3"}},
	})
	if err == nil || !strings.Contains(err.Error(), "invalid integer") || !strings.Contains(err.Error(), "4") {
		t.Fatalf("ApplyChanges() error = %v, want partial batch failure after 4 applied changes", err)
	}
	var methods []string
	for _, request := range mock.requests {
		switch request.method {
		case http.MethodPatch:
			if !strings.Contains(request.body, `"views":11`) || !strings.Contains(request.body, `"tags":["x","y"]`) || !strings.Contains(request.body, `"published":"2026-02-03T00:00:00Z"`) {
				t.Fatalf("PATCH body = %s", request.body)
			}
		case http.MethodPut:
			if strings.Contains(request.body, `"title"`) || !strings.Contains(request.body, `"vector":[0.1,0.2]`) {
				t.Fatalf("PUT body must drop the cleared property and keep the vector: %s", request.body)
			}
		case http.MethodPost:
			if request.path == "/v1/batch/objects" && !strings.Contains(request.body, `"views":3`) {
				t.Fatalf("batch body = %s", request.body)
			}
		}
		if request.path != "/v1/schema" && request.path != "/v1/meta" {
			methods = append(methods, request.method+" "+request.path)
		}
	}
	want := "DELETE /v1/objects/Article/d1,PATCH /v1/objects/Article/u1,GET /v1/objects/Article/u2,PUT /v1/objects/Article/u2,POST /v1/batch/objects"
	if strings.Join(methods, ",") != want {
		t.Fatalf("requests = %v", methods)
	}
	if err := client.ApplyChanges("Article", connection.ChangeSet{Deletes: []map[string]interface{}{{"_id": "missing"}}}); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("deleting a missing object = %v", err)
	}
}

func TestWeaviateExecRunsRESTWrites(t *testing.T) {
	mock := &weaviateMock{version: "1.39.8", classes: weaviateTestClasses(), batch: []interface{}{map[string]interface{}{"result": map[string]interface{}{}}}}
	client := newWeaviateTestDB(t, mock, "")
	if affected, err := client.Exec("POST /v1/batch/objects\n{\"objects\": [{\"class\": \"Article\"}]}"); err != nil || affected != 1 {
		t.Fatalf("Exec(batch) = %d, %v", affected, err)
	}
	if affected, err := client.Exec("DELETE /objects/Article/a1"); err != nil || affected != 1 {
		t.Fatalf("Exec(delete without /v1) = %d, %v", affected, err)
	}
	for _, query := range []string{"GET /v1/schema", "SELECT * FROM Article", "POST /v1/objects\n{not json"} {
		if _, err := client.Exec(query); err == nil {
			t.Fatalf("Exec(%q) must be rejected", query)
		}
	}
}

func TestWeaviateConnectRequiresValidAPIKey(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":[{"message":"invalid api key"}]}`))
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	err := (&WeaviateDB{}).Connect(connection.ConnectionConfig{Type: "weaviate", Host: parsed.Hostname(), Port: mustAtoi(t, parsed.Port()), Password: "wrong"})
	if err == nil || !strings.Contains(err.Error(), "invalid api key") {
		t.Fatalf("Connect() error = %v", err)
	}
}

func mustAtoi(t *testing.T, text string) int {
	t.Helper()
	var value int
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("parse %q: %v", text, err)
	}
	return value
}

func TestIsWeaviateReadCommand(t *testing.T) {
	for text, want := range map[string]bool{
		"{ Get { Article { title } } }":                      true,
		"query { Aggregate { Article { meta { count } } } }": true,
		`{"query": "{ Get { Article { title } } }"}`:         true,
		"GET /v1/schema": true,
		"POST /v1/graphql\n{\"query\": \"{ Get { A { b } } }\"}": true,
		"SELECT * FROM Article":                                  true,
		"POST /v1/objects\n{}":                                   false,
		"DELETE /v1/schema/Article":                              false,
		"PATCH /v1/objects/Article/a1\n{}":                       false,
	} {
		if got := IsWeaviateReadCommand(text); got != want {
			t.Errorf("IsWeaviateReadCommand(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestWeaviatePreviewChangesListsRequests(t *testing.T) {
	mock := &weaviateMock{version: "1.39.8", classes: weaviateTestClasses()}
	client := newWeaviateTestDB(t, mock, "")
	deletes, updates, inserts := client.PreviewChanges("Article", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": "d1"}},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"_id": "u1"}, Values: map[string]interface{}{"views": "11"}},
			{Keys: map[string]interface{}{"_id": "u2"}, Values: map[string]interface{}{"title": nil}},
			{Keys: map[string]interface{}{"_id": "u3"}, Values: map[string]interface{}{"views": "eleven"}},
		},
		Inserts: []map[string]interface{}{{"_id": "n1", "title": "new"}},
	})
	if len(deletes) != 1 || deletes[0] != "DELETE /v1/objects/Article/d1" {
		t.Fatalf("deletes = %q", deletes)
	}
	if len(updates) != 3 || !strings.HasPrefix(updates[0], "PATCH /v1/objects/Article/u1\n") || !strings.Contains(updates[0], `"views": 11`) {
		t.Fatalf("PATCH preview = %q", updates)
	}
	if !strings.HasPrefix(updates[1], "PUT /v1/objects/Article/u2\n") || strings.Contains(updates[1], `"title"`) || !strings.Contains(updates[1], `"vector"`) {
		t.Fatalf("PUT preview = %q", updates[1])
	}
	if !strings.HasPrefix(updates[2], "# ") {
		t.Fatalf("invalid value preview = %q", updates[2])
	}
	if len(inserts) != 1 || !strings.HasPrefix(inserts[0], "POST /v1/batch/objects\n") || !strings.Contains(inserts[0], `"id": "n1"`) {
		t.Fatalf("inserts = %q", inserts)
	}
	for _, request := range mock.requests {
		if request.method != http.MethodGet && request.method != http.MethodPost {
			t.Fatalf("preview must not write: %s %s", request.method, request.path)
		}
		if request.method == http.MethodPost && request.path != "/v1/graphql" {
			t.Fatalf("preview must not write: %s %s", request.method, request.path)
		}
	}
}
