package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/syncjob"
)

func TestDataSyncJobQueryMetadataProbeSQLStripsOnlyTopLevelSQLServerOrderBy(t *testing.T) {
	config := connection.ConnectionConfig{Type: "sqlserver"}
	query := "SELECT id FROM (SELECT id FROM audit ORDER BY created_at DESC) AS nested ORDER BY id DESC"
	got := dataSyncJobQueryMetadataProbeSQL(config, query)
	want := "SELECT TOP 0 * FROM (SELECT id FROM (SELECT id FROM audit ORDER BY created_at DESC) AS nested) AS __gonavi_preflight"
	if got != want {
		t.Fatalf("metadata probe = %q, want %q", got, want)
	}
	if got := dataSyncJobQueryMetadataProbeSQL(config, "SELECT 'ORDER BY' AS label FROM audit ORDER BY id"); !strings.Contains(got, "'ORDER BY'") || strings.Contains(got, "FROM audit ORDER BY id)") {
		t.Fatalf("probe must preserve string literals and remove the outer order: %q", got)
	}
}

func TestDataSyncJobQueryComparisonKeyRequiresMatchingUniqueTargetIndex(t *testing.T) {
	mapping := syncjob.TableMapping{
		KeyColumns: []string{"external_id"},
		Columns:    []syncjob.ColumnMapping{{Source: "external_id", Target: "external_id"}},
	}
	columns := []connection.ColumnDefinition{{Name: "external_id"}}
	nonUnique := []connection.IndexDefinition{{Name: "idx_external_id", ColumnName: "external_id", NonUnique: 1, SeqInIndex: 1}}
	issues := preflightQueryComparisonKeyIssuesWithIndexes(mapping, columns, nonUnique, "query -> target")
	if len(issues) != 1 || issues[0].Code != "query_key_target_non_unique" {
		t.Fatalf("non-unique key issues = %#v", issues)
	}
	unique := []connection.IndexDefinition{{Name: "uq_external_id", ColumnName: "external_id", NonUnique: 0, SeqInIndex: 1}}
	if issues := preflightQueryComparisonKeyIssuesWithIndexes(mapping, columns, unique, "query -> target"); len(issues) != 0 {
		t.Fatalf("unique key issues = %#v", issues)
	}
	compound := []connection.IndexDefinition{
		{Name: "pk_orders", ColumnName: "tenant_id", NonUnique: 0, SeqInIndex: 1},
		{Name: "pk_orders", ColumnName: "order_id", NonUnique: 0, SeqInIndex: 2},
	}
	partial := mapping
	partial.KeyColumns = []string{"tenant_id"}
	partial.Columns = []syncjob.ColumnMapping{{Source: "tenant_id", Target: "tenant_id"}}
	if issues := preflightQueryComparisonKeyIssuesWithIndexes(partial, append(columns, connection.ColumnDefinition{Name: "tenant_id"}), compound, "query -> target"); len(issues) != 1 || issues[0].Code != "query_key_target_non_unique" {
		t.Fatalf("partial compound key issues = %#v", issues)
	}
}

func TestDataSyncJobQueryComparisonKeySkipsIndexCheckWhenMetadataIsUnavailable(t *testing.T) {
	mapping := syncjob.TableMapping{
		KeyColumns: []string{"external_id"},
		Columns:    []syncjob.ColumnMapping{{Source: "external_id", Target: "external_id"}},
	}
	columns := []connection.ColumnDefinition{{Name: "external_id"}}
	if issues := preflightQueryComparisonKeyIssuesWithIndexes(mapping, columns, nil, "query -> target"); len(issues) != 0 {
		t.Fatalf("missing index metadata should not be treated as an unindexed target: %#v", issues)
	}
}

func TestDataSyncJobQueryMetadataProbeSQLServerPreservesOffsetFetch(t *testing.T) {
	query := "SELECT id FROM audit ORDER BY id OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY"
	got := dataSyncJobQueryMetadataProbeSQL(connection.ConnectionConfig{Type: "sqlserver"}, query)
	if !strings.Contains(strings.ToUpper(got), "ORDER BY ID OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY") {
		t.Fatalf("ORDER BY/OFFSET query was changed: %q", got)
	}
}

func TestPreflightUnsupportedTargetSchemaIssuesBlocksOnlyUnrepairableMigrationDiffs(t *testing.T) {
	definition := syncjob.JobDefinition{
		Kind:    syncjob.JobKindMigration,
		Options: syncjob.ExecutionOptions{Content: "both"},
	}
	issues := preflightUnsupportedTargetSchemaIssues(
		definition,
		syncjob.TableMapping{SourceTable: "orders", TargetTable: "orders"},
		[]connection.ColumnDefinition{{Name: "amount", Type: "decimal(18,2)", Nullable: "NO"}},
		[]connection.ColumnDefinition{{Name: "amount", Type: "varchar(32)", Nullable: "NO"}},
		"mysql", "mysql", "orders -> orders",
	)
	if len(issues) != 1 || issues[0].Code != "schema_unsupported_difference" || issues[0].Severity != DataSyncJobPreflightBlocker {
		t.Fatalf("schema diff issues = %#v", issues)
	}
}
