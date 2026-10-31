package app

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

type hiveTransferClearFake struct {
	hiveTransferFake
	capabilities map[string]db.HiveTableWriteCapabilities
	inspected    []string
	executed     []string
	failAt       int
	failure      error
}

func (f *hiveTransferClearFake) HiveTableWriteCapabilities(ctx context.Context, table string) (db.HiveTableWriteCapabilities, error) {
	if err := ctx.Err(); err != nil {
		return db.HiveTableWriteCapabilities{}, err
	}
	f.inspected = append(f.inspected, table)
	return f.capabilities[table], nil
}

func (f *hiveTransferClearFake) ExecContext(ctx context.Context, sql string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	f.executed = append(f.executed, sql)
	if f.failAt == len(f.executed) {
		return 0, f.failure
	}
	return 1, nil
}

func installHiveTransferClearDatabase(t *testing.T, database db.Database) {
	t.Helper()
	installImportTestDatabase(t, database)
	originalSupport, originalRevision := driverRuntimeSupportStatusFunc, verifyDriverAgentRevisionFunc
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
	t.Cleanup(func() {
		driverRuntimeSupportStatusFunc = originalSupport
		verifyDriverAgentRevisionFunc = originalRevision
	})
}

func TestHiveTransferClearPreflightsWholeBatchBeforeAnyDML(t *testing.T) {
	for _, mode := range []tableDataClearMode{tableDataClearModeTruncate, tableDataClearModeDeleteAll} {
		t.Run(string(mode), func(t *testing.T) {
			first := db.HiveTableWriteCapabilities{Truncate: true, Delete: true}
			second := db.HiveTableWriteCapabilities{Reason: "external or non-ACID table"}
			database := &hiveTransferClearFake{capabilities: map[string]db.HiveTableWriteCapabilities{quoteQualifiedIdentByType("hive", "warehouse.a"): first, quoteQualifiedIdentByType("hive", "warehouse.b"): second}}
			installHiveTransferClearDatabase(t, database)
			application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			result := application.runTableDataClear(connection.ConnectionConfig{Type: "hive", Database: "warehouse"}, "warehouse", []string{"a", "b"}, mode)
			if result.Success || len(database.inspected) != 2 || len(database.executed) != 0 || result.OutcomeUnknown {
				t.Fatalf("preflight result=%#v checked=%#v executed=%#v", result, database.inspected, database.executed)
			}
			payload, ok := result.Data.(map[string]interface{})
			if !ok || payload["count"] != 0 {
				t.Fatal(result.Data)
			}
		})
	}
}

func TestHiveTransferClearAllowsVerifiedTruncateAndPreservesPartialOutcome(t *testing.T) {
	for _, partial := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "unknown partial"}[partial], func(t *testing.T) {
			caps := db.HiveTableWriteCapabilities{Truncate: true}
			database := &hiveTransferClearFake{capabilities: map[string]db.HiveTableWriteCapabilities{quoteQualifiedIdentByType("hive", "warehouse.a"): caps, quoteQualifiedIdentByType("hive", "warehouse.b"): caps}}
			if partial {
				database.failAt = 2
				database.failure = db.MarkWriteOutcomeUnknown(errors.New("write response lost"))
			}
			installHiveTransferClearDatabase(t, database)
			application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			result := application.TruncateTables(connection.ConnectionConfig{Type: "hive", Database: "warehouse"}, "warehouse", []string{"a", "b"})
			if result.Success == partial || result.OutcomeUnknown != partial || len(database.executed) != 2 || len(database.inspected) != 2 {
				t.Fatalf("clear result=%#v executed=%#v", result, database.executed)
			}
			payload := result.Data.(map[string]interface{})
			want := 2
			if partial {
				want = 1
			}
			if payload["count"] != want {
				t.Fatal(payload)
			}
		})
	}
	if !supportsTruncateTableForDBType("hive") {
		t.Fatal("Hive native TRUNCATE builder remains disabled")
	}
}

func TestHiveTransferClearRequiresCapabilitiesAndCancellation(t *testing.T) {
	config := connection.ConnectionConfig{Type: "hive"}
	if err := preflightHiveTableClear(context.Background(), &fakeExportQueryDB{}, config, "warehouse", []string{"a"}, tableDataClearModeTruncate); err == nil {
		t.Fatal("unverified Hive mutation accepted")
	}
	if err := preflightHiveTableClear(context.Background(), &fakeExportQueryDB{}, connection.ConnectionConfig{Type: "mysql"}, "warehouse", []string{"a"}, tableDataClearModeTruncate); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := execTableDataClear(ctx, &hiveTransferClearFake{}, config, "TRUNCATE TABLE t"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := execTableDataClear(nil, &fakeExportQueryDB{}, config, "TRUNCATE TABLE t"); err == nil {
		t.Fatal("Hive context execution unavailable")
	}
	if tableClearOutcomeUnknown(errors.New("rejected")) {
		t.Fatal("known rejection reported unknown")
	}
}

func TestHiveTransferSQLQueryMetadataGuardSurvivesWrappers(t *testing.T) {
	writer, err := newSQLInsertExportFileWriter(&bytes.Buffer{}, ExportFileOptions{InsertSQLDialect: "hive", InsertSQLTargetTable: "t", InsertSQLColumnOrder: []string{"m"}, InsertSQLColumnTypes: map[string]string{"m": "MAP<STRING,BINARY>"}})
	if err != nil {
		t.Fatal(err)
	}
	projection := &exportColumnProjectionConsumer{delegate: writer, requestedColumns: []string{"m"}}
	consumer := &countingExportConsumer{delegate: projection}
	if err := consumer.SetColumns([]string{"m"}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.SetColumnDefinitions([]connection.ColumnDefinition{{Name: "m", Type: "MAP<STRING,BINARY>"}}); err == nil || !strings.Contains(err.Error(), "HEX/BASE64") {
		t.Fatalf("missing source schema guard: %v", err)
	}
	projection.columnIndexes = []int{2}
	if err := projection.SetColumnDefinitions(nil); err == nil {
		t.Fatal("invalid projection metadata accepted")
	}
}

func TestHiveTransferTypedExportRejectsIrreversibleWireCollections(t *testing.T) {
	consumer := &hiveExportConsumer{delegate: &importPreviewCollector{previewLimit: 1}}
	if err := consumer.SetColumns([]string{"mapping"}); err != nil {
		t.Fatal(err)
	}
	if err := consumer.SetColumnDefinitions([]connection.ColumnDefinition{{Name: "mapping", Type: "MAP<STRING,BINARY>"}}); err == nil {
		t.Fatal("irreversible nested BINARY metadata must fail before reading rows")
	}
	consumer.columnTypes = map[string]string{"mapping": "MAP<STRING,BINARY>"}
	invalid := "{\"bytes\":" + string([]byte{0, 255}) + "}"
	if err := consumer.ConsumeRow(map[string]interface{}{"mapping": invalid}); err == nil {
		t.Fatal("irreversible Hive binary text was exported as valid data")
	}
}
