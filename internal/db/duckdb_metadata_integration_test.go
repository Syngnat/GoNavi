//go:build gonavi_duckdb_driver

package db

import (
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDuckDBMetadataDetectsPrimaryAndUniqueIndexes(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "metadata.duckdb")
	client := &DuckDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "duckdb", Host: dbPath}); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	if _, err := client.Exec(`
CREATE TABLE events (
	id BIGINT PRIMARY KEY,
	email VARCHAR UNIQUE,
	name VARCHAR
);
CREATE UNIQUE INDEX idx_events_name ON events(name);
`); err != nil {
		t.Fatalf("create test table failed: %v", err)
	}

	columns, err := client.GetColumns("main", "main.events")
	if err != nil {
		t.Fatalf("GetColumns failed: %v", err)
	}
	if len(columns) != 3 {
		t.Fatalf("unexpected column count: %d, columns=%+v", len(columns), columns)
	}

	keysByName := map[string]string{}
	for _, column := range columns {
		keysByName[column.Name] = column.Key
	}
	if keysByName["id"] != "PRI" {
		t.Fatalf("primary key metadata missing: columns=%+v", columns)
	}
	if keysByName["email"] != "UNI" {
		t.Fatalf("unique constraint metadata missing: columns=%+v", columns)
	}

	indexes, err := client.GetIndexes("main", "main.events")
	if err != nil {
		t.Fatalf("GetIndexes failed: %v", err)
	}
	if !duckDBTestHasUniqueIndexColumn(indexes, "id") {
		t.Fatalf("primary key index metadata missing: indexes=%+v", indexes)
	}
	if !duckDBTestHasUniqueIndexColumn(indexes, "email") {
		t.Fatalf("unique constraint index metadata missing: indexes=%+v", indexes)
	}
	if !duckDBTestHasUniqueIndexColumn(indexes, "name") {
		t.Fatalf("unique index metadata missing: indexes=%+v", indexes)
	}
}

func TestDuckDBQualifiedMetadataDoesNotFallbackToSameNamedObject(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "qualified-fallback.duckdb")
	client := &DuckDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "duckdb", Host: dbPath}); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	if _, err := client.Exec(`
CREATE TABLE main.events (
	id BIGINT PRIMARY KEY,
	marker VARCHAR UNIQUE
);
CREATE SCHEMA compat;
CREATE TABLE compat.legacy (id BIGINT);
`); err != nil {
		t.Fatalf("create qualified fallback fixtures failed: %v", err)
	}

	columns, err := client.GetColumns("main", "missing.events")
	if err != nil {
		t.Fatalf("GetColumns for missing qualified object failed: %v", err)
	}
	if len(columns) != 0 {
		t.Fatalf("missing schema returned columns from a same-named table: %+v", columns)
	}

	indexes, err := client.GetIndexes("main", "missing.events")
	if err != nil {
		t.Fatalf("GetIndexes for missing qualified object failed: %v", err)
	}
	if len(indexes) != 0 {
		t.Fatalf("missing schema returned indexes from a same-named table: %+v", indexes)
	}

	if ddl, err := client.GetCreateStatement("main", "missing.events"); err == nil {
		t.Fatalf("missing schema returned a same-named table definition: %q", ddl)
	}
	if ddl, err := client.GetCreateStatement("missing_catalog", "main.events"); err == nil {
		t.Fatalf("missing catalog returned a same-named table definition: %q", ddl)
	}

	ddl, err := client.GetCreateStatement("", "legacy")
	if err != nil {
		t.Fatalf("unqualified compatibility lookup failed: %v", err)
	}
	if !strings.Contains(strings.ToLower(ddl), "legacy") {
		t.Fatalf("unqualified compatibility lookup returned unexpected DDL: %q", ddl)
	}
}

func TestDuckDBDefinitionReloadReflectsLatestDDL(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "definition-reload.duckdb")
	client := &DuckDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "duckdb", Host: dbPath}); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	if _, err := client.Exec(`
CREATE VIEW active_users AS
SELECT id FROM (VALUES (1), (2)) AS users(id);

CREATE OR REPLACE MACRO add_one(x) AS x + 1;
`); err != nil {
		t.Fatalf("create initial objects failed: %v", err)
	}

	viewDefinitionBefore, _, err := client.Query(`SELECT view_definition FROM information_schema.views WHERE table_schema = 'main' AND table_name = 'active_users' LIMIT 1`)
	if err != nil {
		t.Fatalf("query initial view definition failed: %v", err)
	}
	if len(viewDefinitionBefore) != 1 {
		t.Fatalf("expected one initial view definition row, got %+v", viewDefinitionBefore)
	}
	if got := duckDBRowString(viewDefinitionBefore[0], "view_definition"); !strings.Contains(got, "SELECT id FROM") || !strings.Contains(got, "VALUES (1), (2)") {
		t.Fatalf("unexpected initial view definition: %q", got)
	}

	routineDefinitionBefore, _, err := client.Query(`SELECT macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = 'main' AND function_name = 'add_one' LIMIT 1`)
	if err != nil {
		t.Fatalf("query initial macro definition failed: %v", err)
	}
	if len(routineDefinitionBefore) != 1 {
		t.Fatalf("expected one initial macro definition row, got %+v", routineDefinitionBefore)
	}
	if got := duckDBRowString(routineDefinitionBefore[0], "macro_definition"); !strings.Contains(got, "x + 1") {
		t.Fatalf("unexpected initial macro definition: %q", got)
	}

	if _, err := client.Exec(`
CREATE OR REPLACE VIEW active_users AS
SELECT id, id * 10 AS score FROM (VALUES (1), (2)) AS users(id);

CREATE OR REPLACE MACRO add_one(x) AS x + 2;
`); err != nil {
		t.Fatalf("replace latest objects failed: %v", err)
	}

	viewDefinitionAfter, _, err := client.Query(`SELECT view_definition FROM information_schema.views WHERE table_schema = 'main' AND table_name = 'active_users' LIMIT 1`)
	if err != nil {
		t.Fatalf("query latest view definition failed: %v", err)
	}
	if len(viewDefinitionAfter) != 1 {
		t.Fatalf("expected one latest view definition row, got %+v", viewDefinitionAfter)
	}
	if got := duckDBRowString(viewDefinitionAfter[0], "view_definition"); !strings.Contains(got, "SELECT id") || !strings.Contains(got, "score") || !strings.Contains(got, "10") {
		t.Fatalf("expected latest view definition, got %q", got)
	}

	routineDefinitionAfter, _, err := client.Query(`SELECT macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = 'main' AND function_name = 'add_one' LIMIT 1`)
	if err != nil {
		t.Fatalf("query latest macro definition failed: %v", err)
	}
	if len(routineDefinitionAfter) != 1 {
		t.Fatalf("expected one latest macro definition row, got %+v", routineDefinitionAfter)
	}
	if got := duckDBRowString(routineDefinitionAfter[0], "macro_definition"); !strings.Contains(got, "x + 2") {
		t.Fatalf("expected latest macro definition, got %q", got)
	}
}

func duckDBTestHasUniqueIndexColumn(indexes []connection.IndexDefinition, columnName string) bool {
	for _, index := range indexes {
		if index.ColumnName == columnName && index.NonUnique == 0 {
			return true
		}
	}
	return false
}
