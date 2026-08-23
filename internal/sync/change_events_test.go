package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type changeEventSessionTestDatabase struct {
	watermarkTestDatabase
	mu              sync.Mutex
	connects        int
	closes          int
	columnInspects  int
	applyStarted    chan struct{}
	blockApplyUntil bool
}

func (d *changeEventSessionTestDatabase) Connect(connection.ConnectionConfig) error {
	d.mu.Lock()
	d.connects++
	d.mu.Unlock()
	return nil
}

func (d *changeEventSessionTestDatabase) Close() error {
	d.mu.Lock()
	d.closes++
	d.mu.Unlock()
	return nil
}

func (d *changeEventSessionTestDatabase) GetColumns(database, table string) ([]connection.ColumnDefinition, error) {
	d.mu.Lock()
	d.columnInspects++
	d.mu.Unlock()
	return d.fakeMigrationDB.GetColumns(database, table)
}

func (d *changeEventSessionTestDatabase) ApplyChangesContext(ctx context.Context, table string, changes connection.ChangeSet) error {
	if d.applyStarted != nil {
		select {
		case d.applyStarted <- struct{}{}:
		default:
		}
	}
	if d.blockApplyUntil {
		<-ctx.Done()
		return ctx.Err()
	}
	return d.ApplyChanges(table, changes)
}

func changeEventBaseRequest(events ...DataChangeEvent) ChangeEventRequest {
	return ChangeEventRequest{
		Sync: SyncConfig{
			SourceConfig:   connection.ConnectionConfig{Type: "mongodb", Database: "src"},
			TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
			SourceDatabase: "src",
			TargetDatabase: "dst",
			Content:        "data",
			Mode:           "insert_update",
		},
		Events:         events,
		RowErrorPolicy: RowErrorPolicyStop,
	}
}

func TestRunChangeEventsContextSkipsBadRowByAtomicBatchIsolation(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "secret", Type: "varchar(100)"},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	target.queryFunc = func(string) ([]map[string]interface{}, []string, error) { return nil, nil, nil }
	committedIDs := make([]int64, 0, 2)
	target.applyFunc = func(_ string, changes connection.ChangeSet) error {
		for _, row := range changes.Inserts {
			if row["secret"] == "customer-password-raw" {
				return fmt.Errorf("driver rejected payload customer-password-raw")
			}
		}
		for _, row := range changes.Inserts {
			committedIDs = append(committedIDs, row["id"].(int64))
		}
		return nil
	}
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: target})
	request := changeEventBaseRequest(
		DataChangeEvent{ID: "good-1", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert, Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1), "secret": "safe-a"}},
		DataChangeEvent{ID: "bad", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert, Key: map[string]interface{}{"id": int64(2)}, After: map[string]interface{}{"id": int64(2), "secret": "customer-password-raw"}},
		DataChangeEvent{ID: "good-3", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert, Key: map[string]interface{}{"id": int64(3)}, After: map[string]interface{}{"id": int64(3), "secret": "safe-c"}},
	)
	request.Sync.BatchSize = 3
	request.RowErrorPolicy = RowErrorPolicySkipRow
	callbackErrors := make([]ChangeEventRowError, 0, 1)
	request.OnRowError = func(_ context.Context, rowError ChangeEventRowError) error {
		callbackErrors = append(callbackErrors, rowError)
		return nil
	}

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(context.Background(), request)
	if !result.Success || result.EventsApplied != 2 || result.EventsSkipped != 1 || result.RowsInserted != 2 {
		t.Fatalf("RunChangeEventsContext() = %+v, want two commits and one skipped row", result)
	}
	if fmt.Sprint(committedIDs) != "[1 3]" {
		t.Fatalf("committed IDs = %v, want [1 3]", committedIDs)
	}
	if len(target.applied) == 0 || len(target.applied[0].Inserts) != 3 {
		t.Fatalf("first attempted event batch = %#v, want configured size 3", target.applied)
	}
	if len(callbackErrors) != 1 || callbackErrors[0].Index != 1 || callbackErrors[0].EventID != "bad" || callbackErrors[0].Code != "apply_failed" {
		t.Fatalf("row callbacks = %#v", callbackErrors)
	}
	if strings.Contains(result.Message, "customer-password-raw") || strings.Contains(fmt.Sprint(result.RowErrors), "customer-password-raw") {
		t.Fatalf("sensitive payload leaked in result: %+v", result)
	}
}

func TestRunChangeEventsContextDoesNotReplayUnknownWriteWithSkipRow(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	target.queryFunc = func(string) ([]map[string]interface{}, []string, error) { return nil, nil, nil }
	applyCalls := 0
	target.applyFunc = func(string, connection.ChangeSet) error {
		applyCalls++
		return db.MarkWriteOutcomeUnknown(errors.New("write response lost"))
	}
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: target})
	request := changeEventBaseRequest(
		DataChangeEvent{ID: "first", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert, Key: map[string]interface{}{"id": int64(10)}, After: map[string]interface{}{"id": int64(10)}},
		DataChangeEvent{ID: "second", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert, Key: map[string]interface{}{"id": int64(50)}, After: map[string]interface{}{"id": int64(50)}},
	)
	request.Sync.BatchSize = 2
	request.RowErrorPolicy = RowErrorPolicySkipRow
	callbackCalls := 0
	request.OnRowError = func(context.Context, ChangeEventRowError) error {
		callbackCalls++
		return nil
	}

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(context.Background(), request)
	if result.Success || !result.OutcomeUnknown || result.EventsApplied != 0 || result.EventsSkipped != 0 {
		t.Fatalf("RunChangeEventsContext() = %+v, want unknown terminal failure", result)
	}
	if applyCalls != 1 {
		t.Fatalf("apply calls = %d, want one unknown batch without split/replay", applyCalls)
	}
	if callbackCalls != 0 || len(result.RowErrors) != 0 {
		t.Fatalf("row-error handling ran after unknown write: callbacks=%d errors=%#v", callbackCalls, result.RowErrors)
	}
}

func TestRunChangeEventsContextStopsWhenRowErrorCallbackFails(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	target.queryFunc = func(string) ([]map[string]interface{}, []string, error) { return nil, nil, nil }
	target.applyFunc = func(string, connection.ChangeSet) error { return fmt.Errorf("driver payload top-secret") }
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: target})
	request := changeEventBaseRequest(DataChangeEvent{
		Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
		Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1)},
	})
	request.RowErrorPolicy = RowErrorPolicySkipRow
	request.OnRowError = func(context.Context, ChangeEventRowError) error {
		return fmt.Errorf("callback payload callback-secret")
	}

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(context.Background(), request)
	if result.Success || result.EventsApplied != 0 || result.EventsSkipped != 0 || !strings.Contains(result.Message, "行错误回调失败") {
		t.Fatalf("RunChangeEventsContext() = %+v, want callback failure", result)
	}
	if strings.Contains(result.Message, "top-secret") || strings.Contains(result.Message, "callback-secret") {
		t.Fatalf("sensitive callback/driver error leaked: %q", result.Message)
	}
}

func TestRunChangeEventsContextRejectsNonAtomicTargetBeforeConnect(t *testing.T) {
	request := changeEventBaseRequest(DataChangeEvent{
		Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
		Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1)},
	})
	request.Sync.TargetConfig.Type = "clickhouse"
	factoryCalls := 0
	oldFactory := newSyncDatabase
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(context.Background(), request)
	if result.Success || !strings.Contains(result.Message, "不具备已知原子") {
		t.Fatalf("RunChangeEventsContext() = %+v, want non-atomic rejection", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("non-atomic target opened %d connections", factoryCalls)
	}
}

func TestRunChangeEventsContextHonorsCancellationBeforeConnect(t *testing.T) {
	request := changeEventBaseRequest(DataChangeEvent{
		Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
		Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1)},
	})
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(ctx, request)
	if result.Success || !result.Cancelled || !strings.Contains(result.Message, "context canceled") {
		t.Fatalf("RunChangeEventsContext() = %+v, want cancellation", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("cancelled event run opened %d connections", factoryCalls)
	}
}

func TestRunChangeEventsContextReplayedInsertBecomesUpdate(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(100)"},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	target.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if !strings.Contains(query, "`id` = 7") {
			t.Fatalf("target key lookup = %s", query)
		}
		return []map[string]interface{}{{"id": int64(7), "name": "old"}}, nil, nil
	}
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: target})
	request := changeEventBaseRequest(DataChangeEvent{
		ID:        "resume-token-1",
		Object:    SyncObjectRef{Database: "src", Name: "events"},
		Operation: ChangeEventOperationInsert,
		Key:       map[string]interface{}{"id": int64(7)},
		After:     map[string]interface{}{"id": int64(7), "name": "new"},
	})

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(context.Background(), request)
	if !result.Success || result.EventsApplied != 1 || result.RowsInserted != 0 || result.RowsUpdated != 1 || result.RowsDeleted != 0 {
		t.Fatalf("RunChangeEventsContext() = %+v, want idempotent replay update", result)
	}
	if len(target.applied) != 1 || len(target.applied[0].Inserts) != 0 || len(target.applied[0].Updates) != 1 {
		t.Fatalf("applied = %#v, want one update", target.applied)
	}
	update := target.applied[0].Updates[0]
	if update.Keys["id"] != int64(7) || update.Values["name"] != "new" {
		t.Fatalf("update = %#v", update)
	}
}

func TestRunChangeEventsContextMapsDeleteKeyAndTargetTable(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "account_id", Type: "bigint", Nullable: "NO"},
		{Name: "name", Type: "varchar(100)"},
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.accounts": columns}}}
	target.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if !strings.Contains(query, "`account_id` = 7") {
			t.Fatalf("mapped target key lookup = %s", query)
		}
		return []map[string]interface{}{{"account_id": int64(7), "name": "old"}}, nil, nil
	}
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: target})
	request := changeEventBaseRequest(DataChangeEvent{
		Object:    SyncObjectRef{Database: "src", Name: "people"},
		Operation: ChangeEventOperationDelete,
		Key:       map[string]interface{}{"_id": "7"},
	})
	request.Sync.Mappings = []SyncObjectMapping{{
		Source:     SyncObjectRef{Database: "src", Name: "people"},
		Target:     SyncObjectRef{Schema: "dst", Name: "accounts"},
		KeyColumns: []string{"_id"},
		Columns: []SyncColumnMapping{
			{Source: "_id", Target: "account_id", Transforms: []SyncValueTransform{{Type: "int64"}}},
			{Source: "name", Target: "name"},
		},
	}}

	result := NewSyncEngine(Reporter{}).RunChangeEventsContext(context.Background(), request)
	if !result.Success || result.EventsApplied != 1 || result.RowsDeleted != 1 {
		t.Fatalf("RunChangeEventsContext() = %+v, want mapped delete", result)
	}
	if len(target.applied) != 1 || target.applyTable[0] != "accounts" || len(target.applied[0].Deletes) != 1 || target.applied[0].Deletes[0]["account_id"] != int64(7) {
		t.Fatalf("mapped delete = tables %v changes %#v", target.applyTable, target.applied)
	}
}

func TestChangeEventSessionReusesConnectionMetadataAndPerBatchCallback(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(100)"},
	}
	target := &changeEventSessionTestDatabase{watermarkTestDatabase: watermarkTestDatabase{
		fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}},
	}}
	target.queryFunc = func(string) ([]map[string]interface{}, []string, error) { return nil, nil, nil }
	factoryCalls := 0
	oldFactory := newSyncDatabase
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return target, nil
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })

	request := changeEventBaseRequest()
	session, err := NewSyncEngine(Reporter{}).OpenChangeEventSessionContext(context.Background(), request.Sync)
	if err != nil {
		t.Fatalf("open change-event session: %v", err)
	}
	first := session.ApplyContext(context.Background(), []DataChangeEvent{{
		ID: "first", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
		Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1), "name": "one"},
	}}, RowErrorPolicyStop, nil)
	if !first.Success || first.RowsInserted != 1 {
		t.Fatalf("first apply = %+v", first)
	}
	callbackCalls := 0
	second := session.ApplyContext(context.Background(), []DataChangeEvent{{
		ID: "bad-second", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
		Key: map[string]interface{}{"id": int64(2)}, After: map[string]interface{}{"id": int64(2), "unknown": "value"},
	}}, RowErrorPolicySkipRow, func(_ context.Context, rowError ChangeEventRowError) error {
		callbackCalls++
		if rowError.EventID != "bad-second" {
			t.Fatalf("row error = %#v", rowError)
		}
		return nil
	})
	if !second.Success || second.EventsSkipped != 1 || callbackCalls != 1 {
		t.Fatalf("second apply = %+v callbacks=%d", second, callbackCalls)
	}
	third := session.ApplyContext(context.Background(), []DataChangeEvent{{
		ID: "third", Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
		Key: map[string]interface{}{"id": int64(3)}, After: map[string]interface{}{"id": int64(3), "name": "three"},
	}}, RowErrorPolicyStop, func(context.Context, ChangeEventRowError) error {
		t.Fatal("callback from a prior ApplyContext call leaked into the next delivery")
		return nil
	})
	if !third.Success || third.RowsInserted != 1 {
		t.Fatalf("third apply = %+v", third)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close session again: %v", err)
	}
	target.mu.Lock()
	connects, closes, columnInspects := target.connects, target.closes, target.columnInspects
	target.mu.Unlock()
	if factoryCalls != 1 || connects != 1 || closes != 1 || columnInspects != 1 {
		t.Fatalf("factory=%d connects=%d closes=%d column inspections=%d", factoryCalls, connects, closes, columnInspects)
	}
	if len(target.applied) != 2 {
		t.Fatalf("applied batches = %#v", target.applied)
	}
}

func TestChangeEventSessionCloseCancelsActiveApplyAndIsIdempotent(t *testing.T) {
	columns := []connection.ColumnDefinition{{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"}}
	target := &changeEventSessionTestDatabase{
		watermarkTestDatabase: watermarkTestDatabase{
			fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}},
		},
		applyStarted:    make(chan struct{}, 1),
		blockApplyUntil: true,
	}
	target.queryFunc = func(string) ([]map[string]interface{}, []string, error) { return nil, nil, nil }
	useSyncDatabaseFactorySequence(t, syncDatabaseFactoryStep{db: target})
	session, err := NewSyncEngine(Reporter{}).OpenChangeEventSessionContext(context.Background(), changeEventBaseRequest().Sync)
	if err != nil {
		t.Fatalf("open change-event session: %v", err)
	}
	resultCh := make(chan ChangeEventResult, 1)
	go func() {
		resultCh <- session.ApplyContext(context.Background(), []DataChangeEvent{{
			Object: SyncObjectRef{Name: "events"}, Operation: ChangeEventOperationInsert,
			Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1)},
		}}, RowErrorPolicyStop, nil)
	}()
	select {
	case <-target.applyStarted:
	case <-time.After(time.Second):
		t.Fatal("ApplyContext did not reach the context-aware target applier")
	}
	if err := session.Close(); err != nil {
		t.Fatalf("close session: %v", err)
	}
	select {
	case result := <-resultCh:
		if result.Success || !result.Cancelled || !strings.Contains(result.Message, context.Canceled.Error()) {
			t.Fatalf("cancelled apply = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("Close did not cancel active ApplyContext")
	}
	if err := session.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
	if result := session.ApplyContext(context.Background(), nil, RowErrorPolicyStop, nil); result.Success || !strings.Contains(result.Message, "closed") {
		t.Fatalf("apply after close = %+v", result)
	}
	target.mu.Lock()
	closes := target.closes
	target.mu.Unlock()
	if closes != 1 {
		t.Fatalf("target close count = %d", closes)
	}
}
