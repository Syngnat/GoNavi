package app

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"
	"GoNavi-Wails/shared/i18n"
)

type sessionWorkbenchRecordingDB struct {
	db.Database

	connectCalls atomic.Int32
	closeCalls   atomic.Int32
	connected    atomic.Bool
	query        func(context.Context, string) ([]map[string]interface{}, []string, error)
	exec         func(context.Context, string) (int64, error)
	getDatabases func() ([]string, error)
	queryContext chan context.Context
	execSQL      chan string
}

func (database *sessionWorkbenchRecordingDB) Connect(connection.ConnectionConfig) error {
	database.connectCalls.Add(1)
	database.connected.Store(true)
	return nil
}

func (database *sessionWorkbenchRecordingDB) Close() error {
	database.closeCalls.Add(1)
	database.connected.Store(false)
	return nil
}

func (database *sessionWorkbenchRecordingDB) Ping() error { return nil }

// GetDatabases backs the workbench's database picker. Listing sessions reads
// the catalog from the same isolated connection, so the fake has to answer it
// instead of panicking on the embedded nil interface.
func (database *sessionWorkbenchRecordingDB) GetDatabases() ([]string, error) {
	if database.getDatabases != nil {
		return database.getDatabases()
	}
	return nil, nil
}

func (database *sessionWorkbenchRecordingDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return database.QueryContext(context.Background(), query)
}

func (database *sessionWorkbenchRecordingDB) Exec(query string) (int64, error) {
	return database.ExecContext(context.Background(), query)
}

func (database *sessionWorkbenchRecordingDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if !database.connected.Load() {
		return nil, nil, errors.New("query started before connection")
	}
	if database.queryContext != nil {
		database.queryContext <- ctx
	}
	if database.query == nil {
		return nil, nil, nil
	}
	return database.query(ctx, query)
}

func (database *sessionWorkbenchRecordingDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if !database.connected.Load() {
		return 0, errors.New("exec started before connection")
	}
	if database.execSQL != nil {
		database.execSQL <- query
	}
	if database.exec == nil {
		return 0, nil
	}
	return database.exec(ctx, query)
}

var _ db.Database = (*sessionWorkbenchRecordingDB)(nil)

func sessionWorkbenchTestApp(t *testing.T, database db.Database) *App {
	t.Helper()
	installDatabaseCacheConcurrencyTestHooks(t)
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	return newDatabaseCacheConcurrencyTestApp()
}

func sessionWorkbenchConfig(databaseType string) connection.ConnectionConfig {
	return connection.ConnectionConfig{
		Type:     databaseType,
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "workbench",
		Database: "default_db",
	}
}

func TestDBListSessionsUnsupportedDoesNotOpenConnection(t *testing.T) {
	var factoryCalls atomic.Int32
	installDatabaseCacheConcurrencyTestHooks(t)
	newDatabaseFunc = func(string) (db.Database, error) {
		factoryCalls.Add(1)
		return &sessionWorkbenchRecordingDB{}, nil
	}

	result := newDatabaseCacheConcurrencyTestApp().DBListSessions(sessionWorkbenchConfig("redis"), "0")
	if !result.Success {
		t.Fatalf("DBListSessions success = false, message = %q", result.Message)
	}
	payload, ok := result.Data.(connection.SessionListPayload)
	if !ok {
		t.Fatalf("result.Data type = %T, want connection.SessionListPayload", result.Data)
	}
	if payload.Capability.Supported || payload.Capability.ReasonCode != "not_applicable" {
		t.Fatalf("unsupported payload capability = %+v", payload.Capability)
	}
	if got := factoryCalls.Load(); got != 0 {
		t.Fatalf("unsupported listing opened %d connections", got)
	}
}

func TestDBListSessionsReturnsRowsAndClosesIsolatedConnection(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		queryContext: make(chan context.Context, 1),
		query: func(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
			if !strings.Contains(query, "pg_stat_activity") {
				t.Fatalf("session listing query = %q", query)
			}
			if _, ok := ctx.Deadline(); !ok {
				t.Fatal("session listing context has no query deadline")
			}
			return []map[string]interface{}{{
				"session_id":         int64(42),
				"database_or_tenant": "analytics",
				"user_name":          "reporter",
				"state":              "active",
				"duration_ms":        int64(1500),
				"statement":          "SELECT 1",
			}}, []string{"session_id"}, nil
		},
		getDatabases: func() ([]string, error) {
			return []string{"analytics", "shop", "  "}, nil
		},
	}
	app := sessionWorkbenchTestApp(t, database)
	config := sessionWorkbenchConfig("postgres")
	config.QueryTimeout = 5

	result := app.DBListSessions(config, "analytics")
	if !result.Success {
		t.Fatalf("DBListSessions failed: %q", result.Message)
	}
	payload, ok := result.Data.(connection.SessionListPayload)
	if !ok || len(payload.Sessions) != 1 {
		t.Fatalf("payload = %#v", result.Data)
	}
	// The listing states which database the rows were read from, because
	// PostgreSQL-lineage servers only report the connected database's sessions.
	if payload.ScopedDatabase != "analytics" {
		t.Fatalf("payload scoped database = %q, want %q", payload.ScopedDatabase, "analytics")
	}
	if got := payload.Sessions[0]; got.SessionID != "42" || got.DatabaseOrTenant != "analytics" || got.QueryID != "" {
		t.Fatalf("normalized session = %+v", got)
	}
	if got := database.connectCalls.Load(); got != 1 {
		t.Fatalf("Connect calls = %d, want 1", got)
	}
	if got := database.closeCalls.Load(); got != 1 {
		t.Fatalf("Close calls = %d, want 1", got)
	}
	select {
	case <-database.queryContext:
	default:
		t.Fatal("QueryContext was not called")
	}
}

// The database catalog is a separate call so a refresh does not pay for a
// second round trip that only the picker needs.
func TestDBListSessionDatabasesReturnsTrimmedCatalogAndClosesConnection(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		getDatabases: func() ([]string, error) {
			return []string{"analytics", " shop ", "", "   "}, nil
		},
	}
	app := sessionWorkbenchTestApp(t, database)

	result := app.DBListSessionDatabases(sessionWorkbenchConfig("postgres"), "analytics")
	if !result.Success {
		t.Fatalf("DBListSessionDatabases failed: %q", result.Message)
	}
	names, ok := result.Data.([]string)
	if !ok {
		t.Fatalf("result.Data type = %T, want []string", result.Data)
	}
	if got := strings.Join(names, ","); got != "analytics,shop" {
		t.Fatalf("catalog = %q, want %q", got, "analytics,shop")
	}
	if got := database.connectCalls.Load(); got != 1 {
		t.Fatalf("Connect calls = %d, want 1", got)
	}
	if got := database.closeCalls.Load(); got != 1 {
		t.Fatalf("Close calls = %d, want 1", got)
	}
}

// An engine without a session adapter must not open a connection just to
// answer the picker.
func TestDBListSessionDatabasesSkipsUnsupportedEngines(t *testing.T) {
	// Installs the cleanup that restores the package-level driver hooks. Without
	// it the stubbed factory leaks into every later test in this package.
	installDatabaseCacheConcurrencyTestHooks(t)
	factoryCalls := atomic.Int32{}
	newDatabaseFunc = func(string) (db.Database, error) {
		factoryCalls.Add(1)
		return &sessionWorkbenchRecordingDB{}, nil
	}

	result := newDatabaseCacheConcurrencyTestApp().
		DBListSessionDatabases(sessionWorkbenchConfig("redis"), "0")
	if !result.Success {
		t.Fatalf("DBListSessionDatabases failed: %q", result.Message)
	}
	names, ok := result.Data.([]string)
	if !ok || len(names) != 0 {
		t.Fatalf("unsupported catalog = %#v, want empty", result.Data)
	}
	if got := factoryCalls.Load(); got != 0 {
		t.Fatalf("unsupported catalog opened %d connections", got)
	}
}

func TestDBListSessionsLocalizesDriverErrorsAndFollowsLanguageSwitch(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		query: func(context.Context, string) ([]map[string]interface{}, []string, error) {
			return nil, nil, errors.New("permission denied")
		},
	}
	app := sessionWorkbenchTestApp(t, database)
	config := sessionWorkbenchConfig("postgres")

	app.SetLanguage(string(i18n.LanguageEnUS))
	english := app.DBListSessions(config, "analytics")
	expectedEnglish := app.appText("session_workbench.backend.error.list_failed", map[string]any{
		"detail": sessionWorkbenchErrorDetail(errors.New("list database sessions: permission denied")),
	})
	if english.Message != expectedEnglish {
		t.Fatalf("English error = %q, want %q", english.Message, expectedEnglish)
	}

	app.SetLanguage(string(i18n.LanguageZhCN))
	database2 := &sessionWorkbenchRecordingDB{
		query: func(context.Context, string) ([]map[string]interface{}, []string, error) {
			return nil, nil, errors.New("permission denied")
		},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database2, nil }
	chinese := app.DBListSessions(config, "analytics")
	if chinese.Message == english.Message || !strings.Contains(chinese.Message, "加载服务器会话失败") {
		t.Fatalf("language switch message = %q, English message = %q", chinese.Message, english.Message)
	}
}

func TestDBExecuteSessionActionReadOnlyAndUnsupportedDoNotOpenConnection(t *testing.T) {
	tests := []struct {
		name   string
		config connection.ConnectionConfig
		want   string
	}{
		{
			name: "read only protection",
			config: func() connection.ConnectionConfig {
				config := sessionWorkbenchConfig("postgres")
				config.ReadOnly = true
				return config
			}(),
			want: "readonly",
		},
		{name: "unsupported action", config: sessionWorkbenchConfig("clickhouse"), want: "unsupported"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			var factoryCalls atomic.Int32
			installDatabaseCacheConcurrencyTestHooks(t)
			newDatabaseFunc = func(string) (db.Database, error) {
				factoryCalls.Add(1)
				return &sessionWorkbenchRecordingDB{}, nil
			}
			app := newDatabaseCacheConcurrencyTestApp()
			action := connection.SessionActionCancelQuery
			if test.want == "unsupported" {
				action = connection.SessionActionTerminateSession
			}
			result := app.DBExecuteSessionAction(test.config, "analytics", connection.SessionActionRequest{
				Action:    action,
				SessionID: "42",
				QueryID:   "query-42",
			})
			if result.Success {
				t.Fatalf("expected failure, got %#v", result)
			}
			if got := factoryCalls.Load(); got != 0 {
				t.Fatalf("blocked action opened %d connections", got)
			}
			if test.want == "readonly" {
				if !strings.Contains(result.Message, "not allowed") && !strings.Contains(result.Message, "不允许") {
					t.Fatalf("read-only message = %q", result.Message)
				}
			} else if !strings.Contains(result.Message, "not supported") && !strings.Contains(result.Message, "不受支持") {
				t.Fatalf("unsupported action message = %q", result.Message)
			}
		})
	}
}

func TestDBExecuteSessionActionRunsServerCommandAndClosesConnection(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		execSQL: make(chan string, 1),
		exec: func(ctx context.Context, query string) (int64, error) {
			if err := ctx.Err(); err != nil {
				return 0, err
			}
			if query != "KILL CONNECTION 42" {
				return 0, errors.New("unexpected session action SQL")
			}
			return 0, nil
		},
	}
	app := sessionWorkbenchTestApp(t, database)
	result := app.DBExecuteSessionAction(sessionWorkbenchConfig("mysql"), "analytics", connection.SessionActionRequest{
		Action:    connection.SessionActionTerminateSession,
		SessionID: "42",
		QueryID:   "query-42",
	})
	if !result.Success {
		t.Fatalf("DBExecuteSessionAction failed: %q", result.Message)
	}
	if got := database.closeCalls.Load(); got != 1 {
		t.Fatalf("Close calls = %d, want 1", got)
	}
	select {
	case query := <-database.execSQL:
		if query != "KILL CONNECTION 42" {
			t.Fatalf("executed SQL = %q", query)
		}
	case <-time.After(time.Second):
		t.Fatal("ExecContext was not called")
	}
}

func TestDBExecuteSessionActionRecordsFixedSessionWorkbenchAuditSource(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		exec: func(_ context.Context, query string) (int64, error) {
			if query != "KILL CONNECTION 42" {
				return 0, errors.New("unexpected session action SQL")
			}
			return 0, nil
		},
	}
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)

	result := app.DBExecuteSessionAction(sessionWorkbenchConfig("mysql"), "analytics", connection.SessionActionRequest{
		Action:    connection.SessionActionTerminateSession,
		SessionID: "42",
	})
	if !result.Success {
		t.Fatalf("DBExecuteSessionAction failed: %q", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "session_workbench"})
	if len(events) != 1 {
		t.Fatalf("session workbench audit events = %#v, want one event", events)
	}
	if events[0].Source != "session_workbench" || events[0].Status != "success" {
		t.Fatalf("unexpected session workbench audit event: %#v", events[0])
	}
}

func TestDBExecuteSessionActionExplainsServerRejection(t *testing.T) {
	database := &sessionWorkbenchRecordingDB{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			if !strings.Contains(query, "pg_terminate_backend(42)") {
				return nil, nil, errors.New("unexpected session action SQL")
			}
			// The server answered, but reported that nothing was terminated.
			return []map[string]interface{}{{"action_succeeded": false}}, nil, nil
		},
	}
	app := sessionWorkbenchTestApp(t, database)
	result := app.DBExecuteSessionAction(sessionWorkbenchConfig("postgres"), "analytics", connection.SessionActionRequest{
		Action:    connection.SessionActionTerminateSession,
		SessionID: "42",
	})
	if result.Success {
		t.Fatal("a rejected server action must not report success")
	}
	if strings.Contains(result.Message, "database server rejected") {
		t.Fatalf("message leaks the raw driver error: %q", result.Message)
	}
	if !strings.Contains(result.Message, "已经结束") && !strings.Contains(result.Message, "already ended") {
		t.Fatalf("message does not explain the likely cause: %q", result.Message)
	}
	if got := database.closeCalls.Load(); got != 1 {
		t.Fatalf("Close calls = %d, want 1", got)
	}
}
