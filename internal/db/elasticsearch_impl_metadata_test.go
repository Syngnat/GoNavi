//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestElasticsearchGetDatabases 测试获取索引列表。
func TestElasticsearchGetDatabases(t *testing.T) {
	t.Run("现代版本使用 CAT 全量通配获取全部索引", func(t *testing.T) {
		var aliasListingRequested atomic.Bool
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet && r.URL.Path == "/_cat/indices" {
				query := r.URL.Query()
				if query.Get("format") != "json" || query.Get("h") != "index" || query.Get("expand_wildcards") != "all" {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				writeJSON(w, []map[string]string{
					{"index": "users"},
					{"index": ".security"},
					{"index": "logs-2024"},
					{"index": "users"},
					{"index": ".kibana_1"},
					{"index": "products"},
				})
				return
			}
			if r.Method == http.MethodGet && r.URL.Path == "/*/_alias" {
				aliasListingRequested.Store(true)
				w.WriteHeader(http.StatusGatewayTimeout)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "")
		databases, err := db.GetDatabases()
		if err != nil {
			t.Fatalf("GetDatabases 失败：%v", err)
		}

		expected := []string{".kibana_1", ".security", "logs-2024", "products", "users"}
		if len(databases) != len(expected) {
			t.Fatalf("期望 %d 个索引，实际 %d：%v", len(expected), len(databases), databases)
		}
		for i, name := range expected {
			if databases[i] != name {
				t.Fatalf("索引 [%d] 期望 %q，实际 %q", i, name, databases[i])
			}
		}
		if aliasListingRequested.Load() {
			t.Fatal("CAT 端点成功时不应继续请求 Alias API")
		}
	})

	t.Run("ES 7.3 拒绝全量通配参数后重试兼容 CAT 请求", func(t *testing.T) {
		var catListingAttempts atomic.Int32
		var aliasListingRequested atomic.Bool
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/_cat/indices":
				catListingAttempts.Add(1)
				query := r.URL.Query()
				if query.Has("expand_wildcards") {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if query.Get("format") != "json" || query.Get("h") != "index" {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				writeJSON(w, []map[string]string{{"index": "legacy-events"}})
			case r.Method == http.MethodGet && r.URL.Path == "/*/_alias":
				aliasListingRequested.Store(true)
				w.WriteHeader(http.StatusGatewayTimeout)
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		db := newTestESDB(t, server.URL, "")
		databases, err := db.GetDatabases()
		if err != nil {
			t.Fatalf("GetDatabases 应兼容 ES 7.3 CAT 参数：%v", err)
		}
		if attempts := catListingAttempts.Load(); attempts != 2 {
			t.Fatalf("期望先尝试现代 CAT 再重试兼容请求，实际请求 %d 次", attempts)
		}
		if aliasListingRequested.Load() {
			t.Fatal("兼容 CAT 请求成功时不应回退 Alias API")
		}
		if !slices.Equal(databases, []string{"legacy-events"}) {
			t.Fatalf("期望 [legacy-events]，实际 %v", databases)
		}
	})

	t.Run("允许没有索引的空集群", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet || r.URL.Path != "/_cat/indices" {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			writeJSON(w, []map[string]string{})
		})

		db := newTestESDB(t, server.URL, "")
		databases, err := db.GetDatabases()
		if err != nil {
			t.Fatalf("GetDatabases 应允许没有索引的空集群：%v", err)
		}
		if len(databases) != 0 {
			t.Fatalf("空集群应返回空索引列表，实际：%v", databases)
		}
	})

	t.Run("CAT 端点不可用时回退到 Alias API", func(t *testing.T) {
		var catListingRequested atomic.Bool
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/_cat/indices":
				catListingRequested.Store(true)
				w.WriteHeader(http.StatusForbidden)
			case r.Method == http.MethodGet && r.URL.Path == "/*/_alias":
				query := r.URL.Query()
				if query.Get("allow_no_indices") != "true" || query.Get("ignore_unavailable") != "true" {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				writeJSON(w, map[string]interface{}{
					"archive": map[string]interface{}{"aliases": map[string]interface{}{}},
					"orders":  map[string]interface{}{"aliases": map[string]interface{}{}},
				})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		db := newTestESDB(t, server.URL, "")
		databases, err := db.GetDatabases()
		if err != nil {
			t.Fatalf("GetDatabases 应在 CAT 被拒绝时回退：%v", err)
		}
		if !catListingRequested.Load() {
			t.Fatal("GetDatabases 应先尝试 CAT 端点")
		}
		expected := []string{"archive", "orders"}
		if !slices.Equal(databases, expected) {
			t.Fatalf("期望 %v，实际 %v", expected, databases)
		}
	})

	t.Run("CAT 超时后使用剩余预算回退到 Alias API", func(t *testing.T) {
		var aliasListingRequested atomic.Bool
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			switch {
			case r.Method == http.MethodGet && r.URL.Path == "/_cat/indices":
				<-r.Context().Done()
			case r.Method == http.MethodGet && r.URL.Path == "/*/_alias":
				aliasListingRequested.Store(true)
				writeJSON(w, map[string]interface{}{
					"events": map[string]interface{}{"aliases": map[string]interface{}{}},
				})
			default:
				w.WriteHeader(http.StatusNotFound)
			}
		})

		db := newTestESDB(t, server.URL, "")
		db.indexListTimeout = 500 * time.Millisecond
		started := time.Now()
		databases, err := db.GetDatabases()
		if err != nil {
			t.Fatalf("GetDatabases 应在 CAT 超时后回退：%v", err)
		}
		if !aliasListingRequested.Load() {
			t.Fatal("CAT 超时后应使用新的上下文请求 Alias API")
		}
		if !slices.Equal(databases, []string{"events"}) {
			t.Fatalf("期望 [events]，实际 %v", databases)
		}
		if elapsed := time.Since(started); elapsed >= db.indexListTimeout {
			t.Fatalf("回退不应耗尽总超时预算，实际耗时 %s", elapsed)
		}
	})

	t.Run("连接未打开时返回错误", func(t *testing.T) {
		db := &ElasticsearchDB{}
		_, err := db.GetDatabases()
		if err == nil || !strings.Contains(err.Error(), "连接未打开") {
			t.Fatalf("期望 '连接未打开' 错误，实际：%v", err)
		}
	})
}

// TestElasticsearchGetTables 测试 GetTables 返回索引名及别名。
func TestElasticsearchGetTables(t *testing.T) {
	t.Run("指定索引名并返回别名", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "/_alias") {
				writeJSON(w, map[string]interface{}{
					"my-index": map[string]interface{}{
						"aliases": map[string]interface{}{
							"my-alias": map[string]interface{}{},
						},
					},
				})
				return
			}
			w.WriteHeader(http.StatusOK)
		})

		db := newTestESDB(t, server.URL, "default-index")
		tables, err := db.GetTables("my-index")
		if err != nil {
			t.Fatalf("GetTables 失败：%v", err)
		}
		if len(tables) < 1 || tables[0] != "my-index" {
			t.Fatalf("期望第一个为 my-index，实际：%v", tables)
		}
		// 应包含别名
		found := false
		for _, tbl := range tables {
			if tbl == "my-alias" {
				found = true
			}
		}
		if !found {
			t.Fatalf("期望包含别名 my-alias，实际：%v", tables)
		}
	})

	t.Run("回退到默认索引", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "/_alias") {
				writeJSON(w, map[string]interface{}{})
				return
			}
			w.WriteHeader(http.StatusOK)
		})

		db := newTestESDB(t, server.URL, "default-index")
		tables, err := db.GetTables("")
		if err != nil {
			t.Fatalf("GetTables 失败：%v", err)
		}
		if len(tables) != 1 || tables[0] != "default-index" {
			t.Fatalf("期望 [default-index]，实际：%v", tables)
		}
	})

	t.Run("无索引名时报错", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		db := newTestESDB(t, server.URL, "")
		_, err := db.GetTables("")
		if err == nil || !strings.Contains(err.Error(), "未指定索引名") {
			t.Fatalf("期望 '未指定索引名' 错误，实际：%v", err)
		}
	})

	t.Run("连接未打开时返回错误", func(t *testing.T) {
		db := &ElasticsearchDB{database: "test"}
		_, err := db.GetTables("test")
		if err == nil || !strings.Contains(err.Error(), "连接未打开") {
			t.Fatalf("期望 '连接未打开' 错误，实际：%v", err)
		}
	})
}

func TestElasticsearchTableExistsUsesExactHeadRequest(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       bool
		wantErr    bool
	}{
		{name: "existing index", statusCode: http.StatusOK, want: true},
		{name: "deleted index", statusCode: http.StatusNotFound, want: false},
		{name: "server failure", statusCode: http.StatusServiceUnavailable, wantErr: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodHead || r.URL.Path != "/orders-2026" {
					t.Fatalf("unexpected existence request: %s %s", r.Method, r.URL.RequestURI())
				}
				w.WriteHeader(test.statusCode)
			})

			database := newTestESDB(t, server.URL, "default-index")
			exists, err := database.TableExists("analytics", "orders-2026")
			if test.wantErr {
				if err == nil {
					t.Fatal("expected existence check error")
				}
				if !strings.Contains(err.Error(), "503") {
					t.Fatalf("expected status code in error, got %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("TableExists returned error: %v", err)
			}
			if exists != test.want {
				t.Fatalf("TableExists = %v, want %v", exists, test.want)
			}
		})
	}
}

func TestElasticsearchTableExistsAcceptsAliasHeadResponse(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead || r.URL.Path != "/orders-read" {
			t.Fatalf("unexpected alias existence request: %s %s", r.Method, r.URL.RequestURI())
		}
		w.WriteHeader(http.StatusOK)
	})

	database := newTestESDB(t, server.URL, "orders-2026")
	exists, err := database.TableExists("orders-2026", "orders-read")
	if err != nil {
		t.Fatalf("alias TableExists returned error: %v", err)
	}
	if !exists {
		t.Fatal("alias HEAD 200 should be treated as existing")
	}
}

func TestElasticsearchTableExistsRequiresConnectionAndIndex(t *testing.T) {
	database := &ElasticsearchDB{}
	if _, err := database.TableExists("orders", "orders"); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("expected connection error, got %v", err)
	}

	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Fatalf("empty index must not issue an HTTP request: %s %s", r.Method, r.URL.Path)
	})
	database = newTestESDB(t, server.URL, "")
	if _, err := database.TableExists("", ""); err == nil || !strings.Contains(err.Error(), "未指定索引名") {
		t.Fatalf("expected missing-index error, got %v", err)
	}
}

// TestElasticsearchGetColumns 测试从 mapping 中提取字段定义。
func TestElasticsearchGetColumns(t *testing.T) {
	t.Run("正常提取字段", func(t *testing.T) {
		fields := map[string]string{
			"title":    "text",
			"status":   "keyword",
			"price":    "float",
			"quantity": "integer",
		}
		mapping := buildMockESMappingResponse("test-index", fields)

		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, "/_mapping") && r.Method == http.MethodGet {
				writeJSON(w, mapping)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "test-index")
		columns, err := db.GetColumns("test-index", "")
		if err != nil {
			t.Fatalf("GetColumns 失败：%v", err)
		}
		if len(columns) != 5 {
			t.Fatalf("期望 5 个字段（含 _id），实际 %d", len(columns))
		}

		// 验证字段类型映射
		typeMap := make(map[string]string)
		for _, col := range columns {
			typeMap[col.Name] = col.Type
		}
		for name, expectedType := range fields {
			if typeMap[name] != expectedType {
				t.Fatalf("字段 %q 类型期望 %q，实际 %q", name, expectedType, typeMap[name])
			}
		}
		if typeMap["_id"] != "keyword" {
			t.Fatalf("_id 字段类型期望 keyword，实际 %q", typeMap["_id"])
		}

		// 验证业务字段标记为可空；_id 是 ES 文档定位列，不沿用 mapping nullable。
		for _, col := range columns {
			if col.Name == "_id" {
				continue
			}
			if col.Nullable != "YES" {
				t.Fatalf("字段 %q Nullable 期望 YES，实际 %q", col.Name, col.Nullable)
			}
		}
	})

	t.Run("服务端返回错误", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":"index_not_found"}`))
		})

		db := newTestESDB(t, server.URL, "test-index")
		_, err := db.GetColumns("test-index", "")
		if err == nil {
			t.Fatal("GetColumns 服务端 404 时应返回错误")
		}
	})

	t.Run("连接未打开时返回错误", func(t *testing.T) {
		db := &ElasticsearchDB{}
		_, err := db.GetColumns("test-index", "")
		if err == nil || !strings.Contains(err.Error(), "连接未打开") {
			t.Fatalf("期望 '连接未打开' 错误，实际：%v", err)
		}
	})
}

// TestElasticsearchGetAllColumns 测试获取全部字段。
func TestElasticsearchGetAllColumns(t *testing.T) {
	fields := map[string]string{
		"name":  "text",
		"email": "keyword",
	}
	mapping := buildMockESMappingResponse("users", fields)

	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/_mapping") {
			writeJSON(w, mapping)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestESDB(t, server.URL, "users")
	columns, err := db.GetAllColumns("")
	if err != nil {
		t.Fatalf("GetAllColumns 失败：%v", err)
	}
	if len(columns) != 3 {
		t.Fatalf("期望 3 个字段（含 _id），实际 %d", len(columns))
	}

	// 验证每个字段都带有表名标识
	for _, col := range columns {
		if col.TableName != "users" {
			t.Fatalf("字段 %q 的 TableName 期望 users，实际 %s", col.Name, col.TableName)
		}
	}
}

// TestElasticsearchQueryDSL 测试 JSON DSL 查询模式。
func TestElasticsearchQueryDSL(t *testing.T) {
	t.Run("指定索引的 DSL 查询", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/_search") {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{
					"hits": {
						"total": {"value": 1},
						"hits": [
							{"_index": "test-index", "_id": "1", "_source": {"title": "测试文档", "status": "active"}}
						]
					}
				}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "test-index")
		dsl := `{"query":{"match_all":{}}}`
		rows, columns, err := db.Query(dsl)
		if err != nil {
			t.Fatalf("DSL 查询失败：%v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("期望 1 条结果，实际 %d", len(rows))
		}

		// 验证包含 _index 和 _id 元数据列
		colSet := make(map[string]bool)
		for _, col := range columns {
			colSet[col] = true
		}
		if !colSet["_index"] || !colSet["_id"] {
			t.Fatalf("结果列应包含 _index 和 _id，实际：%v", columns)
		}

		// 验证数据内容
		if rows[0]["title"] != "测试文档" {
			t.Fatalf("期望 title=测试文档，实际：%v", rows[0]["title"])
		}
		if rows[0]["_index"] != "test-index" {
			t.Fatalf("期望 _index=test-index，实际：%v", rows[0]["_index"])
		}
	})

	t.Run("无默认索引时拒绝纯 JSON DSL", func(t *testing.T) {
		requestCount := 0
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			requestCount++
			w.WriteHeader(http.StatusInternalServerError)
		})

		db := newTestESDB(t, server.URL, "")
		_, _, err := db.Query(`{"query":{"match_all":{}}}`)
		if err == nil || !strings.Contains(err.Error(), "default Elasticsearch index") {
			t.Fatalf("无默认索引的 DSL 应在发送前拒绝，实际错误：%v", err)
		}
		if requestCount != 0 {
			t.Fatalf("无默认索引的 DSL 不应发送请求，实际请求数：%d", requestCount)
		}
	})

	t.Run("查询服务端返回错误", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"parsing_exception"}`))
		})

		db := newTestESDB(t, server.URL, "test-index")
		_, _, err := db.Query(`{"query":{"invalid":{}}}`)
		if err == nil {
			t.Fatal("DSL 查询服务端错误时应返回错误")
		}
	})
}

// TestElasticsearchQueryString 测试 query_string 查询模式。
func TestElasticsearchQueryString(t *testing.T) {
	t.Run("简单字符串查询", func(t *testing.T) {
		var capturedBody string
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/_search") {
				buf := make([]byte, r.ContentLength)
				_, _ = r.Body.Read(buf)
				capturedBody = string(buf)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{
					"hits": {
						"total": {"value": 2},
						"hits": [
							{"_index": "test", "_id": "1", "_source": {"title": "匹配结果1"}},
							{"_index": "test", "_id": "2", "_source": {"title": "匹配结果2"}}
						]
					}
				}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "test")
		rows, _, err := db.Query("hello world")
		if err != nil {
			t.Fatalf("query_string 查询失败：%v", err)
		}
		if len(rows) != 2 {
			t.Fatalf("期望 2 条结果，实际 %d", len(rows))
		}

		// 验证请求体包含 query_string 包装
		if !strings.Contains(capturedBody, "query_string") {
			t.Fatalf("请求体应包含 query_string，实际：%s", capturedBody)
		}
		if !strings.Contains(capturedBody, "hello world") {
			t.Fatalf("请求体应包含查询文本，实际：%s", capturedBody)
		}
	})

	t.Run("查询语句为空时报错", func(t *testing.T) {
		db := newTestESDB(t, "http://localhost:9200", "test")
		_, _, err := db.Query("  ")
		if err == nil || !strings.Contains(err.Error(), "查询语句不能为空") {
			t.Fatalf("期望 '查询语句不能为空' 错误，实际：%v", err)
		}
	})

	t.Run("连接未打开时返回错误", func(t *testing.T) {
		db := &ElasticsearchDB{}
		_, _, err := db.Query("test")
		if err == nil || !strings.Contains(err.Error(), "连接未打开") {
			t.Fatalf("期望 '连接未打开' 错误，实际：%v", err)
		}
	})
}

// TestElasticsearchExecNotSupported 测试 Exec 返回不支持错误。
func TestElasticsearchExecNotSupported(t *testing.T) {
	db := &ElasticsearchDB{}
	rowsAffected, err := db.Exec("DELETE FROM test")
	if err == nil || !strings.Contains(err.Error(), "不支持执行非查询语句") {
		t.Fatalf("期望 '不支持执行非查询语句' 错误，实际：%v", err)
	}
	if rowsAffected != 0 {
		t.Fatalf("Exec 应返回 0 受影响行数，实际：%d", rowsAffected)
	}
}

// TestElasticsearchGetForeignKeys 测试返回空外键列表。
func TestElasticsearchGetForeignKeys(t *testing.T) {
	db := &ElasticsearchDB{}
	fks, err := db.GetForeignKeys("test-index", "test-table")
	if err != nil {
		t.Fatalf("GetForeignKeys 不应返回错误：%v", err)
	}
	if len(fks) != 0 {
		t.Fatalf("GetForeignKeys 应返回空列表，实际：%v", fks)
	}
}

// TestElasticsearchGetTriggers 测试返回空触发器列表。
func TestElasticsearchGetTriggers(t *testing.T) {
	db := &ElasticsearchDB{}
	triggers, err := db.GetTriggers("test-index", "test-table")
	if err != nil {
		t.Fatalf("GetTriggers 不应返回错误：%v", err)
	}
	if len(triggers) != 0 {
		t.Fatalf("GetTriggers 应返回空列表，实际：%v", triggers)
	}
}

// TestElasticsearchConnectNilClient 测试未连接时各操作返回错误。
func TestElasticsearchConnectNilClient(t *testing.T) {
	db := &ElasticsearchDB{}

	// Ping
	if err := db.Ping(); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("Ping: 期望 '连接未打开' 错误，实际：%v", err)
	}

	// GetDatabases
	if _, err := db.GetDatabases(); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("GetDatabases: 期望 '连接未打开' 错误，实际：%v", err)
	}

	// GetColumns
	if _, err := db.GetColumns("idx", ""); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("GetColumns: 期望 '连接未打开' 错误，实际：%v", err)
	}

	// GetAllColumns
	if _, err := db.GetAllColumns("idx"); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("GetAllColumns: 期望 '连接未打开' 错误，实际：%v", err)
	}

	// GetIndexes
	if _, err := db.GetIndexes("idx", "tbl"); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("GetIndexes: 期望 '连接未打开' 错误，实际：%v", err)
	}

	// GetCreateStatement（间接通过 esFetchIndexMapping）
	if _, err := db.GetCreateStatement("idx", "tbl"); err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("GetCreateStatement: 期望 '连接未打开' 错误，实际：%v", err)
	}
}

// TestElasticsearchGetCreateStatement 测试获取索引 settings + mappings。
func TestElasticsearchGetCreateStatement(t *testing.T) {
	indexDef := map[string]interface{}{
		"test-index": map[string]interface{}{
			"settings": map[string]interface{}{
				"index": map[string]interface{}{
					"number_of_shards":   "1",
					"number_of_replicas": "0",
				},
			},
			"mappings": map[string]interface{}{
				"properties": map[string]interface{}{
					"title": map[string]interface{}{"type": "text"},
				},
			},
		},
	}

	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		// GetCreateStatement 使用 Indices.Get 方法，路径为 /<index>
		if r.Method == http.MethodGet && r.URL.Path == "/test-index" && !strings.Contains(r.URL.Path, "_") {
			writeJSON(w, indexDef)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestESDB(t, server.URL, "test-index")
	stmt, err := db.GetCreateStatement("test-index", "")
	if err != nil {
		t.Fatalf("GetCreateStatement 失败：%v", err)
	}
	if !strings.Contains(stmt, "test-index") {
		t.Fatalf("CreateStatement 应包含索引名，实际：%s", stmt)
	}
	if !strings.Contains(stmt, "number_of_shards") {
		t.Fatalf("CreateStatement 应包含 settings，实际：%s", stmt)
	}
	if !strings.Contains(stmt, "mappings") {
		t.Fatalf("CreateStatement 应包含 mappings，实际：%s", stmt)
	}
}

// TestElasticsearchGetIndexes 测试获取索引 settings 信息。
func TestElasticsearchGetIndexes(t *testing.T) {
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/test-index/_settings") && r.Method == http.MethodGet {
			writeJSON(w, map[string]map[string]interface{}{
				"test-index": {
					"settings": map[string]interface{}{
						"index": map[string]interface{}{
							"number_of_shards":   "3",
							"number_of_replicas": "1",
						},
					},
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	db := newTestESDB(t, server.URL, "test-index")
	indexes, err := db.GetIndexes("test-index", "")
	if err != nil {
		t.Fatalf("GetIndexes 失败：%v", err)
	}
	if len(indexes) != 2 {
		t.Fatalf("期望 2 个索引信息（含 PRIMARY），实际 %d", len(indexes))
	}

	primary := indexes[0]
	if primary.Name != "PRIMARY" || primary.ColumnName != "_id" || primary.IndexType != "PRIMARY" {
		t.Fatalf("第一个索引应为 _id PRIMARY，实际：%#v", primary)
	}

	idx := indexes[1]
	if idx.Name != "test-index" {
		t.Fatalf("索引名期望 test-index，实际：%s", idx.Name)
	}
	if idx.IndexType != "INDEX" {
		t.Fatalf("索引类型期望 INDEX，实际：%s", idx.IndexType)
	}
	if !strings.Contains(idx.ColumnName, "shards=3") {
		t.Fatalf("索引信息应包含 shards=3，实际：%s", idx.ColumnName)
	}
	if !strings.Contains(idx.ColumnName, "replicas=1") {
		t.Fatalf("索引信息应包含 replicas=1，实际：%s", idx.ColumnName)
	}
}
