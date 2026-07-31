package app

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type keepAliveRecordingDB struct {
	closed               int
	pings                int
	pingErr              error
	queries              []string
	queryErr             error
	queryContextCalls    int
	queryContextDeadline bool
	queryContextHook     func(context.Context, string) error
	connectHook          func()
}

type contextAwareKeepAliveDB struct {
	keepAliveRecordingDB
	pingStarted chan struct{}
	pingRelease chan struct{}
	startOnce   sync.Once
}

func (f *contextAwareKeepAliveDB) signalPingStarted() {
	f.startOnce.Do(func() {
		close(f.pingStarted)
	})
}

func (f *contextAwareKeepAliveDB) Ping() error {
	f.signalPingStarted()
	<-f.pingRelease
	return nil
}

func (f *contextAwareKeepAliveDB) PingContext(ctx context.Context) error {
	f.signalPingStarted()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-f.pingRelease:
		return nil
	}
}

func (f *keepAliveRecordingDB) Connect(config connection.ConnectionConfig) error {
	if f.connectHook != nil {
		f.connectHook()
	}
	return nil
}
func (f *keepAliveRecordingDB) Close() error {
	f.closed++
	return nil
}
func (f *keepAliveRecordingDB) Ping() error {
	f.pings++
	return f.pingErr
}
func (f *keepAliveRecordingDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queries = append(f.queries, query)
	return nil, nil, f.queryErr
}
func (f *keepAliveRecordingDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryContextCalls++
	_, f.queryContextDeadline = ctx.Deadline()
	f.queries = append(f.queries, query)
	if f.queryContextHook != nil {
		return nil, nil, f.queryContextHook(ctx, query)
	}
	return nil, nil, f.queryErr
}
func (f *keepAliveRecordingDB) Exec(query string) (int64, error)          { return 0, nil }
func (f *keepAliveRecordingDB) GetDatabases() ([]string, error)           { return nil, nil }
func (f *keepAliveRecordingDB) GetTables(dbName string) ([]string, error) { return nil, nil }
func (f *keepAliveRecordingDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}
func (f *keepAliveRecordingDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (f *keepAliveRecordingDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (f *keepAliveRecordingDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (f *keepAliveRecordingDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (f *keepAliveRecordingDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func TestRunConnectionKeepAliveTick_PingsDueCachedConnection(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "db.local", Port: 5432, User: "postgres"}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{}

	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastPing:          time.Now().Add(-5 * time.Hour),
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
	}

	app.runConnectionKeepAliveTick(time.Now())

	if dbInst.pings != 1 {
		t.Fatalf("expected keepalive ping once, got %d", dbInst.pings)
	}

	entry := app.dbCache[key]
	if entry.keepAliveInFlight {
		t.Fatal("expected keepalive in-flight flag to be cleared")
	}
	if entry.lastPing.IsZero() {
		t.Fatal("expected keepalive success to update lastPing")
	}
	if entry.lastKeepAliveAt.IsZero() {
		t.Fatal("expected keepalive success to update lastKeepAliveAt")
	}
}

func TestStopConnectionKeepAliveLoopCancelsContextAwarePing(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "dameng", Host: "db.local", Port: 5236, User: "readonly"}
	key := getCacheKey(config)
	dbInst := &contextAwareKeepAliveDB{
		pingStarted: make(chan struct{}),
		pingRelease: make(chan struct{}),
	}
	defer close(dbInst.pingRelease)
	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	app.keepAliveCancel = cancel
	app.keepAliveDone = done
	go func() {
		defer close(done)
		app.runConnectionKeepAliveTickContext(ctx, time.Now())
	}()

	select {
	case <-dbInst.pingStarted:
	case <-time.After(time.Second):
		t.Fatal("keepalive ping did not start")
	}

	stopped := make(chan struct{})
	go func() {
		app.stopConnectionKeepAliveLoop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("stopConnectionKeepAliveLoop remained blocked after cancellation")
	}
}

func TestRunConnectionKeepAliveTick_ExecutesCustomReadOnlySQL(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{
		Type:             "mysql",
		Host:             "db.local",
		Port:             3306,
		User:             "readonly",
		KeepAliveEnabled: true,
		KeepAliveSQL:     "  SELECT 1  ",
	}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{}

	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastPing:          time.Now().Add(-5 * time.Hour),
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
		keepAliveSQL:      "SELECT 1",
		keepAliveDBType:   "mysql",
	}

	app.runConnectionKeepAliveTick(time.Now())

	if dbInst.pings != 0 {
		t.Fatalf("expected custom SQL to replace Ping, got %d pings", dbInst.pings)
	}
	if len(dbInst.queries) != 1 || dbInst.queries[0] != "SELECT 1" {
		t.Fatalf("expected trimmed custom SQL once, got %#v", dbInst.queries)
	}
	if dbInst.queryContextCalls != 1 || !dbInst.queryContextDeadline {
		t.Fatalf("expected cancellable QueryContext with deadline, calls=%d deadline=%t", dbInst.queryContextCalls, dbInst.queryContextDeadline)
	}
}

func TestResolveConnectionKeepAliveSQL_NormalizesSupportedSQLConnections(t *testing.T) {
	sql, dbType := resolveConnectionKeepAliveSQL(connection.ConnectionConfig{
		Type:             "mysql",
		KeepAliveEnabled: true,
		KeepAliveSQL:     "  SELECT 1  ",
	})
	if sql != "SELECT 1" || dbType != "mysql" {
		t.Fatalf("expected normalized MySQL keepalive SQL, sql=%q dbType=%q", sql, dbType)
	}

	sql, dbType = resolveConnectionKeepAliveSQL(connection.ConnectionConfig{
		Type:             "redis",
		KeepAliveEnabled: true,
		KeepAliveSQL:     "SELECT 1",
	})
	if sql != "" || dbType != "" {
		t.Fatalf("expected non-SQL datasource to ignore custom SQL, sql=%q dbType=%q", sql, dbType)
	}
}

func TestExecuteConnectionKeepAlive_RejectsUnsafeSQL(t *testing.T) {
	tests := []string{
		"DELETE FROM accounts",
		"SELECT 1; SELECT 2",
		"SELECT 1; DELETE FROM accounts",
		"/*!50000 DELETE FROM accounts */ SELECT 1",
		"SELECT /*!50000 SQL_NO_CACHE */ 1",
		"SELECT ';' AS probe",
		"SELECT 1 /* ; */",
	}

	for _, query := range tests {
		t.Run(query, func(t *testing.T) {
			dbInst := &keepAliveRecordingDB{}
			err := executeConnectionKeepAlive(context.Background(), cachedDatabaseKeepAliveTarget{
				inst:   dbInst,
				sql:    query,
				dbType: "mysql",
			})
			if !errors.Is(err, errInvalidConnectionKeepAliveSQL) {
				t.Fatalf("expected unsafe SQL rejection, got %v", err)
			}
			if len(dbInst.queries) != 0 || dbInst.pings != 0 {
				t.Fatalf("expected unsafe SQL not to reach database, queries=%#v pings=%d", dbInst.queries, dbInst.pings)
			}
		})
	}
}

func TestExecuteConnectionKeepAlive_RequiresCancellableQuery(t *testing.T) {
	dbInst := &keepAliveRecordingDB{}
	dbWithoutQueryContext := struct{ db.Database }{Database: dbInst}

	err := executeConnectionKeepAlive(context.Background(), cachedDatabaseKeepAliveTarget{
		inst:   dbWithoutQueryContext,
		sql:    "SELECT 1",
		dbType: "mysql",
	})
	if !errors.Is(err, errConnectionKeepAliveQueryContextUnsupported) {
		t.Fatalf("expected drivers without QueryContext to be rejected, got %v", err)
	}
	if len(dbInst.queries) != 0 || dbInst.pings != 0 {
		t.Fatalf("expected no unbounded query fallback, queries=%#v pings=%d", dbInst.queries, dbInst.pings)
	}
}

func TestRunConnectionKeepAliveTick_KeepsHealthyConnectionOnPolicyError(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "db.local", Port: 3306, User: "readonly"}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{}

	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
		keepAliveSQL:      "DELETE FROM accounts",
		keepAliveDBType:   "mysql",
	}

	app.runConnectionKeepAliveTick(time.Now())

	entry, exists := app.dbCache[key]
	if !exists || entry.inst != dbInst {
		t.Fatal("expected policy error not to evict the healthy cached connection")
	}
	if entry.keepAliveInFlight || entry.lastKeepAliveAt.IsZero() {
		t.Fatalf("expected skipped policy to finish and advance its schedule, inFlight=%t lastKeepAliveAt=%s", entry.keepAliveInFlight, entry.lastKeepAliveAt)
	}
	if dbInst.closed != 0 || len(dbInst.queries) != 0 || dbInst.pings != 0 {
		t.Fatalf("expected invalid policy not to touch the database, closed=%d queries=%#v pings=%d", dbInst.closed, dbInst.queries, dbInst.pings)
	}
}

func TestRunConnectionKeepAliveTickContext_CancelsCustomQuery(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "db.local", Port: 5432, User: "readonly"}
	key := getCacheKey(config)
	queryStarted := make(chan struct{})
	dbInst := &keepAliveRecordingDB{
		queryContextHook: func(ctx context.Context, _ string) error {
			close(queryStarted)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
		keepAliveSQL:      "SELECT 1",
		keepAliveDBType:   "postgres",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.runConnectionKeepAliveTickContext(ctx, time.Now())
	}()
	<-queryStarted
	cancel()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("expected custom keepalive query to stop after loop cancellation")
	}
	entry, exists := app.dbCache[key]
	if !exists || entry.inst != dbInst || entry.keepAliveInFlight {
		t.Fatalf("expected cancelled keepalive to preserve and release cached connection, exists=%t inFlight=%t", exists, entry.keepAliveInFlight)
	}
	if dbInst.closed != 0 {
		t.Fatalf("expected shutdown cancellation not to evict the connection, closed=%d", dbInst.closed)
	}
}

func TestCachedDatabaseKeepAliveTarget_SkipsQueuedStalePolicy(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "db.local", Port: 3306, User: "readonly"}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{}
	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
		keepAliveSQL:      "SELECT 1",
		keepAliveDBType:   "mysql",
		keepAliveRevision: 1,
	}

	targets := app.collectDueConnectionKeepAliveTargets(time.Now())
	if len(targets) != 1 {
		t.Fatalf("expected one due target, got %d", len(targets))
	}
	entry := app.dbCache[key]
	entry.keepAliveRevision = nextConnectionKeepAliveRevision(entry.keepAliveRevision)
	entry.keepAliveSQL = "SELECT 2"
	app.dbCache[key] = entry

	if app.isCachedDatabaseKeepAliveTargetCurrent(targets[0]) {
		t.Fatal("expected queued target to become stale after policy update")
	}
	entry = app.dbCache[key]
	if entry.keepAliveInFlight || entry.keepAliveSQL != "SELECT 2" || entry.keepAliveRevision != 2 {
		t.Fatalf("expected stale target release without changing new policy, inFlight=%t sql=%q revision=%d", entry.keepAliveInFlight, entry.keepAliveSQL, entry.keepAliveRevision)
	}
	if len(dbInst.queries) != 0 {
		t.Fatalf("expected stale queued SQL not to execute, queries=%#v", dbInst.queries)
	}
}

func TestRunConnectionKeepAliveTick_DoesNotApplyStalePolicyResult(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "db.local", Port: 5432, User: "readonly"}
	key := getCacheKey(config)
	queryStarted := make(chan struct{})
	finishQuery := make(chan struct{})
	dbInst := &keepAliveRecordingDB{
		queryContextHook: func(_ context.Context, _ string) error {
			close(queryStarted)
			<-finishQuery
			return errors.New("old probe failed")
		},
	}
	lastKeepAliveAt := time.Now().Add(-5 * time.Hour)
	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastKeepAliveAt:   lastKeepAliveAt,
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
		keepAliveSQL:      "SELECT 1",
		keepAliveDBType:   "postgres",
		keepAliveRevision: 1,
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		app.runConnectionKeepAliveTick(time.Now())
	}()
	<-queryStarted
	app.mu.Lock()
	entry := app.dbCache[key]
	entry.keepAliveRevision = nextConnectionKeepAliveRevision(entry.keepAliveRevision)
	entry.keepAliveSQL = "SELECT 2"
	app.dbCache[key] = entry
	app.mu.Unlock()
	close(finishQuery)

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("expected stale custom keepalive query to finish")
	}
	entry, exists := app.dbCache[key]
	if !exists || entry.inst != dbInst {
		t.Fatal("expected stale query failure not to evict the current cached connection")
	}
	if entry.keepAliveInFlight || entry.keepAliveSQL != "SELECT 2" || entry.keepAliveRevision != 2 {
		t.Fatalf("expected current policy to remain unchanged, inFlight=%t sql=%q revision=%d", entry.keepAliveInFlight, entry.keepAliveSQL, entry.keepAliveRevision)
	}
	if !entry.lastKeepAliveAt.Equal(lastKeepAliveAt) {
		t.Fatalf("expected stale result not to advance current policy schedule, before=%s after=%s", lastKeepAliveAt, entry.lastKeepAliveAt)
	}
	if dbInst.closed != 0 {
		t.Fatalf("expected stale query failure not to close the current connection, closed=%d", dbInst.closed)
	}
}

func TestRunConnectionKeepAliveTick_RemovesFailedCustomSQLConnection(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "mysql", Host: "db.local", Port: 3306, User: "readonly"}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{queryErr: errors.New("token expired")}

	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastPing:          time.Now().Add(-5 * time.Hour),
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
		keepAliveSQL:      "SELECT 1",
		keepAliveDBType:   "mysql",
	}

	app.runConnectionKeepAliveTick(time.Now())

	if len(dbInst.queries) != 1 || dbInst.pings != 0 {
		t.Fatalf("expected one custom query and no Ping, queries=%#v pings=%d", dbInst.queries, dbInst.pings)
	}
	if dbInst.closed != 1 || len(app.dbCache) != 0 {
		t.Fatalf("expected failed custom keepalive to evict and close connection, closed=%d cache=%d", dbInst.closed, len(app.dbCache))
	}
}

func TestRunConnectionKeepAliveTick_RemovesFailedCachedConnection(t *testing.T) {
	app := NewApp()
	config := connection.ConnectionConfig{Type: "postgres", Host: "db.local", Port: 5432, User: "postgres"}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{pingErr: errors.New("token expired")}

	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastPing:          time.Now().Add(-5 * time.Hour),
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 4 * time.Hour,
	}

	app.runConnectionKeepAliveTick(time.Now())

	if dbInst.pings != 1 {
		t.Fatalf("expected keepalive ping once, got %d", dbInst.pings)
	}
	if dbInst.closed != 1 {
		t.Fatalf("expected failed cached connection to be closed once, got %d", dbInst.closed)
	}
	if len(app.dbCache) != 0 {
		t.Fatalf("expected failed cached connection to be evicted, got %d entries", len(app.dbCache))
	}
}

func TestGetDatabaseWithPing_UpdatesCachedKeepAliveSettings(t *testing.T) {
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	defer func() {
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
	}()
	driverRuntimeSupportStatusFunc = func(dbType string) (bool, string) {
		return true, ""
	}

	app := NewApp()
	config := connection.ConnectionConfig{
		Type:                     "postgres",
		Host:                     "db.local",
		Port:                     5432,
		User:                     "postgres",
		KeepAliveEnabled:         true,
		KeepAliveIntervalMinutes: 15,
		KeepAliveSQL:             " SELECT current_timestamp ",
	}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{}

	app.dbCache[key] = cachedDatabase{
		inst:     dbInst,
		lastPing: time.Now(),
		config:   normalizeCacheKeyConfig(config),
	}

	inst, err := app.getDatabaseWithPing(config, false)
	if err != nil {
		t.Fatalf("expected cached database lookup to succeed, got %v", err)
	}
	if inst != dbInst {
		t.Fatal("expected cached database instance to be reused")
	}

	entry := app.dbCache[key]
	if !entry.keepAliveEnabled {
		t.Fatal("expected cached keepalive to be enabled from config")
	}
	if entry.keepAliveInterval != 15*time.Minute {
		t.Fatalf("expected keepalive interval 15m, got %s", entry.keepAliveInterval)
	}
	if entry.keepAliveSQL != "SELECT current_timestamp" {
		t.Fatalf("expected cached custom SQL to be updated, got %q", entry.keepAliveSQL)
	}
	if entry.keepAliveDBType != "postgres" {
		t.Fatalf("expected cached custom SQL dialect postgres, got %q", entry.keepAliveDBType)
	}
}

func TestGetDatabaseWithPing_ConcurrentCacheWinnerReceivesKeepAliveSettings(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	defer func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	}()
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }

	app := NewApp()
	config := connection.ConnectionConfig{
		Type:                     "postgres",
		Host:                     "db.local",
		Port:                     5432,
		User:                     "postgres",
		KeepAliveEnabled:         true,
		KeepAliveIntervalMinutes: 15,
		KeepAliveSQL:             " SELECT current_timestamp ",
	}
	key := getCacheKey(config)
	winner := &keepAliveRecordingDB{}
	created := &keepAliveRecordingDB{}
	created.connectHook = func() {
		app.mu.Lock()
		app.dbCache[key] = cachedDatabase{
			inst:     winner,
			lastPing: time.Now(),
			config:   normalizeCacheKeyConfig(config),
		}
		app.mu.Unlock()
	}
	newDatabaseFunc = func(string) (db.Database, error) { return created, nil }

	inst, err := app.getDatabaseWithPing(config, false)
	if err != nil {
		t.Fatalf("expected concurrent cache winner lookup to succeed, got %v", err)
	}
	if inst != winner {
		t.Fatal("expected the concurrent cache winner to be reused")
	}
	if created.closed != 1 {
		t.Fatalf("expected duplicate created connection to be closed once, got %d", created.closed)
	}
	entry := app.dbCache[key]
	if !entry.keepAliveEnabled || entry.keepAliveInterval != 15*time.Minute {
		t.Fatalf("expected winner keepalive policy to update, enabled=%t interval=%s", entry.keepAliveEnabled, entry.keepAliveInterval)
	}
	if entry.keepAliveSQL != "SELECT current_timestamp" || entry.keepAliveDBType != "postgres" {
		t.Fatalf("expected winner custom SQL policy to update, sql=%q dbType=%q", entry.keepAliveSQL, entry.keepAliveDBType)
	}
	if entry.lastKeepAliveAt.IsZero() {
		t.Fatal("expected winner keepalive schedule to start from the policy update")
	}
}

func TestGetDatabaseWithPing_ForegroundPingDoesNotDelayCustomKeepAliveSQL(t *testing.T) {
	originalDriverRuntimeSupportStatusFunc := driverRuntimeSupportStatusFunc
	defer func() {
		driverRuntimeSupportStatusFunc = originalDriverRuntimeSupportStatusFunc
	}()
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }

	app := NewApp()
	config := connection.ConnectionConfig{
		Type:                     "postgres",
		Host:                     "db.local",
		Port:                     5432,
		User:                     "postgres",
		KeepAliveEnabled:         true,
		KeepAliveIntervalMinutes: 15,
		KeepAliveSQL:             "SELECT 1",
	}
	key := getCacheKey(config)
	dbInst := &keepAliveRecordingDB{}
	lastKeepAliveAt := time.Now().Add(-20 * time.Minute)
	app.dbCache[key] = cachedDatabase{
		inst:              dbInst,
		lastPing:          time.Now().Add(-5 * time.Minute),
		lastKeepAliveAt:   lastKeepAliveAt,
		config:            normalizeCacheKeyConfig(config),
		keepAliveEnabled:  true,
		keepAliveInterval: 15 * time.Minute,
		keepAliveSQL:      "SELECT 1",
		keepAliveDBType:   "postgres",
	}

	if _, err := app.getDatabaseWithPing(config, false); err != nil {
		t.Fatalf("expected foreground cache health Ping to succeed, got %v", err)
	}
	entry := app.dbCache[key]
	if !entry.lastKeepAliveAt.Equal(lastKeepAliveAt) {
		t.Fatalf("expected foreground Ping not to move keepalive schedule, before=%s after=%s", lastKeepAliveAt, entry.lastKeepAliveAt)
	}

	app.runConnectionKeepAliveTick(time.Now())
	if dbInst.pings != 1 || len(dbInst.queries) != 1 {
		t.Fatalf("expected foreground Ping followed by due custom SQL, pings=%d queries=%#v", dbInst.pings, dbInst.queries)
	}
}
