package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
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

// 对账任务开启「自动补字段」后与运行时保持一致：补列被预检视为将自动处理，类型不一致仍然拦截；
// 没开时缺字段仍是阻塞项；显式字段映射继续走仅数据路径，不被结构差异拦截。
func TestPreflightReconcileAutoAddColumnsMatchesRuntime(t *testing.T) {
	sourceColumns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "remark", Type: "varchar(120)", Nullable: "YES"},
	}
	targetMissing := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	reconcile := func(autoAdd *bool) syncjob.JobDefinition {
		return syncjob.JobDefinition{
			Kind:    syncjob.JobKindReconcile,
			Options: syncjob.ExecutionOptions{Content: "data", AutoAddColumns: autoAdd},
		}
	}
	mapping := syncjob.TableMapping{SourceTable: "orders", TargetTable: "orders", Enabled: true, KeyColumns: []string{"id"}}
	capability := sync.MigrationCapability{SupportsAutoAddColumns: true}

	issues := preflightImplicitTargetColumnIssues(reconcile(boolPtr(true)), mapping, sourceColumns, targetMissing, capability, "orders")
	if len(issues) != 1 || issues[0].Code != "target_columns_will_be_added" || issues[0].Severity != DataSyncJobPreflightInfo {
		t.Fatalf("opted-in reconcile must report columns will be added, got %#v", issues)
	}
	// 没开自动补字段时，带识别列的映射走显式投影，预检保持原有语义（不检查缺字段）。
	if issues := preflightImplicitTargetColumnIssues(reconcile(nil), mapping, sourceColumns, targetMissing, capability, "orders"); len(issues) != 0 {
		t.Fatalf("default reconcile keeps the explicit-projection route, got %#v", issues)
	}
	plain := syncjob.TableMapping{SourceTable: "orders", TargetTable: "orders", Enabled: true}
	issues = preflightImplicitTargetColumnIssues(reconcile(nil), plain, sourceColumns, targetMissing, capability, "orders")
	if len(issues) != 1 || issues[0].Code != "target_columns_missing_for_sync" || issues[0].Severity != DataSyncJobPreflightBlocker {
		t.Fatalf("missing columns without auto-add must stay a blocker, got %#v", issues)
	}

	typeDrift := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "remark", Type: "int", Nullable: "YES"},
	}
	issues = preflightUnsupportedTargetSchemaIssues(reconcile(boolPtr(true)), mapping, sourceColumns, typeDrift, "mysql", "mysql", "orders -> orders")
	if len(issues) != 1 || issues[0].Code != "schema_unsupported_difference" {
		t.Fatalf("opted-in reconcile must block unrepairable type drift like runtime, got %#v", issues)
	}
	if issues := preflightUnsupportedTargetSchemaIssues(reconcile(nil), mapping, sourceColumns, typeDrift, "mysql", "mysql", "orders -> orders"); len(issues) != 0 {
		t.Fatalf("data-only reconcile must not be blocked by type drift, got %#v", issues)
	}
	explicit := syncjob.TableMapping{
		SourceTable: "orders", TargetTable: "orders", Enabled: true,
		Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}},
	}
	if issues := preflightUnsupportedTargetSchemaIssues(reconcile(boolPtr(true)), explicit, sourceColumns, typeDrift, "mysql", "mysql", "orders -> orders"); len(issues) != 0 {
		t.Fatalf("explicit projections run data-only and must not be blocked, got %#v", issues)
	}
}
