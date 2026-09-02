package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDiffColumnStructuresNormalizesEquivalentTypeAndNullableMetadata(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO"},
		{Name: "amount", Type: "decimal(10,2)", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int", Nullable: "N"},
		{Name: "amount", Type: "decimal(10, 2)", Nullable: "NO"},
	}

	if diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql"); len(diffs) != 0 {
		t.Fatalf("equivalent metadata must not produce structural diffs, got %+v", diffs)
	}
}

func TestDescribeColumnStructureRecognizesOracleNotNullableMarker(t *testing.T) {
	got := describeColumnStructure(connection.ColumnDefinition{Type: "NUMBER(10)", Nullable: "N"})
	if got != "NUMBER(10) NOT NULL" {
		t.Fatalf("describeColumnStructure() = %q, want Oracle NOT NULL marker", got)
	}
}

func TestUnsupportedExistingTargetSchemaDiffsAllowsCompatibleDifferences(t *testing.T) {
	diffs := []ColumnStructureDiff{
		{Column: "etl_loaded_at", Kind: "extra_in_target", Target: "timestamp"},
		{Column: "backfilled", Kind: "nullable", Source: "NO", Target: "YES"},
		{Column: "title", Kind: "type", Source: "varchar(200)", Target: "varchar(50)"},
		{Column: "optional_note", Kind: "nullable", Source: "YES", Target: "NO"},
	}

	unsupported := unsupportedExistingTargetSchemaDiffs(diffs)
	if len(unsupported) != 2 || unsupported[0].Column != "title" || unsupported[1].Column != "optional_note" {
		t.Fatalf("unsupportedExistingTargetSchemaDiffs() = %+v, want only unsafe type/nullability differences", unsupported)
	}
}

func TestSchemaPlanWarnsWhenExistingTargetAddsSourceNotNullColumnAsNullable(t *testing.T) {
	sourceDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"source_db.events": {
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "source_tag", Type: "varchar(32)", Nullable: "NO"},
		},
	}}
	targetDB := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"target_db.events": {
			{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		},
	}}
	plan, _, _, err := buildSchemaMigrationPlan(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "target_db"},
		AutoAddColumns: true,
	}, "events", sourceDB, targetDB)
	if err != nil {
		t.Fatalf("buildSchemaMigrationPlan() error = %v", err)
	}
	if len(plan.PreDataSQL) != 1 || !strings.Contains(plan.PreDataSQL[0], "source_tag` varchar(32) NULL") {
		t.Fatalf("plan.PreDataSQL = %v, want a nullable ADD COLUMN", plan.PreDataSQL)
	}
	if !strings.Contains(strings.Join(plan.Warnings, "\n"), "source_tag") || !strings.Contains(strings.Join(plan.Warnings, "\n"), "NOT NULL") {
		t.Fatalf("plan.Warnings = %v, want explicit nullable-relaxation warning", plan.Warnings)
	}
}
