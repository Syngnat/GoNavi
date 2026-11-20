package app

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/scriptengine"
	"GoNavi-Wails/internal/scriptlib"
	"GoNavi-Wails/internal/sqlaudit"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/internal/webidentity"
)

type scriptWorkbenchMemorySecretStore struct {
	mu    sync.Mutex
	items map[string][]byte
}

func newScriptWorkbenchMemorySecretStore() *scriptWorkbenchMemorySecretStore {
	return &scriptWorkbenchMemorySecretStore{items: make(map[string][]byte)}
}

func (s *scriptWorkbenchMemorySecretStore) Put(ref string, payload []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items[ref] = append([]byte(nil), payload...)
	return nil
}

func (s *scriptWorkbenchMemorySecretStore) Get(ref string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	payload, ok := s.items[ref]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), payload...), nil
}

func (s *scriptWorkbenchMemorySecretStore) Delete(ref string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.items, ref)
	return nil
}

func (s *scriptWorkbenchMemorySecretStore) HealthCheck() error {
	return nil
}

type scriptWorkbenchNoopEmitter struct{}

func (scriptWorkbenchNoopEmitter) Emit(string, ...any) {}

func newScriptWorkbenchTestApp(t *testing.T, web bool) *App {
	t.Helper()
	var application *App
	if web {
		application = NewWebApp()
	} else {
		application = NewAppWithSecretStore(newScriptWorkbenchMemorySecretStore())
	}
	application.configDir = t.TempDir()
	application.ctx = uievents.WithEmitter(context.Background(), scriptWorkbenchNoopEmitter{})
	return application
}

func saveScriptWorkbenchConnection(
	t *testing.T,
	application *App,
	config connection.ConnectionConfig,
) connection.SavedConnectionView {
	t.Helper()
	view, err := application.SaveConnection(connection.SavedConnectionInput{
		Name:   "script-test-" + config.Type,
		Config: config,
	})
	if err != nil {
		t.Fatalf("save connection: %v", err)
	}
	return view
}

func scriptWorkbenchActorForTest(
	t *testing.T,
	application *App,
	ctx context.Context,
) (scriptlib.Actor, webScriptActor) {
	t.Helper()
	actor, webActor, err := application.scriptWorkbenchActor(ctx)
	if err != nil {
		t.Fatalf("script actor: %v", err)
	}
	return actor, webActor
}

func prepareScriptWorkbenchHostForTest(
	t *testing.T,
	application *App,
	connectionID string,
	allowWrite bool,
) (*scriptWorkbenchHost, context.CancelFunc) {
	t.Helper()
	ctx := context.Background()
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	prepared, err := application.prepareScriptWorkbenchRun(ctx, ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		Title:      "test",
		AllowWrite: allowWrite,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: connectionID,
			Database:     "main",
		}},
	}, actor, webActor)
	if err != nil {
		t.Fatalf("prepare run: %v", err)
	}
	runCtx, cancel := context.WithCancel(context.Background())
	run := &scriptWorkbenchRun{
		id:       "script-run-test",
		owner:    actor.Owner,
		status:   scriptWorkbenchStatusRunning,
		ctx:      runCtx,
		cancel:   cancel,
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, prepared)
	t.Cleanup(func() {
		host.Close()
		cancel()
	})
	return host, cancel
}

func installScriptWorkbenchDatabase(t *testing.T, database db.Database) {
	t.Helper()
	previous := newDatabaseFunc
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	t.Cleanup(func() { newDatabaseFunc = previous })
}

type scriptWorkbenchQueryDB struct {
	fakeBatchWriteDB
	mu           sync.Mutex
	lastExecCtx  context.Context
	queryArgsSQL []string
	queryArgs    [][]any
	execArgsSQL  []string
	execArgs     [][]any
	rows         []map[string]any
	columns      []string
	block        bool
	queryStarted chan struct{}
	queryCalls   int
	execCalls    int
}

func (f *scriptWorkbenchQueryDB) QueryContextWithArgs(
	ctx context.Context,
	query string,
	args []any,
) ([]map[string]any, []string, error) {
	f.mu.Lock()
	f.queryCalls++
	f.queryArgsSQL = append(f.queryArgsSQL, query)
	f.queryArgs = append(f.queryArgs, append([]any(nil), args...))
	block := f.block
	started := f.queryStarted
	f.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if block {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	rows := f.rows
	if rows == nil {
		rows = []map[string]any{{"id": 1}, {"id": 2}, {"id": 3}}
	}
	columns := f.columns
	if columns == nil {
		columns = []string{"id"}
	}
	return rows, columns, nil
}

func (f *scriptWorkbenchQueryDB) ExecContext(ctx context.Context, query string) (int64, error) {
	f.mu.Lock()
	f.lastExecCtx = ctx
	f.mu.Unlock()
	return f.fakeBatchWriteDB.ExecContext(ctx, query)
}

func (f *scriptWorkbenchQueryDB) ExecContextWithArgs(
	ctx context.Context,
	_ string,
	_ []any,
) (int64, error) {
	f.mu.Lock()
	f.lastExecCtx = ctx
	f.execCalls++
	f.mu.Unlock()
	return 1, nil
}

func TestScriptLibraryActorIsolationAndViewerReadOnly(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	adminCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	viewerCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleViewer,
	})

	privateResult := application.saveScriptLibraryScriptContext(adminCtx, scriptlib.SaveScriptInput{
		Name:       "alice private",
		Code:       "gonavi.log('private')",
		Visibility: scriptlib.VisibilityPrivate,
	})
	if !privateResult.Success {
		t.Fatalf("save private script: %s", privateResult.Message)
	}
	sharedResult := application.saveScriptLibraryScriptContext(adminCtx, scriptlib.SaveScriptInput{
		Name:       "shared inventory",
		Code:       "gonavi.log('shared')",
		Visibility: scriptlib.VisibilityShared,
	})
	if !sharedResult.Success {
		t.Fatalf("save shared script: %s", sharedResult.Message)
	}

	viewerSnapshot := application.getScriptLibrarySnapshotContext(viewerCtx)
	if !viewerSnapshot.Success {
		t.Fatalf("viewer snapshot: %s", viewerSnapshot.Message)
	}
	snapshot := viewerSnapshot.Data.(ScriptWorkbenchLibrarySnapshot)
	if len(snapshot.Scripts) != 1 || snapshot.Scripts[0].Name != "shared inventory" {
		t.Fatalf("viewer scripts = %+v", snapshot.Scripts)
	}
	if viewerSave := application.saveScriptLibraryScriptContext(viewerCtx, scriptlib.SaveScriptInput{
		Name: "viewer attempt",
		Code: "1",
	}); viewerSave.Success {
		t.Fatal("viewer must not save scripts")
	}

	actor, webActor := scriptWorkbenchActorForTest(t, application, viewerCtx)
	prepared, err := application.prepareScriptWorkbenchRun(viewerCtx, ScriptWorkbenchRunRequest{
		Script:     "1 + 1",
		AllowWrite: true,
	}, actor, webActor)
	if err != nil {
		t.Fatalf("prepare viewer run: %v", err)
	}
	if prepared.allowWrite {
		t.Fatal("viewer write mode must be forced off")
	}
}

func TestScriptWorkbenchActorNamespacesDesktopAndWebOwners(t *testing.T) {
	desktopApp := newScriptWorkbenchTestApp(t, false)
	desktopActor, _, err := desktopApp.scriptWorkbenchActor(context.Background())
	if err != nil {
		t.Fatalf("desktop actor = %v", err)
	}
	if desktopActor.Owner != scriptlib.DesktopOwner() {
		t.Fatalf("desktop owner = %q", desktopActor.Owner)
	}

	webApp := newScriptWorkbenchTestApp(t, true)
	webCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "local",
		Role:     webidentity.RoleAdmin,
	})
	webActor, _, err := webApp.scriptWorkbenchActor(webCtx)
	if err != nil {
		t.Fatalf("web actor = %v", err)
	}
	if webActor.Owner != scriptlib.WebOwner("local") {
		t.Fatalf("web owner = %q, want %q", webActor.Owner, scriptlib.WebOwner("local"))
	}
	if webActor.Owner == scriptlib.DesktopOwner() {
		t.Fatal("web local owner must not collide with desktop owner")
	}
}

func TestScriptWorkbenchHostRejectsInvalidOutputPayload(t *testing.T) {
	application := NewApp()
	err := application.handleScriptWorkbenchEvent(&scriptWorkbenchRun{}, scriptengine.Event{
		Type:    "output",
		Payload: json.RawMessage(`{"name":"bad","rows":[1,2]}`),
	})
	if err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatalf("invalid output payload error = %v", err)
	}
}

func TestScriptWorkbenchCapsRunTitle(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	actor, webActor, err := application.scriptWorkbenchActor(context.Background())
	if err != nil {
		t.Fatalf("actor = %v", err)
	}
	prepared, err := application.prepareScriptWorkbenchRun(context.Background(), ScriptWorkbenchRunRequest{
		Script: "1",
		Title:  strings.Repeat("x", scriptengine.MaxTitleBytes+1),
	}, actor, webActor)
	if err != nil {
		t.Fatalf("prepare = %v", err)
	}
	if len(prepared.title) > scriptengine.MaxTitleBytes {
		t.Fatalf("title bytes = %d", len(prepared.title))
	}
}

func TestScriptLibraryFolderVisibilitySwitch(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	adminCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "alice",
		Role:     webidentity.RoleAdmin,
	})
	viewerCtx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "bob",
		Role:     webidentity.RoleViewer,
	})
	created := application.saveScriptLibraryFolderContext(adminCtx, scriptlib.SaveFolderInput{
		Name:       "private-folder",
		Visibility: scriptlib.VisibilityPrivate,
	})
	if !created.Success {
		t.Fatalf("save folder: %s", created.Message)
	}
	folder := created.Data.(scriptlib.Folder)
	shared := application.setScriptLibraryFolderVisibilityContext(adminCtx, scriptlib.ShareInput{
		ID:         folder.ID,
		Revision:   folder.Revision,
		Visibility: scriptlib.VisibilityShared,
	})
	if !shared.Success {
		t.Fatalf("share folder: %s", shared.Message)
	}
	snapshot := application.getScriptLibrarySnapshotContext(viewerCtx)
	if !snapshot.Success {
		t.Fatalf("viewer folder snapshot: %s", snapshot.Message)
	}
	data := snapshot.Data.(ScriptWorkbenchLibrarySnapshot)
	if len(data.Folders) != 1 || data.Folders[0].ID != folder.ID {
		t.Fatalf("viewer folders = %+v", data.Folders)
	}
}

func TestScriptWorkbenchConnectionACLAndWriteProtection(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username:             "bob",
		Role:                 webidentity.RoleAdmin,
		AllowedConnectionIDs: []string{"another-connection"},
	})
	actor, webActor := scriptWorkbenchActorForTest(t, application, ctx)
	_, err := application.prepareScriptWorkbenchRun(ctx, ScriptWorkbenchRunRequest{
		Script: "1",
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: saved.ID,
		}},
	}, actor, webActor)
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("ACL error = %v", err)
	}

	protected := newScriptWorkbenchTestApp(t, false)
	protectedConnection := saveScriptWorkbenchConnection(t, protected, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
		Protection: connection.ConnectionProtectionConfig{
			RestrictScriptExecution: true,
		},
	})
	desktopActor, desktopWebActor := scriptWorkbenchActorForTest(t, protected, context.Background())
	_, err = protected.prepareScriptWorkbenchRun(context.Background(), ScriptWorkbenchRunRequest{
		Script:     "1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: protectedConnection.ID,
		}},
	}, desktopActor, desktopWebActor)
	if err == nil || !strings.Contains(err.Error(), "script execution is restricted") {
		t.Fatalf("write protection error = %v", err)
	}

	readOnlyApp := newScriptWorkbenchTestApp(t, false)
	readOnlyConnection := saveScriptWorkbenchConnection(t, readOnlyApp, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
		ReadOnly: true,
	})
	readOnlyActor, readOnlyWebActor := scriptWorkbenchActorForTest(t, readOnlyApp, context.Background())
	prepared, err := readOnlyApp.prepareScriptWorkbenchRun(context.Background(), ScriptWorkbenchRunRequest{
		Script:     "1",
		AllowWrite: true,
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: readOnlyConnection.ID,
		}},
	}, readOnlyActor, readOnlyWebActor)
	if err != nil {
		t.Fatalf("read-only connection must not reject the whole allowWrite run: %v", err)
	}
	host := &scriptWorkbenchHost{prepared: prepared}
	if err := host.ensureWriteAllowed(prepared.connections["prod"], "UPDATE users SET active = 1"); err == nil {
		t.Fatal("write to a read-only alias must be rejected at execution time")
	}
}

func TestScriptWorkbenchOracleDoesNotTreatServiceNameAsSchema(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "oracle",
		Host:     "127.0.0.1",
		Port:     1521,
		User:     "tester",
		Database: "ORCLPDB1",
	})
	actor, webActor := scriptWorkbenchActorForTest(t, application, context.Background())
	prepared, err := application.prepareScriptWorkbenchRun(context.Background(), ScriptWorkbenchRunRequest{
		Script: "1",
		Connections: []ScriptWorkbenchConnection{{
			Alias:        "prod",
			ConnectionID: saved.ID,
		}},
	}, actor, webActor)
	if err != nil {
		t.Fatalf("prepare Oracle run: %v", err)
	}
	if got := prepared.connections["prod"].database; got != "" {
		t.Fatalf("Oracle default schema = %q, want empty instead of service name", got)
	}
}

func TestScriptWorkbenchHostRejectsMultipleStatements(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, false)
	_, _, _, _, err := host.prepareConnectionStatement(scriptWorkbenchDBRequest{
		Alias: "prod",
		SQL:   "SELECT 1; SELECT 2",
	})
	if err == nil || !strings.Contains(err.Error(), "exactly one SQL statement") {
		t.Fatalf("single-statement error = %v", err)
	}
}

func TestScriptWorkbenchHostRejectsExplicitTransactionControl(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)
	for _, sql := range []string{
		"BEGIN",
		"COMMIT",
		"ROLLBACK",
		"SET autocommit = 1",
		"SAVEPOINT script_manual",
	} {
		t.Run(sql, func(t *testing.T) {
			_, _, _, _, err := host.prepareConnectionStatement(scriptWorkbenchDBRequest{
				Alias: "prod",
				SQL:   sql,
			})
			if err == nil || !strings.Contains(err.Error(), "transaction control") {
				t.Fatalf("transaction control error = %v", err)
			}
		})
	}
}

func TestScriptWorkbenchArrayParametersAndRowBudget(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &scriptWorkbenchQueryDB{
		rows:    []map[string]any{{"id": 1}, {"id": 2}, {"id": 3}},
		columns: []string{"id"},
	}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, false)

	bindings, err := scriptWorkbenchBindings(map[string]any{
		"ids": []any{"1", "2"},
	}, 10)
	if err != nil {
		t.Fatalf("bindings: %v", err)
	}
	if len(bindings) != 1 || bindings[0].Type != "list" {
		t.Fatalf("bindings = %+v", bindings)
	}
	if _, err := scriptWorkbenchBindings(map[string]any{
		"ids": []any{"1", "2", "3"},
	}, 2); err == nil {
		t.Fatal("list parameter limit must be enforced")
	}

	params, _ := json.Marshal(map[string]any{
		"alias":   "prod",
		"sql":     "SELECT id FROM users WHERE id IN (:ids)",
		"params":  map[string]any{"ids": []any{"1", "2"}},
		"maxRows": 1,
	})
	value, err := host.Handle(context.Background(), scriptengineHostRequestForTest("db.query", params))
	if err != nil {
		t.Fatalf("db.query: %v", err)
	}
	result := value.(scriptengineHostQueryResult)
	if result.RowCount != 1 || !result.Truncated {
		t.Fatalf("query result = %+v", result)
	}
	database.mu.Lock()
	defer database.mu.Unlock()
	if len(database.queryArgsSQL) != 1 {
		t.Fatalf("query count = %d", len(database.queryArgsSQL))
	}
	if strings.Contains(database.queryArgsSQL[0], ":ids") ||
		!strings.Contains(database.queryArgsSQL[0], "$1") ||
		!strings.Contains(database.queryArgsSQL[0], "$2") {
		t.Fatalf("parameterized SQL = %q", database.queryArgsSQL[0])
	}
	if len(database.queryArgs[0]) != 2 ||
		database.queryArgs[0][0] != "1" ||
		database.queryArgs[0][1] != "2" {
		t.Fatalf("bound args = %#v", database.queryArgs[0])
	}
}

func TestScriptWorkbenchCancelPropagatesToDatabaseQuery(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &scriptWorkbenchQueryDB{
		block:        true,
		queryStarted: make(chan struct{}, 1),
	}
	installScriptWorkbenchDatabase(t, database)
	host, cancel := prepareScriptWorkbenchHostForTest(t, application, saved.ID, false)
	params, _ := json.Marshal(map[string]any{
		"alias":  "prod",
		"sql":    "SELECT id FROM slow_table WHERE id = :id",
		"params": map[string]any{"id": 1},
	})
	done := make(chan error, 1)
	go func() {
		_, err := host.Handle(host.ctx, scriptengineHostRequestForTest("db.query", params))
		done <- err
	}()
	select {
	case <-database.queryStarted:
	case err := <-done:
		database.mu.Lock()
		queryCalls, execCalls := database.queryCalls, database.execCalls
		database.mu.Unlock()
		t.Fatalf("query returned before start: %v queryCalls=%d execCalls=%d", err, queryCalls, execCalls)
	case <-time.After(2 * time.Second):
		t.Fatal("query did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled query must return an error")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancelled query did not return")
	}
}

type scriptWorkbenchTransactionDB struct {
	fakeBatchWriteDB
	session *scriptWorkbenchTransactionSession
}

func (f *scriptWorkbenchTransactionDB) OpenTransactionExecer(
	context.Context,
) (db.TransactionExecer, error) {
	f.session = &scriptWorkbenchTransactionSession{parent: f}
	return f.session, nil
}

type scriptWorkbenchTransactionSession struct {
	parent        *scriptWorkbenchTransactionDB
	lastCtx       context.Context
	commitCalls   int
	rollbackCalls int
	closed        bool
	execArgs      [][]any
}

func (s *scriptWorkbenchTransactionSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *scriptWorkbenchTransactionSession) ExecContext(ctx context.Context, _ string) (int64, error) {
	s.lastCtx = ctx
	return 1, nil
}

func (s *scriptWorkbenchTransactionSession) Close() error {
	s.closed = true
	return nil
}

func (s *scriptWorkbenchTransactionSession) Commit() error {
	s.commitCalls++
	return nil
}

func (s *scriptWorkbenchTransactionSession) Rollback() error {
	s.rollbackCalls++
	return nil
}

func (s *scriptWorkbenchTransactionSession) QueryContextWithArgs(
	context.Context,
	string,
	[]any,
) ([]map[string]any, []string, error) {
	return []map[string]any{{"id": 1}}, []string{"id"}, nil
}

func (s *scriptWorkbenchTransactionSession) ExecContextWithArgs(
	ctx context.Context,
	_ string,
	args []any,
) (int64, error) {
	s.lastCtx = ctx
	s.execArgs = append(s.execArgs, append([]any(nil), args...))
	return 1, nil
}

func TestScriptWorkbenchManagedTransactionReusesExistingAPIs(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &scriptWorkbenchTransactionDB{}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	beginValue, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.begin",
		mustScriptWorkbenchJSON(t, map[string]any{"alias": "prod"}),
	))
	if err != nil {
		t.Fatalf("tx.begin: %v", err)
	}
	transactionID := beginValue.(map[string]any)["transactionId"].(string)
	queryParams := mustScriptWorkbenchJSON(t, map[string]any{
		"transactionId": transactionID,
		"sql":           "SELECT id FROM users WHERE id = :id",
		"params":        map[string]any{"id": 1},
	})
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest("tx.query", queryParams)); err == nil {
		t.Fatal("tx.query before the first write must fail")
	}

	executeParams := mustScriptWorkbenchJSON(t, map[string]any{
		"transactionId": transactionID,
		"sql":           "UPDATE users SET active = :active WHERE id IN (:ids)",
		"params": map[string]any{
			"active": true,
			"ids":    []any{1, 2},
		},
	})
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest("tx.execute", executeParams)); err != nil {
		t.Fatalf("tx.execute: %v", err)
	}
	if database.session == nil || len(database.session.execArgs) != 1 {
		t.Fatalf("transaction session did not receive arguments: %+v", database.session)
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.commit",
		mustScriptWorkbenchJSON(t, map[string]any{"transactionId": transactionID}),
	)); err != nil {
		t.Fatalf("tx.commit: %v", err)
	}
	if database.session.commitCalls != 1 {
		t.Fatalf("commit calls = %d", database.session.commitCalls)
	}
}

func TestScriptWorkbenchTransactionAuditUsesScriptSource(t *testing.T) {
	application := newSQLAuditTestApp(t)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &scriptWorkbenchTransactionDB{}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	beginValue, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.begin",
		mustScriptWorkbenchJSON(t, map[string]any{"alias": "prod"}),
	))
	if err != nil {
		t.Fatalf("tx.begin: %v", err)
	}
	publicTransactionID := beginValue.(map[string]any)["transactionId"].(string)
	executeParams := mustScriptWorkbenchJSON(t, map[string]any{
		"transactionId": publicTransactionID,
		"sql":           "UPDATE users SET active = :active WHERE id IN (:ids)",
		"params": map[string]any{
			"active": true,
			"ids":    []any{1, 2},
		},
	})
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest("tx.execute", executeParams)); err != nil {
		t.Fatalf("tx.execute: %v", err)
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.commit",
		mustScriptWorkbenchJSON(t, map[string]any{"transactionId": publicTransactionID}),
	)); err != nil {
		t.Fatalf("tx.commit: %v", err)
	}

	events := loadSQLAuditEvents(t, application, sqlaudit.Filter{Source: "script"})
	if len(events) == 0 {
		t.Fatal("script transaction produced no SQL audit events")
	}
	seen := make(map[string]bool, len(events))
	for _, event := range events {
		if event.Source != "script" {
			t.Fatalf("audit source = %q, want script", event.Source)
		}
		seen[event.EventType] = true
	}
	for _, eventType := range []string{
		"transaction_begin",
		"transaction_statement",
		"transaction_commit_requested",
		"transaction_commit",
	} {
		if !seen[eventType] {
			t.Fatalf("missing audit event %q; events=%+v", eventType, events)
		}
	}
	if other := loadSQLAuditEvents(t, application, sqlaudit.Filter{Source: "query_editor"}); len(other) != 0 {
		t.Fatalf("script transaction leaked query_editor audit events: %+v", other)
	}
}

func TestScriptWorkbenchActorUsesAdminOnlyForSharedManagement(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, true)
	adminActor, _ := scriptWorkbenchActorForTest(t, application, webidentity.WithActor(
		context.Background(),
		webidentity.Actor{Username: "alice", Role: webidentity.RoleAdmin},
	))
	if !adminActor.CanManageShared || adminActor.ReadOnly {
		t.Fatalf("admin actor = %+v", adminActor)
	}
	viewerActor, _ := scriptWorkbenchActorForTest(t, application, webidentity.WithActor(
		context.Background(),
		webidentity.Actor{Username: "bob", Role: webidentity.RoleViewer},
	))
	if viewerActor.CanManageShared || !viewerActor.ReadOnly {
		t.Fatalf("viewer actor = %+v", viewerActor)
	}
}

func TestScriptWorkbenchWriteGateRequiresExplicitModeAndEditPermissions(t *testing.T) {
	config := connection.ConnectionConfig{
		Type: "postgres",
		Protection: connection.ConnectionProtectionConfig{
			RestrictDataEdit: true,
		},
	}
	host := &scriptWorkbenchHost{
		prepared: &scriptWorkbenchPrepared{allowWrite: true},
	}
	prepared := scriptPreparedConnection{
		config: config,
		dbType: "postgres",
	}
	if err := host.ensureWriteAllowed(prepared, "UPDATE users SET active = 1"); err == nil {
		t.Fatal("data edit protection must block script writes")
	}
	host.prepared.allowWrite = false
	if err := host.ensureWriteAllowed(scriptPreparedConnection{
		config: connection.ConnectionConfig{Type: "postgres"},
		dbType: "postgres",
	}, "UPDATE users SET active = 1"); err == nil {
		t.Fatal("read-only script mode must block writes")
	}
}

func TestScriptWorkbenchOutputStoresRemainBounded(t *testing.T) {
	run := &scriptWorkbenchRun{}
	rows := make([]map[string]any, scriptWorkbenchDefaultOutputRows+10)
	for index := range rows {
		rows[index] = map[string]any{"id": index}
	}
	run.appendOutput("large", rows)
	run.mu.RLock()
	if run.outputRows <= 0 || run.outputRows > scriptWorkbenchDefaultOutputRows {
		run.mu.RUnlock()
		t.Fatalf("stored rows = %d", run.outputRows)
	}
	if len(run.outputs) != 1 || !run.outputs[0].truncated {
		run.mu.RUnlock()
		t.Fatalf("outputs = %+v", run.outputs)
	}
	run.mu.RUnlock()
	for index := 0; index < scriptWorkbenchMaxLogs+20; index++ {
		run.appendLog("info", "bounded log")
	}
	run.mu.RLock()
	defer run.mu.RUnlock()
	if len(run.logs) > scriptWorkbenchMaxLogs || run.logBytes > scriptWorkbenchMaxLogBytes {
		t.Fatalf("logs = %d bytes=%d", len(run.logs), run.logBytes)
	}
	if !run.logsTruncated {
		t.Fatal("log cap must mark the retained window as truncated")
	}
}

func TestSelectScriptInputFileIsSafeInWebAndBeforeStartup(t *testing.T) {
	webApp := NewWebApp()
	if result := webApp.SelectScriptInputFile(""); result.Success ||
		!strings.Contains(result.Message, "upload") {
		t.Fatalf("web selection result = %+v", result)
	}
	desktop := NewAppWithSecretStore(newScriptWorkbenchMemorySecretStore())
	desktop.ctx = nil
	if result := desktop.SelectScriptInputFile(""); result.Success {
		t.Fatalf("nil-context selection result = %+v", result)
	}
}

func scriptengineHostRequestForTest(method string, params json.RawMessage) (request scriptengine.HostRequest) {
	request.Method = method
	request.Params = params
	return request
}

func mustScriptWorkbenchJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}
