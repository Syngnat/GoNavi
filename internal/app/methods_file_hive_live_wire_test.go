//go:build gonavi_hive_driver

package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHiveTransferLiveNestedBinaryIsExplicitlyUnsupported(t *testing.T) {
	instance, config, _, _ := hiveTransferLiveDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, fixture := range []struct{ name, typeName, query string }{
		{"mapping", "MAP<STRING,BINARY>", "SELECT map('bytes',unhex('00ff')) AS mapping"},
		{"details", "STRUCT<payload:BINARY>", "SELECT named_struct('payload',unhex('00ff')) AS details"},
		{"items", "ARRAY<BINARY>", "SELECT array(unhex('00ff')) AS items"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			for _, format := range []string{"csv", "json", "xlsx", "md", "html", "parquet", "sql"} {
				t.Run(format, func(t *testing.T) {
					path := filepath.Join(t.TempDir(), "rejected."+format)
					output, err := os.Create(path)
					if err != nil {
						t.Fatal(err)
					}
					options := ExportFileOptions{Format: format, InsertSQLDialect: "hive", InsertSQLTargetTable: "unreachable", InsertSQLColumnOrder: []string{fixture.name}, InsertSQLColumnTypes: map[string]string{fixture.name: fixture.typeName}}
					count, _, exportErr := exportQueryResultToFileWithContext(ctx, output, instance, config, fixture.query, options, nil)
					if err := output.Close(); err != nil {
						t.Fatal(err)
					}
					if exportErr == nil || count != 0 || !strings.Contains(exportErr.Error(), "HEX/BASE64") {
						t.Fatalf("irreversible Hive wire representation must fail before first row: count=%d error=%v", count, exportErr)
					}
				})
			}
		})
	}
	rows, _, err := instance.QueryContext(ctx, "SELECT unhex('00ff') AS payload")
	if err != nil || len(rows) != 1 || fmt.Sprint(rows[0]["payload"]) != "0x00ff" {
		t.Fatalf("top-level BINARY must remain supported: %#v %v", rows, err)
	}
}
