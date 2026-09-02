package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	redispkg "GoNavi-Wails/internal/redis"
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type mappingSyncDatabase struct {
	db.Database
	columnsByTable map[string][]connection.ColumnDefinition
	queryRows      []map[string]interface{}
	queries        []string
	execs          []string
	appliedTable   string
	applied        connection.ChangeSet
	appliedBatches []connection.ChangeSet
}

func (d *mappingSyncDatabase) Connect(connection.ConnectionConfig) error { return nil }
func (d *mappingSyncDatabase) Close() error                              { return nil }
func (d *mappingSyncDatabase) Query(query string) ([]map[string]interface{}, []string, error) {
	d.queries = append(d.queries, query)
	rows := make([]map[string]interface{}, len(d.queryRows))
	for index, row := range d.queryRows {
		rows[index] = cloneProjectionRow(row)
	}
	return rows, nil, nil
}
func (d *mappingSyncDatabase) Exec(query string) (int64, error) {
	d.execs = append(d.execs, query)
	return 0, nil
}
func (d *mappingSyncDatabase) GetColumns(schema, table string) ([]connection.ColumnDefinition, error) {
	return append([]connection.ColumnDefinition(nil), d.columnsByTable[schema+"."+table]...), nil
}
func (d *mappingSyncDatabase) ApplyChanges(table string, changes connection.ChangeSet) error {
	d.appliedTable = table
	d.applied = changes
	d.appliedBatches = append(d.appliedBatches, changes)
	return nil
}

func TestRunSyncExplicitMappingUsesMappedTargetAndProjectedRows(t *testing.T) {
	source := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"APP.users": {
				{Name: "id", Type: "NUMBER", Key: "PK"},
				{Name: "name", Type: "VARCHAR2(100)"},
			},
		},
		queryRows: []map[string]interface{}{{"id": int64(7), "name": "  alice  "}},
	}
	target := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"dbo.people": {
				{Name: "user_id", Type: "BIGINT", Key: "PK"},
				{Name: "display_name", Type: "NVARCHAR(100)"},
			},
		},
	}

	originalFactory := newSyncDatabase
	t.Cleanup(func() { newSyncDatabase = originalFactory })
	newSyncDatabase = func(databaseType string) (db.Database, error) {
		switch databaseType {
		case "oracle":
			return source, nil
		case "sqlserver":
			return target, nil
		default:
			return nil, errors.New("unexpected database type: " + databaseType)
		}
	}

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle"},
		TargetConfig:   connection.ConnectionConfig{Type: "sqlserver"},
		SourceDatabase: "APP",
		TargetDatabase: "warehouse",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_only",
		Mappings: []SyncObjectMapping{{
			ID:     "users-to-people",
			Source: SyncObjectRef{Schema: "APP", Name: "users"},
			Target: SyncObjectRef{Schema: "dbo", Name: "people"},
			Columns: []SyncColumnMapping{
				{Source: "id", Target: "user_id"},
				{Source: "name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
			},
		}},
	})
	if !result.Success {
		t.Fatalf("RunSync() failed: %+v", result)
	}
	if result.RowsInserted != 1 || result.TablesSynced != 1 {
		t.Fatalf("RunSync() result = %+v, want one inserted row and one table", result)
	}
	if target.appliedTable != "dbo.people" {
		t.Fatalf("ApplyChanges table = %q, want dbo.people", target.appliedTable)
	}
	wantRows := []map[string]interface{}{{"user_id": int64(7), "display_name": "ALICE"}}
	if !reflect.DeepEqual(target.applied.Inserts, wantRows) {
		t.Fatalf("ApplyChanges inserts = %#v, want %#v", target.applied.Inserts, wantRows)
	}
	if len(source.queries) != 1 || source.queries[0] != `SELECT * FROM "APP"."users"` {
		t.Fatalf("source queries = %#v, want mapped fallback query", source.queries)
	}
}

func TestRunSyncSchemaOnlyExplicitMappingAddsMissingColumnsWithoutRows(t *testing.T) {
	source := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"local.orders": {
				{Name: "id", Type: "bigint", Key: "PRI"},
				{Name: "name", Type: "varchar(64)"},
				{Name: "status", Type: "varchar(16)"},
			},
		},
		queryRows: []map[string]interface{}{{"id": int64(1), "name": "alice", "status": "active"}},
	}
	target := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"online.orders_archive": {
				{Name: "id", Type: "bigint", Key: "PRI"},
				{Name: "name", Type: "varchar(64)"},
			},
		},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:        connection.ConnectionConfig{Type: "mysql"},
		TargetConfig:        connection.ConnectionConfig{Type: "mysql"},
		SourceDatabase:      "local",
		TargetDatabase:      "online",
		TargetTableStrategy: "existing_only",
		Tables:              []string{"orders"},
		Content:             "schema",
		Mode:                "insert_update",
		AutoAddColumns:      true,
		Mappings: []SyncObjectMapping{{
			ID:     "orders-to-archive",
			Source: SyncObjectRef{Schema: "local", Name: "orders"},
			Target: SyncObjectRef{Schema: "online", Name: "orders_archive"},
		}},
	})

	if !result.Success || result.TablesSynced != 1 {
		t.Fatalf("RunSync() = %+v, want one schema-synced table", result)
	}
	if len(target.execs) != 1 || !strings.Contains(target.execs[0], "ADD COLUMN `status` varchar(16) NULL") {
		t.Fatalf("target schema execs = %#v, want one status ADD COLUMN", target.execs)
	}
	if len(source.queries) != 0 || len(target.queries) != 0 {
		t.Fatalf("schema-only sync queried rows: source=%#v target=%#v", source.queries, target.queries)
	}
	if len(target.appliedBatches) != 0 {
		t.Fatalf("schema-only sync applied row changes: %#v", target.appliedBatches)
	}
}

func TestRunSyncExplicitMappingUsesConfiguredKeyWithoutPhysicalPK(t *testing.T) {
	source := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"APP.users": {
				{Name: "id", Type: "NUMBER"},
				{Name: "name", Type: "VARCHAR2(100)"},
			},
		},
		queryRows: []map[string]interface{}{{"id": int64(7), "name": "new"}},
	}
	target := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"dbo.people": {
				{Name: "user_id", Type: "BIGINT"},
				{Name: "display_name", Type: "NVARCHAR(100)"},
			},
		},
		queryRows: []map[string]interface{}{{"user_id": int64(7), "display_name": "old"}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle"},
		TargetConfig:   connection.ConnectionConfig{Type: "sqlserver"},
		SourceDatabase: "APP",
		TargetDatabase: "warehouse",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
		Mappings: []SyncObjectMapping{{
			ID:         "users-to-people",
			Source:     SyncObjectRef{Schema: "APP", Name: "users"},
			Target:     SyncObjectRef{Schema: "dbo", Name: "people"},
			KeyColumns: []string{"id"},
			Columns: []SyncColumnMapping{
				{Source: "id", Target: "user_id"},
				{Source: "name", Target: "display_name"},
			},
		}},
	})
	if !result.Success || result.TablesSynced != 1 || result.RowsUpdated != 1 {
		t.Fatalf("RunSync() = %+v, want configured-key update", result)
	}
	if len(target.applied.Updates) != 1 || len(target.applied.Inserts) != 0 || len(target.applied.Deletes) != 0 {
		t.Fatalf("configured key must drive the update diff: %#v", target.applied)
	}
	if got := target.applied.Updates[0].Keys; !reflect.DeepEqual(got, map[string]interface{}{"user_id": int64(7)}) {
		t.Fatalf("update keys = %#v, want mapped configured key", got)
	}
}

func TestRunSyncExplicitMappingUsesConfiguredKeyOverPhysicalPrimaryKey(t *testing.T) {
	source := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"APP.users": {
				{Name: "id", Type: "NUMBER", Key: "PK"},
				{Name: "email", Type: "VARCHAR2(100)"},
				{Name: "name", Type: "VARCHAR2(100)"},
			},
		},
		queryRows: []map[string]interface{}{{"id": int64(8), "email": "old@example.com", "name": "new"}},
	}
	target := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{
			"dbo.people": {
				{Name: "user_id", Type: "BIGINT", Key: "PK"},
				{Name: "email", Type: "NVARCHAR(100)"},
				{Name: "display_name", Type: "NVARCHAR(100)"},
			},
		},
		queryRows: []map[string]interface{}{{"user_id": int64(7), "email": "old@example.com", "display_name": "old"}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle"},
		TargetConfig:   connection.ConnectionConfig{Type: "sqlserver"},
		SourceDatabase: "APP",
		TargetDatabase: "warehouse",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
		TableOptions: map[string]TableOptions{
			"users": {Update: true},
		},
		Mappings: []SyncObjectMapping{{
			ID:         "users-to-people",
			Source:     SyncObjectRef{Schema: "APP", Name: "users"},
			Target:     SyncObjectRef{Schema: "dbo", Name: "people"},
			KeyColumns: []string{"email"},
			Columns: []SyncColumnMapping{
				{Source: "id", Target: "user_id"},
				{Source: "email", Target: "email"},
				{Source: "name", Target: "display_name"},
			},
		}},
	})
	if !result.Success || result.RowsUpdated != 1 || result.RowsInserted != 0 || result.RowsDeleted != 0 {
		t.Fatalf("RunSync() = %+v, want one configured-key update", result)
	}
	if len(target.applied.Updates) != 1 || len(target.applied.Inserts) != 0 || len(target.applied.Deletes) != 0 {
		t.Fatalf("configured key must control diffing: %#v", target.applied)
	}
	if got := target.applied.Updates[0].Keys; !reflect.DeepEqual(got, map[string]interface{}{"email": "old@example.com"}) {
		t.Fatalf("update keys = %#v, want mapped configured key", got)
	}
}

func TestRunSyncExplicitMappingUsesConfiguredFallbackApplyBatchSize(t *testing.T) {
	rows := []map[string]interface{}{
		{"id": int64(1)}, {"id": int64(2)}, {"id": int64(3)}, {"id": int64(4)}, {"id": int64(5)},
	}
	source := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{"APP.users": {{Name: "id", Type: "NUMBER"}}},
		queryRows:      rows,
	}
	target := &mappingSyncDatabase{
		columnsByTable: map[string][]connection.ColumnDefinition{"dbo.people": {{Name: "user_id", Type: "BIGINT"}}},
	}
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "oracle"},
		TargetConfig:   connection.ConnectionConfig{Type: "sqlserver"},
		SourceDatabase: "APP",
		TargetDatabase: "warehouse",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_only",
		BatchSize:      2,
		Mappings: []SyncObjectMapping{{
			Source:  SyncObjectRef{Schema: "APP", Name: "users"},
			Target:  SyncObjectRef{Schema: "dbo", Name: "people"},
			Columns: []SyncColumnMapping{{Source: "id", Target: "user_id"}},
		}},
	})
	if !result.Success || result.RowsInserted != 5 {
		t.Fatalf("RunSync() = %+v, want five mapped inserts", result)
	}
	if len(target.appliedBatches) != 3 {
		t.Fatalf("fallback batches = %#v, want three", target.appliedBatches)
	}
	for index, want := range []int{2, 2, 1} {
		if got := len(target.appliedBatches[index].Inserts); got != want {
			t.Fatalf("fallback batch %d size = %d, want %d", index+1, got, want)
		}
	}
}

type contextAwareSyncDatabase struct {
	db.Database
	queryStarted chan struct{}
	startOnce    sync.Once
	columns      []connection.ColumnDefinition
	legacyCalls  int
}

func (d *contextAwareSyncDatabase) Connect(connection.ConnectionConfig) error { return nil }
func (d *contextAwareSyncDatabase) Close() error                              { return nil }
func (d *contextAwareSyncDatabase) Query(string) ([]map[string]interface{}, []string, error) {
	d.legacyCalls++
	return nil, nil, errors.New("legacy Query should not be used")
}
func (d *contextAwareSyncDatabase) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	d.startOnce.Do(func() { close(d.queryStarted) })
	<-ctx.Done()
	return nil, nil, ctx.Err()
}
func (d *contextAwareSyncDatabase) Exec(string) (int64, error) { return 0, nil }
func (d *contextAwareSyncDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return append([]connection.ColumnDefinition(nil), d.columns...), nil
}

type contextTargetSyncDatabase struct {
	db.Database
	columns []connection.ColumnDefinition
}

func (d *contextTargetSyncDatabase) Connect(connection.ConnectionConfig) error { return nil }
func (d *contextTargetSyncDatabase) Close() error                              { return nil }
func (d *contextTargetSyncDatabase) Query(string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}
func (d *contextTargetSyncDatabase) Exec(string) (int64, error) { return 0, nil }
func (d *contextTargetSyncDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return append([]connection.ColumnDefinition(nil), d.columns...), nil
}
func (d *contextTargetSyncDatabase) ApplyChanges(string, connection.ChangeSet) error { return nil }

func TestRunSyncContextCancelsContextAwareQuery(t *testing.T) {
	source := &contextAwareSyncDatabase{
		queryStarted: make(chan struct{}),
		columns:      []connection.ColumnDefinition{{Name: "id", Type: "NUMBER", Key: "PK"}},
	}
	target := &contextTargetSyncDatabase{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "BIGINT", Key: "PK"}},
	}
	originalFactory := newSyncDatabase
	t.Cleanup(func() { newSyncDatabase = originalFactory })
	newSyncDatabase = func(databaseType string) (db.Database, error) {
		if databaseType == "oracle" {
			return source, nil
		}
		return target, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan SyncResult, 1)
	go func() {
		resultCh <- NewSyncEngine(Reporter{}).RunSyncContext(ctx, SyncConfig{
			SourceConfig:        connection.ConnectionConfig{Type: "oracle"},
			TargetConfig:        connection.ConnectionConfig{Type: "sqlserver"},
			SourceDatabase:      "APP",
			TargetDatabase:      "warehouse",
			TargetSchema:        "dbo",
			Tables:              []string{"users"},
			Content:             "data",
			Mode:                "insert_only",
			TargetTableStrategy: "existing_only",
		})
	}()

	select {
	case <-source.queryStarted:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for context-aware source query")
	}

	select {
	case result := <-resultCh:
		if result.Success || !result.Cancelled {
			t.Fatalf("RunSyncContext() result = %+v, want cancelled failure", result)
		}
		if source.legacyCalls != 0 {
			t.Fatalf("legacy Query calls = %d, want 0", source.legacyCalls)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RunSyncContext() did not return after cancellation")
	}
}

func TestAnalyzeContextCancelsContextAwareQuery(t *testing.T) {
	source := &contextAwareSyncDatabase{
		queryStarted: make(chan struct{}),
		columns:      []connection.ColumnDefinition{{Name: "id", Type: "NUMBER", Key: "PK"}},
	}
	target := &contextTargetSyncDatabase{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "BIGINT", Key: "PK"}},
	}
	originalFactory := newSyncDatabase
	t.Cleanup(func() { newSyncDatabase = originalFactory })
	newSyncDatabase = func(databaseType string) (db.Database, error) {
		if databaseType == "oracle" {
			return source, nil
		}
		return target, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan SyncAnalyzeResult, 1)
	go func() {
		resultCh <- NewSyncEngine(Reporter{}).AnalyzeContext(ctx, SyncConfig{
			SourceConfig:        connection.ConnectionConfig{Type: "oracle"},
			TargetConfig:        connection.ConnectionConfig{Type: "sqlserver"},
			SourceDatabase:      "APP",
			TargetDatabase:      "warehouse",
			TargetSchema:        "dbo",
			Tables:              []string{"users"},
			Content:             "data",
			Mode:                "insert_only",
			TargetTableStrategy: "existing_only",
		})
	}()

	select {
	case <-source.queryStarted:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for context-aware analyze query")
	}

	select {
	case result := <-resultCh:
		if result.Success || result.Message != context.Canceled.Error() {
			t.Fatalf("AnalyzeContext() result = %+v, want context-cancelled failure", result)
		}
		if len(result.Tables) != 1 || !strings.Contains(result.Tables[0].Message, context.Canceled.Error()) {
			t.Fatalf("AnalyzeContext() tables = %+v, want cancelled table summary", result.Tables)
		}
		if source.legacyCalls != 0 {
			t.Fatalf("legacy Query calls = %d, want 0", source.legacyCalls)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("AnalyzeContext() did not return after cancellation")
	}
}

func TestPreviewContextCancelsContextAwareQuery(t *testing.T) {
	source := &contextAwareSyncDatabase{
		queryStarted: make(chan struct{}),
		columns:      []connection.ColumnDefinition{{Name: "id", Type: "NUMBER", Key: "PK"}},
	}
	target := &contextTargetSyncDatabase{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "BIGINT", Key: "PK"}},
	}
	originalFactory := newSyncDatabase
	t.Cleanup(func() { newSyncDatabase = originalFactory })
	newSyncDatabase = func(databaseType string) (db.Database, error) {
		if databaseType == "oracle" {
			return source, nil
		}
		return target, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := NewSyncEngine(Reporter{}).PreviewContext(ctx, SyncConfig{
			SourceConfig:        connection.ConnectionConfig{Type: "oracle"},
			TargetConfig:        connection.ConnectionConfig{Type: "sqlserver"},
			SourceDatabase:      "APP",
			TargetDatabase:      "warehouse",
			TargetSchema:        "dbo",
			Tables:              []string{"users"},
			Content:             "data",
			Mode:                "insert_only",
			TargetTableStrategy: "existing_only",
		}, "users", 25)
		errCh <- err
	}()

	select {
	case <-source.queryStarted:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for context-aware preview query")
	}

	select {
	case err := <-errCh:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("PreviewContext() error = %v, want context.Canceled", err)
		}
		if source.legacyCalls != 0 {
			t.Fatalf("legacy Query calls = %d, want 0", source.legacyCalls)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PreviewContext() did not return after cancellation")
	}
}

func TestSourceQueryAnalyzeAndPreviewObserveRequestContext(t *testing.T) {
	operations := []struct {
		name string
		run  func(context.Context, SyncConfig) error
	}{
		{
			name: "analyze",
			run: func(ctx context.Context, config SyncConfig) error {
				result := NewSyncEngine(Reporter{}).AnalyzeContext(ctx, config)
				if result.Success || result.Message != context.Canceled.Error() {
					return fmt.Errorf("AnalyzeContext() = %+v, want cancelled failure", result)
				}
				return context.Canceled
			},
		},
		{
			name: "preview",
			run: func(ctx context.Context, config SyncConfig) error {
				_, err := NewSyncEngine(Reporter{}).PreviewContext(ctx, config, "users", 25)
				return err
			},
		},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			source := &contextAwareSyncDatabase{
				queryStarted: make(chan struct{}),
				columns:      []connection.ColumnDefinition{{Name: "id", Type: "NUMBER", Key: "PK"}},
			}
			target := &contextTargetSyncDatabase{
				columns: []connection.ColumnDefinition{{Name: "id", Type: "BIGINT", Key: "PK"}},
			}
			originalFactory := newSyncDatabase
			t.Cleanup(func() { newSyncDatabase = originalFactory })
			newSyncDatabase = func(databaseType string) (db.Database, error) {
				if databaseType == "oracle" {
					return source, nil
				}
				return target, nil
			}

			ctx, cancel := context.WithCancel(context.Background())
			errCh := make(chan error, 1)
			go func() {
				errCh <- operation.run(ctx, SyncConfig{
					SourceConfig:   connection.ConnectionConfig{Type: "oracle"},
					TargetConfig:   connection.ConnectionConfig{Type: "sqlserver"},
					SourceDatabase: "APP",
					TargetDatabase: "warehouse",
					TargetSchema:   "dbo",
					Tables:         []string{"users"},
					SourceQuery:    "SELECT id FROM active_users",
					Content:        "data",
					Mode:           "insert_only",
				})
			}()

			select {
			case <-source.queryStarted:
				cancel()
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for source-query execution")
			}

			select {
			case err := <-errCh:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("%s error = %v, want context.Canceled", operation.name, err)
				}
				if source.legacyCalls != 0 {
					t.Fatalf("legacy Query calls = %d, want 0", source.legacyCalls)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("%s did not return after cancellation", operation.name)
			}
		})
	}
}

func TestRedisMongoAnalyzeAndPreviewObserveRequestContext(t *testing.T) {
	operations := []struct {
		name           string
		config         SyncConfig
		blockingDBType string
		run            func(context.Context, SyncConfig) error
	}{
		{
			name: "redis_to_mongo_analyze",
			config: SyncConfig{
				SourceConfig: connection.ConnectionConfig{Type: "redis"},
				TargetConfig: connection.ConnectionConfig{Type: "mongodb", Database: "app"},
				Tables:       []string{"session:1"},
				Content:      "data",
				Mode:         "insert_update",
			},
			blockingDBType: "mongodb",
			run: func(ctx context.Context, config SyncConfig) error {
				result := NewSyncEngine(Reporter{}).AnalyzeContext(ctx, config)
				if result.Success || result.Message != context.Canceled.Error() {
					return fmt.Errorf("AnalyzeContext() = %+v, want cancelled failure", result)
				}
				return context.Canceled
			},
		},
		{
			name: "mongo_to_redis_preview",
			config: SyncConfig{
				SourceConfig: connection.ConnectionConfig{Type: "mongodb", Database: "app"},
				TargetConfig: connection.ConnectionConfig{Type: "redis"},
				Tables:       []string{"redis_db_0_keys"},
				Content:      "data",
				Mode:         "insert_update",
			},
			blockingDBType: "mongodb",
			run: func(ctx context.Context, config SyncConfig) error {
				_, err := NewSyncEngine(Reporter{}).PreviewContext(ctx, config, "redis_db_0_keys", 25)
				return err
			},
		},
	}

	for _, operation := range operations {
		t.Run(operation.name, func(t *testing.T) {
			blockingDB := &contextAwareSyncDatabase{queryStarted: make(chan struct{})}
			redisClient := &fakeRedisMigrationClient{values: map[string]*redispkg.RedisValue{
				"session:1": {Type: "string", TTL: -1, Value: "token"},
			}}
			originalFactory := newSyncDatabase
			originalRedisFactory := newRedisSourceClient
			t.Cleanup(func() {
				newSyncDatabase = originalFactory
				newRedisSourceClient = originalRedisFactory
			})
			newSyncDatabase = func(databaseType string) (db.Database, error) {
				if databaseType != operation.blockingDBType {
					return nil, fmt.Errorf("unexpected database type %s", databaseType)
				}
				return blockingDB, nil
			}
			newRedisSourceClient = func() redisMigrationClient { return redisClient }

			ctx, cancel := context.WithCancel(context.Background())
			errCh := make(chan error, 1)
			go func() { errCh <- operation.run(ctx, operation.config) }()
			select {
			case <-blockingDB.queryStarted:
				cancel()
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for Redis/Mongo query")
			}
			select {
			case err := <-errCh:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("%s error = %v, want context.Canceled", operation.name, err)
				}
				if blockingDB.legacyCalls != 0 {
					t.Fatalf("legacy Query calls = %d, want 0", blockingDB.legacyCalls)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("%s did not return after cancellation", operation.name)
			}
		})
	}
}

func TestMappedConfigDisablesUnmappedPagingFastPaths(t *testing.T) {
	config := SyncConfig{Mappings: []SyncObjectMapping{{Source: SyncObjectRef{Name: "users"}, Target: SyncObjectRef{Name: "people"}}}}
	engine := NewSyncEngine(Reporter{})

	handled, _, err := engine.tryApplyDirectImportInPages(
		config, &SyncResult{}, 0, 1, "users", nil, nil, SchemaMigrationPlan{}, nil, nil,
		TableOptions{Insert: true}, "mysql", "postgres", "people",
	)
	if err != nil || handled {
		t.Fatalf("direct import mapping guard = handled %v err %v, want false nil", handled, err)
	}

	handled, _, err = engine.tryApplyDiffInPages(
		config, &SyncResult{}, 0, 1, "users", nil, nil, SchemaMigrationPlan{TargetTableExists: true}, nil, nil,
		TableOptions{Insert: true, Update: true}, "mysql", "postgres", "people", "id",
	)
	if err != nil || handled {
		t.Fatalf("diff mapping guard = handled %v err %v, want false nil", handled, err)
	}
}

func TestSourceQueryMappingUsesSyntheticSourceObject(t *testing.T) {
	tableName, err := validateSourceQuerySyncConfig(SyncConfig{
		SourceQuery: "SELECT id FROM users",
		Tables:      []string{"people"},
		Mappings: []SyncObjectMapping{{
			Source: SyncObjectRef{Name: "users"},
			Target: SyncObjectRef{Name: "people"},
		}},
	})
	if err != nil || tableName != "users" {
		t.Fatalf("validateSourceQuerySyncConfig() = %q, %v, want synthetic source users", tableName, err)
	}
}

func mappedDiffConfigForTest() SyncConfig {
	return SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql", Database: "source_db"},
		TargetConfig:   connection.ConnectionConfig{Type: "postgres", Database: "target_db"},
		SourceDatabase: "source_db",
		TargetDatabase: "target_db",
		TargetSchema:   "public",
		Tables:         []string{"users"},
		Content:        "data",
		Mode:           "insert_update",
		Mappings: []SyncObjectMapping{{
			ID:     "users-to-people",
			Source: SyncObjectRef{Schema: "source_db", Name: "users"},
			Target: SyncObjectRef{Schema: "public", Name: "people"},
			Columns: []SyncColumnMapping{
				{Source: "id", Target: "user_id"},
				{Source: "name", Target: "display_name", Transforms: []SyncValueTransform{{Type: "trim"}, {Type: "upper"}}},
			},
		}},
	}
}

func mappedDiffDatabasesForTest() (*fakeMigrationDB, *fakeMigrationDB) {
	source := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"source_db.users": {
				{Name: "id", Type: "bigint", Key: "PRI"},
				{Name: "name", Type: "varchar(100)"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			"SELECT COUNT(*) AS __gonavi_count__ FROM `source_db`.`users`": {{"__gonavi_count__": int64(1)}},
			"SELECT * FROM `source_db`.`users`":                            {{"id": int64(7), "name": " alice "}},
		},
	}
	target := &fakeMigrationDB{
		columns: map[string][]connection.ColumnDefinition{
			"public.people": {
				{Name: "user_id", Type: "bigint", Key: "PK"},
				{Name: "display_name", Type: "varchar(100)"},
			},
		},
		queryData: map[string][]map[string]interface{}{
			`SELECT * FROM "public"."people"`: {{"user_id": int64(7), "display_name": "ALICE"}},
		},
	}
	return source, target
}

func TestAnalyzeExplicitMappingUsesProjectedFallback(t *testing.T) {
	source, target := mappedDiffDatabasesForTest()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	result := NewSyncEngine(Reporter{}).Analyze(mappedDiffConfigForTest())
	if !result.Success || len(result.Tables) != 1 {
		t.Fatalf("Analyze() = %+v, want one successful mapped table", result)
	}
	summary := result.Tables[0]
	if !summary.CanSync || summary.PKColumn != "user_id" || summary.Same != 1 || summary.Inserts != 0 || summary.Updates != 0 || summary.Deletes != 0 {
		t.Fatalf("Analyze() summary = %+v, want one identical projected row", summary)
	}
	for _, query := range source.queryLog {
		if strings.Contains(strings.ToUpper(query), " LIMIT ") || strings.Contains(strings.ToUpper(query), " OFFSET ") {
			t.Fatalf("mapped analysis used unmapped paging query: %s", query)
		}
	}
}

func TestPreviewExplicitMappingUsesProjectedFallback(t *testing.T) {
	source, target := mappedDiffDatabasesForTest()
	useSyncDatabaseFactorySequence(t,
		syncDatabaseFactoryStep{db: source},
		syncDatabaseFactoryStep{db: target},
	)

	preview, err := NewSyncEngine(Reporter{}).Preview(mappedDiffConfigForTest(), "users", 20)
	if err != nil {
		t.Fatalf("Preview() error = %v", err)
	}
	if preview.PKColumn != "user_id" || preview.TotalInserts != 0 || preview.TotalUpdates != 0 || preview.TotalDeletes != 0 {
		t.Fatalf("Preview() = %+v, want identical projected rows", preview)
	}
	if preview.ColumnTypes["user_id"] != "bigint" || preview.ColumnTypes["display_name"] != "varchar(100)" {
		t.Fatalf("Preview() column types = %#v, want mapped target metadata", preview.ColumnTypes)
	}
	if len(source.queryLog) != 1 || source.queryLog[0] != "SELECT * FROM `source_db`.`users`" {
		t.Fatalf("mapped preview source queries = %#v, want full projected fallback", source.queryLog)
	}
}
