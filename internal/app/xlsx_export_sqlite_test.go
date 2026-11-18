//go:build gonavi_full_drivers || gonavi_sqlite_driver

package app

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"

	runtime "GoNavi-Wails/internal/desktop"
)

func TestXLSXExportSQLiteQueryResults(t *testing.T) {
	application := newSQLAuditTestApp(t)
	databasePath := filepath.Join(t.TempDir(), "export.sqlite")
	config := connection.ConnectionConfig{
		ID: "xlsx-export-sqlite", Type: "custom", Driver: "sqlite", DSN: databasePath, Database: databasePath,
	}.WithResolvedSavedSnapshot()
	t.Cleanup(func() { application.DBReleaseConnection(config) })
	for _, statement := range []string{
		`CREATE TABLE fixture (id INTEGER, amount REAL, name TEXT, code TEXT, bigint TEXT, precise TEXT, nullable TEXT)`,
		`INSERT INTO fixture VALUES (1, 12.5, 'alice', '0012', '9007199254740993', '0.1234567890123456', NULL)`,
		`INSERT INTO fixture VALUES (0, -0.1, '中文 & <test>', '0024', '18446744073709551615', '12.50', 'end')`,
		`INSERT INTO fixture VALUES (-42, 0, 'tail', NULL, NULL, NULL, NULL)`,
	} {
		result := application.DBQueryMulti(config, databasePath, statement, "xlsx-export-setup")
		if !result.Success {
			t.Fatalf("prepare SQLite fixture: %s", result.Message)
		}
	}
	const query = "SELECT id, amount, name, code, bigint, precise, nullable FROM fixture ORDER BY rowid"
	queryResult := application.DBQueryMulti(config, databasePath, query, "xlsx-export-select")
	if !queryResult.Success {
		t.Fatalf("query SQLite fixture: %s", queryResult.Message)
	}
	resultSets, ok := queryResult.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 || len(resultSets[0].Rows) != 3 {
		t.Fatalf("query result = %#v, want one result set with three rows", queryResult.Data)
	}
	for _, mode := range []string{"loaded-results", "requery-all"} {
		for _, maxRows := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s/maxRows=%d", mode, maxRows), func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "query_result.xlsx")
				application.saveFileDialog = func(context.Context, runtime.SaveDialogOptions) (string, error) {
					return path, nil
				}
				options := ExportFileOptions{
					Format: "xlsx", XLSXMaxRowsPerSheet: maxRows,
					Columns:        []string{"name", "amount", "id", "code", "bigint", "precise", "nullable"},
					ColumnComments: map[string]string{"id": "编号", "name": "姓名"},
				}
				var result connection.QueryResult
				if mode == "loaded-results" {
					result = application.ExportDataWithOptions(resultSets[0].Rows, resultSets[0].Columns, "query_result", options)
				} else {
					result = application.ExportQueryWithOptions(config, databasePath, query, "query_result", options)
				}
				if !result.Success {
					t.Fatalf("export SQLite results: %s", result.Message)
				}
				assertXLSXExportRecords(t, path, true, maxRows)
				assertNoTempExportResidue(t, filepath.Dir(path))
			})
		}
	}
}
