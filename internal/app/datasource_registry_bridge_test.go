package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestRegistryTypesBorrowExistingDialects(t *testing.T) {
	config := connection.ConnectionConfig{Type: "tidb"}
	if got := resolveDDLDBType(config); got != "mysql" {
		t.Fatalf("resolveDDLDBType(tidb) = %q, want mysql", got)
	}
	if got := resolveExplainDBType(config); got != "tidb" {
		t.Fatalf("explain dialect = %q, want tidb", got)
	}
	if got := resolveDDLDBType(connection.ConnectionConfig{Type: "pingcap-tidb"}); got != "mysql" {
		t.Fatalf("alias dialect = %q", got)
	}
	if !supportsConnectionReadOnlyMode(config) {
		t.Fatal("TiDB must support read-only protection")
	}
	if got := defaultPortByType("tidb"); got != 4000 {
		t.Fatalf("default port = %d", got)
	}
	if got := tableObjectTypeForDB("tidb"); got != "table" {
		t.Fatalf("object type = %q", got)
	}
	if got := normalizeRunConfig(config, "orders").Database; got != "orders" {
		t.Fatalf("selected database not applied: %q", got)
	}
}

// DBQuery 按原始类型分流读写：OpenSearch 控制台的读请求必须走查询路径，否则 AI 工具拿不到结果行。
func TestRegistryTypesClassifyStatementsWithBorrowedDialect(t *testing.T) {
	for query, want := range map[string]bool{
		"GET /orders/_search\n{\"query\": {\"match_all\": {}}}":        true,
		"POST /_plugins/_sql\n{\"query\": \"SELECT sku FROM orders\"}": true,
		"DELETE /orders": false,
		"POST /_plugins/_sql\n{\"query\": \"DELETE FROM orders\"}": false,
		"POST /orders/_doc\n{\"sku\": \"A-1\"}":                    false,
	} {
		if got := isReadOnlySQLQuery("opensearch", query); got != want {
			t.Fatalf("isReadOnlySQLQuery(opensearch, %q) = %v, want %v", query, got, want)
		}
	}
	if !isReadOnlySQLQuery("tidb", "SELECT * FROM orders") || isReadOnlySQLQuery("tidb", "UPDATE orders SET qty = 1") {
		t.Fatal("TiDB statements must classify with the MySQL rules")
	}
	for query, want := range map[string]bool{
		`from(bucket: "b") |> range(start: -1h)`:                  true,
		`from(bucket: "a") |> range(start: 0) |> to(bucket: "b")`: false,
		`SELECT * FROM "cpu" WHERE "host" = 'a'`:                  true,
		`SHOW MEASUREMENTS`:                                       true,
		`SELECT * INTO "copy" FROM "cpu"`:                         false,
		`INSERT cpu,host=a usage=1`:                               false,
		`DROP MEASUREMENT "cpu"`:                                  false,
	} {
		if got := isReadOnlySQLQuery("influxdb", query); got != want {
			t.Fatalf("isReadOnlySQLQuery(influxdb, %q) = %v, want %v", query, got, want)
		}
	}
}

func TestRegistryAgentsAppearInDriverManager(t *testing.T) {
	definitions := allDriverDefinitionsWithPackages(nil)
	found := map[string]driverDefinition{}
	for _, definition := range definitions {
		found[definition.Type] = definition
	}
	for _, key := range datasource.AgentKeys() {
		definition, ok := found[key]
		if !ok {
			t.Fatalf("driver manager misses registry agent %q", key)
		}
		if definition.BuiltIn || definition.DefaultDownloadURL != "builtin://activate/"+key || definition.PinnedVersion == "" {
			t.Fatalf("definition for %q = %#v", key, definition)
		}
		tag, err := optionalDriverBuildTag(key, "")
		if err != nil || tag != "gonavi_"+key+"_driver" {
			t.Fatalf("build tag for %q = %q, %v", key, tag, err)
		}
	}
	if got := normalizeDriverType("PingCAP-TiDB"); got != "tidb" {
		t.Fatalf("normalizeDriverType alias = %q", got)
	}
}

type fakeVariantReporter struct {
	db.Database
	variant, version string
}

func (f fakeVariantReporter) DriverVariantInfo() (string, string) { return f.variant, f.version }

func TestTestConnectionResultReportsVariant(t *testing.T) {
	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "tidb", DriverVariant: "auto"}

	info := captureTestConnectionVariant(config, fakeVariantReporter{variant: "v8", version: "8.5.8"})
	result := application.testConnectionSuccessResult(config, info)
	payload, ok := result.Data.(*testConnectionVariantInfo)
	if !result.Success || !ok || payload.DriverVariant != "v8" || payload.RequestedVariant != "auto" || payload.ServerVersion != "8.5.8" {
		t.Fatalf("result = %#v", result)
	}
	if !strings.Contains(result.Message, "8.5.8") || !strings.Contains(result.Message, payload.DriverVariantLabel) {
		t.Fatalf("message %q must mention version and variant", result.Message)
	}

	if payload.SuggestedVariant != "" {
		t.Fatalf("auto detection must not suggest another variant, got %q", payload.SuggestedVariant)
	}

	pinned := connection.ConnectionConfig{Type: "tidb", DriverVariant: "v5"}
	mismatch := captureTestConnectionVariant(pinned, fakeVariantReporter{variant: "v5", version: "8.5.8"})
	if mismatch == nil || mismatch.SuggestedVariant != "v8" {
		t.Fatalf("a pinned variant outside the server range must suggest v8, got %#v", mismatch)
	}
	warned := application.testConnectionSuccessResult(pinned, mismatch)
	if !warned.Success || !strings.Contains(warned.Message, mismatch.SuggestedVariantLabel) {
		t.Fatalf("mismatch message %q must name the suggested variant", warned.Message)
	}
	matched := captureTestConnectionVariant(pinned, fakeVariantReporter{variant: "v5", version: "5.4.3"})
	if matched == nil || matched.SuggestedVariant != "" {
		t.Fatalf("a pinned variant matching the server must not suggest another one, got %#v", matched)
	}

	legacy := captureTestConnectionVariant(connection.ConnectionConfig{Type: "mysql"}, fakeVariantReporter{variant: "", version: ""})
	if legacy != nil {
		t.Fatalf("legacy types must keep the plain result, got %#v", legacy)
	}
	plain := application.testConnectionSuccessResult(connection.ConnectionConfig{Type: "mysql"}, nil)
	if plain.Data != nil || plain.Message != application.appText("db.backend.message.connect_success", nil) {
		t.Fatalf("plain result = %#v", plain)
	}
}

func TestDriverProxyModeKeepsOriginalTarget(t *testing.T) {
	if registryUsesDriverProxy("tidb") {
		t.Fatal("TiDB is a single-address MySQL protocol and must use port forwarding")
	}
	if registryUsesDriverProxy("mysql") {
		t.Fatal("legacy types are not registry types")
	}
}

func TestRegistryPostgresAndHTTPWireReadQueriesAvoidNativeMultiResult(t *testing.T) {
	for _, dbType := range []string{"cockroachdb", "kwdb", "questdb", "weaviate", "opensearch", "etcd", "zookeeper"} {
		if !shouldPreferPlainReadQueryResult(dbType) || shouldUseNativeMultiResultBatch(dbType, []string{"SELECT 1"}, true) {
			t.Fatalf("%s read queries must use the plain query path", dbType)
		}
	}
	if shouldPreferPlainReadQueryResult("tidb") {
		t.Fatal("TiDB reuses the MySQL driver and keeps native multi-result batches")
	}
	// 执行路径传入的是借用方言：Presto 归一为 trino，与 Trino 一样没有多结果集接口。
	presto := resolveDDLDBType(connection.ConnectionConfig{Type: "presto"})
	if presto != "trino" || shouldUseNativeMultiResultBatch(presto, []string{"SELECT 1"}, true) {
		t.Fatalf("presto (%s) read queries must use the plain query path", presto)
	}
}

func TestRegistryExplainFallsBackToBorrowedDialect(t *testing.T) {
	cases := map[string]string{"tidb": "tidb", "cockroachdb": "cockroachdb", "questdb": "questdb", "timescaledb": "postgres"}
	for dbType, want := range cases {
		if got := resolveExplainDBType(connection.ConnectionConfig{Type: dbType}); got != want {
			t.Fatalf("resolveExplainDBType(%s) = %s, want %s", dbType, got, want)
		}
	}
}

func TestRegistryConsoleReadOnlyClassification(t *testing.T) {
	cases := map[string]map[string]bool{
		"etcd":      {"get /app --prefix": true, "member list": true, "put /app x": false, "del /app --prefix": false},
		"zookeeper": {"ls -R /": true, "get -s /app": true, "srvr": true, "create /app": false, "deleteall /app": false, "4lw srst": false},
	}
	for dbType, queries := range cases {
		for query, want := range queries {
			if got := isReadOnlySQLQuery(dbType, query); got != want {
				t.Fatalf("%s %q read-only = %v, want %v", dbType, query, got, want)
			}
		}
	}
}
