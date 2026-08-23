package app

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/sqlaudit"
)

type sqlAuditTestDatabase struct {
	rows      []map[string]interface{}
	columns   []string
	queryErr  error
	affected  int64
	connected bool
}

func (database *sqlAuditTestDatabase) Connect(connection.ConnectionConfig) error {
	database.connected = true
	return nil
}
func (database *sqlAuditTestDatabase) Close() error { return nil }
func (database *sqlAuditTestDatabase) Ping() error  { return nil }
func (database *sqlAuditTestDatabase) Query(string) ([]map[string]interface{}, []string, error) {
	return database.rows, database.columns, database.queryErr
}
func (database *sqlAuditTestDatabase) Exec(string) (int64, error) {
	return database.affected, database.queryErr
}
func (database *sqlAuditTestDatabase) GetDatabases() ([]string, error) { return nil, nil }
func (database *sqlAuditTestDatabase) GetTables(string) ([]string, error) {
	return nil, nil
}
func (database *sqlAuditTestDatabase) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (database *sqlAuditTestDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (database *sqlAuditTestDatabase) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (database *sqlAuditTestDatabase) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (database *sqlAuditTestDatabase) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (database *sqlAuditTestDatabase) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func newSQLAuditTestApp(t *testing.T) *App {
	t.Helper()
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	app.activateSQLAudit()
	t.Cleanup(func() { app.closeSQLAuditStore() })
	return app
}

func loadSQLAuditEvents(t *testing.T, app *App, filter sqlaudit.Filter) []sqlaudit.Event {
	t.Helper()
	filter.PageSize = 500
	result := app.GetSQLAuditEvents(filter)
	if !result.Success {
		t.Fatalf("GetSQLAuditEvents returned failure: %s", result.Message)
	}
	page, ok := result.Data.(sqlaudit.Page)
	if !ok {
		t.Fatalf("GetSQLAuditEvents data type = %T, want sqlaudit.Page", result.Data)
	}
	sort.Slice(page.Items, func(left, right int) bool {
		return page.Items[left].Sequence < page.Items[right].Sequence
	})
	return page.Items
}

func TestSQLAuditStatusFromResultUsesStructuredCancellationMarker(t *testing.T) {
	result := connection.QueryResult{
		Success: false,
		Message: "导入已停止",
		Data:    map[string]interface{}{"cancelled": true},
	}
	if got := sqlAuditStatusFromResult(result); got != "cancelled" {
		t.Fatalf("status = %q, want cancelled", got)
	}
}

func TestSQLAuditConnectionFingerprintExcludesSecrets(t *testing.T) {
	base := connection.ConnectionConfig{
		Type:          "postgres",
		Host:          "db.internal",
		Port:          5432,
		User:          "alice",
		Password:      "primary-secret",
		Database:      "app",
		DSN:           "postgres://alice:dsn-secret@db.internal/app",
		URI:           "postgres://alice:uri-secret@db.internal/app",
		UseSSH:        true,
		SSH:           connection.SSHConfig{Host: "jump.internal", User: "ops", Password: "ssh-secret"},
		UseProxy:      true,
		Proxy:         connection.ProxyConfig{Host: "proxy.internal", User: "proxy", Password: "proxy-secret"},
		UseHTTPTunnel: true,
		HTTPTunnel:    connection.HTTPTunnelConfig{Host: "tunnel.internal", User: "tunnel", Password: "tunnel-secret"},
	}
	changedSecrets := base
	changedSecrets.User = "bob"
	changedSecrets.Password = "changed-primary"
	changedSecrets.DSN = "postgres://bob:changed-dsn@db.internal/app"
	changedSecrets.URI = "postgres://bob:changed-uri@db.internal/app"
	changedSecrets.SSH.Password = "changed-ssh"
	changedSecrets.Proxy.Password = "changed-proxy"
	changedSecrets.HTTPTunnel.Password = "changed-tunnel"

	baseFingerprint := buildSQLAuditConnectionFingerprint(base, "app")
	if got := buildSQLAuditConnectionFingerprint(changedSecrets, "app"); got != baseFingerprint {
		t.Fatalf("secret-only changes altered audit fingerprint: base=%s changed=%s", baseFingerprint, got)
	}
	changedEndpoint := base
	changedEndpoint.Host = "other.internal"
	if got := buildSQLAuditConnectionFingerprint(changedEndpoint, "app"); got == baseFingerprint {
		t.Fatal("endpoint change should alter audit fingerprint")
	}
	saved := base
	saved.ID = "connection-1"
	savedFingerprint := buildSQLAuditConnectionFingerprint(saved, "app")
	savedChangedEndpoint := saved
	savedChangedEndpoint.Host = "moved.internal"
	if got := buildSQLAuditConnectionFingerprint(savedChangedEndpoint, "app"); got != savedFingerprint {
		t.Fatal("saved connection endpoint edit should retain its audit fingerprint")
	}
	if got := buildSQLAuditConnectionFingerprint(saved, "analytics"); got == savedFingerprint {
		t.Fatal("logical database change should alter a saved connection audit fingerprint")
	}
	dsnOnly := connection.ConnectionConfig{Type: "custom", Driver: "postgres", DSN: "host=opaque-a port=5432 user=alice password=first dbname=app"}
	dsnSecretChanged := dsnOnly
	dsnSecretChanged.DSN = "host=opaque-a port=5432 user=bob password=second dbname=app"
	if got, want := buildSQLAuditConnectionFingerprint(dsnSecretChanged, "app"), buildSQLAuditConnectionFingerprint(dsnOnly, "app"); got != want {
		t.Fatal("DSN credential change should not alter temporary connection fingerprint")
	}
	dsnEndpointChanged := dsnOnly
	dsnEndpointChanged.DSN = "host=opaque-b port=5432 user=alice password=first dbname=app"
	if got, want := buildSQLAuditConnectionFingerprint(dsnEndpointChanged, "app"), buildSQLAuditConnectionFingerprint(dsnOnly, "app"); got == want {
		t.Fatal("safe DSN endpoint change should alter temporary connection fingerprint")
	}
	uriOnly := connection.ConnectionConfig{Type: "postgres", URI: "postgres://alice:first@db.internal/app?pass=first&key=first"}
	uriSecretsChanged := uriOnly
	uriSecretsChanged.URI = "postgres://bob:second@db.internal/app?pass=second&key=second&custom_secret=third"
	if got, want := buildSQLAuditConnectionFingerprint(uriSecretsChanged, "app"), buildSQLAuditConnectionFingerprint(uriOnly, "app"); got != want {
		t.Fatal("URI credentials and query parameters must not alter temporary connection fingerprint")
	}
	uriEndpointChanged := uriOnly
	uriEndpointChanged.URI = "postgres://alice:first@other.internal/app?pass=first"
	if got, want := buildSQLAuditConnectionFingerprint(uriEndpointChanged, "app"), buildSQLAuditConnectionFingerprint(uriOnly, "app"); got == want {
		t.Fatal("URI authority change should alter temporary connection fingerprint")
	}
}

func TestDBQueryWithCancelWritesRedactedSQLAudit(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &sqlAuditTestDatabase{
		rows:    []map[string]interface{}{{"id": int64(7)}},
		columns: []string{"id"},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, Database: "app"}

	result := app.DBQueryWithCancel(config, "app", "SELECT * FROM users WHERE email = 'secret@example.test' AND id = 7", "query-audit-1")
	if !result.Success {
		t.Fatalf("DBQueryWithCancel returned failure: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-audit-1"})
	if len(events) != 1 {
		t.Fatalf("audit event count = %d, want 1: %#v", len(events), events)
	}
	event := events[0]
	if event.EventType != "query" || event.Status != "success" || event.RowsReturned != 1 {
		t.Fatalf("unexpected query audit event: %#v", event)
	}
	if strings.Contains(event.SQLText, "secret@example.test") || strings.Contains(event.SQLText, " 7") {
		t.Fatalf("audit SQL leaked literals: %q", event.SQLText)
	}
	if !event.SQLRedacted || event.ConnectionFingerprint == "" {
		t.Fatalf("expected redacted event with connection identity: %#v", event)
	}
}

func TestManagedSQLTransactionWritesCompleteAuditTimeline(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	firstStatement := "UPDATE users SET name = 'private-name' WHERE id = 1"
	secondStatement := "DELETE FROM audit_logs WHERE user_id = 1"
	database := &fakeBatchWriteDB{execAffected: map[string]int64{
		firstStatement:  1,
		secondStatement: 3,
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	started := app.DBQueryMultiTransactional(config, "main", firstStatement+";\n"+secondStatement+";", "query-tx-audit")
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("DBQueryMultiTransactional returned %#v", started)
	}
	committed := app.DBCommitTransactionWithTrigger(started.TransactionID, "auto")
	if !committed.Success {
		t.Fatalf("DBCommitTransactionWithTrigger returned failure: %s", committed.Message)
	}

	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{TransactionID: started.TransactionID})
	if len(events) != 5 {
		t.Fatalf("transaction audit event count = %d, want 5: %#v", len(events), events)
	}
	wantTypes := []string{"transaction_begin", "transaction_statement", "transaction_statement", "transaction_commit_requested", "transaction_commit"}
	for index, wantType := range wantTypes {
		if events[index].EventType != wantType || events[index].Status != "success" {
			t.Fatalf("event %d = %#v, want type=%s success", index, events[index], wantType)
		}
	}
	if events[1].StatementIndex != 1 || events[1].StatementCount != 2 || events[1].RowsAffected != 1 {
		t.Fatalf("unexpected first statement audit metrics: %#v", events[1])
	}
	if events[2].StatementIndex != 2 || events[2].RowsAffected != 3 {
		t.Fatalf("unexpected second statement audit metrics: %#v", events[2])
	}
	if strings.Contains(events[1].SQLText, "private-name") {
		t.Fatalf("transaction audit leaked SQL literal: %q", events[1].SQLText)
	}
	if events[3].CommitMode != "auto" || events[3].BoundaryMode != "text_sql" {
		t.Fatalf("commit request audit lost trigger/boundary metadata: %#v", events[3])
	}
	if events[4].CommitMode != "auto" || events[4].BoundaryMode != "text_sql" {
		t.Fatalf("commit audit lost trigger/boundary metadata: %#v", events[4])
	}
}

func TestManagedSQLTransactionFailureAuditsStatementAndAutomaticRollback(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	firstStatement := "UPDATE users SET active = 1 WHERE id = 1"
	secondStatement := "DELETE FROM missing_table WHERE id = 1"
	database := &fakeBatchWriteDB{
		execAffected: map[string]int64{firstStatement: 1},
		execErr:      map[string]error{secondStatement: errors.New("table 'private_table_name' does not exist")},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	result := app.DBQueryMultiTransactional(config, "main", firstStatement+";\n"+secondStatement+";", "query-tx-failed")
	if result.Success {
		t.Fatalf("expected transaction failure, got %#v", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-tx-failed"})
	if len(events) != 5 {
		t.Fatalf("failed transaction audit event count = %d, want 5: %#v", len(events), events)
	}
	if events[2].EventType != "transaction_statement" || events[2].Status != "error" {
		t.Fatalf("failed statement was not audited: %#v", events[2])
	}
	if strings.Contains(events[2].Error, "private_table_name") {
		t.Fatalf("audit error leaked quoted driver detail: %q", events[2].Error)
	}
	if events[3].EventType != "transaction_rollback_requested" || events[3].Status != "success" {
		t.Fatalf("automatic rollback request was not audited: %#v", events[3])
	}
	if events[4].EventType != "transaction_auto_rollback" || events[4].Status != "success" {
		t.Fatalf("automatic rollback was not audited: %#v", events[4])
	}
}

func TestSQLAuditRecordsRealSQLiteExecutions(t *testing.T) {
	app := newSQLAuditTestApp(t)
	databasePath := filepath.Join(t.TempDir(), "audit-target.sqlite")
	config := connection.ConnectionConfig{
		Type:     "custom",
		Driver:   "sqlite",
		DSN:      databasePath,
		Database: databasePath,
	}
	t.Cleanup(func() { app.DBReleaseConnection(config) })
	queries := []struct {
		id  string
		sql string
	}{
		{id: "real-sqlite-create", sql: "CREATE TABLE audit_users (id INTEGER PRIMARY KEY, email TEXT)"},
		{id: "real-sqlite-insert", sql: "INSERT INTO audit_users(id, email) VALUES (1, 'private@example.test')"},
		{id: "real-sqlite-select", sql: "SELECT id, email FROM audit_users WHERE id = 1"},
	}
	for _, query := range queries {
		result := app.DBQueryMulti(config, databasePath, query.sql, query.id)
		if !result.Success {
			t.Fatalf("DBQueryMulti(%s) returned failure: %s", query.id, result.Message)
		}
	}

	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "real-sqlite-", PageSize: 10})
	if len(events) != len(queries) {
		t.Fatalf("real SQLite audit event count = %d, want %d: %#v", len(events), len(queries), events)
	}
	for _, event := range events {
		if event.Status != "success" || event.DBType != "sqlite" {
			t.Fatalf("unexpected real SQLite audit event: %#v", event)
		}
		if strings.Contains(event.SQLText, "private@example.test") {
			t.Fatalf("real SQLite audit leaked literal: %q", event.SQLText)
		}
	}
	if events[1].RowsAffected != 1 {
		t.Fatalf("real SQLite INSERT affected rows = %d, want 1", events[1].RowsAffected)
	}
	if events[2].RowsReturned != 1 {
		t.Fatalf("real SQLite SELECT returned rows = %d, want 1", events[2].RowsReturned)
	}
}

func TestSQLAuditHealthRecordsAndClosesPersistenceGap(t *testing.T) {
	app := newSQLAuditTestApp(t)
	wasActive, suspendErr := app.suspendSQLAudit()
	if suspendErr != nil {
		t.Fatalf("suspendSQLAudit returned error: %v", suspendErr)
	}
	if !wasActive {
		t.Fatal("expected SQL audit runtime to be active before suspension")
	}
	app.appendSQLAuditEvent(sqlaudit.Event{EventType: "query", Status: "success", QueryID: "lost-query"})

	degradedResult := app.GetSQLAuditHealth()
	degraded, ok := degradedResult.Data.(sqlAuditHealthState)
	if !ok {
		t.Fatalf("GetSQLAuditHealth data type = %T, want sqlAuditHealthState", degradedResult.Data)
	}
	if degraded.Status != sqlAuditHealthStatusDegraded || degraded.DroppedEvents != 1 {
		t.Fatalf("unexpected degraded SQL audit health: %#v", degraded)
	}

	app.resumeSQLAudit(wasActive)
	app.appendSQLAuditEvent(sqlaudit.Event{EventType: "query", Status: "success", QueryID: "recovered-query"})
	healthResult := app.GetSQLAuditHealth()
	health := healthResult.Data.(sqlAuditHealthState)
	if health.Status != sqlAuditHealthStatusHealthy || health.DroppedEvents != 1 || health.LastSuccessAt == 0 {
		t.Fatalf("unexpected recovered SQL audit health: %#v", health)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 2 || events[0].QueryID != "recovered-query" || events[1].EventType != "audit_gap" {
		t.Fatalf("recovered audit timeline did not persist gap marker and next event: %#v", events)
	}
}

func TestSuspendSQLAuditReturnsCheckpointFailureAndCanResume(t *testing.T) {
	app := newSQLAuditTestApp(t)
	originalClose := closeSQLAuditStoreHandle
	closeSQLAuditStoreHandle = func(store *sqlaudit.Store) error {
		return errors.Join(originalClose(store), errors.New("simulated checkpoint failure"))
	}
	wasActive, err := app.suspendSQLAudit()
	closeSQLAuditStoreHandle = originalClose
	if err == nil || !strings.Contains(err.Error(), "simulated checkpoint failure") {
		t.Fatalf("suspendSQLAudit error = %v, want checkpoint failure", err)
	}
	if !wasActive {
		t.Fatal("failed suspension lost the prior active state")
	}

	app.resumeSQLAudit(wasActive)
	app.appendSQLAuditEvent(sqlaudit.Event{EventType: "query", Status: "success", QueryID: "after-failed-suspend"})
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "after-failed-suspend"})
	if len(events) != 1 {
		t.Fatalf("audit store did not resume after failed suspension: %#v", events)
	}
}

func TestSQLAuditHealthReportsCaptureStateAndMode(t *testing.T) {
	app := newSQLAuditTestApp(t)

	health := app.GetSQLAuditHealth().Data.(sqlAuditHealthState)
	if health.CaptureEnabled == nil || !*health.CaptureEnabled {
		t.Fatalf("default capture state was not reported as enabled: %#v", health)
	}
	if health.CaptureMode != sqlaudit.CaptureModeRedacted {
		t.Fatalf("default capture mode = %q, want %q", health.CaptureMode, sqlaudit.CaptureModeRedacted)
	}

	settings := sqlaudit.DefaultSettings()
	settings.Enabled = false
	settings.CaptureMode = sqlaudit.CaptureModeMetadata
	if result := app.UpdateSQLAuditSettings(settings); !result.Success {
		t.Fatalf("UpdateSQLAuditSettings returned failure: %s", result.Message)
	}
	health = app.GetSQLAuditHealth().Data.(sqlAuditHealthState)
	if health.CaptureEnabled == nil || *health.CaptureEnabled {
		t.Fatalf("disabled capture state was not reported explicitly: %#v", health)
	}
	if health.CaptureMode != sqlaudit.CaptureModeMetadata {
		t.Fatalf("capture mode = %q, want %q", health.CaptureMode, sqlaudit.CaptureModeMetadata)
	}
}

func TestSQLAuditRecoveryRetainsGapMarkerAtMinimumRecordLimit(t *testing.T) {
	app := newSQLAuditTestApp(t)
	settingsResult := app.UpdateSQLAuditSettings(sqlaudit.Settings{
		Enabled:       true,
		CaptureMode:   sqlaudit.CaptureModeRedacted,
		RetentionDays: 30,
		MaxRecords:    1,
	})
	if !settingsResult.Success {
		t.Fatalf("UpdateSQLAuditSettings returned failure: %s", settingsResult.Message)
	}

	wasActive, suspendErr := app.suspendSQLAudit()
	if suspendErr != nil {
		t.Fatalf("suspendSQLAudit returned error: %v", suspendErr)
	}
	app.appendSQLAuditEvent(sqlaudit.Event{EventType: "query", Status: "success", QueryID: "lost-at-minimum-limit"})
	app.resumeSQLAudit(wasActive)
	app.appendSQLAuditEvent(sqlaudit.Event{EventType: "query", Status: "success", QueryID: "current-at-minimum-limit"})

	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 || events[0].EventType != "audit_gap" {
		t.Fatalf("minimum retention limit must keep the recovery marker: %#v", events)
	}
	health := app.GetSQLAuditHealth().Data.(sqlAuditHealthState)
	if health.Status != sqlAuditHealthStatusHealthy || health.DroppedEvents != 1 {
		t.Fatalf("unexpected health after durable minimum-limit marker: %#v", health)
	}
}

func TestSQLAuditOversizedBatchCreatesVisibleHealthGapInsteadOfSilentTail(t *testing.T) {
	app := newSQLAuditTestApp(t)
	settingsResult := app.UpdateSQLAuditSettings(sqlaudit.Settings{
		Enabled:       true,
		CaptureMode:   sqlaudit.CaptureModeRedacted,
		RetentionDays: 30,
		MaxRecords:    1,
	})
	if !settingsResult.Success {
		t.Fatalf("UpdateSQLAuditSettings returned failure: %s", settingsResult.Message)
	}

	app.appendSQLAuditEvents([]sqlaudit.Event{
		{EventType: "transaction_statement", Status: "success", QueryID: "oversized-1"},
		{EventType: "transaction_statement", Status: "success", QueryID: "oversized-2"},
	})
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 || events[0].EventType != "audit_settings_change" {
		t.Fatalf("oversized batch must fail atomically while retaining its settings boundary, got %#v", events)
	}
	health := app.GetSQLAuditHealth().Data.(sqlAuditHealthState)
	if health.Status != sqlAuditHealthStatusDegraded || health.DroppedEvents != 2 {
		t.Fatalf("oversized batch was not exposed as a health gap: %#v", health)
	}
}

func TestSQLAuditControlEventsSurviveDisableAndClear(t *testing.T) {
	app := newSQLAuditTestApp(t)
	disabled := sqlaudit.Settings{
		Enabled:       false,
		CaptureMode:   sqlaudit.CaptureModeRedacted,
		RetentionDays: 30,
		MaxRecords:    100,
	}
	if result := app.UpdateSQLAuditSettings(disabled); !result.Success {
		t.Fatalf("disable SQL audit returned failure: %s", result.Message)
	}
	app.appendSQLAuditEvent(sqlaudit.Event{EventType: "query", Status: "success", QueryID: "disabled-query"})

	enabled := disabled
	enabled.Enabled = true
	if result := app.UpdateSQLAuditSettings(enabled); !result.Success {
		t.Fatalf("enable SQL audit returned failure: %s", result.Message)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 2 || events[0].EventType != "audit_settings_change" || events[1].EventType != "audit_settings_change" {
		t.Fatalf("disable/enable control boundaries were not persisted: %#v", events)
	}
	for _, event := range events {
		if event.QueryID == "disabled-query" {
			t.Fatalf("ordinary event was persisted while auditing was disabled: %#v", events)
		}
	}

	if result := app.ClearSQLAuditEvents(0); !result.Success {
		t.Fatalf("ClearSQLAuditEvents returned failure: %s", result.Message)
	}
	events = loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 1 || events[0].EventType != "audit_clear" || events[0].RowsAffected != 2 {
		t.Fatalf("clear boundary did not replace deleted history with a control event: %#v", events)
	}
}

func TestSQLAuditSettingsControlCanRecoverDegradedWriterWhileDisablingCapture(t *testing.T) {
	app := newSQLAuditTestApp(t)
	app.markSQLAuditFailure(1, errors.New("simulated writer failure"))
	settings := sqlaudit.DefaultSettings()
	settings.Enabled = false

	if result := app.UpdateSQLAuditSettings(settings); !result.Success {
		t.Fatalf("disable after writer recovery returned failure: %s", result.Message)
	}
	health := app.GetSQLAuditHealth().Data.(sqlAuditHealthState)
	if health.Status != sqlAuditHealthStatusHealthy || health.DroppedEvents != 1 || health.CaptureEnabled == nil || *health.CaptureEnabled {
		t.Fatalf("control write did not close the degraded state: %#v", health)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{})
	if len(events) != 2 || events[0].EventType != "audit_settings_change" || events[1].EventType != "audit_gap" {
		t.Fatalf("settings recovery lacks control and gap boundaries: %#v", events)
	}
	if result := app.BuildSQLAuditExport(sqlaudit.Filter{}, "json"); !result.Success {
		t.Fatalf("recovered disabled audit history should remain exportable: %s", result.Message)
	}
}

func TestWriteSQLAuditExportPreservesExistingFileWhenAtomicReplacementFails(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "audit.json")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatalf("write original export: %v", err)
	}

	originalReplace := replaceSQLAuditFile
	t.Cleanup(func() { replaceSQLAuditFile = originalReplace })
	replaceSQLAuditFile = func(_, _ string) error {
		return errors.New("simulated atomic replacement failure")
	}

	if err := writeSQLAuditExportAtomically(target, []byte("replacement")); err == nil {
		t.Fatal("expected replacement failure")
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read preserved export: %v", err)
	}
	if string(content) != "original" {
		t.Fatalf("existing export was not preserved: %q", content)
	}
}

func TestWriteSQLAuditExportNoReplacePreservesExistingFile(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "audit.json")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatalf("write original export: %v", err)
	}

	if err := writeSQLAuditExportAtomicallyNoReplace(target, []byte("replacement")); err == nil {
		t.Fatal("expected no-replace export to fail when target already exists")
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read preserved export: %v", err)
	}
	if string(content) != "original" {
		t.Fatalf("existing export was overwritten: %q", content)
	}
}

func TestWriteSQLAuditExportNoReplacePublishesNewFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "audit.json")
	if err := writeSQLAuditExportAtomicallyNoReplace(target, []byte("new content")); err != nil {
		t.Fatalf("no-replace export failed for a new target: %v", err)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read new export: %v", err)
	}
	if string(content) != "new content" {
		t.Fatalf("new export content = %q", content)
	}
}

func TestWriteSQLAuditExportNoReplaceAllowsOnlyOneConcurrentPublisher(t *testing.T) {
	target := filepath.Join(t.TempDir(), "audit.json")
	const writers = 8
	results := make(chan error, writers)
	var group sync.WaitGroup
	group.Add(writers)
	for i := 0; i < writers; i++ {
		go func(index int) {
			defer group.Done()
			results <- writeSQLAuditExportAtomicallyNoReplace(target, []byte("publisher"))
		}(i)
	}
	group.Wait()
	close(results)

	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent no-replace publishers succeeded %d times, want exactly one", successes)
	}
	if content, err := os.ReadFile(target); err != nil || string(content) != "publisher" {
		t.Fatalf("published export = %q, err=%v", content, err)
	}
}

func TestExportSQLAuditFileRejectsWebRuntimeBeforeOpeningDesktopDialog(t *testing.T) {
	app := NewWebApp()
	app.configDir = t.TempDir()
	app.activateSQLAudit()
	t.Cleanup(func() { app.closeSQLAuditStore() })

	result := app.ExportSQLAuditFile(sqlaudit.Filter{}, "json")
	if result.Success || !strings.Contains(result.Message, "BuildSQLAuditExport") {
		t.Fatalf("web runtime desktop export result = %#v, want safe rejection", result)
	}
}

func TestSQLAuditExportTargetRejectsInternalStorageFiles(t *testing.T) {
	app := newSQLAuditTestApp(t)
	for _, protectedPath := range []string{
		app.sqlAuditDatabasePath(),
		app.sqlAuditDatabasePath() + "-wal",
		app.sqlAuditDatabasePath() + "-shm",
		app.sqlAuditHealthFilePath(),
	} {
		if err := app.validateSQLAuditExportTarget(protectedPath); err == nil {
			t.Fatalf("protected audit export target %q was accepted", protectedPath)
		}
	}
	if err := app.validateSQLAuditExportTarget(filepath.Join(t.TempDir(), "safe-export.json")); err != nil {
		t.Fatalf("safe audit export target was rejected: %v", err)
	}
}

func TestSQLAuditExportTargetRejectsMissingSidecarThroughSymlinkedParent(t *testing.T) {
	app := newSQLAuditTestApp(t)
	auditDirectory := filepath.Dir(app.sqlAuditDatabasePath())
	aliasDirectory := filepath.Join(t.TempDir(), "audit-alias")
	if err := os.Symlink(auditDirectory, aliasDirectory); err != nil {
		t.Skipf("creating a directory symlink is unavailable: %v", err)
	}
	candidate := filepath.Join(aliasDirectory, filepath.Base(app.sqlAuditHealthFilePath()))
	_ = os.Remove(app.sqlAuditHealthFilePath())
	if err := app.validateSQLAuditExportTarget(candidate); err == nil {
		t.Fatalf("symlinked missing health export target %q was accepted", candidate)
	}
}

func TestDBQueryMultiAuditsSuccessfulPrefixBeforeLaterStatementFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	firstStatement := "UPDATE users SET active = 1 WHERE id = 1"
	secondStatement := "DELETE FROM missing_table WHERE id = 2"
	database := &fakeBatchWriteDB{
		execAffected: map[string]int64{firstStatement: 3},
		execErr:      map[string]error{secondStatement: errors.New("second statement failed")},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	result := app.DBQueryMulti(config, "main", firstStatement+";\n"+secondStatement+";", "query-partial-audit")
	if result.Success {
		t.Fatalf("expected second statement failure, got %#v", result)
	}
	if !result.Partial || result.ExecutedCount != 1 || result.FailedIndex != 2 ||
		result.BoundaryMode != sqlaudit.BoundaryModeImplicit || result.CommitMode != sqlaudit.CommitModeAuto {
		t.Fatalf("partial execution summary = %#v", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-partial-audit"})
	if len(events) != 3 {
		t.Fatalf("partial batch audit event count = %d, want 3: %#v", len(events), events)
	}
	if events[0].EventType != "query_statement" || events[0].Status != "success" ||
		events[0].StatementIndex != 1 || events[0].RowsAffected != 3 ||
		events[0].BoundaryMode != sqlaudit.BoundaryModeImplicit || events[0].CommitMode != sqlaudit.CommitModeAuto {
		t.Fatalf("successful committed prefix was not audited: %#v", events[0])
	}
	if events[1].EventType != "query_statement" || events[1].Status != "error" ||
		events[1].StatementIndex != 2 || events[1].FailedIndex != 2 || !strings.Contains(events[1].Error, "second statement failed") {
		t.Fatalf("failed statement was not audited: %#v", events[1])
	}
	if events[2].EventType != "query" || events[2].Status != "error" || events[2].StatementCount != 2 ||
		events[2].ExecutedCount != 1 || events[2].FailedIndex != 2 || events[2].BoundaryMode != sqlaudit.BoundaryModeImplicit {
		t.Fatalf("batch summary was not retained after statement events: %#v", events[2])
	}
}

func TestDBQueryMultiNativeResultsAuditDriverBoundaryAndExecutionSummary(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	query := "SELECT 1 AS first_value;\nSELECT 2 AS second_value;"
	baseDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{query: {
			{Rows: []map[string]interface{}{{"first_value": 1}}, Columns: []string{"first_value"}, StatementIndex: 1},
			{Rows: []map[string]interface{}{{"second_value": 2}}, Columns: []string{"second_value"}, StatementIndex: 2},
		}},
		queryErr: map[string]error{},
	}
	nativeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(string) (db.Database, error) { return nativeDB, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, Database: "master"}

	result := app.DBQueryMulti(config, "master", query, "query-native-audit")
	if !result.Success || result.ExecutedCount != 2 || result.FailedIndex != 0 ||
		result.BoundaryMode != sqlaudit.BoundaryModeDriverAPI || result.CommitMode != sqlaudit.CommitModeAuto {
		t.Fatalf("native execution summary = %#v", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-native-audit"})
	if len(events) != 3 {
		t.Fatalf("native audit event count = %d, want 3: %#v", len(events), events)
	}
	for index := 0; index < 2; index++ {
		if events[index].EventType != "query_statement" || events[index].Status != "success" ||
			events[index].StatementIndex != index+1 || events[index].BoundaryMode != sqlaudit.BoundaryModeDriverAPI || events[index].CommitMode != sqlaudit.CommitModeAuto {
			t.Fatalf("native statement audit %d = %#v", index+1, events[index])
		}
	}
	if events[2].EventType != "query" || events[2].ExecutedCount != 2 || events[2].BoundaryMode != sqlaudit.BoundaryModeDriverAPI {
		t.Fatalf("native query summary audit = %#v", events[2])
	}
}

func TestDBQueryMultiNativeErrorPreservesAuditedPrefixAndUnknownWriteOutcome(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	firstStatement := "INSERT INTO audit_log OUTPUT INSERTED.id VALUES (1)"
	secondStatement := "SELECT 2 AS second_value"
	query := firstStatement + ";\n" + secondStatement + ";"
	baseDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{query: {
			{Rows: []map[string]interface{}{{"id": 1}}, Columns: []string{"id"}, StatementIndex: 1},
		}},
	}
	nativeDB := &fakeNativeMultiResultDB{
		fakeBatchWriteDB: baseDB,
		partialResultErr: map[string]error{query: errors.New("second statement stream failed")},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return nativeDB, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, Database: "master"}

	result := app.DBQueryMulti(config, "master", query, "query-native-partial-audit")
	if result.Success || !result.Partial || !result.OutcomeUnknown || result.ExecutedCount != 1 || result.FailedIndex != 2 ||
		result.BoundaryMode != sqlaudit.BoundaryModeDriverAPI || result.CommitMode != sqlaudit.CommitModeAuto {
		t.Fatalf("native partial execution summary = %#v", result)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 || resultSets[0].StatementIndex != 1 {
		t.Fatalf("native partial result sets were not retained: %#v", result.Data)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-native-partial-audit"})
	if len(events) != 3 {
		t.Fatalf("native partial audit event count = %d, want 3: %#v", len(events), events)
	}
	if events[0].EventType != "query_statement" || events[0].Status != "success" || events[0].StatementIndex != 1 || events[0].RowsReturned != 1 {
		t.Fatalf("native completed prefix was not audited: %#v", events[0])
	}
	if events[1].EventType != "query_statement" || events[1].Status != "error" || events[1].FailedIndex != 2 || !events[1].OutcomeUnknown {
		t.Fatalf("native failing statement was not audited: %#v", events[1])
	}
	if events[2].EventType != "query" || events[2].ExecutedCount != 1 || events[2].FailedIndex != 2 || !events[2].OutcomeUnknown {
		t.Fatalf("native partial query summary was not retained: %#v", events[2])
	}
}

func TestDBQueryMultiAuditsTextTransactionBoundaryAndCommitState(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	update := "UPDATE audit_log SET active = 1 WHERE id = 1"
	database := &fakeBatchWriteDB{execAffected: map[string]int64{update: 1}}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	result := app.DBQueryMulti(config, "main", "BEGIN;\n"+update+";\nCOMMIT;", "query-text-transaction-audit")
	if !result.Success || result.BoundaryMode != sqlaudit.BoundaryModeTextSQL || result.CommitMode != sqlaudit.CommitModeManual || result.ExecutedCount != 3 {
		t.Fatalf("text transaction execution summary = %#v", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-text-transaction-audit"})
	if len(events) != 4 {
		t.Fatalf("text transaction audit event count = %d, want 4: %#v", len(events), events)
	}
	for index, wantCommitMode := range []string{sqlaudit.CommitModePending, sqlaudit.CommitModePending, sqlaudit.CommitModeManual} {
		event := events[index]
		if event.EventType != "query_statement" || event.BoundaryMode != sqlaudit.BoundaryModeTextSQL || event.CommitMode != wantCommitMode {
			t.Fatalf("text transaction statement %d audit = %#v", index+1, event)
		}
	}
	if events[3].EventType != "query" || events[3].BoundaryMode != sqlaudit.BoundaryModeTextSQL || events[3].CommitMode != sqlaudit.CommitModeManual {
		t.Fatalf("text transaction summary audit = %#v", events[3])
	}
}

func TestManagedSQLTransactionStatementAuditUsesActualCompletionTimes(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	firstStatement := "UPDATE users SET active = 1 WHERE id = 1"
	secondStatement := "UPDATE users SET active = 0 WHERE id = 2"
	database := &fakeBatchWriteDB{
		execAffected: map[string]int64{firstStatement: 1, secondStatement: 1},
		execDelay: map[string]time.Duration{
			firstStatement:  25 * time.Millisecond,
			secondStatement: 25 * time.Millisecond,
		},
	}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	started := app.DBQueryMultiTransactional(config, "main", firstStatement+";\n"+secondStatement+";", "query-timestamp-audit")
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("start managed transaction: %#v", started)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{TransactionID: started.TransactionID})
	statements := make([]sqlaudit.Event, 0, 2)
	for _, event := range events {
		if event.EventType == "transaction_statement" {
			statements = append(statements, event)
		}
	}
	if len(statements) != 2 {
		t.Fatalf("transaction statement events = %d, want 2: %#v", len(statements), events)
	}
	if statements[0].Timestamp <= 0 || statements[1].Timestamp <= statements[0].Timestamp {
		t.Fatalf("statement completion timestamps were collapsed at batch flush: %#v", statements)
	}
	if statements[0].DurationMs < 20 || statements[1].DurationMs < 20 {
		t.Fatalf("statement durations do not reflect execution time: %#v", statements)
	}
	if rollback := app.DBRollbackTransaction(started.TransactionID); !rollback.Success {
		t.Fatalf("rollback managed transaction: %#v", rollback)
	}
}

func TestManagedSQLTransactionProtectionDenialIsAudited(t *testing.T) {
	app := newSQLAuditTestApp(t)
	config := connection.ConnectionConfig{
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "main",
		ReadOnly: true,
	}

	result := app.DBQueryMultiTransactional(config, "main", "UPDATE users SET active = 1 WHERE id = 9", "query-denied-audit")
	if result.Success {
		t.Fatalf("expected production protection denial, got %#v", result)
	}
	events := loadSQLAuditEvents(t, app, sqlaudit.Filter{Search: "query-denied-audit"})
	if len(events) != 1 {
		t.Fatalf("denied managed transaction audit events = %d, want 1: %#v", len(events), events)
	}
	if events[0].EventType != "transaction_begin" || events[0].Status != "error" || events[0].Error == "" {
		t.Fatalf("denied managed transaction was not audited: %#v", events[0])
	}
}
