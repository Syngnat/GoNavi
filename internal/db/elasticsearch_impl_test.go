//go:build gonavi_full_drivers || gonavi_elasticsearch_driver

package db

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"

	"github.com/elastic/go-elasticsearch/v8"
)

// ---- 测试辅助函数 ----

// newMockESServer 创建模拟 Elasticsearch REST API 的 HTTP 测试服务器。
// 自动为所有响应添加 go-elasticsearch v8 客户端要求的 X-Elastic-Product 头。
func newMockESServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	return server
}

// newTestESDB 创建连接到测试服务器的 ElasticsearchDB 实例。
func newTestESDB(t *testing.T, serverURL, defaultIndex string) *ElasticsearchDB {
	t.Helper()
	cfg := elasticsearch.Config{
		Addresses: []string{serverURL},
		Transport: &esProductCheckBypassTransport{inner: http.DefaultTransport},
	}
	client, err := elasticsearch.NewClient(cfg)
	if err != nil {
		t.Fatalf("创建测试 ES 客户端失败: %v", err)
	}
	consoleCfg := cfg
	consoleCfg.DisableRetry = true
	consoleCfg.MaxRetries = 0
	consoleCfg.RetryOnStatus = nil
	consoleCfg.RetryOnError = nil
	consoleClient, err := elasticsearch.NewClient(consoleCfg)
	if err != nil {
		t.Fatalf("创建测试 ES Console 客户端失败: %v", err)
	}
	return &ElasticsearchDB{
		client:        client,
		consoleClient: consoleClient,
		database:      defaultIndex,
	}
}

func TestBuildESClientConfigSeparatesConnectionAndRequestTimeout(t *testing.T) {
	config := buildESClientConfig(connection.ConnectionConfig{
		Type:    "elasticsearch",
		Host:    "127.0.0.1",
		Port:    defaultEsPort,
		Timeout: 1,
	})
	wrapped, ok := config.Transport.(*esProductCheckBypassTransport)
	if !ok {
		t.Fatalf("expected product-check transport wrapper, got %T", config.Transport)
	}
	transport, ok := wrapped.inner.(*http.Transport)
	if !ok {
		t.Fatalf("expected HTTP transport, got %T", wrapped.inner)
	}
	if transport.ResponseHeaderTimeout != 0 {
		t.Fatalf("connection timeout leaked into Elasticsearch response timeout: %s", transport.ResponseHeaderTimeout)
	}
	if transport.DialContext == nil {
		t.Fatal("expected bounded connection dial")
	}
}

func TestElasticsearchApplyChangesResolvesWriteAliasMetadata(t *testing.T) {
	testCases := []struct {
		name          string
		target        string
		aliasPath     string
		aliasStatus   int
		aliasResponse map[string]interface{}
		wantIndex     string
		wantErr       string
	}{
		{
			name:      "unique write index",
			target:    "events",
			aliasPath: "/_alias/events",
			aliasResponse: map[string]interface{}{
				"events-000001": map[string]interface{}{"aliases": map[string]interface{}{
					"events": map[string]interface{}{"is_write_index": false},
				}},
				"events-000002": map[string]interface{}{"aliases": map[string]interface{}{
					"events": map[string]interface{}{"is_write_index": true},
				}},
			},
			wantIndex: "events-000002",
		},
		{
			name:      "missing write index",
			target:    "events",
			aliasPath: "/_alias/events",
			aliasResponse: map[string]interface{}{
				"events-000001": map[string]interface{}{"aliases": map[string]interface{}{
					"events": map[string]interface{}{},
				}},
				"events-000002": map[string]interface{}{"aliases": map[string]interface{}{
					"events": map[string]interface{}{"is_write_index": false},
				}},
			},
			wantErr: "is_write_index=true",
		},
		{
			name:      "conflicting write indexes",
			target:    "events",
			aliasPath: "/_alias/events",
			aliasResponse: map[string]interface{}{
				"events-000001": map[string]interface{}{"aliases": map[string]interface{}{
					"events": map[string]interface{}{"is_write_index": true},
				}},
				"events-000002": map[string]interface{}{"aliases": map[string]interface{}{
					"events": map[string]interface{}{"is_write_index": true},
				}},
			},
			wantErr: "is_write_index=true",
		},
		{
			name:        "direct index",
			target:      "events-000002",
			aliasPath:   "/_alias/events-000002",
			aliasStatus: http.StatusNotFound,
			wantIndex:   "events-000002",
		},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			var bulkCalls atomic.Int32
			var bulkIndex string
			server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
				switch {
				case r.Method == http.MethodGet:
					if r.URL.Path != tc.aliasPath {
						t.Errorf("unexpected alias metadata path: got %q want %q", r.URL.Path, tc.aliasPath)
						w.WriteHeader(http.StatusInternalServerError)
						return
					}
					if tc.aliasStatus != 0 {
						w.WriteHeader(tc.aliasStatus)
						return
					}
					writeJSON(w, tc.aliasResponse)
				case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
					bulkCalls.Add(1)
					body, err := io.ReadAll(r.Body)
					if err != nil {
						t.Errorf("读取 bulk 请求失败：%v", err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					var action map[string]map[string]interface{}
					if err := json.Unmarshal([]byte(strings.SplitN(strings.TrimSpace(string(body)), "\n", 2)[0]), &action); err != nil {
						t.Errorf("解析 bulk action 失败：%v", err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					bulkIndex, _ = action["index"]["_index"].(string)
					writeJSON(w, map[string]interface{}{"errors": false, "items": []interface{}{map[string]interface{}{"index": map[string]interface{}{"status": 201}}}})
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			})

			db := newTestESDB(t, server.URL, tc.target)
			err := db.ApplyChanges(tc.target, connection.ChangeSet{
				Inserts: []map[string]interface{}{{"message": "hello"}},
			})
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("expected error containing %q, got %v", tc.wantErr, err)
				}
				if bulkCalls.Load() != 0 {
					t.Fatalf("bulk must not run after alias validation failure, calls=%d", bulkCalls.Load())
				}
				return
			}
			if err != nil {
				t.Fatalf("ApplyChanges returned error: %v", err)
			}
			if bulkCalls.Load() != 1 || bulkIndex != tc.wantIndex {
				t.Fatalf("expected one bulk write to %q, calls=%d index=%q", tc.wantIndex, bulkCalls.Load(), bulkIndex)
			}
		})
	}
}

// buildMockESMappingResponse 构造模拟的 mapping 响应 JSON。
func buildMockESMappingResponse(indexName string, fields map[string]string) map[string]interface{} {
	properties := make(map[string]interface{})
	for name, fieldType := range fields {
		properties[name] = map[string]interface{}{"type": fieldType}
	}
	return map[string]interface{}{
		indexName: map[string]interface{}{
			"mappings": map[string]interface{}{
				"properties": properties,
			},
		},
	}
}

// writeJSON 将数据以 JSON 格式写入 HTTP 响应。
func writeJSON(w http.ResponseWriter, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(data)
}

// ---- 核心功能测试 ----

// TestElasticsearchPing 测试 Ping 成功和失败路径。
func TestElasticsearchPing(t *testing.T) {
	t.Run("ping 成功", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			// Ping 使用 HEAD / 方法
			if r.Method == http.MethodHead && r.URL.Path == "/" {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.WriteHeader(http.StatusNotFound)
		})

		db := newTestESDB(t, server.URL, "")
		if err := db.Ping(); err != nil {
			t.Fatalf("Ping 应成功，但返回错误：%v", err)
		}
	})

	t.Run("ping 服务端返回错误", func(t *testing.T) {
		server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		})

		db := newTestESDB(t, server.URL, "")
		err := db.Ping()
		if err == nil {
			t.Fatal("Ping 服务端 500 时应返回错误")
		}
		if !strings.Contains(err.Error(), "500") {
			t.Fatalf("错误信息应包含状态码，实际：%v", err)
		}
	})
}

func TestElasticsearchConnectOnlyRequiresPing(t *testing.T) {
	var aliasListingRequested atomic.Bool
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodHead && r.URL.Path == "/":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodGet && r.URL.Path == "/*/_alias":
			aliasListingRequested.Store(true)
			w.WriteHeader(http.StatusForbidden)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	host, port, ok := parseHostPortWithDefault(strings.TrimPrefix(server.URL, "http://"), defaultEsPort)
	if !ok {
		t.Fatalf("无法解析测试服务器地址：%s", server.URL)
	}

	db := &ElasticsearchDB{}
	if err := db.Connect(connection.ConnectionConfig{
		Type:    "elasticsearch",
		Host:    host,
		Port:    port,
		Timeout: 2,
	}); err != nil {
		t.Fatalf("Connect 应只验证服务连通性，不应被索引枚举权限影响：%v", err)
	}
	if aliasListingRequested.Load() {
		t.Fatal("Connect 不应在连接测试阶段枚举全部索引")
	}
}

func TestElasticsearchConnectRejectsFailedPing(t *testing.T) {
	var aliasListingRequested atomic.Bool
	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodHead && r.URL.Path == "/":
			w.WriteHeader(http.StatusServiceUnavailable)
		case r.Method == http.MethodGet && r.URL.Path == "/*/_alias":
			aliasListingRequested.Store(true)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	host, port, ok := parseHostPortWithDefault(strings.TrimPrefix(server.URL, "http://"), defaultEsPort)
	if !ok {
		t.Fatalf("无法解析测试服务器地址：%s", server.URL)
	}

	db := &ElasticsearchDB{}
	err := db.Connect(connection.ConnectionConfig{
		Type:    "elasticsearch",
		Host:    host,
		Port:    port,
		Timeout: 2,
	})
	if err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("Connect 应保留 Ping 失败，实际：%v", err)
	}
	if aliasListingRequested.Load() {
		t.Fatal("Ping 失败后不应继续枚举索引")
	}
}

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

// ---- 辅助函数测试 ----

// TestNormalizeElasticsearchConfig 测试配置规范化。
func TestNormalizeElasticsearchConfig(t *testing.T) {
	t.Run("设置默认值", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type: "elasticsearch",
		})
		if config.Host != "localhost" {
			t.Fatalf("默认 Host 期望 localhost，实际：%q", config.Host)
		}
		if config.Port != defaultEsPort {
			t.Fatalf("默认 Port 期望 %d，实际：%d", defaultEsPort, config.Port)
		}
		if config.User != "" {
			t.Fatalf("默认 User 期望空字符串，实际：%q", config.User)
		}
	})

	t.Run("保留用户设置", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type:     "elasticsearch",
			Host:     "es.example.com",
			Port:     9201,
			User:     "admin",
			Password: "secret",
		})
		if config.Host != "es.example.com" {
			t.Fatalf("Host 期望 es.example.com，实际：%q", config.Host)
		}
		if config.Port != 9201 {
			t.Fatalf("Port 期望 9201，实际：%d", config.Port)
		}
		if config.User != "admin" {
			t.Fatalf("User 期望 admin，实际：%q", config.User)
		}
	})

	t.Run("从 URI 中提取配置", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type: "elasticsearch",
			URI:  "http://uri-user:uri-pass@es-host:9202",
		})
		if config.User != "uri-user" {
			t.Fatalf("User 期望从 URI 提取 uri-user，实际：%q", config.User)
		}
		if config.Password != "uri-pass" {
			t.Fatalf("Password 期望从 URI 提取 uri-pass，实际：%q", config.Password)
		}
		if config.Host != "es-host" {
			t.Fatalf("Host 期望从 URI 提取 es-host，实际：%q", config.Host)
		}
		if config.Port != 9202 {
			t.Fatalf("Port 期望从 URI 提取 9202，实际：%d", config.Port)
		}
	})

	t.Run("已有 Host 时不从 URI 覆盖", func(t *testing.T) {
		config := normalizeElasticsearchConfig(connection.ConnectionConfig{
			Type: "elasticsearch",
			Host: "custom-host",
			URI:  "http://uri-user:uri-pass@uri-host:9200",
		})
		if config.Host != "custom-host" {
			t.Fatalf("已有 Host 时不应覆盖，期望 custom-host，实际：%q", config.Host)
		}
	})
}

// TestApplyElasticsearchURI 测试 URI 解析。
func TestApplyElasticsearchURI(t *testing.T) {
	t.Run("HTTPS URI 启用 SSL", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			URI: "https://user:pass@es.example.com:9200",
		})
		if !config.UseSSL {
			t.Fatal("HTTPS URI 应启用 SSL")
		}
		if config.SSLMode != "required" {
			t.Fatalf("SSLMode 期望 required，实际：%q", config.SSLMode)
		}
		if config.Host != "es.example.com" {
			t.Fatalf("Host 期望 es.example.com，实际：%q", config.Host)
		}
	})

	t.Run("非 HTTP 协议忽略", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			URI: "tcp://localhost:9200",
		})
		if config.Host != "" {
			t.Fatalf("非 HTTP 协议不应设置 Host，实际：%q", config.Host)
		}
	})

	t.Run("空 URI 不修改配置", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			Host: "original-host",
			Port: 9300,
		})
		if config.Host != "original-host" || config.Port != 9300 {
			t.Fatal("空 URI 不应修改原有配置")
		}
	})

	t.Run("已有用户凭证不被 URI 覆盖", func(t *testing.T) {
		config := applyElasticsearchURI(connection.ConnectionConfig{
			User:     "existing-user",
			Password: "existing-pass",
			URI:      "http://uri-user:uri-pass@localhost:9200",
		})
		if config.User != "existing-user" {
			t.Fatalf("已有 User 不应覆盖，期望 existing-user，实际：%q", config.User)
		}
		if config.Password != "existing-pass" {
			t.Fatalf("已有 Password 不应覆盖，期望 existing-pass，实际：%q", config.Password)
		}
	})
}

// TestExtractColumnsFromMapping 测试 mapping 字段提取。
func TestExtractColumnsFromMapping(t *testing.T) {
	t.Run("标准字段提取", func(t *testing.T) {
		mapping := map[string]interface{}{
			"test-index": map[string]interface{}{
				"mappings": map[string]interface{}{
					"properties": map[string]interface{}{
						"title": map[string]interface{}{"type": "text"},
						"count": map[string]interface{}{"type": "long"},
						"tags":  map[string]interface{}{"type": "keyword"},
					},
				},
			},
		}

		columns := extractColumnsFromMapping("test-index", mapping)
		if len(columns) != 4 {
			t.Fatalf("期望 4 个字段（含 _id），实际 %d", len(columns))
		}

		typeMap := make(map[string]string)
		for _, col := range columns {
			typeMap[col.Name] = col.Type
		}
		expectedTypes := map[string]string{"_id": "keyword", "title": "text", "count": "long", "tags": "keyword"}
		for name, expectedType := range expectedTypes {
			if typeMap[name] != expectedType {
				t.Fatalf("字段 %q 类型期望 %q，实际 %q", name, expectedType, typeMap[name])
			}
		}
	})

	t.Run("含 description 的字段提取注释", func(t *testing.T) {
		mapping := map[string]interface{}{
			"idx": map[string]interface{}{
				"mappings": map[string]interface{}{
					"properties": map[string]interface{}{
						"email": map[string]interface{}{
							"type":        "keyword",
							"description": "用户邮箱地址",
						},
					},
				},
			},
		}

		columns := extractColumnsFromMapping("idx", mapping)
		if len(columns) != 2 {
			t.Fatalf("期望 2 个字段（含 _id），实际 %d", len(columns))
		}
		var emailComment string
		for _, col := range columns {
			if col.Name == "email" {
				emailComment = col.Comment
				break
			}
		}
		if emailComment != "用户邮箱地址" {
			t.Fatalf("期望 email 注释 '用户邮箱地址'，实际：%q", emailComment)
		}
	})

	t.Run("空 mapping 返回空列表", func(t *testing.T) {
		mapping := map[string]interface{}{}
		columns := extractColumnsFromMapping("non-existent", mapping)
		if len(columns) != 0 {
			t.Fatalf("空 mapping 应返回空列表，实际 %d 个", len(columns))
		}
	})

	t.Run("索引数据无 mappings 字段", func(t *testing.T) {
		mapping := map[string]interface{}{
			"idx": map[string]interface{}{
				"settings": map[string]interface{}{},
			},
		}
		columns := extractColumnsFromMapping("idx", mapping)
		if len(columns) != 0 {
			t.Fatalf("无 mappings 时应返回空列表，实际 %d 个", len(columns))
		}
	})

	t.Run("从 mapping 响应中自动查找索引数据", func(t *testing.T) {
		// 模拟 ES 返回的 mapping 响应，键名不完全匹配（如带日期后缀的索引别名）
		mapping := map[string]interface{}{
			"logs-2024.01.01": map[string]interface{}{
				"mappings": map[string]interface{}{
					"properties": map[string]interface{}{
						"message": map[string]interface{}{"type": "text"},
					},
				},
			},
		}
		columns := extractColumnsFromMapping("non-matching-key", mapping)
		if len(columns) != 2 {
			t.Fatalf("应自动查找 mapping 数据，期望 2 个字段（含 _id），实际 %d 个", len(columns))
		}
	})
}

// TestIsJSONDSL 测试 JSON DSL 检测。
func TestIsJSONDSL(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{"JSON DSL", `{"query":{"match_all":{}}}`, true},
		{"简单字符串", "hello world", false},
		{"空字符串", "", false},
		{"JSON 对象以空格开头", `  {"query":{}}`, true},
		{"非查询 JSON 前缀", `[1,2,3]`, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isJSONDSL(tt.input); got != tt.expected {
				t.Fatalf("isJSONDSL(%q) = %v，期望 %v", tt.input, got, tt.expected)
			}
		})
	}
}

// TestExtractEsFieldType 测试字段类型提取。
func TestExtractEsFieldType(t *testing.T) {
	tests := []struct {
		name     string
		prop     interface{}
		expected string
	}{
		{
			name:     "标准字段类型",
			prop:     map[string]interface{}{"type": "keyword"},
			expected: "keyword",
		},
		{
			name:     "嵌套对象类型",
			prop:     map[string]interface{}{"properties": map[string]interface{}{}},
			expected: "object",
		},
		{
			name:     "无 type 无 properties",
			prop:     map[string]interface{}{"enabled": true},
			expected: "unknown",
		},
		{
			name:     "非 map 类型",
			prop:     "invalid",
			expected: "unknown",
		},
		{
			name:     "nil 值",
			prop:     nil,
			expected: "unknown",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractEsFieldType(tt.prop); got != tt.expected {
				t.Fatalf("extractEsFieldType() = %q，期望 %q", got, tt.expected)
			}
		})
	}
}

// TestResolveEsIndexName 测试索引名解析。
func TestResolveEsIndexName(t *testing.T) {
	tests := []struct {
		name      string
		dbName    string
		tableName string
		defaultDB string
		expected  string
	}{
		{
			name:      "优先使用 tableName",
			dbName:    "db1",
			tableName: "tbl1",
			defaultDB: "default",
			expected:  "tbl1",
		},
		{
			name:      "回退到 dbName",
			dbName:    "db1",
			tableName: "",
			defaultDB: "default",
			expected:  "db1",
		},
		{
			name:      "回退到默认值",
			dbName:    "",
			tableName: "",
			defaultDB: "default",
			expected:  "default",
		},
		{
			name:      "全部为空",
			dbName:    "",
			tableName: "",
			defaultDB: "",
			expected:  "",
		},
		{
			name:      "空白字符等同于空",
			dbName:    "  ",
			tableName: "  ",
			defaultDB: "default",
			expected:  "default",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := resolveEsIndexName(tt.dbName, tt.tableName, tt.defaultDB)
			if got != tt.expected {
				t.Fatalf("resolveEsIndexName(%q, %q, %q) = %q，期望 %q",
					tt.dbName, tt.tableName, tt.defaultDB, got, tt.expected)
			}
		})
	}
}

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

// ---- P1 功能测试 ----

// TestParseESConsoleRequest 测试 DevTools 风格查询解析。
func TestParseESConsoleRequest(t *testing.T) {
	t.Run("带 body 的 GET 请求", func(t *testing.T) {
		input := "GET /logs-*/_search\n{\"query\":{\"match_all\":{}}}"
		req, ok := parseESConsoleRequest(input)
		if !ok {
			t.Fatal("解析应成功")
		}
		if req.Method != "GET" {
			t.Fatalf("方法期望 GET，实际：%q", req.Method)
		}
		if req.Path != "/logs-*/_search" {
			t.Fatalf("路径期望 /logs-*/_search，实际：%q", req.Path)
		}
		if len(req.Body) == 0 {
			t.Fatal("body 不应为空")
		}
	})

	t.Run("带 body 的 POST 请求", func(t *testing.T) {
		input := "POST /orders/_search\n{\"size\":10}"
		req, ok := parseESConsoleRequest(input)
		if !ok {
			t.Fatal("解析应成功")
		}
		if req.Method != "POST" {
			t.Fatalf("方法期望 POST，实际：%q", req.Method)
		}
		if req.Path != "/orders/_search" {
			t.Fatalf("路径期望 /orders/_search，实际：%q", req.Path)
		}
		if len(req.Body) == 0 {
			t.Fatal("body 不应为空")
		}
	})

	t.Run("无 body 的 GET 请求", func(t *testing.T) {
		input := "GET /_cluster/health"
		req, ok := parseESConsoleRequest(input)
		if !ok {
			t.Fatal("解析应成功")
		}
		if req.Method != "GET" {
			t.Fatalf("方法期望 GET，实际：%q", req.Method)
		}
		if req.Path != "/_cluster/health" {
			t.Fatalf("路径期望 /_cluster/health，实际：%q", req.Path)
		}
		if len(req.Body) != 0 {
			t.Fatalf("无 body 时应为空，实际长度：%d", len(req.Body))
		}
	})

	t.Run("DELETE 方法应被拒绝", func(t *testing.T) {
		input := "DELETE /index"
		_, ok := parseESConsoleRequest(input)
		if ok {
			t.Fatal("DELETE 请求应解析失败")
		}
	})

	t.Run("纯 JSON 应被拒绝", func(t *testing.T) {
		input := "{\"query\":{\"match_all\":{}}}"
		_, ok := parseESConsoleRequest(input)
		if ok {
			t.Fatal("纯 JSON 不是 DevTools 格式，应解析失败")
		}
	})

	t.Run("SQL 语句应被拒绝", func(t *testing.T) {
		input := "select * from test"
		_, ok := parseESConsoleRequest(input)
		if ok {
			t.Fatal("SQL 语句不是 DevTools 格式，应解析失败")
		}
	})
}

// TestFlattenESSource 测试嵌套对象展开为点分路径。
func TestFlattenESSource(t *testing.T) {
	t.Run("嵌套对象展开", func(t *testing.T) {
		source := map[string]interface{}{
			"user": map[string]interface{}{
				"name": "张三",
				"age":  18,
			},
		}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		if row["user.name"] != "张三" {
			t.Fatalf("user.name 期望 张三，实际：%v", row["user.name"])
		}
		if row["user.age"] != 18 {
			t.Fatalf("user.age 期望 18，实际：%v", row["user.age"])
		}
		// 原始嵌套键不应保留
		if _, ok := row["user"]; ok {
			t.Fatal("展开后不应保留原始嵌套键 user")
		}
	})

	t.Run("数组序列化为 JSON 字符串", func(t *testing.T) {
		source := map[string]interface{}{
			"tags": []interface{}{"a", "b"},
		}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		tags, ok := row["tags"].(string)
		if !ok {
			t.Fatalf("tags 应序列化为 JSON 字符串，实际类型：%T", row["tags"])
		}
		if tags != `["a","b"]` {
			t.Fatalf("tags JSON 不匹配，实际：%v", tags)
		}
	})

	t.Run("多层嵌套展开", func(t *testing.T) {
		source := map[string]interface{}{
			"a": map[string]interface{}{
				"b": map[string]interface{}{
					"c": 1,
				},
			},
		}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		if row["a.b.c"] != 1 {
			t.Fatalf("a.b.c 期望 1，实际：%v", row["a.b.c"])
		}
		if _, ok := row["a"]; ok {
			t.Fatal("展开后不应保留原始嵌套键 a")
		}
		if _, ok := row["a.b"]; ok {
			t.Fatal("展开后不应保留中间嵌套键 a.b")
		}
	})

	t.Run("空对象返回空", func(t *testing.T) {
		source := map[string]interface{}{}
		row := make(map[string]interface{})
		flattenESSource("", source, row)

		if len(row) != 0 {
			t.Fatalf("空对象展开后应为空，实际长度：%d", len(row))
		}
	})
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

// ---- extractESSQLFromTable 测试 ----

func TestESExtractSQLFromTable(t *testing.T) {
	tests := []struct {
		name string
		sql  string
		want string
	}{
		{"简单表名", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 0`, "app_log_user"},
		{"无引号表名", `SELECT * FROM my_index LIMIT 10`, "my_index"},
		{"带点的表名", `SELECT * FROM "iot_pro_biz_operate_log.index.20240626" LIMIT 101`, "iot_pro_biz_operate_log.index.20240626"},
		{"通配符表名", `SELECT * FROM "logs-*" LIMIT 10`, "logs-*"},
		{"多段引号标识符", `SELECT * FROM "iot_pro_biz_operate_log"."index"."20250515" WHERE (("_score">45)) LIMIT 101 OFFSET 0`, "iot_pro_biz_operate_log.index.20250515"},
		{"两段引号标识符", `SELECT * FROM "my_schema"."my_table" LIMIT 10`, "my_schema.my_table"},
		{"带分号的引号表名", `SELECT * FROM "app_log_user";`, "app_log_user"},
		{"带分号的无引号表名", `SELECT * FROM my_index;`, "my_index"},
		{"非 SELECT 语句", `{"query": {"match_all": {}}}`, ""},
		{"空语句", ``, ""},
		{"FROM 语句片段", `FROM "test"`, "test"},
		{"FROM 后无表名", `SELECT * FROM`, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := extractESSQLFromTable(tt.sql)
			if got != tt.want {
				t.Fatalf("extractESSQLFromTable(%q) = %q, want %q", tt.sql, got, tt.want)
			}
		})
	}
}

// ---- parseESSQL 测试 ----

func TestESParseSQL(t *testing.T) {
	tests := []struct {
		name      string
		sql       string
		wantTable string
		wantLimit int
		wantOff   int
		wantOK    bool
	}{
		{"基础SELECT", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 0`, "app_log_user", 101, 0, true},
		{"带点索引名", `SELECT * FROM "iot.index.2024" LIMIT 200`, "iot.index.2024", 200, 0, true},
		{"多段引号", `SELECT * FROM "schema"."table" LIMIT 50 OFFSET 10`, "schema.table", 50, 10, true},
		{"无LIMIT", `SELECT * FROM "my_index"`, "my_index", 0, 0, true},
		{"带分号", `SELECT * FROM "my_index";`, "my_index", 0, 0, true},
		{"LIMIT 后带分号", `SELECT * FROM "my_index" LIMIT 100;`, "my_index", 100, 0, true},
		{"DSL JSON", `{"query": {"match_all": {}}}`, "", 0, 0, false},
		{"分页_第1页", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 0`, "app_log_user", 101, 0, true},
		{"分页_第2页", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 100`, "app_log_user", 101, 100, true},
		{"分页_第3页", `SELECT * FROM "app_log_user" LIMIT 101 OFFSET 200`, "app_log_user", 101, 200, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parsed, ok := parseESSQL(tt.sql)
			if ok != tt.wantOK {
				t.Fatalf("parseESSQL(%q) ok=%v want %v", tt.sql, ok, tt.wantOK)
			}
			if !tt.wantOK {
				return
			}
			if parsed.Table != tt.wantTable {
				t.Errorf("Table=%q want %q", parsed.Table, tt.wantTable)
			}
			if parsed.Limit != tt.wantLimit {
				t.Errorf("Limit=%d want %d", parsed.Limit, tt.wantLimit)
			}
			if parsed.Offset != tt.wantOff {
				t.Errorf("Offset=%d want %d", parsed.Offset, tt.wantOff)
			}
		})
	}
}

func TestESParseSQLTrimsTrailingSemicolonFromClauses(t *testing.T) {
	t.Run("WHERE 末尾分号不应进入条件值", func(t *testing.T) {
		parsed, ok := parseESSQL(`select * from log_manage_entity_v2 where operateTime > 1782282529000;`)
		if !ok {
			t.Fatal("parseESSQL 应成功解析带分号的 WHERE 查询")
		}
		if parsed.Where != "operateTime > 1782282529000" {
			t.Fatalf("WHERE 子句不应包含尾部分号，实际=%q", parsed.Where)
		}
	})

	t.Run("ORDER BY 末尾分号不应进入排序子句", func(t *testing.T) {
		parsed, ok := parseESSQL(`select * from log_manage_entity_v2 order by operateTime desc;`)
		if !ok {
			t.Fatal("parseESSQL 应成功解析带分号的 ORDER BY 查询")
		}
		if parsed.OrderBy != "operateTime desc" {
			t.Fatalf("ORDER BY 子句不应包含尾部分号，实际=%q", parsed.OrderBy)
		}
	})
}

func TestESConvertWhere(t *testing.T) {
	tests := []struct {
		name  string
		where string
		key   string
	}{
		{"等值", `"status" = 'active'`, "term"},
		{"范围", `"age" > 18`, "range"},
		{"score", `"_score" > 45`, "range"},
		{"AND", `"a" = '1' AND "b" > 2`, "bool"},
		{"OR", `"a" = '1' OR "b" = '2'`, "bool"},
		{"IS NULL", `"name" IS NULL`, "bool"},
		{"IS NOT NULL", `"name" IS NOT NULL`, "exists"},
		{"LIKE", `"name" LIKE 'test%'`, "wildcard"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := convertSQLWhereToESQuery(tt.where)
			if result == nil {
				t.Fatal("convertSQLWhereToESQuery returned nil")
			}
			if _, ok := result[tt.key]; !ok {
				keys := make([]string, 0, len(result))
				for k := range result {
					keys = append(keys, k)
				}
				t.Errorf("expected key %q, got %v", tt.key, keys)
			}
		})
	}
}
