//go:build gonavi_full_drivers || gonavi_opensearch_driver

package db

import (
	"context"
	"os"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestOpenSearchLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_OPENSEARCH_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := &OpenSearchDB{}
			if err := client.Connect(liveConfig(t, "opensearch", addr, "", "")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			if variant == "" || version == "" || client.ElasticsearchServerMajor() != openSearchCompatibleMajor {
				t.Fatalf("variant=%q version=%q major=%d", variant, version, client.ElasticsearchServerMajor())
			}

			console := func(method, path, body string) ElasticsearchConsoleResponse {
				t.Helper()
				kind := ElasticsearchConsoleBodyKindNone
				if body != "" {
					kind = ElasticsearchConsoleBodyKindJSON
				}
				response, err := client.ExecuteElasticsearchConsoleRequest(context.Background(), ElasticsearchConsoleRequest{Method: method, Path: path, Body: body, BodyKind: kind})
				if err != nil {
					t.Fatalf("%s %s: %v", method, path, err)
				}
				return response
			}
			console("DELETE", "/gonavi_os_orders", "")
			if response := console("PUT", "/gonavi_os_orders", `{"mappings":{"properties":{"sku":{"type":"keyword"},"qty":{"type":"integer"}}}}`); response.StatusCode != 200 {
				t.Fatalf("create index: %d %s", response.StatusCode, response.RawBody)
			}
			defer console("DELETE", "/gonavi_os_orders", "")
			console("PUT", "/gonavi_os_orders/_doc/1?refresh=true", `{"sku":"A-1","qty":3}`)
			console("PUT", "/gonavi_os_orders/_doc/2?refresh=true", `{"sku":"B-2","qty":5}`)

			databases, err := client.GetDatabases()
			if err != nil || !slices.Contains(databases, "gonavi_os_orders") {
				t.Fatalf("indices %v: %v", databases, err)
			}
			columns, err := client.GetColumns("gonavi_os_orders", "gonavi_os_orders")
			if err != nil || len(columns) < 2 {
				t.Fatalf("mapping columns %v: %v", columns, err)
			}

			rows, names, err := client.Query("POST /_plugins/_sql\n{\"query\": \"SELECT sku, qty FROM gonavi_os_orders ORDER BY qty\"}")
			if err != nil || len(rows) != 2 || !slices.Equal(names, []string{"sku", "qty"}) || rows[0]["sku"] != "A-1" || rows[1]["qty"] != int64(5) {
				t.Fatalf("sql rows %v columns %v: %v", rows, names, err)
			}
			rows, _, err = client.Query("POST /_plugins/_ppl\n{\"query\": \"source=gonavi_os_orders | where qty > 4 | fields sku\"}")
			if err != nil || len(rows) != 1 || rows[0]["sku"] != "B-2" {
				t.Fatalf("ppl rows %v: %v", rows, err)
			}
			rows, _, err = client.Query("SELECT * FROM gonavi_os_orders WHERE qty = 3")
			if err != nil || len(rows) != 1 {
				t.Fatalf("simplified select rows %v: %v", rows, err)
			}
			if _, _, err := client.Query("POST /_plugins/_sql\n{\"query\": \"DELETE FROM gonavi_os_orders\"}"); err == nil {
				t.Fatal("SQL DELETE must be rejected by the read-only console policy")
			}

			// 数据网格的增删改走 _bulk：OpenSearch 2.x 起携带 _type 会被整批拒绝，三个大版本都要能写。
			if err := client.ApplyChanges("gonavi_os_orders", connection.ChangeSet{
				Inserts: []map[string]interface{}{{"_id": "3", "sku": "C-3", "qty": 1}},
				Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"_id": "1"}, Values: map[string]interface{}{"qty": 4}}},
				Deletes: []map[string]interface{}{{"_id": "2"}},
			}); err != nil {
				t.Fatalf("grid bulk changes: %v", err)
			}
			for id, want := range map[string]int{"1": 200, "2": 404, "3": 200} {
				if response := console("GET", "/gonavi_os_orders/_doc/"+id, ""); response.StatusCode != want {
					t.Fatalf("doc %s status %d, want %d: %s", id, response.StatusCode, want, response.RawBody)
				}
			}
			if response := console("GET", "/gonavi_os_orders/_doc/1", ""); !strings.Contains(response.RawBody, `"qty":4`) {
				t.Fatalf("updated doc 1 = %s", response.RawBody)
			}
		})
	}
}

// TestOpenSearchLiveTLS 连开启安全插件的集群（HTTPS 自签证书 + Basic 认证），地址与 admin 密码来自环境变量。
func TestOpenSearchLiveTLS(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_OPENSEARCH_TLS_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			config := liveConfig(t, "opensearch", addr, "admin", "")
			config.Password = os.Getenv("GONAVI_OPENSEARCH_TLS_PASSWORD")
			config.UseSSL = true
			config.SSLMode = "skip-verify"
			client := &OpenSearchDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect over TLS: %v", err)
			}
			defer client.Close()
			if _, version := client.DriverVariantInfo(); version == "" {
				t.Fatal("server version must be detected over TLS")
			}
			if _, err := client.GetDatabases(); err != nil {
				t.Fatalf("list indices over TLS: %v", err)
			}
			config.Password = "wrong-password"
			if err := (&OpenSearchDB{}).Connect(config); err == nil {
				t.Fatal("a wrong password must fail to connect")
			}
		})
	}
}
