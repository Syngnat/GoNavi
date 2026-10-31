package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"

	"github.com/apache/arrow-go/v18/parquet"
	"github.com/apache/arrow-go/v18/parquet/file"
)

func TestHiveTransferHeaderAndIdentifierDialect(t *testing.T) {
	config := connection.ConnectionConfig{Type: "hive"}
	if got := quoteIdentByType("hive", "a.b"); got != hivesql.QuoteIdentifier("a.b") {
		t.Fatal(got)
	}
	if got := quoteQualifiedIdentByType("hive", "warehouse.events"); got != hivesql.QuoteTable("warehouse.events") {
		t.Fatal(got)
	}
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := writeSQLDatabaseBackupHeader(writer, config, "warehouse"); err != nil {
		t.Fatal(err)
	}
	if err := writeSQLFooter(writer, config); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	for _, want := range []string{"-- Dialect: hive", "CREATE DATABASE IF NOT EXISTS " + hivesql.QuoteIdentifier("warehouse"), "USE " + hivesql.QuoteIdentifier("warehouse")} {
		if !strings.Contains(text, want) {
			t.Fatalf("header missing %q: %s", want, text)
		}
	}
	for _, forbidden := range []string{"FOREIGN_KEY_CHECKS", "START TRANSACTION", "COMMIT"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("borrowed MySQL statement %s", text)
		}
	}
	if supportsMySQLDatabaseContext(config) {
		t.Fatal("Hive must not reuse MySQL database context")
	}
	output.Reset()
	if err := writeHiveSQLDatabaseContext(writer, "warehouse", false, true); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "CREATE DATABASE") || strings.Contains(output.String(), "USE ") {
		t.Fatal(output.String())
	}
}

func TestHiveTransferSQLDumpPreservesDDLPartitionsAndTypedData(t *testing.T) {
	ddl := "CREATE EXTERNAL TABLE warehouse.events (id BIGINT, text STRING)\nPARTITIONED BY (day STRING)\nROW FORMAT SERDE 'org.example.Serde'\nSTORED AS ORC\nLOCATION 'hdfs://cluster/path'\nTBLPROPERTIES ('transactional'='false')"
	for _, mode := range []struct {
		name         string
		schema, data bool
	}{
		{name: "schema and data", schema: true, data: true},
		{name: "schema only", schema: true},
		{name: "data only", data: true},
	} {
		t.Run(mode.name, func(t *testing.T) {
			database := &hiveTransferFake{
				fakeExportQueryDB: fakeExportQueryDB{defs: hiveTransferReadableDefinitions()}, ddl: ddl,
				columns: hiveTransferColumns(), rows: []map[string]interface{}{hiveTransferReadableRow()},
				partitions: []string{"day=2026%2F10%2F25", "day=empty%3Dpartition"},
			}
			var output bytes.Buffer
			writer := bufio.NewWriter(&output)
			err := dumpTableSQL(context.Background(), writer, database, connection.ConnectionConfig{Type: "hive"}, "warehouse", "events", mode.schema, mode.data, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := writer.Flush(); err != nil {
				t.Fatal(err)
			}
			text := output.String()
			if mode.schema && (!strings.Contains(text, "PARTITIONED BY") || !strings.Contains(text, "ROW FORMAT SERDE") || !strings.Contains(text, "TBLPROPERTIES") || strings.Contains(text, "hdfs://cluster/path") || !strings.Contains(text, "ADD IF NOT EXISTS PARTITION (") || !strings.Contains(text, "empty=partition")) {
				t.Fatalf("DDL/empty partitions lost: %s", text)
			}
			if !mode.schema && (strings.Contains(text, "CREATE EXTERNAL") || strings.Contains(text, "ADD IF NOT EXISTS")) {
				t.Fatalf("data-only dump emitted schema: %s", text)
			}
			if mode.data != strings.Contains(text, "INSERT INTO TABLE ") || strings.Contains(text, " VALUES ") || strings.Contains(text, "FOREIGN_KEY_CHECKS") {
				t.Fatalf("invalid data mode: %s", text)
			}
		})
	}
}

func TestHiveTransferSQLDumpNeverInsertsViewData(t *testing.T) {
	database := &hiveTransferFake{ddl: "CREATE VIEW warehouse.report AS SELECT * FROM warehouse.events", columnError: errors.New("must not load view columns")}
	var output bytes.Buffer
	writer := bufio.NewWriter(&output)
	if err := dumpTableSQL(context.Background(), writer, database, connection.ConnectionConfig{Type: "hive"}, "warehouse", "report", true, true, nil); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "CREATE VIEW") || len(database.streamQueries) != 0 {
		t.Fatalf("view data was queried: %s, %#v", output.String(), database.streamQueries)
	}
}

func TestHiveTransferPartitionPathDecodeAndValidation(t *testing.T) {
	defs := []connection.ColumnDefinition{{Name: "region", Type: "STRING"}, {Name: "day", Type: "STRING"}}
	got, err := hivePartitionClauseFromPath("region=a%2Fb%3Dc%27%5C/day=x+y%25", defs)
	want := "PARTITION (" + hivesql.QuoteIdentifier("region") + "=" + hivesql.QuoteString("a/b=c'\\") + ", " + hivesql.QuoteIdentifier("day") + "=" + hivesql.QuoteString("x+y%") + ")"
	if err != nil || got != want {
		t.Fatalf("partition %q want %q err=%v", got, want, err)
	}
	for _, invalid := range []string{"region=a", "day=a/region=b", "region=%ZZ/day=b", "region=a/day=b/extra=x"} {
		if _, err := hivePartitionClauseFromPath(invalid, defs); err == nil {
			t.Fatalf("accepted invalid partition %q", invalid)
		}
	}
	for _, value := range []interface{}{nil, "a'\\", time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC), []byte("x")} {
		typeName := "STRING"
		if _, ok := value.(time.Time); ok {
			typeName = "DATE"
		}
		if _, err := hiveStaticPartitionValue(typeName, value); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := hiveStaticPartitionValue("INT", "bad"); err == nil {
		t.Fatal("invalid partition value accepted")
	}
}

func TestHiveTransferInsertLayoutRejectsUnsafeTypesAndTargets(t *testing.T) {
	for _, defs := range [][]connection.ColumnDefinition{
		nil,
		{{Name: "x", Type: "INT"}, {Name: "X", Type: "INT"}},
		{{Name: "x", Type: "INT); DROP TABLE t"}},
		{{Name: "p", Type: "STRING", Extra: "partition"}},
		{{Name: "x", Type: "INT"}, {Name: "p", Type: "ARRAY<INT>", Extra: "partition"}},
	} {
		if _, err := newHiveInsertLayout(defs, nil); err == nil {
			t.Fatalf("accepted invalid metadata %#v", defs)
		}
	}
	if _, err := newHiveInsertLayout([]connection.ColumnDefinition{{Name: "x", Type: "INT"}}, []string{"absent"}); err == nil {
		t.Fatal("unknown partition accepted")
	}
	layout, err := newHiveInsertLayout([]connection.ColumnDefinition{{Name: "x", Type: "INT"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := layout.insert("t;DROP TABLE x", nil); err == nil {
		t.Fatal("unsafe target accepted")
	}
}

func TestHiveTransferSQLQueryExportKeepsTargetOrder(t *testing.T) {
	options := withHiveExportColumns(ExportFileOptions{Format: "sql", InsertSQLDialect: "hive", InsertSQLTargetTable: "warehouse.events", InsertSQLColumnTypes: buildImportColumnTypeMap(hiveTransferDefinitions())}, hiveTransferDefinitions())
	var output bytes.Buffer
	writer, err := newSQLInsertExportFileWriter(&output, normalizeExportFileOptions("", options))
	if err != nil {
		t.Fatal(err)
	}
	columns := hiveTransferColumns()
	for i, j := 0, len(columns)-1; i < j; i, j = i+1, j-1 {
		columns[i], columns[j] = columns[j], columns[i]
	}
	if err := writer.SetColumns(columns); err != nil {
		t.Fatal(err)
	}
	values := make([]interface{}, len(columns))
	row := hiveTransferRow()
	for i, column := range columns {
		values[i] = row[column]
	}
	if err := writer.ConsumeRowValues(values); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	want, err := buildHiveImportInsert("warehouse.events", columns, row, newImportColumnTypeLookup(hiveTransferDefinitions()))
	if err != nil || output.String() != want+";\n" {
		t.Fatalf("query SQL=%q expected=%q err=%v", output.String(), want, err)
	}
	if _, err := newSQLInsertExportFileWriter(&bytes.Buffer{}, ExportFileOptions{InsertSQLDialect: "hive", InsertSQLTargetTable: "t"}); err == nil {
		t.Fatal("missing metadata accepted")
	}
	if err := writer.consumer.setHiveColumns([]string{"unknown"}); err == nil {
		t.Fatal("unknown query column accepted")
	}
	if err := writer.consumer.setHiveColumns([]string{"id"}); err == nil {
		t.Fatal("missing partition accepted")
	}
}

func TestHiveTransferOtherFormatsPreserveBinaryNestedAndDecimal(t *testing.T) {
	for _, format := range []string{"json", "md", "html", "parquet"} {
		t.Run(format, func(t *testing.T) {
			var output bytes.Buffer
			source := &hiveTransferFake{columns: hiveTransferColumns(), rows: []map[string]interface{}{hiveTransferRow()}}
			count, _, err := exportQueryResultToFileWithContext(context.Background(), &output, source, connection.ConnectionConfig{Type: "hive"}, "SELECT * FROM events", ExportFileOptions{Format: format}, nil)
			if err != nil || count != 1 {
				t.Fatalf("export count=%d err=%v", count, err)
			}
			if format == "parquet" {
				reader, err := file.NewParquetReader(bytes.NewReader(output.Bytes()))
				if err != nil {
					t.Fatal(err)
				}
				defer reader.Close()
				for _, index := range []int{2, 3, 4, 5, 6, 8} {
					chunk, err := reader.RowGroup(0).Column(index)
					if err != nil {
						t.Fatal(err)
					}
					values := make([]parquet.ByteArray, 1)
					_, n, err := chunk.(*file.ByteArrayColumnChunkReader).ReadBatch(1, values, []int16{0}, nil)
					if err != nil || n != 1 || len(values[0]) == 0 {
						t.Fatalf("parquet readback=%q err=%v", values, err)
					}
				}
				return
			}
			text := output.String()
			for _, token := range []string{"0x00ff5c27", "12345678901234567890123456.123456789012", "2026-10-25 22:01:02.123456789"} {
				if !strings.Contains(text, token) {
					t.Fatalf("lost %q: %s", token, text)
				}
			}
			if format == "json" {
				var rows []map[string]interface{}
				decoder := json.NewDecoder(strings.NewReader(text))
				decoder.UseNumber()
				if err := decoder.Decode(&rows); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(rows[0]["mapping"], map[string]interface{}{"bytes": "0x00ff"}) {
					t.Fatalf("binary MAP damaged: %#v", rows)
				}
			}
		})
	}
}
