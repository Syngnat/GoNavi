//go:build gonavi_full_drivers || gonavi_sqlite_driver

package app

import (
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDBGetTablesIncludesSQLiteRowCounts(t *testing.T) {
	app := newSQLAuditTestApp(t)
	databasePath := filepath.Join(t.TempDir(), "table-counts.sqlite")
	config := connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "sqlite",
		DSN:      databasePath,
		Database: databasePath,
	}
	t.Cleanup(func() { app.DBReleaseConnection(config) })

	for _, statement := range []string{
		"CREATE TABLE orders (id INTEGER PRIMARY KEY)",
		"INSERT INTO orders(id) VALUES (1), (2)",
	} {
		result := app.DBQueryMulti(config, databasePath, statement, "sqlite-table-counts")
		if !result.Success {
			t.Fatalf("DBQueryMulti(%q) returned failure: %s", statement, result.Message)
		}
	}

	result := app.DBGetTables(config, databasePath)
	if !result.Success {
		t.Fatalf("DBGetTables returned failure: %s", result.Message)
	}
	tables, ok := result.Data.([]map[string]string)
	if !ok {
		t.Fatalf("DBGetTables data type = %T, want []map[string]string", result.Data)
	}
	for _, table := range tables {
		if table["Table"] == "orders" {
			if table["Rows"] != "2" {
				t.Fatalf("SQLite table row count = %q, want 2", table["Rows"])
			}
			return
		}
	}
	t.Fatalf("orders table missing from SQLite table list: %#v", tables)
}

func TestDBTableExistsUsesExactSQLiteTableName(t *testing.T) {
	app := newSQLAuditTestApp(t)
	databasePath := filepath.Join(t.TempDir(), "table-exists.sqlite")
	config := connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "sqlite",
		DSN:      databasePath,
		Database: databasePath,
	}
	t.Cleanup(func() { app.DBReleaseConnection(config) })

	result := app.DBQueryMulti(config, databasePath, `CREATE TABLE "CaseSensitive" (id INTEGER PRIMARY KEY)`, "sqlite-table-exists")
	if !result.Success {
		t.Fatalf("create table returned failure: %s", result.Message)
	}

	for _, test := range []struct {
		name      string
		tableName string
		want      bool
	}{
		{name: "existing exact name", tableName: "CaseSensitive", want: true},
		{name: "different case", tableName: "casesensitive", want: false},
		{name: "missing table", tableName: "missing", want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := app.DBTableExists(config, databasePath, test.tableName)
			if !result.Success {
				t.Fatalf("DBTableExists returned failure: %s", result.Message)
			}
			data, ok := result.Data.(map[string]bool)
			if !ok {
				t.Fatalf("DBTableExists data type = %T, want map[string]bool", result.Data)
			}
			if data["exists"] != test.want {
				t.Fatalf("DBTableExists(%q) = %v, want %v", test.tableName, data["exists"], test.want)
			}
		})
	}
}

func TestDBQueryMultiReturnsSQLiteRows(t *testing.T) {
	app := newSQLAuditTestApp(t)
	databasePath := filepath.Join(t.TempDir(), "query-results.sqlite")
	config := connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "sqlite",
		DSN:      databasePath,
		Database: databasePath,
	}
	t.Cleanup(func() { app.DBReleaseConnection(config) })

	for _, statement := range []string{
		"CREATE TABLE orders (id INTEGER PRIMARY KEY, name TEXT)",
		"INSERT INTO orders(id, name) VALUES (1, 'SQLite row')",
	} {
		result := app.DBQueryMulti(config, databasePath, statement, "sqlite-query-results")
		if !result.Success {
			t.Fatalf("DBQueryMulti(%q) returned failure: %s", statement, result.Message)
		}
	}

	result := app.DBQueryMulti(config, databasePath, "SELECT id, name FROM orders", "sqlite-query-results")
	if !result.Success {
		t.Fatalf("SQLite SELECT returned failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("SQLite SELECT data type = %T, want []connection.ResultSetData", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
		t.Fatalf("SQLite SELECT result sets = %#v, want one row", resultSets)
	}
	if len(resultSets[0].Columns) != 2 || resultSets[0].Columns[0] != "id" || resultSets[0].Columns[1] != "name" {
		t.Fatalf("SQLite SELECT columns = %#v, want [id name]", resultSets[0].Columns)
	}
	if resultSets[0].Rows[0]["id"] != int64(1) || resultSets[0].Rows[0]["name"] != "SQLite row" {
		t.Fatalf("SQLite SELECT row = %#v", resultSets[0].Rows[0])
	}
}
