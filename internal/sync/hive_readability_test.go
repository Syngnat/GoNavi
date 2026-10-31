package sync

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestHiveNestedBinarySourceFailsBeforeAnySchemaOrDataWrite(t *testing.T) {
	for _, typ := range []string{"map<string,binary>", "array<binary>", "struct<raw:binary>", "uniontype<int,binary>"} {
		t.Run(typ, func(t *testing.T) {
			fields := []connection.ColumnDefinition{{Name: "payload", Type: typ}}
			source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", nil, nil)
			config := hiveTestConfig("insert_only")
			config.Content, config.TargetTableStrategy = "both", "auto_create_if_missing"
			useHiveSyncTestDBs(t, source, target)
			result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
			if result.Success || !strings.Contains(result.Message, "HEX/BASE64") {
				t.Fatalf("lossy source was not explicitly rejected: %+v", result)
			}
			assertHiveNoWrites(t, target)
			if len(source.streamQueries) != 0 {
				t.Fatal("read known-lossy bytes before metadata preflight")
			}
		})
	}
}

func TestHiveNestedBinarySchemaOnlyPreservesDDLWithoutReadingValues(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "payload", Type: "map<string,binary>"}}
	source, target := newHiveSyncTestDB("src", fields, nil), newHiveSyncTestDB("dst", nil, nil)
	target.createColumns = fields
	config := hiveTestConfig("insert_only")
	config.Content, config.TargetTableStrategy = "schema", "auto_create_if_missing"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || len(target.executed) != 1 || !strings.Contains(target.executed[0], "MAP<STRING,BINARY>") {
		t.Fatalf("schema-only type preservation = %+v, SQL=%v", result, target.executed)
	}
	if len(source.streamQueries) != 0 || len(target.applied) != 0 {
		t.Fatal("schema-only migration read or changed row values")
	}
}

func TestHiveNestedBinaryExplicitHexScalarQueryIsSafe(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "hex_value", Type: "STRING"}}
	source := newHiveSyncTestDB("src", fields, []map[string]interface{}{{"hex_value": "00FF"}})
	target := newHiveSyncTestDB("dst", fields, nil)
	config := hiveTestConfig("insert_only")
	config.SourceQuery = "SELECT hex(payload['bytes']) AS hex_value FROM nested_binary"
	useHiveSyncTestDBs(t, source, target)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), config)
	if !result.Success || result.RowsInserted != 1 || target.applied[0].Inserts[0]["hex_value"] != "00FF" {
		t.Fatalf("explicit scalar projection = %+v, writes=%v", result, target.applied)
	}
}

type hiveExistenceTestDB struct {
	hiveSyncTestDB
	exists      bool
	columnError error
	columnCalls int
}

func (d *hiveExistenceTestDB) TableExists(_, _ string) (bool, error) { return d.exists, nil }
func (d *hiveExistenceTestDB) GetColumns(_, _ string) ([]connection.ColumnDefinition, error) {
	d.columnCalls++
	return nil, d.columnError
}

func TestHiveMissingTargetUsesMetadataExistenceInsteadOfErrorText(t *testing.T) {
	fields := []connection.ColumnDefinition{{Name: "name", Type: "string"}}
	source := newHiveSyncTestDB("src", fields, nil)
	target := &hiveExistenceTestDB{hiveSyncTestDB: *newHiveSyncTestDB("dst", nil, nil), columnError: errors.New("HiveServer2 [42S02/10001]: Table not found")}
	config := hiveTestConfig("insert_only")
	config.Content, config.TargetTableStrategy = "both", "auto_create_if_missing"
	plan, err := InspectSchemaMigrationPlan(config, "events", source, target)
	if err != nil || !plan.AutoCreate || plan.TargetTableExists || target.columnCalls != 0 {
		t.Fatalf("missing table plan = %+v, err=%v, GetColumns calls=%d", plan, err, target.columnCalls)
	}
}

func TestHiveExistingTargetMetadataErrorsAreNeverTreatedAsMissing(t *testing.T) {
	denied := errors.New("permission denied")
	target := &hiveExistenceTestDB{exists: true, columnError: denied}
	if _, exists, err := inspectHiveMigrationTargetColumns(target, "hive", "dst", "events"); exists || !errors.Is(err, denied) {
		t.Fatalf("metadata error = %v, exists %t", err, exists)
	}
}
