package app

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/dataexport"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"

	runtime "GoNavi-Wails/internal/desktop"
)

func TestPluginExportQueryEntrypointsRejectBeforeDatabaseOrPicker(t *testing.T) {
	a := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	a.ctx = context.Background()
	calls := 0
	previous := newDatabaseFunc
	newDatabaseFunc = func(string) (db.Database, error) { calls++; return nil, errors.New("unexpected database acquisition") }
	defer func() { newDatabaseFunc = previous }()
	a.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
		calls++
		return "", errors.New("unexpected picker")
	}
	config := connection.ConnectionConfig{Type: "mysql"}
	options := []ExportFileOptions{{Format: "plugin:test.format:ndjson"}, {Format: " PLUGIN:test.format:ndjson"}, {Format: "csv", PluginExporter: &dataexport.PluginExportSelection{}}}
	for i, option := range options {
		cases := map[string]func() connection.QueryResult{
			"query": func() connection.QueryResult {
				return a.ExportQueryWithOptions(config, "db", "SELECT 1", "export", option)
			},
			"table": func() connection.QueryResult { return a.ExportTableWithOptions(config, "db", "t", option) },
			"tables": func() connection.QueryResult {
				return a.ExportTablesSQLWithOptions(config, "db", []string{"t"}, true, true, option)
			},
			"database": func() connection.QueryResult { return a.ExportDatabaseSQLWithOptions(config, "db", true, option) },
			"databases": func() connection.QueryResult {
				return a.ExportDatabasesSQLWithOptions(config, []string{"db"}, true, option)
			},
			"schema": func() connection.QueryResult {
				return a.ExportSchemaSQLWithOptions(config, "db", "schema", true, option)
			},
			"headless": func() connection.QueryResult {
				return (&HeadlessRuntime{app: a}).ExportQueryToPath(context.Background(), config, "db", "SELECT 1", filepath.Join(t.TempDir(), "output"), option, false)
			},
		}
		for name, run := range cases {
			result := run()
			if result.Success {
				t.Errorf("case %d %s accepted non-snapshot exporter", i, name)
			}
		}
	}
	if calls != 0 {
		t.Fatalf("unsupported path performed %d DB/picker operations", calls)
	}
}
