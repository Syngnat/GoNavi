//go:build gonavi_full_drivers || gonavi_meilisearch_driver

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

// meilisearchMock 是一个只有 movies 索引的内存 Meilisearch：记录收到的请求，写入立即生效并返回已完成的任务。
type meilisearchMock struct {
	t          *testing.T
	version    string
	filterable []string
	sortable   []string
	denyVer    bool

	mu        sync.Mutex
	documents map[string]map[string]interface{}
	requests  []string
	bodies    map[string]string
	tasks     map[int]map[string]interface{}
	failNext  string
}

func newMeilisearchMock(t *testing.T, version string) *meilisearchMock {
	mock := &meilisearchMock{t: t, version: version, documents: map[string]map[string]interface{}{}, bodies: map[string]string{}, tasks: map[int]map[string]interface{}{}}
	for _, raw := range []string{
		`{"id":1,"title":"Alpha","year":1999,"tags":["a","b"],"price":9.5}`,
		`{"id":2,"title":"Beta","year":2005,"tags":[],"price":1}`,
		`{"id":3,"title":"Gamma","year":2010}`,
	} {
		var document map[string]interface{}
		_ = json.Unmarshal([]byte(raw), &document)
		mock.documents[fmt.Sprint(document["id"])] = document
	}
	return mock
}

func (m *meilisearchMock) legacy() bool { return datasourceVersionLess(m.version, "0.28") }

func datasourceVersionLess(version, other string) bool {
	parse := func(text string) []int {
		parts := strings.Split(text, ".")
		numbers := make([]int, len(parts))
		for i, part := range parts {
			numbers[i], _ = strconv.Atoi(part)
		}
		return numbers
	}
	a, b := parse(version), parse(other)
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func (m *meilisearchMock) sortedDocuments() []map[string]interface{} {
	ids := make([]string, 0, len(m.documents))
	for id := range m.documents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	documents := make([]map[string]interface{}, 0, len(ids))
	for _, id := range ids {
		documents = append(documents, m.documents[id])
	}
	return documents
}

func (m *meilisearchMock) task(w http.ResponseWriter, details map[string]interface{}) {
	id := len(m.tasks)
	task := map[string]interface{}{"uid": id, "status": "succeeded", "details": details}
	if m.failNext != "" {
		task["status"] = "failed"
		task["error"] = map[string]interface{}{"message": m.failNext, "code": "invalid_document_id"}
		m.failNext = ""
	}
	m.tasks[id] = task
	w.WriteHeader(http.StatusAccepted)
	if m.legacy() {
		writeMeilisearchJSON(w, map[string]interface{}{"uid": id, "status": "enqueued"})
		return
	}
	writeMeilisearchJSON(w, map[string]interface{}{"taskUid": id, "status": "enqueued"})
}

func writeMeilisearchJSON(w http.ResponseWriter, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func (m *meilisearchMock) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	key := r.Method + " " + r.URL.Path
	m.requests = append(m.requests, key)
	m.bodies[key] = string(body)
	if r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("X-Meili-API-Key") != "secret" {
		w.WriteHeader(http.StatusUnauthorized)
		writeMeilisearchJSON(w, map[string]string{"message": "The provided API key is invalid.", "code": "invalid_api_key"})
		return
	}
	notFound := func(code string) {
		w.WriteHeader(http.StatusNotFound)
		writeMeilisearchJSON(w, map[string]string{"message": code, "code": code})
	}
	list := func(items interface{}, total int) {
		if m.legacy() {
			writeMeilisearchJSON(w, items)
			return
		}
		writeMeilisearchJSON(w, map[string]interface{}{"results": items, "total": total})
	}
	query := r.URL.Query()
	offset, _ := strconv.Atoi(query.Get("offset"))
	limit, err := strconv.Atoi(query.Get("limit"))
	if err != nil {
		limit = 20
	}
	window := func(documents []map[string]interface{}, offset, limit int) []map[string]interface{} {
		if offset > len(documents) {
			return []map[string]interface{}{}
		}
		return documents[offset:min(offset+limit, len(documents))]
	}
	switch {
	case key == "GET /version":
		if m.denyVer {
			w.WriteHeader(http.StatusForbidden)
			writeMeilisearchJSON(w, map[string]string{"message": "The provided API key is invalid.", "code": "invalid_api_key"})
			return
		}
		writeMeilisearchJSON(w, map[string]string{"pkgVersion": m.version})
	case key == "GET /indexes":
		list([]map[string]interface{}{{"uid": "movies", "primaryKey": "id", "updatedAt": "t"}}, 1)
	case key == "GET /indexes/movies":
		writeMeilisearchJSON(w, map[string]interface{}{"uid": "movies", "primaryKey": "id", "updatedAt": fmt.Sprint(len(m.tasks))})
	case strings.HasPrefix(key, "GET /indexes/") && !strings.HasPrefix(key, "GET /indexes/movies"):
		notFound("index_not_found")
	case key == "GET /indexes/movies/settings":
		writeMeilisearchJSON(w, map[string]interface{}{"filterableAttributes": m.filterable, "sortableAttributes": m.sortable, "searchableAttributes": []string{"*"}, "pagination": map[string]int{"maxTotalHits": 1000}})
	case key == "GET /indexes/movies/stats":
		writeMeilisearchJSON(w, map[string]interface{}{"numberOfDocuments": len(m.documents), "fieldDistribution": map[string]int{"id": 3, "title": 3, "year": 3, "tags": 2, "price": 2}})
	case key == "GET /indexes/movies/documents":
		documents := m.sortedDocuments()
		list(window(documents, offset, limit), len(documents))
	case strings.HasPrefix(key, "GET /indexes/movies/documents/"):
		if document, ok := m.documents[strings.TrimPrefix(r.URL.Path, "/indexes/movies/documents/")]; ok {
			writeMeilisearchJSON(w, document)
			return
		}
		notFound("document_not_found")
	case key == "POST /indexes/movies/documents/fetch", key == "POST /indexes/movies/search":
		var request struct {
			Offset int `json:"offset"`
			Limit  int `json:"limit"`
		}
		_ = json.Unmarshal(body, &request)
		// 过滤与排序的翻译由断言请求体验证，这里按年份倒序返回一个固定窗口。
		documents := m.sortedDocuments()
		sort.SliceStable(documents, func(i, j int) bool { return documents[i]["year"].(float64) > documents[j]["year"].(float64) })
		if strings.HasSuffix(key, "/search") {
			writeMeilisearchJSON(w, map[string]interface{}{"hits": window(documents, request.Offset, request.Limit), "totalHits": 2})
			return
		}
		writeMeilisearchJSON(w, map[string]interface{}{"results": window(documents, request.Offset, request.Limit), "total": 2})
	case key == "POST /indexes/movies/documents", key == "PUT /indexes/movies/documents":
		var documents []map[string]interface{}
		_ = json.Unmarshal(body, &documents)
		for _, document := range documents {
			id := fmt.Sprint(document["id"])
			if key == "PUT /indexes/movies/documents" && m.documents[id] != nil {
				for field, value := range document {
					m.documents[id][field] = value
				}
				continue
			}
			m.documents[id] = document
		}
		m.task(w, map[string]interface{}{"receivedDocuments": len(documents), "indexedDocuments": len(documents)})
	case key == "POST /indexes/movies/documents/delete-batch":
		var ids []interface{}
		_ = json.Unmarshal(body, &ids)
		deleted := 0
		for _, id := range ids {
			if _, ok := m.documents[fmt.Sprint(id)]; ok {
				delete(m.documents, fmt.Sprint(id))
				deleted++
			}
		}
		m.task(w, map[string]interface{}{"providedIds": len(ids), "deletedDocuments": deleted})
	case key == "PATCH /indexes/movies":
		m.task(w, map[string]interface{}{"oldIndexUid": "movies"})
	case key == "DELETE /indexes/movies":
		m.task(w, map[string]interface{}{"deletedDocuments": len(m.documents)})
	case strings.HasPrefix(key, "GET /tasks/"):
		id, _ := strconv.Atoi(strings.TrimPrefix(r.URL.Path, "/tasks/"))
		writeMeilisearchJSON(w, m.tasks[id])
	default:
		m.t.Errorf("unexpected request %s", key)
		notFound("not_found")
	}
}

func (m *meilisearchMock) sent(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, request := range m.requests {
		if request == key {
			return true
		}
	}
	return false
}

func newMeilisearchTestDB(t *testing.T, mock *meilisearchMock) *MeilisearchDB {
	t.Helper()
	server := httptest.NewServer(mock)
	t.Cleanup(server.Close)
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	client := &MeilisearchDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "meilisearch", Host: parsed.Hostname(), Port: port, Password: "secret"}); err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func TestMeilisearchSelectPushesFilterAndSortToDocumentFetch(t *testing.T) {
	mock := newMeilisearchMock(t, "1.54.3")
	mock.filterable, mock.sortable = []string{"year", "title"}, []string{"year"}
	client := newMeilisearchTestDB(t, mock)
	rows, columns, err := client.Query(`SELECT * FROM "movies" WHERE ("year" > '2000') AND ("title" IN ('Beta', 'Gamma')) ORDER BY "year" DESC LIMIT 2 OFFSET 0`)
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	var request map[string]interface{}
	_ = json.Unmarshal([]byte(mock.bodies["POST /indexes/movies/documents/fetch"]), &request)
	if request["filter"] != `("year" > 2000) AND ("title" IN ["Beta", "Gamma"])` || fmt.Sprint(request["sort"]) != "[year:desc]" {
		t.Fatalf("fetch request = %v", request)
	}
	// 模拟服务按键名排序输出文档；字段顺序跟随样本文档的写法由 TestMeilisearchFieldsFollowSampleOrder 覆盖。
	if strings.Join(columns, ",") != "id,price,tags,title,year" || len(rows) != 2 || rows[0]["title"] != "Gamma" || rows[0]["price"] != nil {
		t.Fatalf("columns = %v rows = %v", columns, rows)
	}
	total, _, err := client.Query(`SELECT COUNT(*) FROM "movies" WHERE "year" > '2000'`)
	if err != nil || total[0]["total"] != int64(2) {
		t.Fatalf("count = %v, err = %v", total, err)
	}
}

func TestMeilisearchSelectFiltersAndSortsOnClientWhenAttributesAreNotConfigured(t *testing.T) {
	mock := newMeilisearchMock(t, "1.1.1")
	client := newMeilisearchTestDB(t, mock)
	rows, _, err := client.Query(`SELECT "title", "year" FROM "movies" WHERE "title" LIKE '%a' ORDER BY "year" DESC LIMIT 1 OFFSET 1`)
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(rows) != 1 || rows[0]["title"] != "Beta" || len(rows[0]) != 2 {
		t.Fatalf("rows = %v", rows)
	}
	if mock.sent("POST /indexes/movies/search") || mock.sent("POST /indexes/movies/documents/fetch") {
		t.Fatal("LIKE on a non-filterable field must not be sent to Meilisearch")
	}
	total, _, err := client.Query(`SELECT COUNT(*) FROM "movies" WHERE "tags" IS NOT NULL`)
	if err != nil || total[0]["total"] != int64(2) {
		t.Fatalf("count = %v, err = %v", total, err)
	}
}

func TestMeilisearchLegacyVersionsSearchWithExpandedFilters(t *testing.T) {
	mock := newMeilisearchMock(t, "0.27.2")
	mock.filterable, mock.sortable = []string{"year"}, []string{"year"}
	client := newMeilisearchTestDB(t, mock)
	if _, _, err := client.Query(`SELECT * FROM "movies" WHERE "year" IN ('2005', '2010') ORDER BY "year" DESC LIMIT 10 OFFSET 0`); err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	var request map[string]interface{}
	_ = json.Unmarshal([]byte(mock.bodies["POST /indexes/movies/search"]), &request)
	if request["filter"] != `"year" = 2005 OR "year" = 2010` || request["q"] != "" {
		t.Fatalf("search request = %v", request)
	}
	ddl, err := client.GetCreateStatement("default", "movies")
	if err != nil || !strings.Contains(ddl, "POST /indexes/movies/settings\n{") || !strings.Contains(ddl, `"primaryKey": "id"`) {
		t.Fatalf("ddl = %q, err = %v", ddl, err)
	}
}

func TestMeilisearchApplyChangesChecksDocumentsAndCoercesValues(t *testing.T) {
	mock := newMeilisearchMock(t, "1.54.3")
	client := newMeilisearchTestDB(t, mock)
	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": float64(1)}},
		Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": float64(2)}, Values: map[string]interface{}{"year": "2006", "tags": `["x"]`}}},
		Inserts: []map[string]interface{}{{"id": "4", "title": "Delta", "year": "2020", "price": nil}},
	}
	if err := client.ApplyChanges("movies", changes); err != nil {
		t.Fatalf("ApplyChanges() error = %v", err)
	}
	if _, ok := mock.documents["1"]; ok {
		t.Fatal("document 1 must be deleted")
	}
	if mock.documents["2"]["year"] != float64(2006) || fmt.Sprint(mock.documents["2"]["tags"]) != "[x]" || mock.documents["2"]["title"] != "Beta" {
		t.Fatalf("partial update = %v", mock.documents["2"])
	}
	if inserted := mock.documents["4"]; inserted["year"] != float64(2020) || inserted["id"] != float64(4) {
		t.Fatalf("insert = %v", inserted)
	} else if _, ok := inserted["price"]; ok {
		t.Fatal("NULL cells must not be written on insert")
	}

	duplicate := connection.ChangeSet{Inserts: []map[string]interface{}{{"id": "3", "title": "Again"}}}
	if err := client.ApplyChanges("movies", duplicate); err == nil || !strings.Contains(err.Error(), "3") {
		t.Fatalf("duplicate insert error = %v", err)
	}
	missing := connection.ChangeSet{Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": float64(9)}, Values: map[string]interface{}{"title": "x"}}}}
	if err := client.ApplyChanges("movies", missing); err == nil || mock.documents["9"] != nil {
		t.Fatalf("updating a missing document must fail without creating it: %v", err)
	}
	mock.failNext = "Document identifier `bad id` is invalid."
	if _, err := client.Exec("POST /indexes/movies/documents\n[{\"id\": \"bad id\"}]"); err == nil || !strings.Contains(err.Error(), "bad id") {
		t.Fatalf("failed task error = %v", err)
	}
}

func TestMeilisearchConnectWithoutVersionPermission(t *testing.T) {
	mock := newMeilisearchMock(t, "1.54.3")
	mock.denyVer = true
	client := newMeilisearchTestDB(t, mock)
	if variant, version := client.DriverVariantInfo(); version != "" || variant == "" {
		t.Fatalf("variant = %q version = %q", variant, version)
	}
	server := httptest.NewServer(mock)
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	port, _ := strconv.Atoi(parsed.Port())
	wrong := &MeilisearchDB{}
	if err := wrong.Connect(connection.ConnectionConfig{Type: "meilisearch", Host: parsed.Hostname(), Port: port, Password: "wrong"}); err == nil {
		t.Fatal("a wrong key must fail to connect")
	}
}

func TestMeilisearchExecDropsIndexAndRejectsUnknownStatements(t *testing.T) {
	mock := newMeilisearchMock(t, "1.54.3")
	client := newMeilisearchTestDB(t, mock)
	if _, err := client.Exec(`DROP TABLE "movies"`); err != nil || !mock.sent("DELETE /indexes/movies") {
		t.Fatalf("DROP TABLE error = %v", err)
	}
	if _, err := client.Exec(`ALTER TABLE "movies" RENAME TO "films"`); err != nil || mock.bodies["PATCH /indexes/movies"] != `{"uid":"films"}` {
		t.Fatalf("rename error = %v, body = %s", err, mock.bodies["PATCH /indexes/movies"])
	}
	if _, err := client.Exec(`UPDATE movies SET year = 1`); err == nil {
		t.Fatal("UPDATE statements are not supported")
	}
	if _, _, err := client.Query(`SELECT * FROM "missing"`); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("missing index error = %v", err)
	}
}

func TestMeilisearchFieldsFollowSampleOrder(t *testing.T) {
	sample := []json.RawMessage{
		json.RawMessage(`{"title":"Alpha","id":1,"year":1999,"meta":{"x":1}}`),
		json.RawMessage(`{"id":"2","title":"Beta","year":"n/a","tags":[]}`),
	}
	fields, types := meilisearchFieldsFromSample("id", sample, map[string]int64{"id": 2, "title": 2, "zeta": 1, "alpha": 1})
	if strings.Join(fields, ",") != "id,title,year,meta,tags,alpha,zeta" {
		t.Fatalf("fields = %v", fields)
	}
	if types["id"] != "mixed" || types["title"] != "string" || types["meta"] != "object" || types["tags"] != "array" || types["year"] != "mixed" {
		t.Fatalf("types = %v", types)
	}
}

func TestMeilisearchPreviewChangesListsRequests(t *testing.T) {
	client := newMeilisearchTestDB(t, newMeilisearchMock(t, "1.54.3"))
	deletes, updates, inserts := client.PreviewChanges("movies", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": float64(1)}},
		Updates: []connection.UpdateRow{
			{Keys: map[string]interface{}{"id": float64(2)}, Values: map[string]interface{}{"year": "2006"}},
			{Keys: map[string]interface{}{"id": float64(3)}, Values: map[string]interface{}{"id": "30"}},
			{Keys: map[string]interface{}{"id": float64(1)}, Values: map[string]interface{}{"year": "soon"}},
		},
		Inserts: []map[string]interface{}{{"id": "9", "title": "New", "price": nil}},
	})
	if len(deletes) != 1 || deletes[0] != "POST /indexes/movies/documents/delete-batch\n[\n  1\n]" {
		t.Fatalf("deletes = %q", deletes)
	}
	if len(updates) != 3 || !strings.HasPrefix(updates[0], "PUT /indexes/movies/documents\n") || !strings.Contains(updates[0], `"year": 2006`) {
		t.Fatalf("partial update = %q", updates)
	}
	if !strings.Contains(updates[1], `"title": "Gamma"`) || !strings.Contains(updates[1], `"id": 30`) || !strings.HasSuffix(updates[1], "delete-batch\n[\n  3\n]") {
		t.Fatalf("primary key change = %q", updates[1])
	}
	if !strings.HasPrefix(updates[2], "# ") || !strings.Contains(updates[2], "soon") {
		t.Fatalf("invalid value = %q", updates[2])
	}
	if len(inserts) != 1 || !strings.Contains(inserts[0], `"id": 9`) || strings.Contains(inserts[0], "price") {
		t.Fatalf("inserts = %q", inserts)
	}
}
