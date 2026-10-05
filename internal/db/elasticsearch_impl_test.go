//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

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

func TestElasticsearchApplyChangesUsesAliasWriteIndexDespiteChangeSetIndex(t *testing.T) {
	const alias = "events"
	const writeIndex = "events-live"
	const archivedIndex = "events-archive"

	server := newMockESServer(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/_alias/"+alias:
			writeJSON(w, map[string]interface{}{
				archivedIndex: map[string]interface{}{"aliases": map[string]interface{}{
					alias: map[string]interface{}{"is_write_index": false},
				}},
				writeIndex: map[string]interface{}{"aliases": map[string]interface{}{
					alias: map[string]interface{}{"is_write_index": true},
				}},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/_bulk":
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Errorf("读取 bulk 请求失败：%v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			lines := strings.Split(strings.TrimSpace(string(body)), "\n")
			if len(lines) != 5 {
				t.Errorf("unexpected bulk NDJSON line count: got %d want 5, body=%q", len(lines), body)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for _, expected := range []struct {
				line      int
				operation string
				id        string
			}{
				{line: 0, operation: "delete", id: "deleted"},
				{line: 1, operation: "update", id: "updated"},
				{line: 3, operation: "index", id: "inserted"},
			} {
				var action map[string]map[string]interface{}
				if err := json.Unmarshal([]byte(lines[expected.line]), &action); err != nil {
					t.Errorf("解析 bulk action 失败：%v", err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				metadata, ok := action[expected.operation]
				if !ok || len(action) != 1 {
					t.Errorf("bulk action line %d: got %v, want only %q", expected.line, action, expected.operation)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if got, _ := metadata["_id"].(string); got != expected.id {
					t.Errorf("%s action used _id %q, want %q", expected.operation, got, expected.id)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if got, _ := metadata["_index"].(string); got != writeIndex {
					t.Errorf("%s action wrote to %q, want alias write index %q", expected.operation, got, writeIndex)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
			}
			writeJSON(w, map[string]interface{}{"errors": false, "items": []interface{}{}})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	db := newTestESDB(t, server.URL, alias)
	err := db.ApplyChanges(alias, connection.ChangeSet{
		Deletes: []map[string]interface{}{{"_id": "deleted", "_index": archivedIndex}},
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"_id": "updated"},
			Values: map[string]interface{}{"message": "updated", "_index": archivedIndex},
		}},
		Inserts: []map[string]interface{}{{"_id": "inserted", "message": "inserted", "_index": archivedIndex}},
	})
	if err != nil {
		t.Fatalf("ApplyChanges returned error: %v", err)
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

// ---- 辅助函数测试 ----

// ---- P1 功能测试 ----

// ---- extractESSQLFromTable 测试 ----

// ---- parseESSQL 测试 ----
