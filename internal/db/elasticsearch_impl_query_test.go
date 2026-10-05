//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestESMockIntegration 使用完整 mock 服务器的集成测试。
func TestESMockIntegration(t *testing.T) {
	// 构造完整的 mock mapping 响应
	mappingData := buildMockESMappingResponse("products", map[string]string{
		"name":        "text",
		"price":       "float",
		"in_stock":    "boolean",
		"created_at":  "date",
		"description": "text",
	})

	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		switch {
		// Ping
		case r.Method == http.MethodHead && path == "/":
			w.WriteHeader(http.StatusOK)

		// Cat.Indices — 仅返回索引名，兼容 ES 6/7/8。
		case r.Method == http.MethodGet && path == "/_cat/indices":
			writeJSON(w, []map[string]string{
				{"index": "products"},
				{"index": "orders"},
				{"index": ".internal"},
			})

		// 完整索引定义响应可能过大，列表加载不应请求该端点。
		case r.Method == http.MethodGet && path == "/*":
			w.WriteHeader(http.StatusForbidden)

		// Indices.GetAlias — 返回别名映射
		case strings.Contains(path, "/_alias") && r.Method == http.MethodGet:
			writeJSON(w, map[string]interface{}{
				"products": map[string]interface{}{
					"aliases": map[string]interface{}{
						"products-alias": map[string]interface{}{},
					},
				},
				"orders":    map[string]interface{}{"aliases": map[string]interface{}{}},
				".internal": map[string]interface{}{"aliases": map[string]interface{}{}},
			})

		// Mapping
		case strings.HasSuffix(path, "/_mapping"):
			writeJSON(w, mappingData)

		// Settings
		case strings.HasSuffix(path, "/_settings"):
			writeJSON(w, map[string]map[string]interface{}{
				"products": {
					"settings": map[string]interface{}{
						"index": map[string]interface{}{
							"number_of_shards":   "1",
							"number_of_replicas": "1",
						},
					},
				},
			})

		// GetCreateStatement
		case r.Method == http.MethodGet && !strings.Contains(path, "_"):
			writeJSON(w, map[string]interface{}{
				"products": map[string]interface{}{
					"settings": map[string]interface{}{"index": map[string]interface{}{"number_of_shards": "1"}},
					"mappings": map[string]interface{}{"properties": map[string]interface{}{"name": map[string]interface{}{"type": "text"}}},
				},
			})

		// Search
		case r.Method == http.MethodPost && strings.HasSuffix(path, "/_search"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"hits": {
					"total": {"value": 3},
					"hits": [
						{"_index": "products", "_id": "1", "_source": {"name": "商品A", "price": 99.9}},
						{"_index": "products", "_id": "2", "_source": {"name": "商品B", "price": 199.9}},
						{"_index": "products", "_id": "3", "_source": {"name": "商品C", "price": 299.9}}
					]
				}
			}`))

		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestESDB(t, server.URL, "products")

	// 验证 Ping
	if err := db.Ping(); err != nil {
		t.Fatalf("Ping 失败：%v", err)
	}

	// 验证 GetDatabases（应返回全部索引包括系统索引）
	databases, err := db.GetDatabases()
	if err != nil {
		t.Fatalf("GetDatabases 失败：%v", err)
	}
	slices.Sort(databases)
	if len(databases) != 3 || databases[0] != ".internal" || databases[1] != "orders" || databases[2] != "products" {
		t.Fatalf("GetDatabases 期望 [.internal, orders, products]，实际：%v", databases)
	}

	// 验证 GetTables（应返回索引名和别名）
	tables, err := db.GetTables("")
	if err != nil {
		t.Fatalf("GetTables 失败：%v", err)
	}
	if len(tables) < 1 || tables[0] != "products" {
		t.Fatalf("GetTables 第一个元素应为 products，实际：%v", tables)
	}
	hasAlias := false
	for _, tbl := range tables {
		if tbl == "products-alias" {
			hasAlias = true
		}
	}
	if !hasAlias {
		t.Fatalf("GetTables 应包含别名 products-alias，实际：%v", tables)
	}

	// 验证 GetColumns
	columns, err := db.GetColumns("products", "")
	if err != nil {
		t.Fatalf("GetColumns 失败：%v", err)
	}
	if len(columns) != 6 { // _id + 5 个 mapping 字段
		t.Fatalf("GetColumns 期望 6 个字段，实际 %d", len(columns))
	}

	// 验证 DSL 查询
	rows, _, err := db.Query(`{"query":{"match_all":{}}}`)
	if err != nil {
		t.Fatalf("DSL 查询失败：%v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("DSL 查询期望 3 条结果，实际 %d", len(rows))
	}

	// 验证 query_string 查询
	rows, _, err = db.Query("商品")
	if err != nil {
		t.Fatalf("query_string 查询失败：%v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("query_string 查询期望 3 条结果，实际 %d", len(rows))
	}

	// 验证 GetCreateStatement
	stmt, err := db.GetCreateStatement("products", "")
	if err != nil {
		t.Fatalf("GetCreateStatement 失败：%v", err)
	}
	if !strings.Contains(stmt, "products") {
		t.Fatalf("GetCreateStatement 应包含索引名，实际：%s", stmt)
	}

	// 验证 Exec 不支持
	_, err = db.Exec("DELETE products")
	if err == nil || !strings.Contains(err.Error(), "不支持") {
		t.Fatalf("Exec 应返回不支持错误，实际：%v", err)
	}

	// 验证 GetForeignKeys / GetTriggers 返回空
	fks, _ := db.GetForeignKeys("products", "")
	if len(fks) != 0 {
		t.Fatalf("GetForeignKeys 应返回空，实际：%d", len(fks))
	}
	triggers, _ := db.GetTriggers("products", "")
	if len(triggers) != 0 {
		t.Fatalf("GetTriggers 应返回空，实际：%d", len(triggers))
	}
}

// TestElasticsearchQueryConsole 测试 DevTools 风格查询端到端。
func TestElasticsearchQueryConsole(t *testing.T) {
	t.Run("DevTools 格式查询能正确执行", func(t *testing.T) {
		var capturedMethod, capturedPath string
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			capturedMethod = r.Method
			capturedPath = r.URL.Path

			if r.Method == http.MethodGet && r.URL.Path == "/test-index/_search" {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{
					"hits": {
						"total": {"value": 1},
						"hits": [
							{"_index": "test-index", "_id": "1", "_source": {"name": "测试文档"}}
						]
					}
				}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "test-index")

		// 模拟 DevTools 格式查询
		consoleQuery := "GET /test-index/_search\n{\"query\":{\"match_all\":{}}}"
		rows, _, err := db.Query(consoleQuery)
		if err != nil {
			t.Fatalf("DevTools 查询失败：%v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("期望 1 条结果，实际 %d", len(rows))
		}
		if rows[0]["name"] != "测试文档" {
			t.Fatalf("期望 name=测试文档，实际：%v", rows[0]["name"])
		}

		// 验证请求路径正确
		if capturedMethod != "GET" {
			t.Fatalf("请求方法期望 GET，实际：%q", capturedMethod)
		}
		if capturedPath != "/test-index/_search" {
			t.Fatalf("请求路径期望 /test-index/_search，实际：%q", capturedPath)
		}
	})

	t.Run("带 index 的 DevTools 查询", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodGet && r.URL.Path == "/my-index/_search" {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"hits":{"total":{"value":0},"hits":[]}}`))
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "default-index")
		query := "GET /my-index/_search\n{\"query\":{\"match_all\":{}}}"
		rows, _, err := db.Query(query)
		if err != nil {
			t.Fatalf("查询失败：%v", err)
		}
		if len(rows) != 0 {
			t.Fatalf("期望 0 条结果，实际 %d", len(rows))
		}
	})
}

// TestElasticsearchAggregations 测试 aggregation 结果展示。
func TestElasticsearchAggregations(t *testing.T) {
	t.Run("仅有 aggregations 无 hits", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"hits": {
					"total": {"value": 0},
					"hits": []
				},
				"aggregations": {
					"status_count": {
						"buckets": [
							{"key": "active", "doc_count": 42},
							{"key": "inactive", "doc_count": 8}
						]
					}
				}
			}`))
		})

		db := newTestESDB(t, server.URL, "test-index")
		rows, columns, err := db.Query(`{"aggs":{"status_count":{"terms":{"field":"status"}}}}`)
		if err != nil {
			t.Fatalf("聚合查询失败：%v", err)
		}

		// hits 为空时应仍返回 _aggregations 行
		if len(rows) < 1 {
			t.Fatal("聚合结果不应为空，至少应包含 _aggregations 行")
		}

		// 验证列中包含 _aggregations 标识
		hasAgg := false
		for _, col := range columns {
			if col == "_aggregations" {
				hasAgg = true
			}
		}
		if !hasAgg {
			t.Fatalf("结果列应包含 _aggregations，实际：%v", columns)
		}
	})

	t.Run("hits 和 aggregations 同时存在", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"hits": {
					"total": {"value": 2},
					"hits": [
						{"_index": "test", "_id": "1", "_source": {"status": "active"}},
						{"_index": "test", "_id": "2", "_source": {"status": "active"}}
					]
				},
				"aggregations": {
					"avg_score": {
						"value": 85.5
					}
				}
			}`))
		})

		db := newTestESDB(t, server.URL, "test-index")
		rows, columns, err := db.Query(`{"aggs":{"avg_score":{"avg":{"field":"score"}}}}`)
		if err != nil {
			t.Fatalf("聚合查询失败：%v", err)
		}

		// 应包含 hits 数据
		if len(rows) < 2 {
			t.Fatalf("期望至少 2 条 hits 结果，实际 %d", len(rows))
		}

		// 验证列中包含 _aggregations
		hasAgg := false
		for _, col := range columns {
			if col == "_aggregations" {
				hasAgg = true
			}
		}
		if !hasAgg {
			t.Fatalf("结果列应包含 _aggregations，实际：%v", columns)
		}
	})
}

// TestESAPIKeyAuth 测试 API Key 认证配置。
func TestESAPIKeyAuth(t *testing.T) {
	t.Run("ConnectionParams 中的 apiKey 应设置到配置", func(t *testing.T) {
		cfg := buildESClientConfig(connection.ConnectionConfig{
			Host:             "localhost",
			Port:             9200,
			ConnectionParams: "apiKey=test-key-123",
		})
		if cfg.APIKey != "test-key-123" {
			t.Fatalf("APIKey 期望 test-key-123，实际：%q", cfg.APIKey)
		}
	})

	t.Run("使用 API Key 时 Basic Auth 应被清除", func(t *testing.T) {
		cfg := buildESClientConfig(connection.ConnectionConfig{
			Host:             "localhost",
			Port:             9200,
			User:             "elastic",
			Password:         "pass",
			ConnectionParams: "apiKey=test-key-123",
		})
		if cfg.APIKey != "test-key-123" {
			t.Fatalf("APIKey 期望 test-key-123，实际：%q", cfg.APIKey)
		}
		if cfg.Username != "" {
			t.Fatalf("使用 API Key 时 Username 应为空，实际：%q", cfg.Username)
		}
		if cfg.Password != "" {
			t.Fatalf("使用 API Key 时 Password 应为空，实际：%q", cfg.Password)
		}
	})
}

// TestElasticsearchSourceFlatten 测试 _source 嵌套对象扁平化端到端。
func TestElasticsearchSourceFlatten(t *testing.T) {
	t.Run("嵌套对象在结果中扁平化", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{
				"hits": {
					"total": {"value": 1},
					"hits": [
						{
							"_index": "test-index",
							"_id": "1",
							"_source": {
								"user": {"name": "张三", "age": 18},
								"title": "测试"
							}
						}
					]
				}
			}`))
		})

		db := newTestESDB(t, server.URL, "test-index")
		rows, columns, err := db.Query(`{"query":{"match_all":{}}}`)
		if err != nil {
			t.Fatalf("查询失败：%v", err)
		}
		if len(rows) != 1 {
			t.Fatalf("期望 1 条结果，实际 %d", len(rows))
		}

		// 验证扁平化字段存在
		if rows[0]["user.name"] != "张三" {
			t.Fatalf("user.name 期望 张三，实际：%v", rows[0]["user.name"])
		}
		// JSON 数字解析为 float64
		if age, ok := rows[0]["user.age"].(float64); !ok || age != 18 {
			t.Fatalf("user.age 期望 18，实际：%v (类型：%T)", rows[0]["user.age"], rows[0]["user.age"])
		}
		if rows[0]["title"] != "测试" {
			t.Fatalf("title 期望 测试，实际：%v", rows[0]["title"])
		}

		// 验证列中包含扁平化字段
		colSet := make(map[string]bool)
		for _, col := range columns {
			colSet[col] = true
		}
		if !colSet["user.name"] {
			t.Fatalf("列应包含 user.name，实际：%v", columns)
		}
		if !colSet["user.age"] {
			t.Fatalf("列应包含 user.age，实际：%v", columns)
		}

		// 验证 _source 原始 JSON 保留（序列化为 JSON 字符串）
		sourceRaw, ok := rows[0]["_source"]
		if !ok {
			t.Fatal("结果应包含 _source 原始 JSON")
		}
		sourceStr, ok := sourceRaw.(string)
		if !ok {
			t.Fatalf("_source 应为 JSON 字符串类型，实际类型：%T", sourceRaw)
		}
		var sourceMap map[string]interface{}
		if err := json.Unmarshal([]byte(sourceStr), &sourceMap); err != nil {
			t.Fatalf("_source JSON 解析失败：%v", err)
		}
		if _, hasNested := sourceMap["user"]; !hasNested {
			t.Fatal("_source 原始 JSON 中应保留嵌套结构 user")
		}
	})
}

func TestElasticsearchSQLSelectDoesNotRequireXPackSQL(t *testing.T) {
	var capturedPath string
	var capturedBody string
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/_search") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		capturedPath = r.URL.Path
		body, _ := io.ReadAll(r.Body)
		capturedBody = string(body)
		if strings.Contains(capturedBody, "query_string") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"hits":{"total":{"value":0},"hits":[]}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"hits": {
				"total": {"value": 1},
				"hits": [
					{"_index": "products", "_id": "1", "_source": {"name": "商品A", "price": 99.9}}
				]
			}
		}`))
	})

	db := newTestESDB(t, server.URL, "")
	rows, columns, err := db.Query(`SELECT * FROM "products";`)
	if err != nil {
		t.Fatalf("ES SQL 查询应通过 _search 转换执行成功：%v", err)
	}
	if capturedPath != "/products/_search" {
		t.Fatalf("ES SQL 查询应转为 products/_search，不应依赖 _sql，实际路径：%s", capturedPath)
	}
	if strings.Contains(capturedBody, "query_string") {
		t.Fatalf("SELECT 查询不应降级为 query_string，实际请求体：%s", capturedBody)
	}
	if len(rows) != 1 || rows[0]["name"] != "商品A" {
		t.Fatalf("期望返回 products 命中数据，实际 rows=%#v columns=%v", rows, columns)
	}
}

func TestElasticsearchLegacyQueryEntryRejectsURLLikeTargetsBeforeNetwork(t *testing.T) {
	requestCount := 0
	server := newMockESServer(t, func(w http.ResponseWriter, _ *http.Request) {
		requestCount++
		w.WriteHeader(http.StatusInternalServerError)
	})
	database := newTestESDB(t, server.URL, "orders")
	for _, query := range []string{
		`SELECT * FROM "orders/_delete_by_query?pretty=true#"`,
		`SELECT * FROM "remote:index"`,
		"POST /orders/_refresh?pretty=true#/_search\n{}",
	} {
		if _, _, err := database.Query(query); err == nil {
			t.Fatalf("unsafe legacy query unexpectedly succeeded: %q", query)
		}
	}
	if requestCount != 0 {
		t.Fatalf("unsafe legacy queries reached Elasticsearch %d times", requestCount)
	}
}

func TestElasticsearchSQLWhereWithTrailingSemicolonPreservesNumericRange(t *testing.T) {
	var capturedBody string
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/log_manage_entity_v2/_search" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		body, _ := io.ReadAll(r.Body)
		capturedBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"hits": {
				"total": {"value": 1},
				"hits": [
					{"_index": "log_manage_entity_v2", "_id": "1", "_source": {"operateTime": 1782282529001, "message": "ok"}}
				]
			}
		}`))
	})

	db := newTestESDB(t, server.URL, "")
	rows, _, err := db.Query(`select * from log_manage_entity_v2 where operateTime > 1782282529000;`)
	if err != nil {
		t.Fatalf("带分号的 ES SQL 查询应执行成功：%v", err)
	}
	if len(rows) != 1 || rows[0]["message"] != "ok" {
		t.Fatalf("期望返回 1 条命中数据，实际 rows=%#v", rows)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(capturedBody), &payload); err != nil {
		t.Fatalf("解析发往 ES 的请求体失败：%v body=%s", err, capturedBody)
	}
	query, _ := payload["query"].(map[string]interface{})
	rangeNode, _ := query["range"].(map[string]interface{})
	fieldNode, _ := rangeNode["operateTime"].(map[string]interface{})
	gtValue, exists := fieldNode["gt"]
	if !exists {
		t.Fatalf("期望生成 range.gt 条件，实际 payload=%v", payload)
	}
	if _, ok := gtValue.(float64); !ok {
		t.Fatalf("operateTime.gt 应保持为数值，实际类型=%T 值=%v body=%s", gtValue, gtValue, capturedBody)
	}
	if gtValue.(float64) != 1782282529000 {
		t.Fatalf("operateTime.gt 数值错误，实际=%v body=%s", gtValue, capturedBody)
	}
}
