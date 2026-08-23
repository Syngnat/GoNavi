package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestRunSyncSkipRowAppliesSnapshotRowsIndividuallyFromStart(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "secret", Type: "varchar(100)"},
	}
	rows := []map[string]interface{}{
		{"id": int64(1), "secret": "safe-a"},
		{"id": int64(2), "secret": "customer-password-raw"},
		{"id": int64(3), "secret": "safe-c"},
	}
	source := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"src.events": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id`, `secret` FROM `src`.`events` ORDER BY `id` ASC LIMIT 3 OFFSET 0": rows,
		},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	committed := make([]int64, 0, 2)
	target.applyFunc = func(_ string, changes connection.ChangeSet) error {
		if len(changes.Inserts) != 1 || len(changes.Updates) != 0 || len(changes.Deletes) != 0 {
			return fmt.Errorf("unsafe non-singleton apply")
		}
		row := changes.Inserts[0]
		if row["secret"] == "customer-password-raw" {
			return fmt.Errorf("driver rejected customer-password-raw")
		}
		committed = append(committed, row["id"].(int64))
		return nil
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)
	rowErrors := make([]ChangeEventRowError, 0, 1)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
		Tables:         []string{"events"},
		Content:        "data",
		Mode:           "insert_only",
		BatchSize:      3,
		RowErrorPolicy: RowErrorPolicySkipRow,
		OnRowError: func(_ context.Context, rowError ChangeEventRowError) error {
			rowErrors = append(rowErrors, rowError)
			return nil
		},
	})
	if !result.Success || result.RowsInserted != 2 || result.RowsSkipped != 1 || fmt.Sprint(committed) != "[1 3]" {
		t.Fatalf("RunSyncContext() = %+v committed=%v, want two inserts and one skipped row", result, committed)
	}
	if len(rowErrors) != 1 || rowErrors[0].Index != 1 || rowErrors[0].Operation != ChangeEventOperationInsert {
		t.Fatalf("row errors = %#v", rowErrors)
	}
	if strings.Contains(result.Message, "customer-password-raw") || strings.Contains(strings.Join(result.Logs, " "), "customer-password-raw") {
		t.Fatalf("snapshot payload leaked: %+v", result)
	}
	if len(target.applied) != 3 {
		t.Fatalf("apply calls = %#v, want three proactive singleton calls", target.applied)
	}
}

func TestRunSyncSkipRowStopsOnUnknownWriteOutcome(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	source := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"src.events": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id` FROM `src`.`events` ORDER BY `id` ASC LIMIT 2 OFFSET 0": {{"id": int64(1)}, {"id": int64(2)}},
		},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	applyCalls := 0
	target.applyFunc = func(string, connection.ChangeSet) error {
		applyCalls++
		return db.MarkWriteOutcomeUnknown(errors.New("write response lost"))
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)
	callbackCalls := 0
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
		Tables:         []string{"events"},
		Content:        "data",
		Mode:           "insert_only",
		BatchSize:      2,
		RowErrorPolicy: RowErrorPolicySkipRow,
		OnRowError: func(context.Context, ChangeEventRowError) error {
			callbackCalls++
			return nil
		},
	})
	if result.Success || !result.OutcomeUnknown || result.RowsSkipped != 0 {
		t.Fatalf("RunSyncContext() = %+v, want unknown terminal failure", result)
	}
	if applyCalls != 1 || callbackCalls != 0 {
		t.Fatalf("unknown write was replayed or skipped: applyCalls=%d callbackCalls=%d", applyCalls, callbackCalls)
	}
}

func TestRunSyncSkipRowContinuesAfterSourceQueryProjectionError(t *testing.T) {
	const sourceSQL = "SELECT external_id, raw_name FROM active_accounts"
	source := &fakeMigrationDB{queryData: map[string][]map[string]interface{}{
		sourceSQL: {
			{"external_id": "1", "raw_name": "  alice  "},
			{"external_id": "customer-password-raw", "raw_name": "  hidden  "},
			{"external_id": "3", "raw_name": "  bob  "},
		},
	}}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"dst.people": {
			{Name: "user_id", Type: "bigint", Nullable: "NO", Key: "PRI"},
			{Name: "display_name", Type: "varchar(100)"},
			{Name: "status", Type: "varchar(20)"},
		},
	}}}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	rowErrors := make([]ChangeEventRowError, 0, 1)
	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
		SourceQuery:    sourceSQL,
		Content:        "data",
		Mode:           "insert_only",
		RowErrorPolicy: RowErrorPolicySkipRow,
		OnRowError: func(_ context.Context, rowError ChangeEventRowError) error {
			rowErrors = append(rowErrors, rowError)
			return nil
		},
		Mappings: []SyncObjectMapping{{
			Source: SyncObjectRef{Name: "active_query"},
			Target: SyncObjectRef{Schema: "dst", Name: "people"},
			Columns: []SyncColumnMapping{
				{Source: "external_id", Target: "user_id", Transforms: []SyncValueTransform{{Type: "int64"}}},
				{Source: "raw_name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
				{Target: "status", Default: &SyncDefaultValue{ValueType: "string", Value: "active"}},
			},
		}},
	})
	if !result.Success || result.RowsInserted != 2 || result.RowsSkipped != 1 {
		t.Fatalf("RunSyncContext() = %+v, want two mapped inserts and one projection skip", result)
	}
	if len(rowErrors) != 1 || rowErrors[0].Index != 1 || rowErrors[0].Operation != "project" || rowErrors[0].Code != "projection_failed" {
		t.Fatalf("row errors = %#v", rowErrors)
	}
	if len(target.applied) != 2 {
		t.Fatalf("source-query apply calls = %#v, want proactive singleton calls", target.applied)
	}
	first := target.applied[0].Inserts[0]
	second := target.applied[1].Inserts[0]
	if first["user_id"] != int64(1) || first["display_name"] != "ALICE" || first["status"] != "active" {
		t.Fatalf("first mapped row = %#v", first)
	}
	if second["user_id"] != int64(3) || second["status"] != "active" {
		t.Fatalf("second mapped row = %#v", second)
	}
	if strings.Contains(result.Message, "customer-password-raw") || strings.Contains(strings.Join(result.Logs, " "), "customer-password-raw") {
		t.Fatalf("projection payload leaked: %+v", result)
	}
}

func TestRunSyncSkipRowStopsWhenRowErrorCallbackFails(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	source := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{"src.events": columns},
		queryData: map[string][]map[string]interface{}{
			"SELECT `id` FROM `src`.`events` ORDER BY `id` ASC LIMIT 1000 OFFSET 0": {{"id": int64(1)}},
		},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	target.applyFunc = func(string, connection.ChangeSet) error {
		return errors.New("driver rejected customer-password-raw")
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSyncContext(context.Background(), SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "src"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
		Tables:         []string{"events"},
		Content:        "data",
		Mode:           "insert_only",
		RowErrorPolicy: RowErrorPolicySkipRow,
		OnRowError: func(context.Context, ChangeEventRowError) error {
			return errors.New("quarantine rejected customer-password-raw")
		},
	})
	if result.Success || result.RowsInserted != 0 || result.RowsSkipped != 0 || !strings.Contains(result.Message, "snapshot \u884c\u9519\u8bef\u56de\u8c03\u5931\u8d25") {
		t.Fatalf("RunSyncContext() = %+v, want sanitized callback failure", result)
	}
	if strings.Contains(result.Message, "customer-password-raw") || strings.Contains(strings.Join(result.Logs, " "), "customer-password-raw") {
		t.Fatalf("callback or driver payload leaked: %+v", result)
	}
}

func TestRunSyncSkipRowRejectsUnsafeSnapshotConfigurationsBeforeConnect(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*SyncConfig)
		want   string
	}{
		{name: "callback required", mutate: func(config *SyncConfig) { config.OnRowError = nil }, want: "OnRowError"},
		{name: "data only", mutate: func(config *SyncConfig) { config.Content = "both" }, want: "data-only"},
		{name: "full overwrite", mutate: func(config *SyncConfig) { config.Mode = "full_overwrite" }, want: "full_overwrite"},
		{name: "existing target", mutate: func(config *SyncConfig) { config.TargetTableStrategy = "auto_create_if_missing" }, want: "\u76ee\u6807\u8868\u5df2\u5b58\u5728"},
		{name: "delete propagation", mutate: func(config *SyncConfig) {
			config.TableOptions = map[string]TableOptions{"events": {Insert: true, Delete: true}}
		}, want: "\u5220\u9664\u4f20\u64ad"},
		{name: "non atomic target", mutate: func(config *SyncConfig) { config.TargetConfig.Type = "clickhouse" }, want: "\u539f\u5b50 SQL"},
		{name: "unknown transform", mutate: func(config *SyncConfig) {
			config.Mappings = []SyncObjectMapping{{
				Source:  SyncObjectRef{Name: "events"},
				Target:  SyncObjectRef{Name: "events"},
				Columns: []SyncColumnMapping{{Source: "id", Target: "id", Transforms: []SyncValueTransform{{Type: "random"}}}},
			}}
		}, want: "\u975e\u786e\u5b9a\u5b57\u6bb5\u8f6c\u6362"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			oldFactory := newSyncDatabase
			factoryCalls := 0
			newSyncDatabase = func(string) (db.Database, error) {
				factoryCalls++
				return nil, errors.New("must not connect")
			}
			t.Cleanup(func() { newSyncDatabase = oldFactory })

			config := SyncConfig{
				SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "src"},
				TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
				Tables:         []string{"events"},
				Content:        "data",
				Mode:           "insert_only",
				RowErrorPolicy: RowErrorPolicySkipRow,
				OnRowError:     func(context.Context, ChangeEventRowError) error { return nil },
			}
			test.mutate(&config)
			result := NewSyncEngine(Reporter{}).RunSync(config)
			if result.Success || !strings.Contains(result.Message, test.want) {
				t.Fatalf("RunSync() = %+v, want rejection containing %q", result, test.want)
			}
			if factoryCalls != 0 {
				t.Fatalf("unsafe config opened %d database connections", factoryCalls)
			}
		})
	}
}
