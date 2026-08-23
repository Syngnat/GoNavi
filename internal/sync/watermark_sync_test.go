package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

type watermarkTestDatabase struct {
	fakeMigrationDB
	queryFunc        func(string) ([]map[string]interface{}, []string, error)
	queryContextFunc func(context.Context, string) ([]map[string]interface{}, []string, error)
	applyFunc        func(string, connection.ChangeSet) error
	queries          []string
	applyTable       []string
	applied          []connection.ChangeSet
}

func (d *watermarkTestDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	d.queries = append(d.queries, query)
	if d.queryFunc != nil {
		return d.queryFunc(query)
	}
	return nil, nil, nil
}

func (d *watermarkTestDatabase) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	if d.queryContextFunc != nil {
		d.queries = append(d.queries, query)
		return d.queryContextFunc(ctx, query)
	}
	return d.Query(query)
}

func (d *watermarkTestDatabase) ApplyChanges(table string, changes connection.ChangeSet) error {
	d.applyTable = append(d.applyTable, table)
	d.applied = append(d.applied, changes)
	if d.applyFunc != nil {
		return d.applyFunc(table, changes)
	}
	return nil
}

func watermarkBaseRequest(mode string, batchSize int) WatermarkSyncRequest {
	request := WatermarkSyncRequest{
		Sync: SyncConfig{
			SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "src"},
			TargetConfig:   connection.ConnectionConfig{Type: "mysql", Database: "dst"},
			SourceDatabase: "src",
			TargetDatabase: "dst",
			Tables:         []string{"events"},
			Content:        "data",
			Mode:           mode,
		},
		Table:             "events",
		WatermarkColumn:   "updated_at",
		TieBreakerColumns: []string{"id"},
		BatchSize:         batchSize,
		DeliverySemantics: WatermarkDeliveryIdempotent,
	}
	if mode == "insert_only" {
		request.DeliverySemantics = WatermarkDeliveryAtLeastOnce
	}
	return request
}

func watermarkTestColumns() []connection.ColumnDefinition {
	return []connection.ColumnDefinition{
		{Name: "updated_at", Type: "datetime", Nullable: "NO"},
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(100)"},
	}
}

func useWatermarkDatabases(t *testing.T, source, target db.Database) {
	t.Helper()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)
}

func TestRunWatermarkSyncProcessesFixedWindowAndCheckpointsEachBatch(t *testing.T) {
	columns := watermarkTestColumns()
	upperTime := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	sharedTime := time.Date(2026, time.August, 8, 11, 0, 0, 0, time.UTC)
	page := 0
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if strings.Contains(query, " DESC") {
			return []map[string]interface{}{{"updated_at": upperTime, "id": int64(4)}}, nil, nil
		}
		page++
		switch page {
		case 1:
			return []map[string]interface{}{
				{"updated_at": sharedTime, "id": int64(1), "name": "one"},
				{"updated_at": sharedTime, "id": int64(2), "name": "two"},
			}, nil, nil
		case 2:
			return []map[string]interface{}{
				{"updated_at": upperTime, "id": int64(3), "name": "three"},
				{"updated_at": upperTime, "id": int64(4), "name": "four"},
			}, nil, nil
		default:
			return nil, nil, nil
		}
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	useWatermarkDatabases(t, source, target)

	checkpoints := make([]WatermarkCheckpoint, 0, 2)
	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), watermarkBaseRequest("insert_only", 2), func(_ context.Context, checkpoint WatermarkCheckpoint) error {
		checkpoints = append(checkpoints, checkpoint)
		return nil
	})

	if !result.Success || result.RowsInserted != 4 || result.RowsUpdated != 0 || result.SourceRowsRead != 4 {
		t.Fatalf("RunWatermarkSync() = %+v, want four inserted rows", result)
	}
	if result.UpperBound == nil || result.Cursor == nil || result.Cursor.Watermark.Value != upperTime.Format(time.RFC3339Nano) || result.Cursor.TieBreakers[0].Value != "4" {
		t.Fatalf("unexpected fixed window/cursor: upper=%#v cursor=%#v", result.UpperBound, result.Cursor)
	}
	if len(checkpoints) != 2 || checkpoints[0].Cursor.TieBreakers[0].Value != "2" || checkpoints[1].Cursor.TieBreakers[0].Value != "4" {
		t.Fatalf("checkpoints = %#v, want cursors 2 then 4", checkpoints)
	}
	if len(target.applied) != 2 || len(target.applied[0].Inserts) != 2 || len(target.applied[1].Inserts) != 2 {
		t.Fatalf("target batches = %#v, want two insert batches", target.applied)
	}
	for _, query := range source.queries[1:] {
		if !strings.Contains(query, "updated_at") || !strings.Contains(query, "id") || !strings.Contains(query, " <= ") {
			t.Fatalf("page query does not contain fixed composite upper bound: %s", query)
		}
	}
	if got := target.applyTable; fmt.Sprint(got) != "[events events]" {
		t.Fatalf("apply tables = %v, want target table", got)
	}
}

func TestWatermarkCursorUsesColumnTypesAfterDriverNormalization(t *testing.T) {
	plan := watermarkRuntimePlan{
		sourceQueryTable: "src.events",
		sourceColumns: []connection.ColumnDefinition{
			{Name: "updated_at", Type: "datetime", Nullable: "NO"},
			{Name: "id", Type: "bigint unsigned", Nullable: "NO", Key: "PRI"},
		},
		watermarkColumn: "updated_at",
		tieColumns:      []string{"id"},
	}
	cursor, err := watermarkCursorFromRow(plan, map[string]interface{}{
		"updated_at": "2026-08-08T12:00:00+08:00",
		"id":         "18446744073709551615",
	})
	if err != nil {
		t.Fatalf("watermarkCursorFromRow() error = %v", err)
	}
	if cursor.Watermark.Type != "timestamp" || cursor.Watermark.Value != "2026-08-08T12:00:00+08:00" {
		t.Fatalf("timestamp cursor = %#v", cursor.Watermark)
	}
	if len(cursor.TieBreakers) != 1 || cursor.TieBreakers[0].Type != "uint64" || cursor.TieBreakers[0].Value != "18446744073709551615" {
		t.Fatalf("uint64 cursor = %#v", cursor.TieBreakers)
	}
	literal, err := watermarkCursorSQLLiteral("mysql", cursor.Watermark)
	if err != nil || literal != "'2026-08-08 12:00:00'" {
		t.Fatalf("MySQL timestamp literal = %q, %v", literal, err)
	}
}

func TestRunWatermarkSyncResumesTypedCursorAcrossCompositeTies(t *testing.T) {
	columns := []connection.ColumnDefinition{
		{Name: "updated_at", Type: "datetime", Nullable: "NO"},
		{Name: "tenant_id", Type: "varchar(32)", Nullable: "NO", Key: "PRI"},
		{Name: "id", Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(100)"},
	}
	watermark := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	resume := WatermarkCursor{
		Version:           WatermarkCursorVersion,
		SourceTable:       "src.events",
		WatermarkColumn:   "updated_at",
		TieBreakerColumns: []string{"tenant_id", "id"},
		Watermark:         WatermarkCursorValue{Type: "timestamp", Value: watermark.Format(time.RFC3339Nano)},
		TieBreakers: []WatermarkCursorValue{
			{Type: "string", Value: "alpha"},
			{Type: "int64", Value: "2"},
		},
	}
	encoded, err := json.Marshal(resume)
	if err != nil {
		t.Fatalf("json.Marshal(cursor) error = %v", err)
	}
	var restored WatermarkCursor
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatalf("json.Unmarshal(cursor) error = %v", err)
	}

	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if strings.Contains(query, " DESC") {
			return []map[string]interface{}{{"updated_at": watermark, "tenant_id": "beta", "id": int64(1)}}, nil, nil
		}
		return []map[string]interface{}{{"updated_at": watermark, "tenant_id": "beta", "id": int64(1), "name": "next"}}, nil, nil
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	useWatermarkDatabases(t, source, target)
	request := watermarkBaseRequest("insert_only", 10)
	request.TieBreakerColumns = []string{"tenant_id", "id"}
	request.Cursor = &restored

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, nil)
	if !result.Success || result.RowsInserted != 1 || result.Cursor == nil || len(result.Cursor.TieBreakers) != 2 || result.Cursor.TieBreakers[0].Value != "beta" || result.Cursor.TieBreakers[1].Value != "1" {
		t.Fatalf("RunWatermarkSync() = %+v, want resumed composite cursor beta/1", result)
	}
	if len(source.queries) != 2 {
		t.Fatalf("source queries = %#v, want upper-bound and one page", source.queries)
	}
	pageQuery := source.queries[1]
	for _, fragment := range []string{"`updated_at` >", "`updated_at` =", "`tenant_id` > 'alpha'", "`tenant_id` = 'alpha'", "`id` > 2", "`tenant_id` < 'beta'", "`id` <= 1"} {
		if !strings.Contains(pageQuery, fragment) {
			t.Fatalf("composite resume query missing %q: %s", fragment, pageQuery)
		}
	}
}

func TestRunWatermarkSyncUsesMappedExplicitKeysForInsertUpdate(t *testing.T) {
	watermark := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	sourceColumns := []connection.ColumnDefinition{
		{Name: "updated_at", Type: "datetime", Nullable: "NO"},
		{Name: "tenant_id", Type: "varchar(32)", Nullable: "NO"},
		{Name: "id", Type: "bigint", Nullable: "NO"},
		{Name: "name", Type: "varchar(100)"},
	}
	targetColumns := []connection.ColumnDefinition{
		{Name: "modified_at", Type: "datetime", Nullable: "NO"},
		{Name: "account", Type: "varchar(32)", Nullable: "NO"},
		{Name: "event_id", Type: "bigint", Nullable: "NO"},
		{Name: "display_name", Type: "varchar(100)"},
	}
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": sourceColumns}}}
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if strings.Contains(query, " DESC") {
			return []map[string]interface{}{{"updated_at": watermark, "tenant_id": "acme", "id": int64(7)}}, nil, nil
		}
		return []map[string]interface{}{{"updated_at": watermark, "tenant_id": "acme", "id": int64(7), "name": " new "}}, nil, nil
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.people": targetColumns}}}
	target.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if !strings.Contains(query, "`account` = 'acme'") || !strings.Contains(query, "`event_id` = 7") {
			return nil, nil, fmt.Errorf("unexpected mapped target lookup: %s", query)
		}
		return []map[string]interface{}{{"modified_at": watermark, "account": "acme", "event_id": int64(7), "display_name": "OLD"}}, nil, nil
	}
	useWatermarkDatabases(t, source, target)
	request := watermarkBaseRequest("insert_update", 10)
	request.TieBreakerColumns = []string{"tenant_id", "id"}
	request.Sync.Mappings = []SyncObjectMapping{{
		ID:         "events-to-people",
		Source:     SyncObjectRef{Schema: "src", Name: "events"},
		Target:     SyncObjectRef{Schema: "dst", Name: "people"},
		KeyColumns: []string{"tenant_id", "id"},
		Columns: []SyncColumnMapping{
			{Source: "updated_at", Target: "modified_at"},
			{Source: "tenant_id", Target: "account"},
			{Source: "id", Target: "event_id"},
			{Source: "name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
		},
	}}

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, nil)
	if !result.Success || result.RowsInserted != 0 || result.RowsUpdated != 1 {
		t.Fatalf("RunWatermarkSync() = %+v, want one mapped update", result)
	}
	if len(target.applied) != 1 || len(target.applied[0].Updates) != 1 || target.applyTable[0] != "people" {
		t.Fatalf("mapped target applies = tables %v changes %#v", target.applyTable, target.applied)
	}
	update := target.applied[0].Updates[0]
	if !reflect.DeepEqual(update.Keys, map[string]interface{}{"account": "acme", "event_id": int64(7)}) || update.Values["display_name"] != "NEW" {
		t.Fatalf("mapped update = %#v, want mapped keys and transformed value", update)
	}
}

func TestRunWatermarkSyncCheckpointFailureDoesNotAdvanceDurableCursor(t *testing.T) {
	columns := watermarkTestColumns()
	initialTime := time.Date(2026, time.August, 8, 10, 0, 0, 0, time.UTC)
	nextTime := initialTime.Add(time.Hour)
	initial := &WatermarkCursor{
		Version:           WatermarkCursorVersion,
		SourceTable:       "src.events",
		WatermarkColumn:   "updated_at",
		TieBreakerColumns: []string{"id"},
		Watermark:         WatermarkCursorValue{Type: "timestamp", Value: initialTime.Format(time.RFC3339Nano)},
		TieBreakers:       []WatermarkCursorValue{{Type: "int64", Value: "0"}},
	}
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if strings.Contains(query, " DESC") {
			return []map[string]interface{}{{"updated_at": nextTime, "id": int64(1)}}, nil, nil
		}
		return []map[string]interface{}{{"updated_at": nextTime, "id": int64(1), "name": "applied"}}, nil, nil
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	useWatermarkDatabases(t, source, target)
	request := watermarkBaseRequest("insert_only", 10)
	request.Cursor = initial
	checkpointCalls := 0

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, func(_ context.Context, checkpoint WatermarkCheckpoint) error {
		checkpointCalls++
		if len(target.applied) != 1 || checkpoint.Cursor.TieBreakers[0].Value != "1" {
			t.Fatalf("checkpoint ran before target commit or with wrong cursor: applied=%d checkpoint=%#v", len(target.applied), checkpoint)
		}
		return fmt.Errorf("checkpoint store unavailable")
	})

	if result.Success || !strings.Contains(result.Message, "目标批次可能已提交") {
		t.Fatalf("RunWatermarkSync() = %+v, want checkpoint failure", result)
	}
	if checkpointCalls != 1 || result.RowsInserted != 1 || result.BatchesApplied != 1 || result.Checkpoints != 0 || result.BatchesProcessed != 0 {
		t.Fatalf("checkpoint failure counters = %+v calls=%d", result, checkpointCalls)
	}
	if !reflect.DeepEqual(result.Cursor, initial) {
		t.Fatalf("durable cursor advanced on checkpoint failure: got %#v want %#v", result.Cursor, initial)
	}
}

func TestRunWatermarkSyncReturnsWithoutPageReadWhenCursorReachedUpperBound(t *testing.T) {
	columns := watermarkTestColumns()
	watermark := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	initial := &WatermarkCursor{
		Version:           WatermarkCursorVersion,
		SourceTable:       "src.events",
		WatermarkColumn:   "updated_at",
		TieBreakerColumns: []string{"id"},
		Watermark:         WatermarkCursorValue{Type: "timestamp", Value: watermark.Format(time.RFC3339Nano)},
		TieBreakers:       []WatermarkCursorValue{{Type: "int64", Value: "9"}},
	}
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if !strings.Contains(query, " DESC") {
			return nil, nil, fmt.Errorf("page query must not run after cursor reached upper bound: %s", query)
		}
		return []map[string]interface{}{{"updated_at": watermark, "id": int64(9)}}, nil, nil
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	useWatermarkDatabases(t, source, target)
	request := watermarkBaseRequest("insert_only", 10)
	request.Cursor = initial
	checkpointCalls := 0

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, func(context.Context, WatermarkCheckpoint) error {
		checkpointCalls++
		return nil
	})
	if !result.Success || result.SourceRowsRead != 0 || result.RowsInserted != 0 || result.BatchesProcessed != 0 {
		t.Fatalf("RunWatermarkSync() = %+v, want successful empty window", result)
	}
	if len(source.queries) != 1 || len(target.applied) != 0 || checkpointCalls != 0 || !reflect.DeepEqual(result.Cursor, initial) {
		t.Fatalf("empty window performed side effects: source=%v applied=%v checkpoints=%d cursor=%#v", source.queries, target.applied, checkpointCalls, result.Cursor)
	}
}

func TestRunWatermarkSyncCheckpointsNoOpInsertUpdatePage(t *testing.T) {
	columns := watermarkTestColumns()
	watermark := time.Date(2026, time.August, 8, 12, 0, 0, 0, time.UTC)
	row := map[string]interface{}{"updated_at": watermark, "id": int64(1), "name": "same"}
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	source.queryFunc = func(query string) ([]map[string]interface{}, []string, error) {
		if strings.Contains(query, " DESC") {
			return []map[string]interface{}{{"updated_at": watermark, "id": int64(1)}}, nil, nil
		}
		return []map[string]interface{}{row}, nil, nil
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	target.queryFunc = func(string) ([]map[string]interface{}, []string, error) {
		return []map[string]interface{}{row}, nil, nil
	}
	useWatermarkDatabases(t, source, target)
	checkpointCalls := 0

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), watermarkBaseRequest("insert_update", 10), func(_ context.Context, checkpoint WatermarkCheckpoint) error {
		checkpointCalls++
		if checkpoint.RowsInserted != 0 || checkpoint.RowsUpdated != 0 || checkpoint.Cursor.TieBreakers[0].Value != "1" {
			t.Fatalf("unexpected no-op checkpoint: %#v", checkpoint)
		}
		return nil
	})
	if !result.Success || result.Cursor == nil || result.Cursor.TieBreakers[0].Value != "1" || result.BatchesProcessed != 1 || result.BatchesApplied != 0 || result.Checkpoints != 1 {
		t.Fatalf("RunWatermarkSync() = %+v, want checkpointed no-op page", result)
	}
	if len(target.applied) != 0 || checkpointCalls != 1 {
		t.Fatalf("no-op page applied target changes or missed checkpoint: applied=%#v checkpoints=%d", target.applied, checkpointCalls)
	}
}

func TestRunWatermarkSyncHonorsCancellationBeforeOpeningConnections(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not open")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(ctx, watermarkBaseRequest("insert_update", 10), nil)
	if result.Success || !result.Cancelled || !strings.Contains(result.Message, "context canceled") {
		t.Fatalf("RunWatermarkSync() = %+v, want cancelled result", result)
	}
	if factoryCalls != 0 {
		t.Fatalf("database factory calls = %d, want 0 after pre-cancel", factoryCalls)
	}
}

func TestRunWatermarkSyncCancelsInFlightContextQuery(t *testing.T) {
	columns := watermarkTestColumns()
	queryStarted := make(chan struct{})
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	source.queryContextFunc = func(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
		close(queryStarted)
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": columns}}}
	useWatermarkDatabases(t, source, target)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan WatermarkSyncResult, 1)
	go func() {
		resultCh <- NewSyncEngine(Reporter{}).RunWatermarkSync(ctx, watermarkBaseRequest("insert_update", 10), nil)
	}()

	select {
	case <-queryStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		t.Fatal("watermark QueryContext did not start")
	}
	select {
	case result := <-resultCh:
		if result.Success || !result.Cancelled || !strings.Contains(result.Message, "context canceled") {
			t.Fatalf("RunWatermarkSync() = %+v, want in-flight cancellation", result)
		}
	case <-time.After(time.Second):
		t.Fatal("RunWatermarkSync did not return after QueryContext cancellation")
	}
	if len(source.queries) != 1 || len(target.applied) != 0 {
		t.Fatalf("cancellation side effects: queries=%v applies=%#v", source.queries, target.applied)
	}
}

func TestRunWatermarkSyncRejectsNullableStableKey(t *testing.T) {
	columns := watermarkTestColumns()
	columns[1].Nullable = "YES"
	source := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"src.events": columns}}}
	target := &watermarkTestDatabase{fakeMigrationDB: fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{"dst.events": watermarkTestColumns()}}}
	useWatermarkDatabases(t, source, target)

	result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), watermarkBaseRequest("insert_update", 10), nil)
	if result.Success || !strings.Contains(result.Message, "稳定 key 字段 id 必须为非 NULL") {
		t.Fatalf("RunWatermarkSync() = %+v, want nullable-key rejection", result)
	}
	if len(source.queries) != 0 || len(target.applied) != 0 {
		t.Fatalf("nullable key reached execution: queries=%v applies=%#v", source.queries, target.applied)
	}
}

func TestRunWatermarkSyncRejectsUnsafeOrUnsupportedContractsBeforeConnect(t *testing.T) {
	base := watermarkBaseRequest("insert_update", 10)
	tests := []struct {
		name    string
		mutate  func(*WatermarkSyncRequest)
		message string
	}{
		{name: "full overwrite", mutate: func(request *WatermarkSyncRequest) { request.Sync.Mode = "full_overwrite" }, message: "full_overwrite"},
		{name: "delete propagation", mutate: func(request *WatermarkSyncRequest) {
			request.Sync.TableOptions = map[string]TableOptions{"events": {Delete: true}}
		}, message: "删除传播"},
		{name: "missing stable tie", mutate: func(request *WatermarkSyncRequest) { request.TieBreakerColumns = nil }, message: "稳定 tie-breaker"},
		{name: "document source", mutate: func(request *WatermarkSyncRequest) { request.Sync.SourceConfig.Type = "mongodb" }, message: "document"},
		{name: "unsupported dialect", mutate: func(request *WatermarkSyncRequest) { request.Sync.SourceConfig.Type = "clickhouse" }, message: "不支持源方言"},
		{name: "unimplemented mapping filter", mutate: func(request *WatermarkSyncRequest) {
			request.Sync.Mappings = []SyncObjectMapping{{Source: SyncObjectRef{Name: "events"}, Target: SyncObjectRef{Name: "events"}, Filter: "tenant_id = 'acme'"}}
		}, message: "过滤条件尚未接入"},
		{name: "unsafe insert only default", mutate: func(request *WatermarkSyncRequest) {
			request.Sync.Mode = "insert_only"
			request.DeliverySemantics = ""
		}, message: "at_least_once"},
		{name: "negative batch", mutate: func(request *WatermarkSyncRequest) { request.BatchSize = -1 }, message: "不能小于 0"},
		{name: "oversized batch", mutate: func(request *WatermarkSyncRequest) { request.BatchSize = 10001 }, message: "不能超过 10000"},
	}
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, fmt.Errorf("must not connect")
	}
	t.Cleanup(func() { newSyncDatabase = oldFactory })

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			request := base
			request.Sync.Tables = append([]string(nil), base.Sync.Tables...)
			request.TieBreakerColumns = append([]string(nil), base.TieBreakerColumns...)
			tt.mutate(&request)
			result := NewSyncEngine(Reporter{}).RunWatermarkSync(context.Background(), request, nil)
			if result.Success || !strings.Contains(result.Message, tt.message) {
				t.Fatalf("RunWatermarkSync() = %+v, want rejection containing %q", result, tt.message)
			}
		})
	}
	if factoryCalls != 0 {
		t.Fatalf("unsafe contracts opened %d database connections", factoryCalls)
	}
}
