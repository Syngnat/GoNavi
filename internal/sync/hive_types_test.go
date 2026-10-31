package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveMigrationTypesPreserveExactDomains(t *testing.T) {
	tick := string(rune(96))
	tests := []struct{ name, source, target, input, want string }{
		{"string", "hive", "hive", "string", "STRING"},
		{"decimal", "hive", "hive", "decimal(38,18)", "DECIMAL(38,18)"},
		{"timestamp", "hive", "hive", "timestamp", "TIMESTAMP"},
		{"binary", "hive", "hive", "binary", "BINARY"},
		{"array", "hive", "hive", "array<decimal(38,18)>", "ARRAY<DECIMAL(38,18)>"},
		{"map", "hive", "hive", "map<string,array<bigint>>", "MAP<STRING,ARRAY<BIGINT>>"},
		{"struct", "hive", "hive", "struct<name:string,amount:decimal(20,4)>", "STRUCT<" + tick + "name" + tick + ":STRING," + tick + "amount" + tick + ":DECIMAL(20,4)>"},
		{"mysql text", "mysql", "hive", "longtext", "STRING"},
		{"mysql binary", "mysql", "hive", "longblob", "BINARY"},
		{"uint64", "mysql", "hive", "bigint unsigned", "DECIMAL(20,0)"},
		{"uint32", "mysql", "hive", "int unsigned", "BIGINT"},
		{"mssql unsigned tinyint", "sqlserver", "hive", "tinyint", "SMALLINT"},
		{"mssql rowversion", "sqlserver", "hive", "timestamp", "BINARY"},
		{"oracle date includes time", "oracle", "hive", "date", "TIMESTAMP"},
		{"postgres decimal", "postgres", "hive", "numeric(38,8)", "DECIMAL(38,8)"},
		{"postgres boolean", "postgres", "hive", "boolean", "BOOLEAN"},
		{"postgres string", "hive", "postgres", "string", "TEXT"},
		{"postgres binary", "hive", "postgres", "binary", "BYTEA"},
		{"mysql string", "hive", "mysql", "string", "LONGTEXT"},
		{"mssql binary", "hive", "sqlserver", "binary", "VARBINARY(MAX)"},
		{"oracle nano timestamp", "hive", "oracle", "timestamp", "TIMESTAMP(9)"},
		{"duckdb nano timestamp", "hive", "duckdb", "timestamp", "TIMESTAMP_NS"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := mapHiveMigrationType(test.source, test.target, connection.ColumnDefinition{Name: "value", Type: test.input})
			if err != nil || got != test.want {
				t.Fatalf("mapping = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestHiveMigrationRejectsLossyTypes(t *testing.T) {
	for _, test := range []struct{ source, target, input string }{
		{"hive", "mysql", "array<int>"}, {"hive", "postgres", "map<string,binary>"},
		{"hive", "sqlite", "struct<a:string>"}, {"hive", "mysql", "timestamp"},
		{"hive", "postgres", "timestamp"}, {"hive", "sqlite", "decimal(38,18)"},
		{"postgres", "hive", "numeric"}, {"mysql", "hive", "decimal(65,30)"},
		{"postgres", "hive", "timestamp with time zone"}, {"postgres", "hive", "integer[]"},
		{"hive", "hive", "STRING); DROP TABLE users; --"}, {"hive", "hive", "decimal(39,1)"},
	} {
		t.Run(test.source+"-"+test.target+"-"+test.input, func(t *testing.T) {
			if typ, err := mapHiveMigrationType(test.source, test.target, connection.ColumnDefinition{Name: "value", Type: test.input}); err == nil {
				t.Fatalf("lossy mapping accepted: %s", typ)
			}
		})
	}
}

func TestHiveCreateTablePreservesPartitionsWithoutForeignStorage(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Key: "PRI", Extra: "auto_increment", Nullable: "NO", Default: stringPtr("12")},
		{Name: "payload", Type: "array<struct<x:string>>", Comment: "quote ' slash"},
		{Name: "day", Type: "string", Extra: "partition"},
	}
	query, err := buildHiveCreateTableSQL("hive", "hive", "warehouse.events", columns)
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"CREATE TABLE", "PARTITIONED BY", "ARRAY<STRUCT<", "COMMENT", "\n"} {
		if !strings.Contains(query, expected) {
			t.Fatalf("missing %q in %s", expected, query)
		}
	}
	for _, forbidden := range []string{"PRIMARY KEY", "FOREIGN KEY", "INDEX", "LOCATION", "transactional", "AUTO_INCREMENT", "NOT NULL", "DEFAULT"} {
		if strings.Contains(query, forbidden) {
			t.Fatalf("copied unsupported semantics %q in %s", forbidden, query)
		}
	}
	start := strings.Index(query, "PARTITIONED BY")
	if strings.Contains(query[:start], "day") {
		t.Fatalf("partition column was duplicated in ordinary columns: %s", query)
	}
}

func TestHiveSQLDoesNotUseOffsetOrMySQLClearFallback(t *testing.T) {
	if got := buildPaginatedSelectSQLForSync("hive", "SELECT * FROM events", "*", "ORDER BY id", 12, 4); got != "" {
		t.Fatalf("OFFSET was accepted: %s", got)
	}
	if got := buildPaginatedSelectSQLForSync("hive", "SELECT * FROM events", "*", "ORDER BY id", 12, 0); got != "SELECT * FROM events ORDER BY id LIMIT 12" {
		t.Fatalf("first page = %s", got)
	}
	if supportsDirectImportPagination("hive") {
		t.Fatal("Hive must not enter generic OFFSET pagination")
	}
	if got := buildClearTargetTableSQL("hive", "warehouse.events"); got != "TRUNCATE TABLE "+quoteQualifiedIdentByType("hive", "warehouse.events") {
		t.Fatalf("clear = %s", got)
	}
	tick := string(rune(96))
	if got := quoteQualifiedIdentByType("hive", "warehouse.events"); got != tick+"warehouse"+tick+"."+tick+"events"+tick {
		t.Fatalf("identifier = %q", got)
	}
}
