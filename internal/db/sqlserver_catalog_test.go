package db

import (
	"strings"
	"testing"
)

func TestFormatSQLServerTableMetadataNameQuotesAmbiguousParts(t *testing.T) {
	tests := []struct {
		name   string
		schema string
		table  string
		want   string
	}{
		{name: "plain", schema: "audit", table: "users", want: "audit.users"},
		{name: "no schema", table: "users", want: "users"},
		{name: "dotted table", schema: "audit", table: "order.items", want: "[audit].[order.items]"},
		{name: "escaped bracket", schema: "audit]ops", table: "order]items", want: "[audit]]ops].[order]]items]"},
		{name: "whitespace table", schema: "audit", table: " id ", want: "[audit].[ id ]"},
		{name: "whitespace schema", schema: " audit ", table: "users", want: "[ audit ].[users]"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := formatSQLServerTableMetadataName(test.schema, test.table); got != test.want {
				t.Fatalf("formatSQLServerTableMetadataName(%q,%q)=%q, want %q", test.schema, test.table, got, test.want)
			}
		})
	}
}

func TestSQLServerCatalogQueriesStayOnCurrentDatabase(t *testing.T) {
	t.Parallel()

	if sql := sqlServerListTablesQuery(); strings.Contains(sql, "].sys.") || !strings.Contains(sql, "FROM sys.tables") {
		t.Fatalf("table catalog query must use current-database sys.tables, got %s", sql)
	}
	if sql := sqlServerAccessibleDatabasesQuery(); !strings.Contains(sql, "HAS_DBACCESS(name)") {
		t.Fatalf("database list query must skip inaccessible databases, got %s", sql)
	}
	if sql := sqlServerCurrentDatabaseQuery(); !strings.Contains(sql, "DB_NAME()") {
		t.Fatalf("current database fallback missing DB_NAME(), got %s", sql)
	}
}

func TestSQLServerUsesCurrentDatabaseCatalogOnlyForAzureEditions(t *testing.T) {
	t.Parallel()

	for _, edition := range []int{5, 6, 9, 11, 12} {
		if !sqlServerUsesCurrentDatabaseCatalogOnly(edition) {
			t.Fatalf("edition %d should use current-database catalog only", edition)
		}
	}
	for _, edition := range []int{2, 3, 4, 8} {
		if sqlServerUsesCurrentDatabaseCatalogOnly(edition) {
			t.Fatalf("edition %d should keep multi-database listing", edition)
		}
	}
}

func TestSQLServerIntFromValue(t *testing.T) {
	t.Parallel()

	got, ok := sqlServerIntFromValue(int64(5))
	if !ok || got != 5 {
		t.Fatalf("int64 edition = %d ok=%v, want 5", got, ok)
	}
	got, ok = sqlServerIntFromValue([]byte("11"))
	if !ok || got != 11 {
		t.Fatalf("bytes edition = %d ok=%v, want 11", got, ok)
	}
}

func TestCollectSQLServerNameColumnDedupesCaseInsensitively(t *testing.T) {
	t.Parallel()

	names := collectSQLServerNameColumn([]map[string]interface{}{
		{"name": "AppDB"},
		{"name": "appdb"},
		{"name": " master "},
		{"name": ""},
		{"other": "ignored"},
	})
	if len(names) != 2 || names[0] != "AppDB" || names[1] != "master" {
		t.Fatalf("names = %#v, want [AppDB master]", names)
	}
}
