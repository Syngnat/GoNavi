package sync

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestAnalyze_SourceQueryUsesQueryResultAsSourceDataset(t *testing.T) {
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {
				{"id": 1, "name": "Alice New"},
				{"id": 2, "name": "Bob"},
			},
			"SELECT `id` FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ WHERE `id` IN (1, 3)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.users": {
					{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
					{Name: "name", Type: "varchar(64)", Nullable: "YES"},
				},
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`users` WHERE `id` IN (1, 2)": {
					{"id": 1, "name": "Alice Old"},
				},
				"SELECT `id` FROM `app`.`users` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 3, "name": "Carol"},
				},
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	engine := NewSyncEngine(Reporter{})
	result := engine.Analyze(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		SourceQuery:  "SELECT id, name FROM active_users",
	})

	if !result.Success {
		t.Fatalf("Analyze 返回失败: %+v", result)
	}
	if len(result.Tables) != 1 {
		t.Fatalf("expected one table summary, got %d", len(result.Tables))
	}

	summary := result.Tables[0]
	if summary.PKColumn != "id" {
		t.Fatalf("expected PKColumn=id, got %q", summary.PKColumn)
	}
	if !summary.CanSync {
		t.Fatalf("expected summary can sync, got %+v", summary)
	}
	if summary.Inserts != 1 || summary.Updates != 1 || summary.Deletes != 1 {
		t.Fatalf("unexpected diff summary: %+v", summary)
	}
}

func TestRunSync_SourceQueryAppliesDiffAgainstTargetTable(t *testing.T) {
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.users": {
				{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
				{Name: "name", Type: "varchar(64)", Nullable: "YES"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {
				{"id": 1, "name": "Alice New"},
				{"id": 2, "name": "Bob"},
			},
			"SELECT `id` FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ WHERE `id` IN (1, 3)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.users": {
					{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
					{Name: "name", Type: "varchar(64)", Nullable: "YES"},
				},
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`users` WHERE `id` IN (1, 2)": {
					{"id": 1, "name": "Alice Old"},
				},
				"SELECT `id` FROM `app`.`users` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 3, "name": "Carol"},
				},
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		SourceQuery:  "SELECT id, name FROM active_users",
		TableOptions: map[string]TableOptions{
			"users": {Insert: true, Update: true, Delete: true},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.TablesSynced != 1 || result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	if targetDB.appliedTable != "users" {
		t.Fatalf("expected applied table users, got %q", targetDB.appliedTable)
	}

	wantInserts := []map[string]interface{}{{"id": 2, "name": "Bob"}}
	if !reflect.DeepEqual(targetDB.appliedChanges.Inserts, wantInserts) {
		t.Fatalf("unexpected inserts: got=%v want=%v", targetDB.appliedChanges.Inserts, wantInserts)
	}

	wantUpdates := []connection.UpdateRow{{
		Keys:   map[string]interface{}{"id": 1},
		Values: map[string]interface{}{"name": "Alice New"},
	}}
	if !reflect.DeepEqual(targetDB.appliedChanges.Updates, wantUpdates) {
		t.Fatalf("unexpected updates: got=%v want=%v", targetDB.appliedChanges.Updates, wantUpdates)
	}

	wantDeletes := []map[string]interface{}{{"id": 3}}
	if !reflect.DeepEqual(targetDB.appliedChanges.Deletes, wantDeletes) {
		t.Fatalf("unexpected deletes: got=%v want=%v", targetDB.appliedChanges.Deletes, wantDeletes)
	}
}

func TestRunSync_SourceQueryInsertUpdateUsesPagedQueries(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {
				{"id": 1, "name": "Alice New"},
				{"id": 2, "name": "Bob"},
			},
			"SELECT `id` FROM (SELECT id, name FROM active_users) AS __gonavi_source_query__ WHERE `id` IN (1, 3)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.users": columns,
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`users` WHERE `id` IN (1, 2)": {
					{"id": 1, "name": "Alice Old"},
				},
				"SELECT `id` FROM `app`.`users` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 3},
				},
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"users"},
		Mode:         "insert_update",
		SourceQuery:  "SELECT id, name FROM active_users",
		TableOptions: map[string]TableOptions{
			"users": {Insert: true, Update: true, Delete: true},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	for _, query := range sourceDB.queryLog {
		if query == "SELECT id, name FROM active_users" {
			t.Fatalf("SQL 结果集分页同步不应全量执行原始查询，实际查询=%s", query)
		}
	}
}

func TestRunSync_BatchesLargeTableChanges(t *testing.T) {
	sourceRows := make([]map[string]interface{}, 2501)
	for i := range sourceRows {
		sourceRows[i] = map[string]interface{}{
			"id":   i + 1,
			"name": "event",
		}
	}

	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.events": columns,
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0":    sourceRows[:1000],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 1000": sourceRows[1000:2000],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 2000": sourceRows[2000:],
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.events": columns,
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != len(sourceRows) {
		t.Fatalf("RowsInserted=%d, want %d", result.RowsInserted, len(sourceRows))
	}
	for _, query := range sourceDB.queryLog {
		if strings.HasPrefix(query, "SELECT * FROM") {
			t.Fatalf("期望分页流式导入不再全量读取源表，实际查询=%s", query)
		}
	}
	if len(targetDB.appliedBatches) != 3 {
		t.Fatalf("期望大表拆成 3 批提交，实际 %d 批", len(targetDB.appliedBatches))
	}
	wantBatchSizes := []int{1000, 1000, 501}
	for idx, want := range wantBatchSizes {
		if got := len(targetDB.appliedBatches[idx].Inserts); got != want {
			t.Fatalf("batch %d inserts=%d, want %d", idx+1, got, want)
		}
	}
}

func TestRunSync_UsesConfiguredBatchSizeForSnapshotReadAndApply(t *testing.T) {
	sourceRows := []map[string]interface{}{
		{"id": 1, "name": "one"},
		{"id": 2, "name": "two"},
		{"id": 3, "name": "three"},
		{"id": 4, "name": "four"},
		{"id": 5, "name": "five"},
	}
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"app.events": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 0": sourceRows[:2],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 2": sourceRows[2:4],
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 4": sourceRows[4:],
		},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"app.events": columns}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
		BatchSize:    2,
	})
	if !result.Success || result.RowsInserted != 5 {
		t.Fatalf("RunSync() = %+v, want five inserts", result)
	}
	if len(targetDB.appliedBatches) != 3 {
		t.Fatalf("applied batches = %#v, want three configured batches", targetDB.appliedBatches)
	}
	for index, want := range []int{2, 2, 1} {
		if got := len(targetDB.appliedBatches[index].Inserts); got != want {
			t.Fatalf("batch %d size = %d, want %d", index+1, got, want)
		}
	}
}

func TestRunSync_RejectsInvalidBatchSizeBeforeConnect(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
		BatchSize:    maxSyncBatchSize + 1,
	})
	if result.Success || !strings.Contains(result.Message, "不能超过 10000") {
		t.Fatalf("RunSync() = %+v, want batch-size rejection", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("invalid batch opened %d connections", factoryCalls)
	}
}

func TestRunSync_SourceQueryAppliesSingleExplicitProjectionMapping(t *testing.T) {
	const sourceSQL = "SELECT external_id, raw_name, amount FROM active_accounts"
	sourceDB := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {{
			"external_id": "7",
			"raw_name":    "  alice  ",
			"amount":      "9223372036854775808.125",
		}},
	}}
	targetColumns := []connection.ColumnDefinition{
		{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "display_name", Type: "varchar(100)"},
		{Name: "amount_exact", Type: "decimal(30,3)"},
		{Name: "status", Type: "varchar(20)"},
	}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"app.people": targetColumns},
		queryData: map[string][]map[string]interface{}{
			"SELECT * FROM `app`.`people`": {{
				"user_id": int64(7), "display_name": "OLD", "amount_exact": "0", "status": "inactive",
			}},
		},
	}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"people"},
		SourceQuery:  sourceSQL,
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			ID:         "active-query-to-people",
			Source:     SyncObjectRef{Name: "active_query"},
			Target:     SyncObjectRef{Schema: "app", Name: "people"},
			KeyColumns: []string{"external_id"},
			Columns: []SyncColumnMapping{
				{Source: "external_id", Target: "user_id", Transforms: []SyncValueTransform{{Type: "int64"}}},
				{Source: "raw_name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
				{Source: "amount", Target: "amount_exact", Transforms: []SyncValueTransform{{Type: "decimal-safe"}}},
				{Target: "status", Default: &SyncDefaultValue{ValueType: "string", Value: "active"}},
			},
		}},
	})
	if !result.Success || result.RowsInserted != 0 || result.RowsUpdated != 1 {
		t.Fatalf("RunSync() = %+v, want mapped source-query update", result)
	}
	if len(targetDB.appliedBatches) != 1 || len(targetDB.appliedBatches[0].Updates) != 1 {
		t.Fatalf("mapped source-query batches = %#v", targetDB.appliedBatches)
	}
	update := targetDB.appliedBatches[0].Updates[0]
	if update.Keys["user_id"] != int64(7) || update.Values["display_name"] != "ALICE" || fmt.Sprint(update.Values["amount_exact"]) != "9223372036854775808.125" || update.Values["status"] != "active" {
		t.Fatalf("mapped source-query update = %#v", update)
	}
	if len(sourceDB.queryLog) != 1 || sourceDB.queryLog[0] != sourceSQL {
		t.Fatalf("mapped source query must fail closed to full execution, queries=%#v", sourceDB.queryLog)
	}
}

func TestRunSync_SourceQueryMappingProjectionErrorDoesNotLeakPayload(t *testing.T) {
	const sourceSQL = "SELECT external_id FROM active_accounts"
	sourceDB := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {{"external_id": "customer-password-raw"}},
	}}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"app.people": {{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"}},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  sourceSQL,
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			Source:     SyncObjectRef{Name: "active_query"},
			Target:     SyncObjectRef{Schema: "app", Name: "people"},
			KeyColumns: []string{"external_id"},
			Columns: []SyncColumnMapping{{
				Source: "external_id", Target: "user_id", Transforms: []SyncValueTransform{{Type: "int64"}},
			}},
		}},
	})
	if result.Success || !strings.Contains(result.Message, "字段投影失败") {
		t.Fatalf("RunSync() = %+v, want projection failure", result)
	}
	if strings.Contains(result.Message, "customer-password-raw") || strings.Contains(strings.Join(result.Logs, " "), "customer-password-raw") {
		t.Fatalf("projection payload leaked: result=%+v", result)
	}
}

func TestRunSync_SourceQueryMappingAllowsBusinessKeyDifferentFromTargetPK(t *testing.T) {
	sourceDB := &fakeMigrationDB{}
	targetDB := &fakeQuerySyncTargetDB{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"app.people": {
			{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "external_code", Type: "varchar(50)", Nullable: "NO"},
		},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: sourceDB},
		syncDatabaseFactoryStep{db: targetDB},
	)
	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT external_id FROM active_accounts",
		Content:      "data",
		Mode:         "insert_update",
		Mappings: []SyncObjectMapping{{
			Source:     SyncObjectRef{Name: "active_query"},
			Target:     SyncObjectRef{Schema: "app", Name: "people"},
			KeyColumns: []string{"external_id"},
			Columns:    []SyncColumnMapping{{Source: "external_id", Target: "external_code"}},
		}},
	})
	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("RunSync() = %+v, want a runnable mapped business-key sync", result)
	}
	if len(sourceDB.queryLog) != 1 || sourceDB.queryLog[0] != "SELECT external_id FROM active_accounts" {
		t.Fatalf("mapped business key did not execute source query: %#v", sourceDB.queryLog)
	}
}

func TestRunSync_SourceQueryRejectsMultipleMappingsBeforeConnect(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })
	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT id FROM active_accounts",
		Content:      "data",
		Mode:         "insert_only",
		Mappings: []SyncObjectMapping{
			{Source: SyncObjectRef{Name: "query_a"}, Target: SyncObjectRef{Name: "people"}, Columns: []SyncColumnMapping{{Source: "id", Target: "id"}}},
			{Source: SyncObjectRef{Name: "query_b"}, Target: SyncObjectRef{Name: "archive"}, Columns: []SyncColumnMapping{{Source: "id", Target: "id"}}},
		},
	})
	if result.Success || !strings.Contains(result.Message, "恰好一个对象映射") {
		t.Fatalf("RunSync() = %+v, want multiple-mapping rejection", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("invalid mapping opened %d connections", factoryCalls)
	}
}

func TestRunSync_DirectImportPagingKeepsSelectedPKFilter(t *testing.T) {
	sourceRows := []map[string]interface{}{
		{"id": 1, "name": "event-1"},
		{"id": 2, "name": "event-2"},
		{"id": 3, "name": "event-3"},
	}
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.events": columns,
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0": sourceRows,
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.events": columns,
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_only",
		TableOptions: map[string]TableOptions{
			"events": {
				Insert:            true,
				SelectedInsertPKs: []string{"2"},
			},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != 1 {
		t.Fatalf("RowsInserted=%d, want 1", result.RowsInserted)
	}
	if len(targetDB.appliedBatches) != 1 || len(targetDB.appliedBatches[0].Inserts) != 1 {
		t.Fatalf("expected one selected insert batch, got %+v", targetDB.appliedBatches)
	}
	if got := targetDB.appliedBatches[0].Inserts[0]["id"]; got != 2 {
		t.Fatalf("selected insert id=%v, want 2", got)
	}
}

func TestRunSync_InsertUpdateDiffUsesPagedPKLookups(t *testing.T) {
	sourceRows := []map[string]interface{}{
		{"id": 1, "name": "one-new"},
		{"id": 2, "name": "two"},
		{"id": 3, "name": "three"},
	}
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
	sourceDB := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"app.events": columns,
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `name` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0": sourceRows,
			"SELECT `id` FROM `app`.`events` WHERE `id` IN (1, 4)": {
				{"id": 1},
			},
		},
	}
	targetDB := &fakeQuerySyncTargetDB{
		fakeMigrationDB: fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{
				"app.events": columns,
			},
			queryData: map[string][]map[string]interface{}{
				"SELECT `id`, `name` FROM `app`.`events` WHERE `id` IN (1, 2, 3)": {
					{"id": 1, "name": "one-old"},
					{"id": 2, "name": "two"},
				},
				"SELECT `id` FROM `app`.`events` ORDER BY `id` ASC LIMIT 1000": {
					{"id": 1},
					{"id": 4},
				},
			},
		},
	}

	oldFactory := newSyncDatabase
	defer func() { newSyncDatabase = oldFactory }()
	callCount := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		callCount++
		if callCount == 1 {
			return sourceDB, nil
		}
		return targetDB, nil
	}

	engine := NewSyncEngine(Reporter{})
	result := engine.RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		Tables:       []string{"events"},
		Mode:         "insert_update",
		TableOptions: map[string]TableOptions{
			"events": {Insert: true, Update: true, Delete: true},
		},
	})

	if !result.Success {
		t.Fatalf("RunSync 返回失败: %+v", result)
	}
	if result.RowsInserted != 1 || result.RowsUpdated != 1 || result.RowsDeleted != 1 {
		t.Fatalf("unexpected sync result: %+v", result)
	}
	if len(targetDB.appliedBatches) != 2 {
		t.Fatalf("expected source diff batch and delete batch, got %d", len(targetDB.appliedBatches))
	}
	firstBatch := targetDB.appliedBatches[0]
	if !reflect.DeepEqual(firstBatch.Inserts, []map[string]interface{}{{"id": 3, "name": "three"}}) {
		t.Fatalf("unexpected inserts: %+v", firstBatch.Inserts)
	}
	wantUpdates := []connection.UpdateRow{{
		Keys:   map[string]interface{}{"id": 1},
		Values: map[string]interface{}{"name": "one-new"},
	}}
	if !reflect.DeepEqual(firstBatch.Updates, wantUpdates) {
		t.Fatalf("unexpected updates: %+v", firstBatch.Updates)
	}
	if !reflect.DeepEqual(targetDB.appliedBatches[1].Deletes, []map[string]interface{}{{"id": 4}}) {
		t.Fatalf("unexpected deletes: %+v", targetDB.appliedBatches[1].Deletes)
	}
	for _, query := range append(sourceDB.queryLog, targetDB.queryLog...) {
		if strings.HasPrefix(query, "SELECT * FROM") {
			t.Fatalf("分页差异同步不应全量读取表，实际查询=%s", query)
		}
	}
}
