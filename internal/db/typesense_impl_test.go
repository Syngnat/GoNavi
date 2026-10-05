//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// typesenseMock 是一个只有 books 集合的内存 Typesense：记录收到的请求与查询参数，过滤由断言参数验证，搜索按 id 顺序返回窗口。
type typesenseMock struct {
	t         *testing.T
	version   string
	denyDebug bool

	mu        sync.Mutex
	documents map[string]map[string]interface{}
	requests  []string
	queries   map[string][]url.Values
	bodies    map[string]string
}

func newTypesenseMock(t *testing.T, version string) *typesenseMock {
	mock := &typesenseMock{t: t, version: version, documents: map[string]map[string]interface{}{}, queries: map[string][]url.Values{}, bodies: map[string]string{}}
	for i := 1; i <= 400; i++ {
		document := map[string]interface{}{"id": strconv.Itoa(i), "title": fmt.Sprintf("book %d", i), "year": 1990 + i%30, "genre": []string{"a", "b", "c"}[i%3]}
		if i%4 == 0 {
			document["note"] = "stored"
		}
		if i%5 != 0 {
			document["rating"] = float64(i%10) + 0.5
		}
		mock.documents[strconv.Itoa(i)] = document
	}
	return mock
}

func (m *typesenseMock) sortedIDs() []string {
	ids := make([]string, 0, len(m.documents))
	for id := range m.documents {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		a, _ := strconv.Atoi(ids[i])
		b, _ := strconv.Atoi(ids[j])
		return a < b
	})
	return ids
}

func (m *typesenseMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	key := r.Method + " " + r.URL.Path
	m.requests = append(m.requests, key)
	m.queries[key] = append(m.queries[key], r.URL.Query())
	m.bodies[key] = string(body)
	reply := func(status int, value interface{}) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(value)
	}
	if r.Header.Get("X-TYPESENSE-API-KEY") != "secret" {
		reply(http.StatusUnauthorized, map[string]string{"message": "Forbidden - a valid `x-typesense-api-key` header must be sent."})
		return
	}
	info := map[string]interface{}{
		"name": "books", "created_at": 1, "num_documents": len(m.documents), "default_sorting_field": "year",
		"fields": []map[string]interface{}{
			{"name": "title", "type": "string"},
			{"name": "year", "type": "int32"},
			{"name": "genre", "type": "string", "facet": true},
			{"name": "rating", "type": "float", "optional": true},
			{"name": "tags", "type": "string[]", "optional": true},
		},
	}
	const documentsPrefix = "/collections/books/documents/"
	switch {
	case key == "GET /debug":
		if m.denyDebug {
			reply(http.StatusUnauthorized, map[string]string{"message": "Forbidden"})
			return
		}
		reply(http.StatusOK, map[string]interface{}{"state": 1, "version": m.version})
	case key == "GET /collections":
		reply(http.StatusOK, []interface{}{info})
	case key == "GET /collections/books":
		reply(http.StatusOK, info)
	case key == "GET /collections/books/synonyms":
		reply(http.StatusOK, map[string]interface{}{"synonyms": []interface{}{map[string]interface{}{"id": "syn-1", "synonyms": []string{"book", "novel"}}}})
	case key == "GET /collections/books/overrides":
		reply(http.StatusOK, map[string]interface{}{"overrides": []interface{}{}})
	case key == "GET /collections/books/documents/search":
		query := r.URL.Query()
		ids := m.sortedIDs()
		var offset, limit int
		if query.Has("offset") {
			offset, _ = strconv.Atoi(query.Get("offset"))
			limit, _ = strconv.Atoi(query.Get("limit"))
		} else {
			page, _ := strconv.Atoi(query.Get("page"))
			limit, _ = strconv.Atoi(query.Get("per_page"))
			offset = (page - 1) * limit
		}
		hits := make([]interface{}, 0)
		for _, id := range ids[min(offset, len(ids)):min(offset+limit, len(ids))] {
			hits = append(hits, map[string]interface{}{"document": m.documents[id], "text_match": 100})
		}
		reply(http.StatusOK, map[string]interface{}{"found": len(ids), "hits": hits})
	case key == "GET /collections/books/documents/export":
		w.WriteHeader(http.StatusOK)
		for _, id := range m.sortedIDs() {
			line, _ := json.Marshal(m.documents[id])
			_, _ = w.Write(append(line, '\n'))
		}
	case key == "POST /collections/books/documents/import":
		w.WriteHeader(http.StatusOK)
		for _, line := range strings.Split(strings.TrimSpace(string(body)), "\n") {
			if strings.Contains(line, "title") {
				_, _ = w.Write([]byte(`{"success":true}` + "\n"))
			} else {
				_, _ = w.Write([]byte(`{"success":false,"error":"Field ` + "`title`" + ` has been declared in the schema, but is not found in the document."}` + "\n"))
			}
		}
	case key == "POST /collections/books/documents":
		var document map[string]interface{}
		_ = json.Unmarshal(body, &document)
		id := fmt.Sprint(document["id"])
		if _, exists := m.documents[id]; exists {
			reply(http.StatusConflict, map[string]string{"message": "A document with id " + id + " already exists."})
			return
		}
		m.documents[id] = document
		reply(http.StatusCreated, document)
	case key == "DELETE /collections/books/documents":
		deleted := 0
		if r.URL.Query().Get("truncate") == "true" {
			deleted = len(m.documents)
			m.documents = map[string]map[string]interface{}{}
		}
		reply(http.StatusOK, map[string]int{"num_deleted": deleted})
	case strings.HasPrefix(r.URL.Path, documentsPrefix):
		id := strings.TrimPrefix(r.URL.Path, documentsPrefix)
		document, ok := m.documents[id]
		if !ok {
			reply(http.StatusNotFound, map[string]string{"message": "Could not find a document with id: " + id})
			return
		}
		switch r.Method {
		case http.MethodGet:
			reply(http.StatusOK, document)
		case http.MethodPatch:
			var values map[string]interface{}
			_ = json.Unmarshal(body, &values)
			for field, value := range values {
				if value == nil {
					delete(document, field)
				} else {
					document[field] = value
				}
			}
			reply(http.StatusOK, document)
		case http.MethodDelete:
			delete(m.documents, id)
			reply(http.StatusOK, document)
		}
	case key == "DELETE /collections/books":
		reply(http.StatusOK, info)
	case strings.HasPrefix(key, "GET /collections/"):
		reply(http.StatusNotFound, map[string]string{"message": "Not Found"})
	default:
		m.t.Errorf("unexpected request %s", key)
		reply(http.StatusNotFound, map[string]string{"message": "Not Found"})
	}
}

func (m *typesenseMock) lastQuery(key string) url.Values {
	m.mu.Lock()
	defer m.mu.Unlock()
	queries := m.queries[key]
	if len(queries) == 0 {
		return nil
	}
	return queries[len(queries)-1]
}

func newTypesenseTestDB(t *testing.T, mock *typesenseMock) *TypesenseDB {
	t.Helper()
	server := httptest.NewServer(mock)
	t.Cleanup(server.Close)
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	client := &TypesenseDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "typesense", Host: parsed.Hostname(), Port: port, Password: "secret"}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestTypesenseSelectPushesFilterAndSortToSearch(t *testing.T) {
	mock := newTypesenseMock(t, "29.0")
	client := newTypesenseTestDB(t, mock)
	rows, columns, err := client.Query(`SELECT * FROM "books" WHERE ("year" > '2000') AND ("genre" IN ('a', 'b')) AND ("year" != '2005') ORDER BY "year" DESC LIMIT 300 OFFSET 10`)
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	searches := mock.queries["GET /collections/books/documents/search"]
	last := searches[len(searches)-2:]
	if last[0].Get("offset") != "10" || last[0].Get("limit") != "250" || last[1].Get("offset") != "260" || last[1].Get("limit") != "50" {
		t.Fatalf("search windows = %v", last)
	}
	if got := last[0].Get("filter_by"); got != "(year:>2000) && (genre:=[`a`,`b`]) && (year:!=2005)" {
		t.Fatalf("filter_by = %q", got)
	}
	if last[0].Get("sort_by") != "year:desc" || len(rows) != 300 {
		t.Fatalf("sort_by = %q, rows = %d", last[0].Get("sort_by"), len(rows))
	}
	if strings.Join(columns, ",") != "id,title,year,genre,rating,note" {
		t.Fatalf("columns = %v", columns)
	}
	if _, ok := rows[0]["_text_match"]; ok {
		t.Fatal("grid rows must not carry search metadata")
	}
	total, _, err := client.Query(`SELECT COUNT(*) FROM "books" WHERE NOT (("year" >= '2005') OR ("genre" = 'a'))`)
	if err != nil || total[0]["total"] != int64(400) {
		t.Fatalf("count = %v, err = %v", total, err)
	}
	if got := mock.lastQuery("GET /collections/books/documents/search").Get("filter_by"); got != "(year:<2005) && (genre:!=`a`)" {
		t.Fatalf("negated filter_by = %q", got)
	}
}

func TestTypesenseLegacyVersionsPageAndFallBackToExport(t *testing.T) {
	// 0.24 / 0.25 前没有 offset / limit：按页码读取，窗口不对齐时取覆盖窗口的页再截取。
	paged := newTypesenseMock(t, "0.24.1")
	pagedClient := newTypesenseTestDB(t, paged)
	if _, _, err := pagedClient.Query(`SELECT * FROM "books" WHERE "genre" = 'a' LIMIT 50 OFFSET 100`); err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	query := paged.lastQuery("GET /collections/books/documents/search")
	if query.Get("page") != "3" || query.Get("per_page") != "50" || query.Get("filter_by") != "genre:=`a`" || query.Has("offset") {
		t.Fatalf("page-based search = %v", query)
	}
	rows, _, err := pagedClient.Query(`SELECT "id" FROM "books" LIMIT 30 OFFSET 240`)
	if err != nil || len(rows) != 30 || rows[0]["id"] != "241" || rows[29]["id"] != "270" {
		t.Fatalf("unaligned window rows = %v, err = %v", rows, err)
	}

	// 0.20 的搜索结果跨页不稳定：集合不大时网格改用导出在客户端分页，条件与排序也在客户端处理。
	mock := newTypesenseMock(t, "0.20.0")
	client := newTypesenseTestDB(t, mock)
	if _, err := client.GetColumns("default", "books"); err != nil {
		t.Fatalf("GetColumns() error = %v", err)
	}
	searchesBefore := len(mock.queries["GET /collections/books/documents/search"])
	rows, _, err = client.Query(`SELECT * FROM "books" WHERE "genre" = 'a' LIMIT 50 OFFSET 50`)
	if err != nil || len(rows) != 50 || rows[0]["genre"] != "a" || len(mock.queries["GET /collections/books/documents/export"]) != 1 ||
		len(mock.queries["GET /collections/books/documents/search"]) != searchesBefore {
		t.Fatalf("0.20 browsing must page on the client from the export: rows = %d, err = %v", len(rows), err)
	}
	rows, _, err = client.Query(`SELECT * FROM "books" WHERE ("title" = 'book 7') OR ("year" = '1991') ORDER BY "year" DESC LIMIT 5 OFFSET 0`)
	if err != nil || len(mock.queries["GET /collections/books/documents/search"]) != searchesBefore {
		t.Fatalf("OR / non-facet strings on 0.20 must be filtered on the client from the export: err = %v", err)
	}
	if len(rows) != 5 || rows[0]["id"] != "7" || rows[1]["id"] != "1" {
		t.Fatalf("client-side rows = %v", rows)
	}
	if total, _, err := client.Query(`SELECT COUNT(*) FROM "books" WHERE "genre" = 'a'`); err != nil || total[0]["total"] != int64(400) {
		t.Fatalf("count still uses the native filter on 0.20: %v, err = %v", total, err)
	}
	ddl, err := client.GetCreateStatement("default", "books")
	if err != nil || !strings.HasPrefix(ddl, "POST /collections\n{\n  \"name\": \"books\",\n  \"fields\": [") || strings.Contains(ddl, "num_documents") ||
		!strings.Contains(ddl, "PUT /collections/books/synonyms/syn-1\n{") {
		t.Fatalf("ddl = %q, err = %v", ddl, err)
	}
}

func TestTypesenseColumnsMarkKeysAndStoredOnlyFields(t *testing.T) {
	client := newTypesenseTestDB(t, newTypesenseMock(t, "0.25.2"))
	columns, err := client.GetColumns("default", "books")
	if err != nil {
		t.Fatalf("GetColumns() error = %v", err)
	}
	byName := map[string]connection.ColumnDefinition{}
	for _, column := range columns {
		byName[column.Name] = column
	}
	if byName["id"].Key != "PRI" || byName["title"].Nullable != "NO" || byName["rating"].Nullable != "YES" ||
		byName["genre"].Comment != "facet" || byName["year"].Comment != "sort, default_sorting_field" || byName["note"].Comment != "stored only" {
		t.Fatalf("columns = %+v", columns)
	}
	legacy := newTypesenseTestDB(t, newTypesenseMock(t, "0.24.1"))
	numeric, _ := legacy.nativeFilter(&typesenseCollectionMeta{schema: map[string]typesenseField{"year": {Name: "year", Type: "int32"}}}, mustParseRegistryWhere(t, `"year" != '2005'`))
	if numeric != "(year:<2005 || year:>2005)" {
		t.Fatalf("numeric != before 0.25 = %q", numeric)
	}
}

func mustParseRegistryWhere(t *testing.T, text string) interface{} {
	t.Helper()
	node, err := parseRegistryWhere(text)
	if err != nil {
		t.Fatalf("parseRegistryWhere(%q) error = %v", text, err)
	}
	return node
}

func TestTypesenseApplyChangesAndWrites(t *testing.T) {
	mock := newTypesenseMock(t, "29.0")
	client := newTypesenseTestDB(t, mock)
	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": "1"}},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"id": "2"}, Values: map[string]interface{}{"year": "2006", "tags": `["x"]`, "rating": nil}},
			{Keys: map[string]interface{}{"id": "3"}, Values: map[string]interface{}{"id": "3003", "title": "moved"}},
		},
		Inserts: []map[string]interface{}{{"id": float64(5000), "title": "new", "year": "2020", "genre": "a", "rating": nil}},
	}
	if err := client.ApplyChanges("books", changes); err != nil {
		t.Fatalf("ApplyChanges() error = %v", err)
	}
	if _, ok := mock.documents["1"]; ok {
		t.Fatal("document 1 must be deleted")
	}
	if updated := mock.documents["2"]; updated["year"] != float64(2006) || fmt.Sprint(updated["tags"]) != "[x]" || updated["rating"] != nil {
		t.Fatalf("partial update = %v", updated)
	}
	if moved := mock.documents["3003"]; moved == nil || moved["title"] != "moved" || moved["year"] != float64(1993) || mock.documents["3"] != nil {
		t.Fatalf("moved document = %v, old = %v", moved, mock.documents["3"])
	}
	if inserted := mock.documents["5000"]; inserted["year"] != float64(2020) {
		t.Fatalf("insert = %v", inserted)
	} else if _, ok := inserted["rating"]; ok {
		t.Fatal("NULL cells must not be written on insert")
	}
	if err := client.ApplyChanges("books", connection.ChangeSet{Inserts: []map[string]interface{}{{"id": "4", "title": "dup", "year": "1", "genre": "a"}}}); err == nil || !strings.Contains(err.Error(), "4") {
		t.Fatalf("duplicate insert error = %v", err)
	}
	if err := client.ApplyChanges("books", connection.ChangeSet{Deletes: []map[string]interface{}{{"id": "9999"}}}); err == nil || !strings.Contains(err.Error(), "9999") {
		t.Fatalf("missing delete error = %v", err)
	}
	if err := client.ApplyChanges("books", connection.ChangeSet{Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": "4"}, Values: map[string]interface{}{"year": "soon"}}}}); err == nil || !strings.Contains(err.Error(), "soon") {
		t.Fatalf("invalid number error = %v", err)
	}

	if _, err := client.Exec("POST /collections/books/documents/import?action=upsert\n{\"id\":\"7\",\"title\":\"x\"}\n{\"id\":\"8\"}"); err == nil || !strings.Contains(err.Error(), "title") {
		t.Fatalf("import error = %v", err)
	}
	if _, err := client.Exec(`DELETE FROM "books" WHERE "year" < '1995'`); err != nil || mock.lastQuery("DELETE /collections/books/documents").Get("filter_by") != "year:<1995" {
		t.Fatalf("DELETE FROM error = %v, query = %v", err, mock.lastQuery("DELETE /collections/books/documents"))
	}
	if affected, err := client.Exec(`TRUNCATE TABLE "books"`); err != nil || affected == 0 || len(mock.documents) != 0 {
		t.Fatalf("TRUNCATE affected %d, err = %v", affected, err)
	}
	if _, err := client.Exec(`DROP TABLE "books"`); err != nil {
		t.Fatalf("DROP TABLE error = %v", err)
	}
	if _, _, err := client.Query(`SELECT * FROM "missing"`); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing collection error = %v", err)
	}
}

func TestTypesenseTruncateBeforeTruncateParameterDeletesByID(t *testing.T) {
	mock := newTypesenseMock(t, "0.24.1")
	client := newTypesenseTestDB(t, mock)
	if _, err := client.Exec(`TRUNCATE TABLE "books"`); err != nil {
		t.Fatalf("TRUNCATE error = %v", err)
	}
	deletes := mock.queries["DELETE /collections/books/documents"]
	if len(deletes) != 2 || !strings.HasPrefix(deletes[0].Get("filter_by"), "id:=[`1`,`2`,") || deletes[0].Has("truncate") {
		t.Fatalf("delete requests = %v", deletes)
	}
}

func TestTypesenseConnectWithoutDebugPermission(t *testing.T) {
	mock := newTypesenseMock(t, "29.0")
	mock.denyDebug = true
	client := newTypesenseTestDB(t, mock)
	if variant, version := client.DriverVariantInfo(); version != "" || variant == "" {
		t.Fatalf("variant = %q version = %q", variant, version)
	}
	server := httptest.NewServer(mock)
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	wrong := &TypesenseDB{}
	if err := wrong.Connect(connection.ConnectionConfig{Type: "typesense", Host: parsed.Hostname(), Port: port, Password: "wrong"}); err == nil {
		t.Fatal("a wrong key must fail to connect")
	}
}

func TestTypesensePreviewChangesListsRequests(t *testing.T) {
	client := newTypesenseTestDB(t, newTypesenseMock(t, "29.0"))
	deletes, updates, inserts := client.PreviewChanges("books", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": "1"}},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"id": "2"}, Values: map[string]interface{}{"year": "2006", "rating": nil}},
			{Keys: map[string]interface{}{"id": "3"}, Values: map[string]interface{}{"id": "3003"}},
		},
		Inserts: []map[string]interface{}{{"id": float64(5000), "title": "new", "year": "2020", "genre": "a"}},
	})
	if len(deletes) != 1 || deletes[0] != "DELETE /collections/books/documents/1" {
		t.Fatalf("deletes = %q", deletes)
	}
	if len(updates) != 2 || updates[0] != "PATCH /collections/books/documents/2\n{\n  \"rating\": null,\n  \"year\": 2006\n}" {
		t.Fatalf("partial update = %q", updates)
	}
	if !strings.HasPrefix(updates[1], "POST /collections/books/documents\n") || !strings.Contains(updates[1], `"title": "book 3"`) ||
		!strings.HasSuffix(updates[1], "DELETE /collections/books/documents/3") {
		t.Fatalf("id change = %q", updates[1])
	}
	if len(inserts) != 1 || !strings.Contains(inserts[0], `"id": "5000"`) || !strings.Contains(inserts[0], `"year": 2020`) {
		t.Fatalf("inserts = %q", inserts)
	}
}
