package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/sqlaudit"
	datasync "GoNavi-Wails/internal/sync"
)

func TestSQLSnippet_RedactsSensitiveSQL(t *testing.T) {
	query := "SELECT * FROM users WHERE phone = '13800138000' AND token = 'raw-token' AND id = 42"
	snippet := sqlSnippet(query)
	if strings.Contains(snippet, "13800138000") || strings.Contains(snippet, "raw-token") || strings.Contains(snippet, "42") {
		t.Fatalf("SQL log snippet leaked raw literal: %q", snippet)
	}
	if !strings.Contains(snippet, "SELECT") || !strings.Contains(snippet, "FROM users") {
		t.Fatalf("SQL log snippet lost diagnostic structure: %q", snippet)
	}
}

func TestDBQueryAuditedWritesOneUserActionEventWithoutSlowQueryHistory(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	query := "UPDATE users SET display_name = 'private-name' WHERE id = 7"
	database := &fakeBatchWriteDB{
		execAffected: map[string]int64{query: 2},
		execDelay:    map[string]time.Duration{query: time.Duration(queryHistorySlowThresholdMs)*time.Millisecond + 25*time.Millisecond},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}

	result := app.DBQueryAudited(config, "app", query, "table_designer")
	if !result.Success {
		t.Fatalf("DBQueryAudited returned failure: %s", result.Message)
	}
	if !strings.HasPrefix(result.QueryID, "query-") {
		t.Fatalf("query ID = %q, want generated query ID", result.QueryID)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: result.QueryID})
	if len(events) != 1 {
		t.Fatalf("audit event count = %d, want 1: %#v", len(events), events)
	}
	event := events[0]
	if event.QueryID != result.QueryID || event.Source != "table_designer" || event.Status != "success" || event.RowsAffected != 2 {
		t.Fatalf("unexpected application audit event: %#v", event)
	}
	if strings.Contains(event.SQLText, "private-name") || strings.Contains(event.SQLText, " 7") || !event.SQLRedacted {
		t.Fatalf("application audit SQL was not redacted: %#v", event)
	}

	history := app.GetSlowQueries(config, "app", "recent", 10)
	if !history.Success {
		t.Fatalf("GetSlowQueries returned failure: %s", history.Message)
	}
	records, ok := history.Data.([]connection.QueryExecutionRecord)
	if !ok {
		t.Fatalf("GetSlowQueries data type = %T, want []connection.QueryExecutionRecord", history.Data)
	}
	if len(records) != 0 {
		t.Fatalf("DBQueryAudited must not write slow query history: %#v", records)
	}
}

func TestDBQueryAuditedRecordsProtectionDenial(t *testing.T) {
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app", ReadOnly: true}
	query := "DELETE FROM users WHERE email = 'private@example.test'"

	result := app.DBQueryAudited(config, "app", query, "object_editor")
	if result.Success || strings.TrimSpace(result.Message) == "" {
		t.Fatalf("protected action result = %#v, want rejected error", result)
	}
	if !strings.HasPrefix(result.QueryID, "query-") {
		t.Fatalf("query ID = %q, want generated query ID", result.QueryID)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: result.QueryID})
	if len(events) != 1 {
		t.Fatalf("audit event count = %d, want 1: %#v", len(events), events)
	}
	event := events[0]
	if event.Status != "error" || event.Source != "object_editor" || strings.TrimSpace(event.Error) == "" {
		t.Fatalf("protection denial was not fully audited: %#v", event)
	}
	if strings.Contains(event.SQLText, "private@example.test") || !event.SQLRedacted {
		t.Fatalf("denied audit SQL was not redacted: %#v", event)
	}
}

func TestDirectDBQueryCannotBypassWriteAuditWithEmptyQueryID(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	writeSQL := "DELETE FROM users WHERE id = 7"
	readSQL := "SELECT id FROM users"
	database := &fakeBatchWriteDB{
		execAffected: map[string]int64{writeSQL: 1},
		queryMap:     map[string][]map[string]interface{}{readSQL: {{"id": 7}}},
		fieldMap:     map[string][]string{readSQL: {"id"}},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"}

	if result := app.DBQuery(config, "app", writeSQL); !result.Success {
		t.Fatalf("direct DBQuery write returned failure: %s", result.Message)
	}
	if result := app.DBQuery(config, "app", readSQL); !result.Success {
		t.Fatalf("direct DBQuery metadata read returned failure: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 || events[0].Source != "application_api" || events[0].RowsAffected != 1 {
		t.Fatalf("direct write was not uniquely audited: %#v", events)
	}
}

func TestDirectDBQueryCannotBypassWriteAuditWhenBatchStartsWithRead(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	query := "SELECT 1; UPDATE users SET enabled = false WHERE id = 7"
	database := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{query: {{"value": 1}}},
		fieldMap: map[string][]string{query: {"value"}},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"}

	result := app.DBQuery(config, "app", query)
	if !result.Success {
		t.Fatalf("direct mixed batch returned failure: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 || events[0].Source != "application_api" {
		t.Fatalf("read-first write batch bypassed audit: %#v", events)
	}
}

func TestDirectDBQueryCannotBypassAuditWithNestedWriteSyntax(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})
	verifyDriverAgentRevisionFunc = func(connection.ConnectionConfig) error { return nil }
	explainWrite := "EXPLAIN ANALYZE UPDATE users SET enabled = false WHERE id = 7"
	pragmaWrite := "PRAGMA user_version = 7"
	mongoWrite := `{"aggregate":"users","pipeline":[{"$merge":{"into":"users_archive"}}],"cursor":{}}`
	database := &fakeBatchWriteDB{
		queryMap:     map[string][]map[string]interface{}{explainWrite: {{"plan": "ok"}}},
		fieldMap:     map[string][]string{explainWrite: {"plan"}},
		execAffected: map[string]int64{pragmaWrite: 0, mongoWrite: 1},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)

	for _, testCase := range []struct {
		dbType string
		query  string
	}{
		{dbType: "postgres", query: explainWrite},
		{dbType: "sqlite", query: pragmaWrite},
		{dbType: "mongodb", query: mongoWrite},
	} {
		config := connection.ConnectionConfig{Type: testCase.dbType, Host: "127.0.0.1", Database: "app"}
		if result := app.DBQuery(config, "app", testCase.query); !result.Success {
			t.Fatalf("direct %s nested write returned failure: %s", testCase.dbType, result.Message)
		}
	}

	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 3 {
		t.Fatalf("nested write syntax bypassed audit: %#v", events)
	}
	for _, event := range events {
		if event.Source != "application_api" {
			t.Fatalf("unexpected nested write audit source: %#v", event)
		}
	}
}

func TestWebRuntimeAuditsGenericReadQueriesWithoutTrustingSQLClassification(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	query := "SELECT mutating_function(7)"
	database := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{query: {{"result": 1}}},
		fieldMap: map[string][]string{query: {"result"}},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	app.webRuntime = true
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}

	result := app.DBQuery(config, "app", query)
	if !result.Success {
		t.Fatalf("web generic read returned failure: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 || events[0].Source != "application_api" {
		t.Fatalf("web generic query was not audit-all: %#v", events)
	}
}

func TestObjectDDLHelperRecordsProtectionDenial(t *testing.T) {
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app", ReadOnly: true}

	result := app.DropTable(config, "app", "private_orders")
	if result.Success {
		t.Fatalf("DropTable on protected connection returned success: %#v", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "object_editor"})
	if len(events) != 1 || events[0].Status != "error" || events[0].Source != "object_editor" {
		t.Fatalf("protected object DDL was not audited: %#v", events)
	}
	if !strings.Contains(events[0].SQLText, "DROP TABLE") {
		t.Fatalf("object DDL audit lost operation structure: %#v", events[0])
	}
}

func TestApplyChangesRecordsMetadataWithoutRowValues(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	fakeDB := &fakeCreateDatabaseDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"}

	result := app.ApplyChanges(config, "app", "users", connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"id": 7},
			Values: map[string]interface{}{"email": "private@example.test"},
		}},
	})
	if !result.Success {
		t.Fatalf("ApplyChanges returned failure: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "data_editor"})
	if len(events) != 1 || events[0].Status != "success" || events[0].Source != "data_editor" {
		t.Fatalf("data editor action was not audited: %#v", events)
	}
	if strings.Contains(events[0].SQLText, "private@example.test") || strings.Contains(events[0].SQLText, " 7") {
		t.Fatalf("data editor audit leaked row values: %#v", events[0])
	}
}

func TestBackendWriteWorkflowsRecordFixedAuditSources(t *testing.T) {
	protectedConfig := connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "app",
		ReadOnly: true,
	}

	t.Run("sql_file", func(t *testing.T) {
		originalNewDatabaseFunc := newDatabaseFunc
		t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
		newDatabaseFunc = func(string) (db.Database, error) { return &fakeSQLFileBatchDB{}, nil }
		app := newSQLAuditTestApp(t)
		filePath := filepath.Join(t.TempDir(), "private-job.sql")
		if err := os.WriteFile(filePath, []byte("INSERT INTO users(email) VALUES ('private@example.test');"), 0o600); err != nil {
			t.Fatalf("write SQL file fixture: %v", err)
		}
		config := protectedConfig
		config.ReadOnly = false
		result := app.ExecuteSQLFile(config, "app", filePath, "sql-file-audit-test")
		if !result.Success {
			t.Fatalf("SQL file execution returned failure: %#v", result)
		}
		events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "sql_file"})
		if len(events) != 1 || events[0].Source != "sql_file" || events[0].Status != "success" {
			t.Fatalf("SQL file execution was not audited with its fixed source: %#v", events)
		}
		if strings.Contains(events[0].SQLText, "private@example.test") || strings.Contains(events[0].SQLText, "private-job.sql") {
			t.Fatalf("SQL file audit leaked file contents or path: %#v", events[0])
		}
		if !strings.Contains(events[0].SQLText, "SHA256_") || !strings.Contains(events[0].SQLText, "EXECUTED_1") || events[0].StatementCount != 1 {
			t.Fatalf("SQL file audit lacks a safe content identity or execution counts: %#v", events[0])
		}
	})

	t.Run("sql_file_failure_redaction", func(t *testing.T) {
		originalNewDatabaseFunc := newDatabaseFunc
		t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
		newDatabaseFunc = func(string) (db.Database, error) {
			return &fakeSQLFileBatchDB{failExecSQL: "CALL broken_proc"}, nil
		}
		app := newSQLAuditTestApp(t)
		filePath := filepath.Join(t.TempDir(), "private-failure.sql")
		if err := os.WriteFile(filePath, []byte("CALL broken_proc('private-secret', 777);"), 0o600); err != nil {
			t.Fatalf("write failing SQL file fixture: %v", err)
		}
		config := protectedConfig
		config.ReadOnly = false
		result := app.ExecuteSQLFile(config, "app", filePath, "sql-file-failure-audit-test")
		if result.Success {
			t.Fatalf("failing SQL file execution returned success: %#v", result)
		}
		events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "sql_file"})
		if len(events) != 1 || events[0].Status != "error" {
			t.Fatalf("failing SQL file execution was not audited: %#v", events)
		}
		redactedPayload := events[0].SQLText + "\n" + events[0].Error
		for _, secret := range []string{"private-secret", "777", "private-failure.sql", "broken_proc"} {
			if strings.Contains(redactedPayload, secret) {
				t.Fatalf("failing SQL file audit payload leaked %q: %q", secret, redactedPayload)
			}
		}
	})

	t.Run("data_import", func(t *testing.T) {
		app := newSQLAuditTestApp(t)
		result := app.ImportDataWithProgress(protectedConfig, "app", "users", "private.csv")
		if result.Success {
			t.Fatalf("protected import returned success: %#v", result)
		}
		events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "data_import"})
		if len(events) != 1 || events[0].Source != "data_import" || events[0].Status != "error" {
			t.Fatalf("data import attempt was not audited with its fixed source: %#v", events)
		}
		if strings.Contains(events[0].SQLText, "private.csv") {
			t.Fatalf("data import audit leaked the local file path: %#v", events[0])
		}
		if !strings.Contains(strings.ToLower(events[0].SQLText), "users") {
			t.Fatalf("data import audit lost the safe target table: %#v", events[0])
		}
	})

	t.Run("sync", func(t *testing.T) {
		app := newSQLAuditTestApp(t)
		result := app.DataSync(datasync.SyncConfig{
			TargetConfig:   protectedConfig,
			TargetDatabase: "app",
			Tables:         []string{"users"},
			Content:        "data",
		})
		if result.Success {
			t.Fatalf("protected data sync returned success: %#v", result)
		}
		events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Source: "sync"})
		if len(events) != 1 || events[0].Source != "sync" || events[0].Status != "error" {
			t.Fatalf("data sync attempt was not audited with its fixed source: %#v", events)
		}
		if events[0].StatementCount != 1 || !strings.Contains(events[0].SQLText, "TABLES_1") {
			t.Fatalf("data sync audit lacks its safe task summary: %#v", events[0])
		}
	})
}

func TestAIEntryPointAndMCPExecutorRecordAuditSources(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &sqlAuditTestDatabase{
		rows:     []map[string]interface{}{{"id": 7}},
		columns:  []string{"id"},
		affected: 1,
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}

	aiResult := app.DBQueryAI(config, "app", "SELECT id FROM users WHERE email = 'private@example.test'")
	if !aiResult.Success {
		t.Fatalf("DBQueryAI returned failure: %s", aiResult.Message)
	}
	mcpResult := NewMCPQueryExecutor(app).DBQueryMulti(config, "app", "SELECT id FROM users")
	if !mcpResult.Success {
		t.Fatalf("MCPQueryExecutor returned failure: %s", mcpResult.Message)
	}
	cliResult := NewCLIQueryExecutor(app).DBQueryMulti(context.Background(), config, "app", "SELECT id FROM users", "cli-audit-source")
	if !cliResult.Success {
		t.Fatalf("CLIQueryExecutor returned failure: %s", cliResult.Message)
	}
	spoofedResult := app.DBQueryAudited(config, "app", "UPDATE users SET email = 'private@example.test' WHERE id = 7", "mcp")
	if !spoofedResult.Success {
		t.Fatalf("DBQueryAudited returned failure: %s", spoofedResult.Message)
	}

	aiEvents := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: aiResult.QueryID})
	if len(aiEvents) != 1 || aiEvents[0].Source != "ai_action" {
		t.Fatalf("AI query did not retain its entry-point source: %#v", aiEvents)
	}
	if strings.Contains(aiEvents[0].SQLText, "private@example.test") {
		t.Fatalf("AI query audit leaked a literal: %#v", aiEvents[0])
	}
	mcpEvents := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: mcpResult.QueryID})
	if len(mcpEvents) != 1 || mcpEvents[0].Source != "mcp" {
		t.Fatalf("MCP query did not retain its backend-owned source: %#v", mcpEvents)
	}
	cliEvents := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: cliResult.QueryID})
	if len(cliEvents) != 1 || cliEvents[0].Source != "cli" {
		t.Fatalf("CLI query did not retain its backend-owned source: %#v", cliEvents)
	}
	spoofedEvents := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: spoofedResult.QueryID})
	if len(spoofedEvents) != 1 || spoofedEvents[0].Source != "application_api" {
		t.Fatalf("public audited query was able to spoof a privileged source: %#v", spoofedEvents)
	}
}

type mcpContextCancellationDatabase struct {
	sqlAuditTestDatabase
	started chan struct{}
}

func (database *mcpContextCancellationDatabase) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	close(database.started)
	<-ctx.Done()
	return nil, nil, ctx.Err()
}

func TestMCPQueryExecutorCancelsUnderlyingQueryWithRequestContext(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &mcpContextCancellationDatabase{started: make(chan struct{})}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	application := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}
	requestCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- NewMCPQueryExecutor(application).DBQueryMultiContext(requestCtx, config, "app", "SELECT 1")
	}()
	select {
	case <-database.started:
	case <-time.After(2 * time.Second):
		t.Fatal("MCP query did not reach the context-aware database")
	}
	cancel()

	select {
	case result := <-resultCh:
		if result.Success {
			t.Fatalf("cancelled MCP query unexpectedly succeeded: %#v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled MCP query did not return")
	}
}
