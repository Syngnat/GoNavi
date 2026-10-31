//go:build gonavi_hive_driver

package app

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func hiveTransferLiveDatabase(t *testing.T) (*db.HiveDB, connection.ConnectionConfig, string, string) {
	t.Helper()
	host := strings.TrimSpace(os.Getenv("GONAVI_HIVE_LIVE_HOST"))
	if host == "" {
		t.Skip("set GONAVI_HIVE_LIVE_HOST to run isolated real-Hive transfer verification")
	}
	port := 10000
	if text := os.Getenv("GONAVI_HIVE_LIVE_PORT"); text != "" {
		var err error
		port, err = strconv.Atoi(text)
		if err != nil || port < 1 || port > 65535 {
			t.Fatal("invalid GONAVI_HIVE_LIVE_PORT")
		}
	}
	params := os.Getenv("GONAVI_HIVE_LIVE_PARAMS")
	if params == "" {
		params = "authMode=NONE&hiveFamily=hive&fetchSize=100"
	}
	config := connection.ConnectionConfig{Type: "hive", Host: host, Port: port, User: os.Getenv("GONAVI_HIVE_LIVE_USER"),
		Password: os.Getenv("GONAVI_HIVE_LIVE_PASSWORD"), ConnectionParams: params, Database: "default", Timeout: 30, QueryTimeout: 120}
	instance := &db.HiveDB{}
	if err := instance.Connect(config); err != nil {
		t.Fatalf("connect live Hive: %v", err)
	}
	t.Cleanup(func() {
		if err := instance.Close(); err != nil {
			t.Errorf("close live Hive: %v", err)
		}
	})
	var nonce [6]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	source := "gonavi_transfer_" + hex.EncodeToString(nonce[:])
	restored := source + "_restore"
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		for _, database := range []string{restored, source} {
			if !strings.HasPrefix(database, "gonavi_transfer_") {
				t.Error("refusing unsafe Hive cleanup target")
				continue
			}
			if _, err := instance.ExecContext(ctx, "DROP DATABASE IF EXISTS "+hivesql.QuoteIdentifier(database)+" CASCADE"); err != nil {
				t.Errorf("cleanup isolated Hive namespace: %v", err)
			}
		}
	})
	return instance, config, source, restored
}

func hiveTransferLiveExec(t *testing.T, ctx context.Context, instance *db.HiveDB, sql string) {
	t.Helper()
	if _, err := instance.ExecContext(ctx, sql); err != nil {
		t.Fatalf("live Hive statement failed: %v", err)
	}
}

func hiveTransferLiveCreateTable(t *testing.T, ctx context.Context, instance *db.HiveDB, database, table string) {
	t.Helper()
	columns := make([]string, 0)
	for _, def := range hiveTransferReadableDefinitions() {
		if def.Extra != "partition" {
			columns = append(columns, hivesql.QuoteIdentifier(def.Name)+" "+def.Type)
		}
	}
	hiveTransferLiveExec(t, ctx, instance, "CREATE TABLE "+hivesql.QuoteIdentifier(database)+"."+hivesql.QuoteIdentifier(table)+
		" ("+strings.Join(columns, ", ")+") PARTITIONED BY (day STRING) STORED AS ORC TBLPROPERTIES ('transactional'='false')")
}

func hiveTransferLiveAssertRow(t *testing.T, ctx context.Context, instance *db.HiveDB, table string) {
	t.Helper()
	query := "SELECT CAST(id AS STRING) AS exact_id, text AS blank_text, CAST(price AS STRING) AS exact_price, hex(payload) AS binary_hex, " +
		"CAST(items[0] AS STRING) AS array_price, hex(mapping['bytes']) AS map_binary, CAST(details.amount AS STRING) AS struct_price, " +
		"details.ok AS struct_bool, details.note AS struct_text, hex(details.payload) AS struct_binary, active AS active_bool, CAST(at AS STRING) AS exact_time, day AS partition_day FROM " + hivesql.QuoteTable(table)
	rows, _, err := instance.QueryContext(ctx, query)
	if err != nil || len(rows) != 1 {
		t.Fatalf("live Hive verification rows=%d err=%v", len(rows), err)
	}
	for key, want := range map[string]string{
		"exact_id": "9007199254740993", "blank_text": "", "exact_price": "12345678901234567890123456.123456789012",
		"binary_hex": "00FF5C27", "array_price": "12345678901234567890123456.123456789012", "map_binary": "307830306666",
		"struct_price": "12345678901234567890123456.123456789012", "struct_bool": "true", "struct_binary": "307830306666",
		"active_bool": "true", "exact_time": "2026-10-25 22:01:02.123456789", "partition_day": "2026/10/25",
	} {
		if got := fmt.Sprint(rows[0][key]); got != want {
			t.Errorf("live Hive %s=%q, want %q", key, got, want)
		}
	}
	wantNote := hiveTransferRow()["details"].(map[string]interface{})["note"]
	if got := rows[0]["struct_text"]; got != wantNote {
		t.Errorf("backslash/quote text roundtrip: got %q want %q", got, wantNote)
	}
}

func TestHiveTransferLiveSQLBackupRestore(t *testing.T) {
	instance, config, source, restored := hiveTransferLiveDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	hiveTransferLiveExec(t, ctx, instance, "CREATE DATABASE "+hivesql.QuoteIdentifier(source))
	hiveTransferLiveExec(t, ctx, instance, "CREATE DATABASE "+hivesql.QuoteIdentifier(restored))
	hiveTransferLiveCreateTable(t, ctx, instance, source, "input_csv")
	if err := instance.ApplyChangesContext(ctx, source+".input_csv", connection.ChangeSet{Inserts: []map[string]interface{}{hiveTransferReadableRow()}}); err != nil {
		t.Fatal(err)
	}
	hiveTransferLiveAssertRow(t, ctx, instance, source+".input_csv")
	hiveTransferLiveExports(t, ctx, instance, config, source)
	hiveTransferLiveNullPaired(t, ctx, instance, config)
	hiveTransferLiveBackupRestore(t, ctx, instance, config, source, restored)
}

func TestHiveTransferLiveRoundTrip(t *testing.T) {
	instance, config, source, restored := hiveTransferLiveDatabase(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	hiveTransferLiveExec(t, ctx, instance, "CREATE DATABASE "+hivesql.QuoteIdentifier(source))
	hiveTransferLiveExec(t, ctx, instance, "CREATE DATABASE "+hivesql.QuoteIdentifier(restored))
	for _, format := range []string{"csv", "json", "xlsx"} {
		t.Run("import_"+format, func(t *testing.T) {
			table := "input_" + format
			hiveTransferLiveCreateTable(t, ctx, instance, source, table)
			path := filepath.Join(t.TempDir(), "input."+format)
			output, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			fixture := &hiveTransferFake{columns: hiveTransferColumns(), rows: []map[string]interface{}{hiveTransferReadableRow()}}
			_, _, exportErr := exportQueryResultToFileWithContext(ctx, output, fixture, config, "SELECT fixture", ExportFileOptions{Format: format}, nil)
			closeErr := output.Close()
			if exportErr != nil || closeErr != nil {
				t.Fatalf("fixture export: %v %v", exportErr, closeErr)
			}
			defs, err := instance.GetColumnsContext(ctx, source, table)
			if err != nil {
				t.Fatal(err)
			}
			writer := newImportDatabaseRowWriter(instance, "hive", source+"."+table, newImportColumnTypeLookup(defs))
			consumer := newImportBatchConsumer(writer, 20, 0, false, false, nil)
			consumer.SetContext(ctx)
			if err := streamImportFileWithOptionsContext(ctx, path, consumer, ImportFileOptions{LosslessHive: true}); err != nil {
				t.Fatal(err)
			}
			if err := consumer.Flush(); err != nil {
				t.Fatal(err)
			}
			hiveTransferLiveAssertRow(t, ctx, instance, source+"."+table)
		})
	}
	if t.Failed() {
		return
	}
	hiveTransferLiveExports(t, ctx, instance, config, source)
	hiveTransferLiveNullPaired(t, ctx, instance, config)
	hiveTransferLiveBackupRestore(t, ctx, instance, config, source, restored)
}

func hiveTransferLiveExports(t *testing.T, ctx context.Context, instance *db.HiveDB, config connection.ConnectionConfig, source string) {
	t.Helper()
	for _, format := range []string{"csv", "json", "xlsx", "md", "html", "parquet", "sql"} {
		t.Run("export_"+format, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "result."+format)
			output, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			options := ExportFileOptions{Format: format, InsertSQLDialect: "hive", InsertSQLTargetTable: source + ".input_csv", InsertSQLColumnTypes: buildImportColumnTypeMap(hiveTransferReadableDefinitions())}
			options = withHiveExportColumns(options, hiveTransferReadableDefinitions())
			count, _, exportErr := exportQueryResultToFileWithContext(ctx, output, instance, config, "SELECT * FROM "+hivesql.QuoteTable(source+".input_csv"), options, nil)
			closeErr := output.Close()
			if exportErr != nil || closeErr != nil || count != 1 {
				t.Fatalf("live export count=%d error=%v close=%v", count, exportErr, closeErr)
			}
			if format == "csv" || format == "json" || format == "xlsx" {
				hiveTransferLiveAssertExportedFile(t, path)
			}
			stat, err := os.Stat(path)
			if err != nil || stat.Size() == 0 {
				t.Fatalf("live export is empty: %v", err)
			}
		})
	}
}

func hiveTransferLiveAssertExportedFile(t *testing.T, path string) {
	t.Helper()
	collector := &importCollectConsumer{}
	err := streamImportFileWithOptions(path, collector, ImportFileOptions{LosslessHive: true})
	rows, columns := collector.rows, collector.columns
	if err != nil || len(rows) != 1 {
		t.Fatalf("read exported Hive file: rows=%d err=%v", len(rows), err)
	}
	lookup := newImportColumnTypeLookup(hiveTransferReadableDefinitions())
	got, err := buildHiveImportInsert("target", columns, rows[0], lookup)
	if err != nil {
		t.Fatal(err)
	}
	want, err := buildHiveImportInsert("target", hiveTransferColumns(), hiveTransferReadableRow(), lookup)
	if err != nil || got != want {
		t.Fatalf("real Hive export lost values: err=%v got=%s want=%s", err, got, want)
	}
}

func hiveTransferLiveBackupRestore(t *testing.T, ctx context.Context, instance *db.HiveDB, config connection.ConnectionConfig, source, restored string) {
	t.Helper()
	hiveTransferLiveExec(t, ctx, instance, "ALTER TABLE "+hivesql.QuoteTable(source+".input_csv")+" ADD IF NOT EXISTS PARTITION (day='empty')")
	hiveTransferLiveExec(t, ctx, instance, "CREATE VIEW "+hivesql.QuoteTable(source+".transfer_report")+" AS SELECT id,price FROM "+hivesql.QuoteTable(source+".input_csv"))
	lookup, err := listHiveExportViews(ctx, instance, config, source)
	if err != nil {
		t.Fatal(err)
	}
	var backup bytes.Buffer
	writer := bufio.NewWriter(&backup)
	if err := writeSQLDatabaseBackupHeader(writer, config, source); err != nil {
		t.Fatal(err)
	}
	if err := writeSQLDropIfExistsPreamble(writer, config, source, []string{"input_csv", "transfer_report"}, lookup, true, ExportFileOptions{IncludeDropIfExists: true}); err != nil {
		t.Fatal(err)
	}
	for _, object := range []string{"input_csv", "transfer_report"} {
		if err := dumpTableSQL(ctx, writer, instance, config, source, object, true, true, lookup); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	preflight, err := PreflightSQLImport(strings.NewReader(backup.String()), "hive")
	if err != nil || !preflight.Safe {
		t.Fatalf("backup preflight %#v %v", preflight, err)
	}
	result, err := executeSQLFileStream(ctx, instance, strings.NewReader(backup.String()), sqlFileExecutionOptions{DBType: "hive", PinDatabase: restored}, nil)
	if err != nil || result.Failed != 0 {
		t.Fatalf("live SQL restore result=%#v err=%v", result, err)
	}
	hiveTransferLiveAssertRow(t, ctx, instance, restored+".input_csv")
	hiveTransferLiveAssertRow(t, ctx, instance, source+".input_csv")
	rows, _, err := instance.QueryContext(ctx, "SHOW PARTITIONS "+hivesql.QuoteTable(restored+".input_csv"))
	if err != nil || len(rows) != 2 {
		t.Fatalf("restored empty/data partitions count=%d err=%v", len(rows), err)
	}
	views, err := instance.HiveViews(ctx, restored)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(views, ","), "transfer_report") {
		t.Fatalf("restored view missing: %#v", views)
	}
	rows, _, err = instance.QueryContext(ctx, "SELECT COUNT(*) AS n FROM "+hivesql.QuoteTable(restored+".transfer_report"))
	if err != nil || len(rows) != 1 || fmt.Sprint(rows[0]["n"]) != "1" {
		t.Fatalf("restored view query failed: %#v %v", rows, err)
	}
}
