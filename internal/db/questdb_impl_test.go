//go:build gonavi_full_drivers || gonavi_questdb_driver

package db

import (
	"net/url"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestParseQuestDBVersion(t *testing.T) {
	cases := map[string]string{
		"Build Information: QuestDB 8.3.3, JDK 17.0.11, Commit Hash 58cf2d4": "8.3.3",
		"Build Information: QuestDB 10.0.1, JDK 25.0.2":                      "10.0.1",
		"PostgreSQL 12.3, compiled by Visual C++ build 1914, 64-bit, QuestDB": "",
	}
	for banner, want := range cases {
		if got := parseQuestDBVersion(banner); got != want {
			t.Fatalf("parseQuestDBVersion(%q) = %q, want %q", banner, got, want)
		}
	}
}

func TestWithQuestDBDefaults(t *testing.T) {
	config := withQuestDBDefaults(connection.ConnectionConfig{Host: "127.0.0.1"})
	params, err := url.ParseQuery(config.ConnectionParams)
	if err != nil || config.Port != defaultQuestDBPort || config.Database != defaultQuestDBDatabase || params.Get("search_path") != "public" {
		t.Fatalf("defaults = %+v, params %v (%v)", config, params, err)
	}
	explicit := withQuestDBDefaults(connection.ConnectionConfig{Port: 18812, Database: "qdb", ConnectionParams: "search_path=analytics"})
	if explicit.Port != 18812 || explicit.ConnectionParams != "search_path=analytics" {
		t.Fatalf("explicit settings must be kept, got %+v", explicit)
	}
}

func TestBuildQuestDBCreateTable(t *testing.T) {
	ddl := buildQuestDBCreateTable("trades", questDBTableInfo{designatedTimestamp: "ts", partitionBy: "DAY", walEnabled: true, dedup: true}, []questDBColumn{
		{name: "symbol", typeName: "SYMBOL", symbolCapacity: "256", symbolCached: true, indexed: true, indexCapacity: "256", upsertKey: true},
		{name: "price", typeName: "DOUBLE"},
		{name: "ts", typeName: "TIMESTAMP", designated: true, upsertKey: true},
	})
	want := "CREATE TABLE 'trades' (\n\tsymbol SYMBOL CAPACITY 256 CACHE INDEX CAPACITY 256,\n\tprice DOUBLE,\n\tts TIMESTAMP\n) timestamp(ts) PARTITION BY DAY WAL\nDEDUP UPSERT KEYS(symbol, ts);"
	if ddl != want {
		t.Fatalf("ddl =\n%s\nwant\n%s", ddl, want)
	}
	plain := buildQuestDBCreateTable("plain", questDBTableInfo{partitionBy: "NONE"}, []questDBColumn{{name: "id", typeName: "INT"}})
	if strings.Contains(plain, "PARTITION") || strings.Contains(plain, "timestamp(") {
		t.Fatalf("non-partitioned table must not declare partitions: %s", plain)
	}
}
