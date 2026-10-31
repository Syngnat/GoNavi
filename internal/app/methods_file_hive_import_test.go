package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func hiveTransferDefinitions() []connection.ColumnDefinition {
	return []connection.ColumnDefinition{
		{Name: "id", Type: "BIGINT"},
		{Name: "text", Type: "STRING", Nullable: "YES"},
		{Name: "price", Type: "DECIMAL(38,12)"},
		{Name: "payload", Type: "BINARY"},
		{Name: "items", Type: "ARRAY<DECIMAL(38,12)>"},
		{Name: "mapping", Type: "MAP<STRING,BINARY>"},
		{Name: "details", Type: "STRUCT<amount:DECIMAL(38,12),ok:BOOLEAN,note:STRING,payload:BINARY>"},
		{Name: "active", Type: "BOOLEAN"},
		{Name: "at", Type: "TIMESTAMP"},
		{Name: "day", Type: "STRING", Extra: "partition"},
	}
}

func hiveTransferRow() map[string]interface{} {
	return map[string]interface{}{
		"id": json.Number("9007199254740993"), "text": "",
		"price":   json.Number("12345678901234567890123456.123456789012"),
		"payload": []byte{0, 255, 92, 39},
		"items":   []interface{}{json.Number("12345678901234567890123456.123456789012"), nil},
		"mapping": map[string]interface{}{"bytes": []byte{0, 255}},
		"details": map[string]interface{}{
			"amount": json.Number("12345678901234567890123456.123456789012"),
			"ok":     true, "note": "C:\\new\\folder\\'", "payload": []byte{0, 255},
		},
		"active": true, "at": "2026-10-25 22:01:02.123456789", "day": "2026/10/25",
	}
}

func hiveTransferReadableDefinitions() []connection.ColumnDefinition {
	defs := hiveTransferDefinitions()
	for i := range defs {
		switch defs[i].Name {
		case "mapping":
			defs[i].Type = "MAP<STRING,STRING>"
		case "details":
			defs[i].Type = "STRUCT<amount:DECIMAL(38,12),ok:BOOLEAN,note:STRING,payload:STRING>"
		}
	}
	return defs
}

func hiveTransferReadableRow() map[string]interface{} {
	row := hiveTransferRow()
	row["mapping"] = map[string]interface{}{"bytes": "0x00ff"}
	row["details"].(map[string]interface{})["payload"] = "0x00ff"
	return row
}

func hiveTransferColumns() []string {
	defs := hiveTransferDefinitions()
	columns := make([]string, 0, len(defs))
	for _, def := range defs {
		columns = append(columns, def.Name)
	}
	return columns
}

func TestHiveTransferCSVJSONXLSXRoundTrip(t *testing.T) {
	defs := hiveTransferDefinitions()
	lookup := newImportColumnTypeLookup(defs)
	original := hiveTransferRow()
	wantSQL, err := buildHiveImportInsert("warehouse.events", hiveTransferColumns(), original, lookup)
	if err != nil {
		t.Fatal(err)
	}
	for _, format := range []string{"csv", "json", "xlsx"} {
		t.Run(format, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "hive."+format)
			output, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			source := &hiveTransferFake{columns: hiveTransferColumns(), rows: []map[string]interface{}{original}}
			count, _, exportErr := exportQueryResultToFileWithContext(context.Background(), output, source,
				connection.ConnectionConfig{Type: "hive"}, "SELECT * FROM events", ExportFileOptions{Format: format}, nil)
			closeErr := output.Close()
			if exportErr != nil || closeErr != nil || count != 1 {
				t.Fatalf("export count=%d error=%v close=%v", count, exportErr, closeErr)
			}
			target := &hiveTransferFake{}
			writer := newImportDatabaseRowWriter(target, "hive", "warehouse.events", lookup)
			consumer := newImportBatchConsumer(writer, 20, 0, false, false, nil)
			if err := streamImportFile(path, consumer); err != nil {
				t.Fatal(err)
			}
			if err := consumer.Flush(); err != nil {
				t.Fatal(err)
			}
			if len(target.inserts) != 1 || target.inserts[0]["text"] != "" {
				t.Fatalf("blank Hive STRING was changed: %#v", target.inserts)
			}
			gotSQL, err := buildHiveImportInsert("warehouse.events", hiveTransferColumns(), target.inserts[0], lookup)
			if err != nil || gotSQL != wantSQL {
				t.Fatalf("roundtrip error=%v\n got: %s\nwant: %s", err, gotSQL, wantSQL)
			}
		})
	}
}

func TestHiveTransferImportCapabilityNeverClaimsTransactions(t *testing.T) {
	capability := ResolveDataImportCapability(connection.ConnectionConfig{Type: "hive"}, &hiveTransferFake{})
	if capability.DatabaseType != "hive" || !capability.TableImport.Supported || !capability.SQLFileImport.Supported {
		t.Fatalf("Hive import capability %#v", capability)
	}
	if capability.TableImport.SupportsTransactionalBatch || capability.SQLFileImport.SupportsTransactionalBatch ||
		!capability.SQLFileImport.RequiresPinnedSession || !reflect.DeepEqual(capability.TableImport.SupportedFormats, []string{"csv", "json", "xlsx"}) {
		t.Fatalf("unsafe Hive capability %#v", capability)
	}
	if !reflect.DeepEqual(capability.TableImport.SupportedConflictPolicies, []string{"stop"}) {
		t.Fatal(capability.TableImport.SupportedConflictPolicies)
	}
	for _, policy := range []string{"skip_duplicates", "upsert"} {
		if err := validateImportConflictPolicyForDB("hive", ImportFileOptions{ConflictPolicy: policy, ConflictKeyColumns: []string{"id"}}); err == nil {
			t.Fatalf("Hive must reject conflict policy %s", policy)
		}
	}
}

func TestHiveTransferImportInsertRequiresSafeMetadata(t *testing.T) {
	for _, test := range []struct {
		name string
		defs []connection.ColumnDefinition
		cols []string
		row  map[string]interface{}
	}{
		{name: "missing metadata", cols: []string{"x"}, row: map[string]interface{}{"x": 1}},
		{name: "unknown column", defs: []connection.ColumnDefinition{{Name: "x", Type: "INT"}}, cols: []string{"other"}},
		{name: "missing partition", defs: []connection.ColumnDefinition{{Name: "x", Type: "INT"}, {Name: "p", Type: "STRING", Extra: "partition"}}, cols: []string{"x"}},
		{name: "decimal float", defs: []connection.ColumnDefinition{{Name: "x", Type: "DECIMAL(38,12)"}}, cols: []string{"x"}, row: map[string]interface{}{"x": 1.1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := buildHiveImportInsert("t", test.cols, test.row, newImportColumnTypeLookup(test.defs))
			if err == nil {
				t.Fatal("unsafe Hive input was accepted")
			}
		})
	}
}

func TestHiveTransferBatchAndSinglePreserveRawValuesAndContext(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "batch"}[batch], func(t *testing.T) {
			database := &hiveTransferFake{}
			writer := newImportDatabaseRowWriter(database, "hive", "t", newImportColumnTypeLookup(hiveTransferDefinitions()))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			row := hiveTransferRow()
			var err error
			if batch {
				err = writer.ApplyBatchContext(ctx, []map[string]interface{}{row})
			} else {
				err = writer.ApplyOneContext(ctx, row)
			}
			if err != nil || database.appliedContext != ctx || !reflect.DeepEqual(database.inserts, []map[string]interface{}{row}) {
				t.Fatalf("preservation/context: error=%v rows=%#v", err, database.inserts)
			}
			database.inserts[0]["text"] = "changed"
			if row["text"] != "" {
				t.Fatal("writer leaked map ownership")
			}
			cancel()
			if err := writer.ApplyOneContext(ctx, row); err == nil {
				t.Fatal("cancelled import was accepted")
			}
		})
	}
	legacy := newImportDatabaseRowWriter(&hiveTransferFake{}, "postgres", "t", newImportColumnTypeLookup(hiveTransferDefinitions()))
	if got := legacy.normalizeRowsForImport([]map[string]interface{}{{"text": ""}})[0]["text"]; got != nil {
		t.Fatalf("legacy nullable-column behavior changed: %v", got)
	}
}

func TestHiveTransferInsertUsesSelectAndStaticPartitions(t *testing.T) {
	query, err := buildHiveImportInsert("warehouse.events", hiveTransferColumns(), hiveTransferRow(), newImportColumnTypeLookup(hiveTransferDefinitions()))
	if err != nil {
		t.Fatal(err)
	}
	for _, fragment := range []string{"INSERT INTO TABLE ", " PARTITION (", " SELECT ", "array(", "map(", "named_struct(", "unhex(", "TRUE", "12345678901234567890123456.123456789012"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("missing %q in %s", fragment, query)
		}
	}
	if strings.Contains(query, " VALUES ") || strings.Contains(query, "ON CONFLICT") {
		t.Fatal(query)
	}
}
