package sync

import (
	"GoNavi-Wails/internal/connection"
	"reflect"
	"strings"
	"testing"
)

func compositeKeyColumns() []connection.ColumnDefinition {
	return []connection.ColumnDefinition{
		{Name: "tenant_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "order_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "status", Type: "varchar(32)", Nullable: "YES"},
	}
}

func compositeKeyRows() ([]map[string]interface{}, []map[string]interface{}) {
	return []map[string]interface{}{
			{"tenant_id": int64(1), "order_id": int64(7), "status": "paid"},
			{"tenant_id": int64(2), "order_id": int64(7), "status": "new"},
		}, []map[string]interface{}{
			{"tenant_id": int64(1), "order_id": int64(7), "status": "pending"},
			{"tenant_id": int64(3), "order_id": int64(7), "status": "old"},
		}
}

func compositeTableConfig() SyncConfig {
	return SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql", Database: "source_db", Host: "source.local"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql", Database: "target_db", Host: "target.local"},
		Tables:              []string{"orders"},
		Content:             "data",
		Mode:                "insert_update",
		TargetTableStrategy: "existing_only",
		TableOptions: map[string]TableOptions{
			"orders": {Insert: true, Update: true, Delete: true},
		},
	}
}

func compositeTableDatabases() (*fakeMigrationDB, *fakeQuerySyncTargetDB) {
	sourceRows, targetRows := compositeKeyRows()
	columns := compositeKeyColumns()
	source := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"source_db.orders": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM `source_db`.`orders`": sourceRows,
		},
	}
	target := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"target_db.orders": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM `target_db`.`orders`": targetRows,
		},
	}}
	return source, target
}

func TestAnalyzeAndPreviewAcceptCompositePrimaryKey(t *testing.T) {
	t.Run("analyze", func(t *testing.T) {
		source, target := compositeTableDatabases()
		useSyncDatabaseFactorySequence(t,
			syncDatabaseFactoryStep{db: source},
			syncDatabaseFactoryStep{db: target},
		)

		result := NewSyncEngine(Reporter{}).Analyze(compositeTableConfig())
		if !result.Success || len(result.Tables) != 1 {
			t.Fatalf("Analyze() = %+v", result)
		}
		summary := result.Tables[0]
		if !summary.CanSync || summary.PKColumn != "tenant_id,order_id" || summary.Inserts != 1 || summary.Updates != 1 || summary.Deletes != 1 {
			t.Fatalf("composite-key summary = %+v", summary)
		}
	})

	t.Run("preview", func(t *testing.T) {
		source, target := compositeTableDatabases()
		useSyncDatabaseFactorySequence(t,
			syncDatabaseFactoryStep{db: source},
			syncDatabaseFactoryStep{db: target},
		)

		preview, err := NewSyncEngine(Reporter{}).Preview(compositeTableConfig(), "orders", 20)
		if err != nil {
			t.Fatalf("Preview() error = %v", err)
		}
		if preview.PKColumn != "tenant_id,order_id" || !reflect.DeepEqual(preview.PKColumns, []string{"tenant_id", "order_id"}) || preview.TotalInserts != 1 || preview.TotalUpdates != 1 || preview.TotalDeletes != 1 {
			t.Fatalf("composite-key preview = %+v", preview)
		}
		if len(preview.Inserts) != 1 || preview.Inserts[0].PK != `[2,7]` {
			t.Fatalf("preview inserts = %#v", preview.Inserts)
		}
		if len(preview.Updates) != 1 || preview.Updates[0].PK != `[1,7]` || preview.Updates[0].Source["status"] != "paid" || preview.Updates[0].Target["status"] != "pending" {
			t.Fatalf("preview updates = %#v", preview.Updates)
		}
		if len(preview.Deletes) != 1 || preview.Deletes[0].PK != `[3,7]` {
			t.Fatalf("preview deletes = %#v", preview.Deletes)
		}
	})
}

func TestRunSyncMySQLLikeAppliesCompositePrimaryKeyChanges(t *testing.T) {
	source, target := compositeTableDatabases()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSync(compositeTableConfig())
	if !result.Success || result.TablesSynced != 1 || result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("RunSync() = %+v", result)
	}
	if len(target.appliedChanges.Updates) != 1 || !reflect.DeepEqual(target.appliedChanges.Updates[0].Keys, map[string]interface{}{"tenant_id": int64(1), "order_id": int64(7)}) {
		t.Fatalf("updates = %#v", target.appliedChanges.Updates)
	}
	if len(target.appliedChanges.Deletes) != 1 || !reflect.DeepEqual(target.appliedChanges.Deletes[0], map[string]interface{}{"tenant_id": int64(3), "order_id": int64(7)}) {
		t.Fatalf("deletes = %#v", target.appliedChanges.Deletes)
	}
}

func TestRunSyncPostgresLikeSourceQueryMapsCompositePrimaryKey(t *testing.T) {
	const sourceSQL = "SELECT tenant, order_no, status FROM active_orders"
	sourceRows, targetRows := compositeKeyRows()
	source := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {
			{"tenant": sourceRows[0]["tenant_id"], "order_no": sourceRows[0]["order_id"], "status": sourceRows[0]["status"]},
			{"tenant": sourceRows[1]["tenant_id"], "order_no": sourceRows[1]["order_id"], "status": sourceRows[1]["status"]},
		},
	}}
	target := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"public.orders": compositeKeyColumns()},
		queryData: map[string][]map[string]interface{}{
			`SELECT * FROM "public"."orders"`: targetRows,
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "postgres", Database: "source_db"},
		TargetConfig: connection.ConnectionConfig{Type: "postgres", Database: "target_db"},
		SourceQuery:  sourceSQL,
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			Source:     SyncObjectRef{Name: "active_orders"},
			Target:     SyncObjectRef{Schema: "public", Name: "orders"},
			KeyColumns: []string{"order_no", "tenant"},
			Columns: []SyncColumnMapping{
				{Source: "tenant", Target: "tenant_id"},
				{Source: "order_no", Target: "order_id"},
				{Source: "status", Target: "status"},
			},
		}},
		TableOptions: map[string]TableOptions{
			"active_orders": {Insert: true, Update: true, Delete: true},
		},
	})
	if !result.Success || result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("RunSync() = %+v", result)
	}
	if target.appliedTable != "public.orders" {
		t.Fatalf("applied table = %q", target.appliedTable)
	}
	if len(target.appliedChanges.Updates) != 1 || len(target.appliedChanges.Updates[0].Keys) != 2 {
		t.Fatalf("updates = %#v", target.appliedChanges.Updates)
	}
	if len(target.appliedChanges.Deletes) != 1 || len(target.appliedChanges.Deletes[0]) != 2 {
		t.Fatalf("deletes = %#v", target.appliedChanges.Deletes)
	}
}

func TestLoadSourceQueryContextRejectsInvalidCompositeKeyMappings(t *testing.T) {
	target := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"app.orders": compositeKeyColumns(),
	}}
	baseColumns := []SyncColumnMapping{
		{Source: "tenant", Target: "tenant_id"},
		{Source: "order_no", Target: "order_id"},
		{Source: "status_raw", Target: "status"},
	}
	cases := []struct {
		name       string
		keyColumns []string
		want       string
	}{
		{name: "missing key", keyColumns: []string{"tenant"}, want: "数量一致"},
		{name: "duplicate key", keyColumns: []string{"tenant", "tenant"}, want: "字段重复"},
		{name: "non primary key", keyColumns: []string{"order_no", "status_raw"}, want: "必须属于目标表主键"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			config := SyncConfig{
				SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
				TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
				SourceQuery:  "SELECT tenant, order_no, status_raw FROM active_orders",
				Content:      "data",
				Mode:         "insert_update",
				Mappings: []SyncObjectMapping{{
					Source:     SyncObjectRef{Name: "active_orders"},
					Target:     SyncObjectRef{Schema: "app", Name: "orders"},
					KeyColumns: tc.keyColumns,
					Columns:    baseColumns,
				}},
			}
			_, err := loadSourceQuerySyncContext(config, &fakeMigrationDB{}, target, false, false, true)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("loadSourceQuerySyncContext() error = %v, want containing %q", err, tc.want)
			}
		})
	}
}

func TestCompositePrimaryKeySelectionUsesPreviewTuple(t *testing.T) {
	rows := []map[string]interface{}{
		{"tenant_id": int64(1), "order_id": int64(7)},
		{"tenant_id": int64(2), "order_id": int64(7)},
	}
	selected := filterRowsByKeySelection([]string{"tenant_id", "order_id"}, rows, true, []string{`[2,7]`})
	if len(selected) != 1 || selected[0]["tenant_id"] != int64(2) {
		t.Fatalf("selected rows = %#v", selected)
	}
}
