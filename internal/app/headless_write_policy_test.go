package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"
)

func saveHeadlessSafetyLevel(t *testing.T, runtime *HeadlessRuntime, level ai.SQLPermissionLevel) {
	t.Helper()
	store := aiservice.NewProviderConfigStore(runtime.app.configDir, nil)
	if err := store.Save(aiservice.ProviderConfigStoreSnapshot{
		Providers:    []ai.ProviderConfig{},
		SafetyLevel:  level,
		ContextLevel: ai.ContextSchemaOnly,
	}); err != nil {
		t.Fatalf("save AI safety level: %v", err)
	}
}

func installHeadlessTestDatabase(t *testing.T, database db.Database) {
	t.Helper()
	previousNewDatabase := newDatabaseFunc
	previousDriverSupport := driverRuntimeSupportStatusFunc
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	t.Cleanup(func() {
		newDatabaseFunc = previousNewDatabase
		driverRuntimeSupportStatusFunc = previousDriverSupport
	})
}

func TestHeadlessQueryUsesSharedAISafetyAndConnectionProtections(t *testing.T) {
	tests := []struct {
		name       string
		level      ai.SQLPermissionLevel
		config     connection.ConnectionConfig
		sql        string
		allow      bool
		wantOK     bool
		wantReason string
	}{
		{name: "readonly blocks DML despite acknowledgement", level: ai.PermissionReadOnly, sql: "UPDATE demo SET value = 1", allow: true, wantReason: "AI safety"},
		{name: "readwrite allows DML with acknowledgement", level: ai.PermissionReadWrite, sql: "UPDATE demo SET value = 1", allow: true, wantOK: true},
		{name: "readwrite blocks DDL", level: ai.PermissionReadWrite, sql: "CREATE TABLE demo(id INT)", allow: true, wantReason: "AI safety"},
		{name: "full still requires acknowledgement", level: ai.PermissionFull, sql: "DELETE FROM demo", wantReason: "allow-write"},
		{name: "data protection blocks DML", level: ai.PermissionFull, config: connection.ConnectionConfig{Protection: connection.ConnectionProtectionConfig{RestrictDataEdit: true}}, sql: "UPDATE demo SET value = 1", allow: true, wantReason: "not allowed"},
		{name: "structure protection blocks DDL", level: ai.PermissionFull, config: connection.ConnectionConfig{Protection: connection.ConnectionProtectionConfig{RestrictStructureEdit: true}}, sql: "CREATE TABLE demo(id INT)", allow: true, wantReason: "not allowed"},
		{name: "script protection blocks DML", level: ai.PermissionFull, config: connection.ConnectionConfig{Protection: connection.ConnectionProtectionConfig{RestrictScriptExecution: true}}, sql: "UPDATE demo SET value = 1", allow: true, wantReason: "not allowed"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
			if err != nil {
				t.Fatalf("NewHeadlessRuntime: %v", err)
			}
			defer runtime.Close()
			saveHeadlessSafetyLevel(t, runtime, test.level)
			database := &headlessSecretCaptureDB{sqlAuditTestDatabase: sqlAuditTestDatabase{
				rows:     []map[string]interface{}{{"ok": 1}},
				columns:  []string{"ok"},
				affected: 1,
			}}
			installHeadlessTestDatabase(t, database)
			test.config.Type = "postgres"
			result := runtime.Query(context.Background(), test.config, "app", test.sql, HeadlessQueryOptions{AllowMutating: test.allow})
			if result.Success != test.wantOK {
				t.Fatalf("Query success = %t, want %t; message=%s", result.Success, test.wantOK, result.Message)
			}
			if test.wantReason != "" && !containsFold(result.Message, test.wantReason) {
				t.Fatalf("Query message %q does not contain %q", result.Message, test.wantReason)
			}
			if !test.wantOK {
				data, _ := result.Data.(map[string]any)
				if data["errorKind"] != headlessResultErrorKindPolicy {
					t.Fatalf("policy result metadata = %#v", result.Data)
				}
			}
			if !test.wantOK && database.connected {
				t.Fatal("policy-denied query opened a database connection")
			}
		})
	}
}

func TestMCPAuthorizedExecutionRechecksLatestConnectionProtection(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime: %v", err)
	}
	defer runtime.Close()
	saveHeadlessSafetyLevel(t, runtime, ai.PermissionFull)

	initial, err := runtime.SaveConnection(connection.SavedConnectionInput{
		ID:   "mcp-toctou",
		Name: "MCP TOCTOU",
		Config: connection.ConnectionConfig{
			ID:   "mcp-toctou",
			Type: "postgres",
			Host: "127.0.0.1",
			Port: 5432,
		},
	})
	if err != nil {
		t.Fatalf("save initial connection: %v", err)
	}
	if _, err := runtime.SaveConnection(connection.SavedConnectionInput{
		ID:   "mcp-toctou",
		Name: "MCP TOCTOU",
		Config: connection.ConnectionConfig{
			ID:       "mcp-toctou",
			Type:     "postgres",
			Host:     "127.0.0.1",
			Port:     5432,
			ReadOnly: true,
		},
	}); err != nil {
		t.Fatalf("tighten connection protection: %v", err)
	}

	database := &headlessSecretCaptureDB{sqlAuditTestDatabase: sqlAuditTestDatabase{
		rows:    []map[string]interface{}{{"ok": 1}},
		columns: []string{"ok"},
	}}
	installHeadlessTestDatabase(t, database)
	stale := initial.Config
	stale.ID = initial.ID
	result := NewMCPQueryExecutor(runtime.app).DBQueryMultiAuthorizedContext(
		context.Background(), stale, "app", "UPDATE demo SET value = 1", true,
	)
	if result.Success {
		t.Fatalf("MCP execution bypassed latest read-only protection: %#v", result)
	}
	if !containsFold(result.Message, "not allowed") {
		t.Fatalf("unexpected stale-protection denial: %q", result.Message)
	}
	if database.connected {
		t.Fatal("MCP policy denial opened a database connection")
	}
}

func TestHeadlessSingleTransactionPreflightsBeforeOpeningDatabase(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime: %v", err)
	}
	defer runtime.Close()
	saveHeadlessSafetyLevel(t, runtime, ai.PermissionFull)
	filePath := t.TempDir() + "/migration.sql"
	if err := os.WriteFile(filePath, []byte("INSERT INTO demo(id) VALUES (1);\nCREATE TABLE later(id INT);\n"), 0o600); err != nil {
		t.Fatalf("write SQL file: %v", err)
	}
	database := &fakeBatchWriteDB{}
	connected := false
	previousNewDatabase := newDatabaseFunc
	previousDriverSupport := driverRuntimeSupportStatusFunc
	newDatabaseFunc = func(string) (db.Database, error) {
		connected = true
		return database, nil
	}
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	t.Cleanup(func() {
		newDatabaseFunc = previousNewDatabase
		driverRuntimeSupportStatusFunc = previousDriverSupport
	})

	result := runtime.ExecuteSQLFile(context.Background(), connection.ConnectionConfig{Type: "postgres"}, "app", filePath, HeadlessSQLFileOptions{AllowMutating: true})
	if result.Success || !containsFold(result.Message, "atomicity") {
		t.Fatalf("single preflight result = %#v, want atomicity rejection", result)
	}
	data, _ := result.Data.(map[string]any)
	if data["errorKind"] != headlessResultErrorKindPolicy {
		t.Fatalf("single preflight policy metadata = %#v", result.Data)
	}
	if connected {
		t.Fatal("single preflight opened the database before rejecting the second statement")
	}
}

func TestHeadlessOffModePreflightsSafetyBeforeOpeningDatabase(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime: %v", err)
	}
	defer runtime.Close()
	saveHeadlessSafetyLevel(t, runtime, ai.PermissionReadWrite)
	filePath := t.TempDir() + "/migration.sql"
	if err := os.WriteFile(filePath, []byte("INSERT INTO demo(id) VALUES (1);\nCREATE TABLE later(id INT);\n"), 0o600); err != nil {
		t.Fatalf("write SQL file: %v", err)
	}
	connected := false
	previousNewDatabase := newDatabaseFunc
	previousDriverSupport := driverRuntimeSupportStatusFunc
	newDatabaseFunc = func(string) (db.Database, error) {
		connected = true
		return &fakeBatchWriteDB{}, nil
	}
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }
	t.Cleanup(func() {
		newDatabaseFunc = previousNewDatabase
		driverRuntimeSupportStatusFunc = previousDriverSupport
	})

	result := runtime.ExecuteSQLFile(context.Background(), connection.ConnectionConfig{Type: "postgres"}, "app", filePath, HeadlessSQLFileOptions{
		AllowMutating:   true,
		TransactionMode: HeadlessSQLTransactionModeOff,
	})
	if result.Success || !containsFold(result.Message, "AI safety") {
		t.Fatalf("off-mode preflight result = %#v, want safety rejection", result)
	}
	if connected {
		t.Fatal("off-mode safety preflight opened the database")
	}
}

func TestHeadlessExportRejectsWriteCTEBeforeOpeningDatabase(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime: %v", err)
	}
	defer runtime.Close()
	database := &headlessSecretCaptureDB{}
	installHeadlessTestDatabase(t, database)
	outputPath := t.TempDir() + "/export.json"
	result := runtime.ExportQueryToPath(
		context.Background(),
		connection.ConnectionConfig{Type: "postgres"},
		"app",
		"WITH moved AS (DELETE FROM demo RETURNING id) SELECT id FROM moved",
		outputPath,
		ExportFileOptions{Format: "json"},
		false,
	)
	if result.Success {
		t.Fatalf("write CTE export unexpectedly succeeded: %#v", result)
	}
	if database.connected {
		t.Fatal("write CTE export opened the database")
	}
	if _, err := os.Stat(outputPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("write CTE export created a target file: %v", err)
	}
}

func TestHeadlessSQLFileRetainsCLIAuditSource(t *testing.T) {
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: t.TempDir()})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime: %v", err)
	}
	defer runtime.Close()
	saveHeadlessSafetyLevel(t, runtime, ai.PermissionReadWrite)
	filePath := t.TempDir() + "/migration.sql"
	if err := os.WriteFile(filePath, []byte("INSERT INTO demo(id) VALUES (1);\n"), 0o600); err != nil {
		t.Fatalf("write SQL file: %v", err)
	}
	database := &headlessTransactionTestDB{}
	installHeadlessTestDatabase(t, database)

	result := runtime.ExecuteSQLFile(context.Background(), connection.ConnectionConfig{Type: "postgres"}, "app", filePath, HeadlessSQLFileOptions{AllowMutating: true})
	if !result.Success {
		t.Fatalf("ExecuteSQLFile: %#v", result)
	}
	events := loadSQLAuditEvents(t, runtime.app, sqlaudit.Filter{Source: "cli"})
	if len(events) != 1 || events[0].Source != "cli" || events[0].StatementCount != 1 {
		t.Fatalf("headless SQL-file audit = %#v, want one cli event", events)
	}
}

func TestExecuteSQLFileSingleTransactionUsesOneTransactionAndReportsUnknownOutcomes(t *testing.T) {
	t.Run("uses one pinned textual transaction", func(t *testing.T) {
		database := &fakeSQLFileBatchDB{}
		result, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);\nUPDATE demo SET id = 2;"), sqlFileExecutionOptions{
			DBType:          "postgres",
			TransactionMode: sqlFileTransactionModeSingle,
		}, nil)
		if err != nil || result.Executed != 2 || result.Failed != 0 {
			t.Fatalf("textual single transaction result = %#v, err=%v", result, err)
		}
		wantQueries := []string{"BEGIN", "INSERT INTO demo(id) VALUES (1)", "UPDATE demo SET id = 2", "COMMIT"}
		if database.session == nil || !database.session.closed || database.batchCalls != 0 || strings.Join(database.execQueries, "|") != strings.Join(wantQueries, "|") {
			t.Fatalf("unexpected pinned transaction execution: queries=%#v session=%#v batchCalls=%d", database.execQueries, database.session, database.batchCalls)
		}
	})

	t.Run("commits once", func(t *testing.T) {
		database := &headlessTransactionTestDB{}
		result, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);\nUPDATE demo SET id = 2;"), sqlFileExecutionOptions{
			DBType:          "postgres",
			TransactionMode: sqlFileTransactionModeSingle,
		}, nil)
		if err != nil || result.Executed != 2 || result.Failed != 0 {
			t.Fatalf("single transaction result = %#v, err=%v", result, err)
		}
		if database.tx == nil || database.tx.commitCalls != 1 || database.tx.rollbackCalls != 0 {
			t.Fatalf("unexpected transaction lifecycle: %#v", database.tx)
		}
	})

	t.Run("commit failure is unknown", func(t *testing.T) {
		database := &headlessTransactionTestDB{commitErr: errors.New("commit response lost")}
		result, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
			DBType:          "postgres",
			TransactionMode: sqlFileTransactionModeSingle,
		}, nil)
		if err == nil || !result.OutcomeUnknown {
			t.Fatalf("commit failure result = %#v, err=%v; want unknown", result, err)
		}
		if database.tx == nil || database.tx.commitCalls != 1 || database.tx.rollbackCalls != 1 {
			t.Fatalf("commit failure cleanup = %#v", database.tx)
		}
	})

	t.Run("rollback failure is unknown", func(t *testing.T) {
		database := &headlessTransactionTestDB{
			rollbackErr: errors.New("rollback response lost"),
			fakeBatchWriteDB: fakeBatchWriteDB{execErr: map[string]error{
				"INSERT INTO demo(id) VALUES (1)": errors.New("statement failed"),
			}},
		}
		result, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
			DBType:          "postgres",
			TransactionMode: sqlFileTransactionModeSingle,
		}, nil)
		if err == nil || !result.OutcomeUnknown {
			t.Fatalf("rollback failure result = %#v, err=%v; want unknown", result, err)
		}
	})

	t.Run("statement response loss is unknown", func(t *testing.T) {
		database := &headlessTransactionTestDB{fakeBatchWriteDB: fakeBatchWriteDB{execErr: map[string]error{
			"INSERT INTO demo(id) VALUES (1)": db.MarkWriteOutcomeUnknown(errors.New("statement response lost")),
		}}}
		result, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
			DBType:          "postgres",
			TransactionMode: sqlFileTransactionModeSingle,
		}, nil)
		if err == nil || !result.OutcomeUnknown {
			t.Fatalf("statement unknown result = %#v, err=%v; want unknown", result, err)
		}
	})

	t.Run("in-flight cancellation is unknown", func(t *testing.T) {
		started := make(chan string, 1)
		database := &headlessTransactionTestDB{fakeBatchWriteDB: fakeBatchWriteDB{
			execStarted: started,
			execRelease: make(chan struct{}),
		}}
		ctx, cancel := context.WithCancel(context.Background())
		type executionResult struct {
			result sqlFileExecutionResult
			err    error
		}
		done := make(chan executionResult, 1)
		go func() {
			result, err := executeSQLFileStream(ctx, database, stringsReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
				DBType:          "postgres",
				TransactionMode: sqlFileTransactionModeSingle,
			}, nil)
			done <- executionResult{result: result, err: err}
		}()
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("statement did not start")
		}
		cancel()
		select {
		case execution := <-done:
			if !errors.Is(execution.err, context.Canceled) || !execution.result.OutcomeUnknown {
				t.Fatalf("cancel result = %#v, err=%v; want unknown cancellation", execution.result, execution.err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("cancelled statement did not return")
		}
	})
}

func TestHeadlessSQLFileTransactionModeRejectsContinueOnErrorExceptOff(t *testing.T) {
	database := &fakeBatchWriteDB{}
	if _, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
		DBType:          "postgres",
		TransactionMode: sqlFileTransactionModeSingle,
		ContinueOnError: true,
	}, nil); err == nil {
		t.Fatal("single transaction unexpectedly accepted continue-on-error")
	}
	result, err := executeSQLFileStream(context.Background(), database, stringsReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
		DBType:          "postgres",
		TransactionMode: sqlFileTransactionModeOff,
		ContinueOnError: true,
	}, nil)
	if err != nil || result.Executed != 1 {
		t.Fatalf("off transaction mode result = %#v, err=%v", result, err)
	}
}

func TestSingleTransactionPolicyRejectsUnprovableStatements(t *testing.T) {
	tests := []struct {
		name    string
		stmt    string
		wantErr bool
	}{
		{name: "query", stmt: "SELECT 1"},
		{name: "DML", stmt: "UPDATE demo SET value = 1"},
		{name: "explicit begin", stmt: "BEGIN TRANSACTION", wantErr: true},
		{name: "transaction setting", stmt: "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE", wantErr: true},
		{name: "DDL", stmt: "CREATE TABLE demo(id INT)", wantErr: true},
		{name: "unknown side effect", stmt: "CALL refresh_demo()", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateSQLFileSingleTransactionStatement("postgres", test.stmt)
			if (err != nil) != test.wantErr {
				t.Fatalf("validate error = %v, wantErr=%t", err, test.wantErr)
			}
		})
	}
	if err := validateSQLFileSingleTransactionStatement("mysql", "INSERT INTO demo(id) VALUES (1)"); err == nil {
		t.Fatal("MySQL single transaction unexpectedly claimed proven atomicity")
	}
}

func TestSQLImportOptionsHashSeparatesTransactionModes(t *testing.T) {
	off := buildSQLImportOptionsHashWithTransactionMode(false, DefaultSQLImportMaxStatementBytes, sqlFileTransactionModeOff)
	single := buildSQLImportOptionsHashWithTransactionMode(false, DefaultSQLImportMaxStatementBytes, sqlFileTransactionModeSingle)
	if off == single {
		t.Fatal("single and off transaction modes share a managed-job options hash")
	}
}

type headlessTransactionTestDB struct {
	fakeBatchWriteDB
	tx          *headlessTransactionTestSession
	commitErr   error
	rollbackErr error
}

func (database *headlessTransactionTestDB) OpenTransactionExecer(context.Context) (db.TransactionExecer, error) {
	database.tx = &headlessTransactionTestSession{
		fakeBatchWriteSession: fakeBatchWriteSession{parent: &database.fakeBatchWriteDB},
		commitErr:             database.commitErr,
		rollbackErr:           database.rollbackErr,
	}
	return database.tx, nil
}

type headlessTransactionTestSession struct {
	fakeBatchWriteSession
	commitCalls   int
	rollbackCalls int
	commitErr     error
	rollbackErr   error
}

func (session *headlessTransactionTestSession) Commit() error {
	session.commitCalls++
	return session.commitErr
}

func (session *headlessTransactionTestSession) Rollback() error {
	session.rollbackCalls++
	return session.rollbackErr
}

func containsFold(value, want string) bool {
	return strings.Contains(strings.ToLower(value), strings.ToLower(want))
}

func stringsReader(value string) *strings.Reader {
	return strings.NewReader(value)
}
