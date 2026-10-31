//go:build gonavi_hive_driver

package app

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func hiveTransferLiveNullPaired(t *testing.T, ctx context.Context, instance *db.HiveDB, config connection.ConnectionConfig) {
	t.Helper()
	for _, format := range []string{"csv", "xlsx", "json"} {
		for index, value := range []interface{}{nil, "NULL", "", "\\N", "literal \"quote\"", "line\nback\\slash"} {
			literal, err := hivesql.Value("STRING", value)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(t.TempDir(), "null-pair."+format)
			output, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			count, _, exportErr := exportQueryResultToFileWithContext(ctx, output, instance, config, "SELECT "+literal+" AS v", ExportFileOptions{Format: format}, nil)
			closeErr := output.Close()
			if exportErr != nil || closeErr != nil || count != 1 {
				t.Fatalf("live null export %s/%d: count=%d err=%v close=%v", format, index, count, exportErr, closeErr)
			}
			collector := &importCollectConsumer{}
			token := "NULL"
			if err := streamImportFileWithOptions(path, collector, ImportFileOptions{LosslessHive: true, NullToken: &token}); err != nil {
				t.Fatal(err)
			}
			if len(collector.rows) != 1 || !reflect.DeepEqual(collector.rows[0]["v"], value) {
				t.Fatalf("live null roundtrip %s/%d: got=%#v want=%#v", format, index, collector.rows, value)
			}
		}
	}
}
