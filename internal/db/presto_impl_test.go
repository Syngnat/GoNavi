//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// fakePrestoPage 是一次轮询响应：列只在第一次带数据的页出现，headers 是响应头里的会话变更。
type fakePrestoPage struct {
	columns     []prestoColumn
	data        [][]interface{}
	err         *prestoErrorInfo
	updateType  string
	updateCount *int64
	headers     map[string]string
}

type fakePrestoRequest struct {
	statement string
	headers   http.Header
}

// fakePresto 模拟协调节点：POST 按语句文本取脚本，后续页走 /v1/statement/<id>/<n>。
type fakePresto struct {
	t       *testing.T
	version string
	scripts map[string][]fakePrestoPage
	// unavailable 是 POST 先返回 503 的次数。
	unavailable int
	status      int

	mu       sync.Mutex
	nextID   int
	queries  map[string][]fakePrestoPage
	requests []fakePrestoRequest
	deletes  []string
	// blockGet 非空时轮询请求先通知 getStarted，再等待 blockGet 关闭。
	blockGet   chan struct{}
	getStarted chan struct{}
}

func newFakePresto(t *testing.T, version string) (*fakePresto, *httptest.Server) {
	fake := &fakePresto{t: t, version: version, scripts: map[string][]fakePrestoPage{}, queries: map[string][]fakePrestoPage{}}
	fake.scripts["SELECT 1"] = []fakePrestoPage{{columns: []prestoColumn{{Name: "_col0", Type: "integer"}}, data: [][]interface{}{{1}}}}
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	return fake, server
}

func (f *fakePresto) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.URL.Path == "/v1/info":
		if f.version == "" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"nodeVersion": map[string]any{"version": f.version}, "coordinator": true})
	case r.Method == http.MethodPost && r.URL.Path == "/v1/statement":
		body, _ := io.ReadAll(r.Body)
		statement := string(body)
		f.mu.Lock()
		f.requests = append(f.requests, fakePrestoRequest{statement: statement, headers: r.Header.Clone()})
		if f.unavailable > 0 {
			f.unavailable--
			f.mu.Unlock()
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if f.status != 0 {
			f.mu.Unlock()
			http.Error(w, "Unauthorized", f.status)
			return
		}
		pages, ok := f.scripts[statement]
		if !ok {
			pages = []fakePrestoPage{{err: &prestoErrorInfo{Message: "unexpected statement " + statement, ErrorName: "SYNTAX_ERROR"}}}
		}
		f.nextID++
		id := fmt.Sprintf("q%d", f.nextID)
		f.queries[id] = pages
		f.mu.Unlock()
		// 与真实服务端一样，提交响应本身不带数据，只给 nextUri。
		f.writePage(w, r, id, 0, fakePrestoPage{})
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/statement/"):
		f.mu.Lock()
		block, started := f.blockGet, f.getStarted
		f.mu.Unlock()
		if block != nil {
			started <- struct{}{}
			<-block
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/statement/"), "/")
		index, _ := strconv.Atoi(parts[1])
		f.mu.Lock()
		pages := f.queries[parts[0]]
		f.mu.Unlock()
		f.writePage(w, r, parts[0], index, pages[index-1])
	case r.Method == http.MethodDelete:
		f.mu.Lock()
		f.deletes = append(f.deletes, r.URL.Path)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(w, r)
	}
}

// writePage 写第 index 页（0 是提交响应）；还有后续页时带 nextUri。
func (f *fakePresto) writePage(w http.ResponseWriter, r *http.Request, id string, index int, page fakePrestoPage) {
	f.mu.Lock()
	total := len(f.queries[id])
	f.mu.Unlock()
	payload := map[string]any{"id": id}
	if index < total {
		payload["nextUri"] = fmt.Sprintf("http://%s/v1/statement/%s/%d", r.Host, id, index+1)
	}
	if page.columns != nil {
		payload["columns"] = page.columns
	}
	if page.data != nil {
		payload["data"] = page.data
	}
	if page.err != nil {
		payload["error"] = page.err
		delete(payload, "nextUri")
	}
	if page.updateType != "" {
		payload["updateType"] = page.updateType
	}
	if page.updateCount != nil {
		payload["updateCount"] = *page.updateCount
	}
	for name, value := range page.headers {
		w.Header().Add(name, value)
	}
	_ = json.NewEncoder(w).Encode(payload)
}

func (f *fakePresto) lastRequest(statement string) fakePrestoRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.requests) - 1; i >= 0; i-- {
		if f.requests[i].statement == statement {
			return f.requests[i]
		}
	}
	f.t.Fatalf("statement %q was not submitted; got %d requests", statement, len(f.requests))
	return fakePrestoRequest{}
}

func connectFakePresto(t *testing.T, server *httptest.Server, mutate func(*connection.ConnectionConfig)) *PrestoDB {
	t.Helper()
	config := connection.ConnectionConfig{Type: "presto", URI: server.URL, User: "analyst", Database: "tpch.tiny", Timeout: 5}
	if mutate != nil {
		mutate(&config)
	}
	presto := &PrestoDB{}
	if err := presto.Connect(config); err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { _ = presto.Close() })
	return presto
}

func TestPrestoConnectPicksVariantFromServerVersion(t *testing.T) {
	for _, tc := range []struct {
		version, variant, session, capabilities string
		offset                                  prestoOffsetMode
	}{
		{version: "0.289", variant: "prestodb", session: "offset_clause_enabled=true", offset: prestoOffsetNative},
		{version: "0.250-amzn-0", variant: "legacy", offset: prestoOffsetEmulated},
		{version: "345", variant: "prestosql", capabilities: "PATH,PARAMETRIC_DATETIME", offset: prestoOffsetNative},
		{version: "305", variant: "prestosql", capabilities: "PATH,PARAMETRIC_DATETIME", offset: prestoOffsetEmulated},
	} {
		fake, server := newFakePresto(t, tc.version)
		presto := connectFakePresto(t, server, nil)
		variant, version := presto.DriverVariantInfo()
		if variant != tc.variant || version != tc.version || presto.offsetMode != tc.offset {
			t.Fatalf("%s: variant=%s version=%s offset=%v", tc.version, variant, version, presto.offsetMode)
		}
		headers := fake.lastRequest("SELECT 1").headers
		if headers.Get("X-Presto-User") != "analyst" || headers.Get("X-Presto-Source") != "GoNavi" ||
			headers.Get("X-Presto-Catalog") != "tpch" || headers.Get("X-Presto-Schema") != "tiny" ||
			headers.Get("X-Presto-Transaction-Id") != "NONE" {
			t.Fatalf("%s: unexpected identity headers %v", tc.version, headers)
		}
		if got := headers.Get("X-Presto-Session"); got != tc.session {
			t.Fatalf("%s: session header %q, want %q", tc.version, got, tc.session)
		}
		if got := headers.Get("X-Presto-Client-Capabilities"); got != tc.capabilities {
			t.Fatalf("%s: capabilities %q, want %q", tc.version, got, tc.capabilities)
		}
	}
}

func TestPrestoConnectFallsBackToRuntimeNodesForVersion(t *testing.T) {
	fake, server := newFakePresto(t, "")
	fake.scripts[prestoVersionQuery] = []fakePrestoPage{{columns: []prestoColumn{{Name: "node_version", Type: "varchar"}}, data: [][]interface{}{{"0.296"}}}}
	presto := connectFakePresto(t, server, func(config *connection.ConnectionConfig) {
		config.DriverVariant = "auto"
		config.ConnectionParams = "session_properties=query_max_run_time:30m,hash_partition_count=8&session.join_distribution_type=BROADCAST&clientTags=bi&timeZone=Asia/Shanghai"
	})
	if variant, version := presto.DriverVariantInfo(); variant != "prestodb" || version != "0.296" {
		t.Fatalf("variant=%s version=%s", variant, version)
	}
	// 版本探测时还没有加档位属性，避免旧服务端因未知会话属性拒绝探测语句。
	if got := fake.lastRequest(prestoVersionQuery).headers.Get("X-Presto-Session"); strings.Contains(got, "offset_clause_enabled") {
		t.Fatalf("version probe must not carry variant session properties: %q", got)
	}
	headers := fake.lastRequest("SELECT 1").headers
	if got := headers.Get("X-Presto-Session"); got != "hash_partition_count=8,join_distribution_type=BROADCAST,offset_clause_enabled=true,query_max_run_time=30m" {
		t.Fatalf("session header %q", got)
	}
	if headers.Get("X-Presto-Client-Tags") != "bi" || headers.Get("X-Presto-Time-Zone") != "Asia/Shanghai" {
		t.Fatalf("client headers %v", headers)
	}
}

func TestPrestoNamespaceFromURIPathAndTrailingSemicolon(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	presto := connectFakePresto(t, server, func(config *connection.ConnectionConfig) {
		config.URI = strings.Replace(server.URL, "http://", "jdbc:presto://", 1) + "/hive/sales"
		config.Database = ""
	})
	headers := fake.lastRequest("SELECT 1").headers
	if headers.Get("X-Presto-Catalog") != "hive" || headers.Get("X-Presto-Schema") != "sales" {
		t.Fatalf("namespace from JDBC path: %v", headers)
	}
	// 协议只接受单条语句，末尾分号由驱动去掉。
	if _, err := presto.ExecContext(context.Background(), "SELECT 1;\n"); err != nil {
		t.Fatal(err)
	}
}

func TestPrestoConnectAuthentication(t *testing.T) {
	_, server := newFakePresto(t, "0.289")
	err := (&PrestoDB{}).Connect(connection.ConnectionConfig{Type: "presto", URI: server.URL, User: "analyst", Password: "secret"})
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("password over http must be refused, got %v", err)
	}
	if err := (&PrestoDB{}).Connect(connection.ConnectionConfig{Type: "presto", URI: server.URL}); err == nil {
		t.Fatal("empty user must be refused")
	}

	fake, server := newFakePresto(t, "0.289")
	connectFakePresto(t, server, func(config *connection.ConnectionConfig) {
		config.ConnectionParams = "accessToken=jwt-token&header.X-Gateway=edge"
	})
	headers := fake.lastRequest("SELECT 1").headers
	if headers.Get("Authorization") != "Bearer jwt-token" || headers.Get("X-Gateway") != "edge" {
		t.Fatalf("token headers %v", headers)
	}

	fake, server = newFakePresto(t, "0.289")
	fake.status = http.StatusUnauthorized
	err = (&PrestoDB{}).Connect(connection.ConnectionConfig{Type: "presto", URI: server.URL, User: "analyst"})
	var httpErr *prestoHTTPError
	if err == nil || !errors.As(err, &httpErr) || httpErr.status != http.StatusUnauthorized {
		t.Fatalf("401 must surface as an authentication error, got %v", err)
	}
}

func TestPrestoQueryFollowsNextURIAndConvertsValues(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	columns := []prestoColumn{
		{Name: "id", Type: "bigint"},
		{Name: "id", Type: "bigint"},
		{Name: "payload", Type: "varbinary"},
		{Name: "tags", Type: "array(varchar)"},
		{Name: "price", Type: "decimal(10,2)"},
		{Name: "attrs", Type: "map(varchar,integer)"},
	}
	fake.scripts["SELECT * FROM orders"] = []fakePrestoPage{
		{},
		{columns: columns, data: [][]interface{}{{json.Number("9007199254740993"), 1, "aGVsbG8=", []interface{}{"a", "b"}, "12.50", "{\n  \"k\" : 9007199254740993\n}"}}},
		{data: [][]interface{}{{2, 2, nil, "[ ]", nil, nil}}},
	}
	presto := connectFakePresto(t, server, nil)
	rows, names, err := presto.QueryContext(context.Background(), "SELECT * FROM orders")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, ",") != "id,id_2,payload,tags,price,attrs" || len(rows) != 2 {
		t.Fatalf("names=%v rows=%v", names, rows)
	}
	first := rows[0]
	if first["id"] != "9007199254740993" || first["id_2"] != int64(1) || first["payload"] != "hello" || first["price"] != "12.50" {
		t.Fatalf("first row %#v", first)
	}
	if tags, ok := first["tags"].([]interface{}); !ok || len(tags) != 2 {
		t.Fatalf("array value %#v", first["tags"])
	}
	// PrestoDB 0.29x 把 map / array 排成 JSON 文本返回，同样转为结构化值；大整数仍按字符串保留精度。
	if attrs, ok := first["attrs"].(map[string]interface{}); !ok || attrs["k"] != "9007199254740993" {
		t.Fatalf("map text value %#v", first["attrs"])
	}
	if tags, ok := rows[1]["tags"].([]interface{}); !ok || len(tags) != 0 {
		t.Fatalf("empty array text %#v", rows[1]["tags"])
	}
	if rows[1]["payload"] != nil {
		t.Fatalf("NULL must stay nil: %#v", rows[1])
	}

	fake.scripts["SELECT nothing"] = []fakePrestoPage{{columns: []prestoColumn{{Name: "x", Type: "integer"}}}}
	rows, names, err = presto.QueryContext(context.Background(), "SELECT nothing")
	if err != nil || len(rows) != 0 || rows == nil || len(names) != 1 {
		t.Fatalf("empty result: rows=%v names=%v err=%v", rows, names, err)
	}
}

func TestPrestoQueryErrorCarriesLocation(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	fake.scripts["SELEC 1"] = []fakePrestoPage{{err: &prestoErrorInfo{
		Message:   "line 1:1: mismatched input 'SELEC'",
		ErrorName: "SYNTAX_ERROR",
		ErrorLocation: &struct {
			LineNumber   int `json:"lineNumber"`
			ColumnNumber int `json:"columnNumber"`
		}{LineNumber: 1, ColumnNumber: 1},
	}}}
	presto := connectFakePresto(t, server, nil)
	_, _, err := presto.QueryContext(context.Background(), "SELEC 1")
	var queryErr *prestoQueryError
	if err == nil || !errors.As(err, &queryErr) || !strings.Contains(err.Error(), "SYNTAX_ERROR") || !strings.Contains(err.Error(), "mismatched input") {
		t.Fatalf("query error %v", err)
	}
	if _, execErr := presto.ExecContext(context.Background(), "SELEC 1"); execErr == nil || IsWriteOutcomeUnknown(execErr) {
		t.Fatalf("a server-side failure proves the write was rejected, got %v", execErr)
	}
}

func TestPrestoLegacyVariantEmulatesOffset(t *testing.T) {
	fake, server := newFakePresto(t, "0.250")
	data := [][]interface{}{{1}, {2}, {3}, {4}, {5}}
	fake.scripts[`SELECT * FROM "tpch"."tiny"."nation" ORDER BY "id" LIMIT 5`] = []fakePrestoPage{{columns: []prestoColumn{{Name: "id", Type: "bigint"}}, data: data}}
	presto := connectFakePresto(t, server, nil)
	rows, _, err := presto.QueryContext(context.Background(), `SELECT * FROM "tpch"."tiny"."nation" ORDER BY "id" OFFSET 2 LIMIT 3`)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 || rows[0]["id"] != int64(3) || rows[2]["id"] != int64(5) {
		t.Fatalf("emulated OFFSET rows %v", rows)
	}
}

func TestRewritePrestoOffset(t *testing.T) {
	for query, want := range map[string]struct {
		text string
		skip int64
	}{
		"SELECT * FROM t ORDER BY a OFFSET 10 LIMIT 5": {"SELECT * FROM t ORDER BY a LIMIT 15", 10},
		"SELECT * FROM t OFFSET 3 ROWS;":               {"SELECT * FROM t", 3},
		"select * from t offset 4 rows limit all":      {"select * from t", 4},
		"SELECT * FROM t LIMIT 5":                      {"SELECT * FROM t LIMIT 5", 0},
		"SELECT * FROM (SELECT * FROM t OFFSET 2) x":   {"SELECT * FROM (SELECT * FROM t OFFSET 2) x", 0},
		"SELECT 1 -- OFFSET 5":                         {"SELECT 1 -- OFFSET 5", 0},
		"SELECT * FROM t OFFSET 0 LIMIT 5":             {"SELECT * FROM t OFFSET 0 LIMIT 5", 0},
		"SELECT 'OFFSET 2 LIMIT 3' AS label":           {"SELECT 'OFFSET 2 LIMIT 3' AS label", 0},
	} {
		text, skip := rewritePrestoOffset(query)
		if text != want.text || skip != want.skip {
			t.Errorf("rewritePrestoOffset(%q) = %q, %d; want %q, %d", query, text, skip, want.text, want.skip)
		}
	}
}

func TestPrestoSessionStateFollowsResponseHeaders(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	fake.scripts["USE hive.sales"] = []fakePrestoPage{{updateType: "USE", headers: map[string]string{"X-Presto-Set-Catalog": "hive", "X-Presto-Set-Schema": "sales"}}}
	fake.scripts["SET SESSION join_distribution_type = 'BROADCAST'"] = []fakePrestoPage{{updateType: "SET SESSION", headers: map[string]string{"X-Presto-Set-Session": "join_distribution_type=BROADCAST"}}}
	fake.scripts["PREPARE q FROM SELECT ?"] = []fakePrestoPage{{updateType: "PREPARE", headers: map[string]string{"X-Presto-Added-Prepare": "q=SELECT+%3F"}}}
	fake.scripts["START TRANSACTION"] = []fakePrestoPage{{updateType: "START TRANSACTION", headers: map[string]string{"X-Presto-Started-Transaction-Id": "tx-1"}}}
	fake.scripts["SHOW TABLES"] = []fakePrestoPage{{columns: []prestoColumn{{Name: "Table", Type: "varchar"}}, data: [][]interface{}{{"orders"}}}}
	fake.scripts[`SHOW TABLES FROM "tpch"."tiny"`] = []fakePrestoPage{{columns: []prestoColumn{{Name: "Table", Type: "varchar"}}, data: [][]interface{}{{"nation"}}}}
	presto := connectFakePresto(t, server, nil)
	ctx := context.Background()
	for _, statement := range []string{"USE hive.sales", "SET SESSION join_distribution_type = 'BROADCAST'", "PREPARE q FROM SELECT ?", "START TRANSACTION"} {
		if _, err := presto.ExecContext(ctx, statement); err != nil {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	if _, _, err := presto.QueryContext(ctx, "SHOW TABLES"); err != nil {
		t.Fatal(err)
	}
	headers := fake.lastRequest("SHOW TABLES").headers
	if headers.Get("X-Presto-Catalog") != "hive" || headers.Get("X-Presto-Schema") != "sales" ||
		headers.Get("X-Presto-Session") != "join_distribution_type=BROADCAST,offset_clause_enabled=true" ||
		headers.Get("X-Presto-Prepared-Statement") != "q=SELECT+%3F" || headers.Get("X-Presto-Transaction-Id") != "tx-1" {
		t.Fatalf("session headers not carried: %v", headers)
	}
	// 元数据会话固定使用连接配置的命名空间，也不加入编辑器里开启的事务。
	if _, err := presto.GetTables(""); err != nil {
		t.Fatal(err)
	}
	meta := fake.lastRequest(`SHOW TABLES FROM "tpch"."tiny"`).headers
	if meta.Get("X-Presto-Catalog") != "tpch" || meta.Get("X-Presto-Transaction-Id") != "NONE" {
		t.Fatalf("metadata session leaked user state: %v", meta)
	}
}

func TestPrestoExecReportsAffectedRows(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	fake.scripts["INSERT INTO t VALUES (1), (2)"] = []fakePrestoPage{{updateType: "INSERT", columns: []prestoColumn{{Name: "rows", Type: "bigint"}}, data: [][]interface{}{{2}}}}
	count := int64(7)
	fake.scripts["DELETE FROM t"] = []fakePrestoPage{{updateType: "DELETE", updateCount: &count}}
	fake.scripts["CREATE TABLE t2 (id bigint)"] = []fakePrestoPage{{updateType: "CREATE TABLE"}}
	presto := connectFakePresto(t, server, nil)
	for statement, want := range map[string]int64{"INSERT INTO t VALUES (1), (2)": 2, "DELETE FROM t": 7, "CREATE TABLE t2 (id bigint)": 0} {
		got, err := presto.ExecContext(context.Background(), statement)
		if err != nil || got != want {
			t.Fatalf("%s: affected=%d err=%v, want %d", statement, got, err, want)
		}
	}
}

func TestPrestoBindArgsUsesPreparedStatementHeader(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	statement := "EXECUTE gonavi_stmt USING 'it''s', 1.5E+00, 42, NULL, true"
	fake.scripts[statement] = []fakePrestoPage{{columns: []prestoColumn{{Name: "ok", Type: "boolean"}}, data: [][]interface{}{{true}}}}
	presto := connectFakePresto(t, server, nil)
	rows, _, err := presto.QueryContextWithArgs(context.Background(), "SELECT ? = ?, ?, ?, ?;", []any{"it's", 1.5, int64(42), nil, true})
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	if got := fake.lastRequest(statement).headers.Get("X-Presto-Prepared-Statement"); got != "gonavi_stmt=SELECT+%3F+%3D+%3F%2C+%3F%2C+%3F%2C+%3F" {
		t.Fatalf("prepared statement header %q", got)
	}
}

func TestPrestoRetriesWhileCoordinatorIsBusy(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	presto := connectFakePresto(t, server, nil)
	fake.mu.Lock()
	fake.unavailable = 2
	fake.mu.Unlock()
	if err := presto.Ping(); err != nil {
		t.Fatalf("503 must be retried: %v", err)
	}
}

func TestPrestoCancelsServerQueryOnContextAndBudget(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	presto := connectFakePresto(t, server, nil)

	fake.scripts["SELECT * FROM big"] = []fakePrestoPage{
		{columns: []prestoColumn{{Name: "id", Type: "bigint"}}, data: [][]interface{}{{1}, {2}, {3}}},
		{data: [][]interface{}{{4}}},
	}
	budget := NewRowBudget(2)
	rows, _, err := presto.QueryContext(ContextWithRowBudget(context.Background(), budget), "SELECT * FROM big")
	if err != nil || len(rows) != 2 {
		t.Fatalf("budgeted rows=%v err=%v", rows, err)
	}
	waitForPrestoDeletes(t, fake, 1)

	block, started := make(chan struct{}), make(chan struct{}, 1)
	fake.mu.Lock()
	fake.blockGet, fake.getStarted = block, started
	fake.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, err := presto.QueryContext(ctx, "SELECT * FROM big")
		done <- err
	}()
	// 语句已提交、正在轮询时取消，客户端应对 nextUri 发 DELETE 取消服务端查询。
	<-started
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled query must fail")
	}
	close(block)
	waitForPrestoDeletes(t, fake, 2)
}

func waitForPrestoDeletes(t *testing.T, fake *fakePresto, want int) {
	t.Helper()
	for i := 0; i < 200; i++ {
		fake.mu.Lock()
		got := len(fake.deletes)
		fake.mu.Unlock()
		if got >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("expected %d DELETE cancellations", want)
}

func TestPrestoMetadata(t *testing.T) {
	fake, server := newFakePresto(t, "0.289")
	varchar := func(name string) []prestoColumn { return []prestoColumn{{Name: name, Type: "varchar"}} }
	fake.scripts["SHOW CATALOGS"] = []fakePrestoPage{{columns: varchar("Catalog"), data: [][]interface{}{{"tpch"}, {"broken"}}}}
	fake.scripts[`SHOW SCHEMAS FROM "tpch"`] = []fakePrestoPage{{columns: varchar("Schema"), data: [][]interface{}{{"tiny"}, {"sf1"}}}}
	fake.scripts[`SHOW SCHEMAS FROM "broken"`] = []fakePrestoPage{{err: &prestoErrorInfo{Message: "catalog unavailable", ErrorName: "GENERIC_INTERNAL_ERROR"}}}
	fake.scripts[`SELECT * FROM "tpch".information_schema.columns WHERE table_schema = 'tiny' AND table_name = 'nation' ORDER BY ordinal_position`] = []fakePrestoPage{{
		columns: []prestoColumn{{Name: "column_name", Type: "varchar"}, {Name: "data_type", Type: "varchar"}, {Name: "is_nullable", Type: "varchar"}, {Name: "comment", Type: "varchar"}, {Name: "extra_info", Type: "varchar"}},
		data:    [][]interface{}{{"nationkey", "bigint", "NO", "key", nil}, {"ds", "varchar", "YES", nil, "partition key"}},
	}}
	fake.scripts[`SHOW CREATE TABLE "tpch"."tiny"."v_nation"`] = []fakePrestoPage{{err: &prestoErrorInfo{Message: "Relation 'v_nation' is a view, not a table", ErrorName: "NOT_SUPPORTED"}}}
	fake.scripts[`SHOW CREATE VIEW "tpch"."tiny"."v_nation"`] = []fakePrestoPage{{columns: varchar("Create View"), data: [][]interface{}{{"CREATE VIEW v_nation AS SELECT 1"}}}}
	presto := connectFakePresto(t, server, nil)

	databases, err := presto.GetDatabases()
	if strings.Join(databases, ",") != "tpch.sf1,tpch.tiny" {
		t.Fatalf("databases %v", databases)
	}
	var partial *PartialMetadataError
	if !errors.As(err, &partial) {
		t.Fatalf("a failing catalog must be reported as partial metadata, got %v", err)
	}
	columns, err := presto.GetColumns("tpch.tiny", "nation")
	if err != nil || len(columns) != 2 || columns[0].Nullable != "NO" || columns[0].Comment != "key" || columns[1].Extra != "partition key" {
		t.Fatalf("columns %+v err=%v", columns, err)
	}
	ddl, err := presto.GetCreateStatement("tpch/tiny", "v_nation")
	if err != nil || ddl != "CREATE VIEW v_nation AS SELECT 1" {
		t.Fatalf("view DDL %q err=%v", ddl, err)
	}
	if _, err := presto.GetTables("tpch"); err == nil {
		t.Fatal("a namespace without schema must be rejected")
	}
	// 编辑器按 SQL 里的引用取列信息：库名只有一段，表名带 catalog.schema. 或 schema. 前缀。
	for _, tc := range []struct{ dbName, table string }{{"tpch", "tpch.tiny.nation"}, {"tiny", "tiny.nation"}, {"tpch", "tiny.nation"}} {
		if columns, err := presto.GetColumns(tc.dbName, tc.table); err != nil || len(columns) != 2 {
			t.Fatalf("GetColumns(%q, %q) = %+v, %v", tc.dbName, tc.table, columns, err)
		}
	}
}
