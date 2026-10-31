package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveProtectedQueriesRejectScriptsAndMutations(t *testing.T) {
	for _, query := range []string{
		"SELECT TRANSFORM(id) USING 'cat' AS (id) FROM events",
		"SELECT reflect('java.lang.Runtime', 'getRuntime')",
		"SELECT java_method('java.lang.System', 'getProperty', 'user.home')",
		"SELECT reflect2(value, 'toString') FROM events",
		"FROM events INSERT OVERWRITE TABLE other SELECT *",
		"EXPORT TABLE events TO '/tmp/export'",
		"LOAD DATA LOCAL INPATH '/tmp/input' INTO TABLE events",
		"ADD JAR /tmp/custom.jar",
		"DFS -rm -r /warehouse",
		"MSCK REPAIR TABLE events",
		"SELECT ${hiveconf:payload}",
		"SELECT '${hivevar:payload}'",
	} {
		t.Run(query, func(t *testing.T) {
			config := connection.ConnectionConfig{Type: "hive", ReadOnly: true}
			if err := ensureConnectionAllowsQuery(config, query); err == nil {
				t.Fatalf("protected Hive connection accepted %s", query)
			}
			if err := ensureConnectionAllowsQuery(connection.ConnectionConfig{Type: "hive"}, query); err != nil {
				t.Fatalf("unrestricted Hive SQL unexpectedly blocked: %v", err)
			}
		})
	}
}

func TestHivePolicyIgnoresStringsIdentifiersAndComments(t *testing.T) {
	for _, query := range []string{
		"SELECT 'reflect(unsafe)' AS note",
		"SELECT 'transform using' AS note",
		"SELECT '\\'reflect hidden' AS note",
		"SELECT 1 -- reflect(unsafe)\n",
		"SELECT 1 /* TRANSFORM USING */",
		"SELECT " + string(rune(96)) + "java_method" + string(rune(96)) + " FROM events",
	} {
		t.Run(query, func(t *testing.T) {
			if hiveQueryMayRunExternalCode(query) {
				t.Fatalf("literal or comment interpreted as Hive script: %s", query)
			}
		})
	}
	if !hiveQueryMayRunExternalCode("SELECT '\\\\', reflect('java.lang.System', 'getProperty', 'user.home')") {
		t.Fatal("backslash string hid a reflection call")
	}
}

func TestHiveNativeDatabaseDDLRejectsMySQLOptions(t *testing.T) {
	query, err := buildCreateDatabaseQuery("hive", "sales", "", "")
	if err != nil || query != "CREATE DATABASE IF NOT EXISTS "+string(rune(96))+"sales"+string(rune(96)) {
		t.Fatalf("invalid Hive database DDL %q: %v", query, err)
	}
	for _, options := range [][2]string{{"utf8mb4", ""}, {"", "binary"}} {
		if _, err := buildCreateDatabaseQuery("hive", "sales", options[0], options[1]); err == nil {
			t.Fatalf("Hive accepted unsupported charset/collation: %v", options)
		}
	}
}

func TestHiveExplainPreservesNativeDriverFamilyPlans(t *testing.T) {
	for _, tc := range []struct{ name, raw, expected string }{
		{"hive", "Explain\nSTAGE PLANS:\n  Stage-1\n    TableScan\n      Filter Operator\n", connection.ExplainOpScan},
		{"spark", "plan\n== Physical Plan ==\n+- HashAggregate(keys=[id])\n   +- FileScan parquet default.events\n", connection.ExplainOpAggregate},
		{"impala", "Explain String\n01:AGGREGATE [FINALIZE]\n  00:SCAN HDFS [default.events]\n", connection.ExplainOpScan},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := parseExplainRawByDialect("hive", "SELECT * FROM events", tc.raw, connection.ExplainFormatText, nil)
			if err != nil || result.RawPayload != tc.raw || len(result.Nodes) == 0 {
				t.Fatalf("native %s plan lost: %+v, %v", tc.name, result, err)
			}
			found := false
			for _, node := range result.Nodes {
				found = found || node.OpType == tc.expected
			}
			if !found {
				t.Fatalf("native %s plan not classified: %+v", tc.name, result.Nodes)
			}
		})
	}
	query, post, _, cleanup, err := buildExplainQuery("hive", "SELECT * FROM events;")
	if err != nil || query != "EXPLAIN SELECT * FROM events" || len(post) > 0 || len(cleanup) > 0 || strings.Contains(query, "ANALYZE") {
		t.Fatalf("Hive explain must not execute the original query: %s %v", query, err)
	}
}
