package app

import (
	"bytes"
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestHiveTransferBackupDDLIsolatesStorageAndNamespace(t *testing.T) {
	drop := buildSQLDropIfExistsStatementWithDatabaseContext(connection.ConnectionConfig{Type: "hive"}, "source", "events", false, true)
	if strings.Contains(drop, "source") || !strings.Contains(drop, "DROP TABLE IF EXISTS ") {
		t.Fatalf("Hive restore must not drop a source-qualified object: %s", drop)
	}
	input := "CREATE EXTERNAL TABLE source.events (s STRING COMMENT 'source.events LOCATION ''literal''') PARTITIONED BY (p STRING) LOCATION 's3a://user:secret@host/path?token=private' TBLPROPERTIES ('description'='source.events');"
	got, err := prepareHiveBackupDDL(input, "source", true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "user:secret") || strings.Contains(got, "token=private") || strings.Contains(got, "TABLE source.events") || !strings.Contains(got, "TABLE events") || !strings.Contains(got, "'source.events'") || !strings.Contains(got, "Source LOCATION omitted") {
		t.Fatalf("unsafe relocation: %s", got)
	}
	view := "CREATE VIEW source.report AS SELECT t.id, 'source.events' AS note FROM source.events t -- source.events\n"
	got, err = prepareHiveBackupDDL(view, "source", true)
	if err != nil || !strings.Contains(got, "VIEW report") || !strings.Contains(got, "FROM events") || !strings.Contains(got, "'source.events'") {
		t.Fatalf("view relocation: %s %v", got, err)
	}
	unchanged, err := prepareHiveBackupDDL("CREATE TABLE source.events (x INT)", "source", false)
	if err != nil || unchanged != "CREATE TABLE source.events (x INT)" {
		t.Fatalf("no-context export changed: %q %v", unchanged, err)
	}
	for _, unsafe := range []string{"CREATE TABLE t (x INT) STORED BY 'external.Handler'", "CREATE TABLE t (x INT) LOCATION '${hiveconf:path}'"} {
		if _, err := prepareHiveBackupDDL(unsafe, "source", true); err == nil {
			t.Fatalf("unsafe DDL accepted: %s", unsafe)
		}
	}
}

func TestHiveTransferBackupLexerAndSubstitutionBoundaries(t *testing.T) {
	for _, invalid := range []string{"CREATE TABLE t (x INT", "CREATE TABLE t )", "CREATE TABLE t (x STRING COMMENT 'unterminated)", "/* unclosed"} {
		if _, err := hiveBackupTokens(invalid); err == nil {
			t.Fatalf("malformed DDL accepted: %q", invalid)
		}
	}
	for _, test := range []struct {
		sql    string
		unsafe bool
	}{
		{sql: "SELECT ${hiveconf:x}", unsafe: true},
		{sql: "SELECT '${hivevar:x}'", unsafe: true},
		{sql: "SELECT 1 -- ${hiveconf:x}\n"},
		{sql: "/* ${env:HOME} */ SELECT 1"},
		{sql: "SELECT '${unclosed", unsafe: true},
	} {
		result := PreflightSQLStatement(test.sql, "hive", 0)
		if result.Safe == test.unsafe || test.unsafe && (result.Reason == nil || result.Reason.Code != SQLImportPreflightHiveVariableSubstitution) {
			t.Fatalf("macro preflight %q: %#v", test.sql, result)
		}
	}
}

func TestHiveTransferNativeViewDiscoveryFailsClosed(t *testing.T) {
	config := connection.ConnectionConfig{Type: "hive"}
	database := &hiveTransferFake{views: []string{"report", " "}}
	lookup, err := listExportViewLookup(context.Background(), database, config, "warehouse")
	if err != nil || len(lookup) != 1 || lookup[normalizeExportObjectKey(config, "warehouse", "report")] != "report" {
		t.Fatalf("view discovery: %#v %v", lookup, err)
	}
	database.viewError = errors.New("metadata failure")
	if _, err := listViewNameLookupWithStatus(database, config, "warehouse"); !errors.Is(err, database.viewError) {
		t.Fatal(err)
	}
	if _, err := listHiveExportViews(context.Background(), &fakeExportQueryDB{}, config, "warehouse"); err == nil {
		t.Fatal("missing native view interface accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := listHiveExportViews(ctx, database, config, "warehouse"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := listExportViewLookup(context.Background(), &fakeExportQueryDB{}, connection.ConnectionConfig{Type: "mysql"}, "warehouse"); err != nil {
		t.Fatal(err)
	}
}

func TestHiveTransferApplyChangesUsesNontransactionalResult(t *testing.T) {
	application := &App{}
	config := connection.ConnectionConfig{Type: "hive"}
	for _, unknown := range []bool{false, true} {
		database := &hiveTransferFake{}
		if unknown {
			database.applyError = db.MarkWriteOutcomeUnknown(errors.New("response lost"))
		}
		result := application.applyHiveChanges(config, "warehouse", "events", database, connection.ChangeSet{Inserts: []map[string]interface{}{{"id": 1}}})
		if result.Success == unknown || result.OutcomeUnknown != unknown || len(database.inserts) != 1 {
			t.Fatalf("Hive write result: %#v", result)
		}
		if !unknown && (strings.Contains(strings.ToLower(result.Message), "transaction committed") || !strings.Contains(result.Message, "Hive")) {
			t.Fatalf("Hive transaction was claimed: %s", result.Message)
		}
	}
	if result := application.applyHiveChanges(config, "warehouse", "events", &fakeExportQueryDB{}, connection.ChangeSet{}); result.Success {
		t.Fatal("missing batch interface accepted")
	}
}

func TestHiveTransferQualifiedResultLabels(t *testing.T) {
	for _, test := range []struct{ query, prefix string }{
		{"SELECT * FROM warehouse.events", "events"}, {"SELECT * FROM events;", "events"}, {"SELECT x FROM events", ""}, {"SELECT * FROM events JOIN other ON 1=1", ""},
	} {
		if got := hiveExportSourceTable(test.query, &countingExportConsumer{delegate: &jsonExportFileWriter{}}); got != test.prefix {
			t.Fatalf("prefix %q: %q", test.query, got)
		}
	}
	if got := hiveExportSourceTable("SELECT * FROM events", &exportColumnProjectionConsumer{}); got != "" {
		t.Fatal("projection labels must remain unchanged")
	}
	if got := hiveExportBareColumns([]string{"events.id", "events.price"}, "events"); !reflect.DeepEqual(got, []string{"id", "price"}) {
		t.Fatal(got)
	}
	if got := hiveExportBareColumns([]string{"events.id", "id"}, "events"); !reflect.DeepEqual(got, []string{"events.id", "id"}) {
		t.Fatal("ambiguous labels were collapsed", got)
	}
	layout, err := newHiveInsertLayout(hiveTransferDefinitions(), nil)
	if err != nil {
		t.Fatal(err)
	}
	consumer := &sqlInsertExportConsumer{hiveLayout: layout, quotedTable: "events"}
	columns := hiveTransferColumns()
	for i, name := range columns {
		columns[i] = "events." + name
	}
	if err := consumer.setHiveColumns(columns); err != nil {
		t.Fatal(err)
	}
	if err := consumer.setHiveColumns([]string{"other.id", "other.day"}); err == nil {
		t.Fatal("unknown qualifier must not map by suffix")
	}
	if consumer.hiveSourceTargets["events.price"] != "price" {
		t.Fatal(consumer.hiveSourceTargets)
	}
}

func TestHiveTransferViewDependencyOrder(t *testing.T) {
	config := connection.ConnectionConfig{Type: "hive"}
	views := map[string]string{"warehouse.a_view": "a_view", "warehouse.z_view": "z_view"}
	definitions := map[string]string{"warehouse.a_view": "CREATE VIEW a_view AS SELECT * FROM warehouse.z_view", "warehouse.z_view": "CREATE VIEW z_view AS SELECT * FROM events"}
	objects := []string{"events", "a_view", "z_view"}
	got, err := orderHiveBackupViews(config, "warehouse", objects, views, definitions)
	if err != nil || !reflect.DeepEqual(got, []string{"events", "z_view", "a_view"}) {
		t.Fatalf("dependency order=%#v error=%v", got, err)
	}
	database := &hiveTransferFake{ddlByTable: map[string]string{quoteQualifiedIdentByType("hive", "warehouse.a_view"): definitions["warehouse.a_view"], quoteQualifiedIdentByType("hive", "warehouse.z_view"): definitions["warehouse.z_view"]}}
	prepared, err := prepareHiveExportObjectOrder(context.Background(), database, config, "warehouse", objects, views)
	if err != nil || !reflect.DeepEqual(prepared, got) {
		t.Fatalf("prepared view order=%#v %v", prepared, err)
	}
	definitions["warehouse.z_view"] = "CREATE VIEW z_view AS SELECT * FROM a_view"
	if _, err := orderHiveBackupViews(config, "warehouse", objects, views, definitions); err == nil {
		t.Fatal("view dependency cycle accepted")
	}
	if _, err := hiveViewReferences("SELECT (", "warehouse"); err == nil {
		t.Fatal("malformed view accepted")
	}
	for _, value := range []interface{}{math.NaN(), math.Inf(1), float32(math.Inf(1))} {
		if _, err := hiveExportCellValue(value, false); err == nil {
			t.Fatal("non-finite Hive value became NULL")
		}
	}
}

func TestHiveTransferExactValueStreamAndPointers(t *testing.T) {
	var output bytes.Buffer
	source := &fakeValueStreamExportDB{streamCols: []string{"value", "binary", "nested"}, streamValues: [][]interface{}{{"2026-10-25 00:00:00.123456789", []byte{255}, []interface{}{map[string]interface{}{"raw": "2026-10-25 00:00:00.123456789"}}}}}
	count, _, err := exportQueryResultToFileWithContext(context.Background(), &output, source, connection.ConnectionConfig{Type: "hive"}, "SELECT values", ExportFileOptions{Format: "json"}, nil)
	if err != nil || count != 1 || !strings.Contains(output.String(), "0xff") || !strings.Contains(output.String(), ".123456789") {
		t.Fatalf("exact stream: %s %v", output.String(), err)
	}
	text := "raw"
	if got, err := hiveExportCellValue(&text, false); err != nil || got != hiveExportText("raw") {
		t.Fatalf("pointer: %v %v", got, err)
	}
	if got, err := hiveExportCellValue((*string)(nil), false); err != nil || got != nil {
		t.Fatalf("nil pointer: %v %v", got, err)
	}
	if _, err := hiveJSONSafeValue(map[interface{}]interface{}{1: "a", "1": "b"}, 0); err == nil {
		t.Fatal("ambiguous map key accepted")
	}
	if _, err := hiveJSONSafeValue("x", 33); err == nil {
		t.Fatal("unbounded nesting accepted")
	}
	for _, value := range []interface{}{[]interface{}{}, [1]string{"x"}, map[string]interface{}(nil), []interface{}(nil)} {
		if _, err := hiveExportCellValue(value, false); err != nil {
			t.Fatal(err)
		}
	}
}
