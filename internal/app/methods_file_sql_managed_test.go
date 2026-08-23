package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/uievents"
)

func installSQLImportTestDatabase(t *testing.T, database db.Database) {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
}

func newManagedSQLImportTestApp(t *testing.T) *App {
	t.Helper()
	app := NewApp()
	app.configDir = t.TempDir()
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	return app
}

func TestImportDatabaseSQLPersistsCompletedManagedJobAndSourceDigest(t *testing.T) {
	database := &fakeSQLFileBatchDB{}
	installSQLImportTestDatabase(t, database)
	path := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(path, []byte("INSERT INTO users(id) VALUES (1);"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newManagedSQLImportTestApp(t)
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app", path, "sql-import-complete", false,
	)
	if !result.Success {
		t.Fatalf("SQL import failed: %#v", result)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("sql-import-complete")
	if err != nil {
		t.Fatal(err)
	}
	if job.Kind != importjob.KindSQL || job.Status != importjob.StatusCompleted || job.Succeeded != 1 || job.Failed != 0 {
		t.Fatalf("unexpected SQL job: %#v", job)
	}
	if job.SourceIdentityToken == "" || job.SourceContentSHA256 == "" || job.SourceBytesTotal <= 0 || job.BytesRead != job.SourceBytesTotal || job.ByteProgressKind != "rawSource" {
		t.Fatalf("SQL source identity/progress was not persisted: %#v", job)
	}
}

func TestImportDatabaseSQLPersistsPartialManagedJob(t *testing.T) {
	database := &fakeSQLFileBatchDB{failExecSQL: "broken_proc"}
	installSQLImportTestDatabase(t, database)
	path := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(path, []byte("CALL broken_proc();\nINSERT INTO users(id) VALUES (1);"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newManagedSQLImportTestApp(t)
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app", path, "sql-import-partial", true,
	)
	if result.Success {
		t.Fatalf("partial SQL import must not report full success: %#v", result)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("sql-import-partial")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusPartial || job.Succeeded != 1 || job.Failed != 1 || job.OutcomeUnknown {
		t.Fatalf("unexpected partial SQL job: %#v", job)
	}
}

func TestImportDatabaseSQLPersistsUnknownJobWhenAutomaticCommitFails(t *testing.T) {
	database := &fakeSQLFileBatchDB{failExecSQL: "COMMIT"}
	installSQLImportTestDatabase(t, database)
	path := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(path, []byte("INSERT INTO users(id) VALUES (1);"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newManagedSQLImportTestApp(t)
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app", path, "sql-import-commit-unknown", false,
	)
	if result.Success {
		t.Fatalf("failed automatic commit must not report success: %#v", result)
	}
	payload, _ := result.Data.(map[string]interface{})
	if payload["outcomeUnknown"] != true {
		t.Fatalf("failed automatic commit must report an unknown outcome: %#v", result)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("sql-import-commit-unknown")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusUnknown || !job.OutcomeUnknown {
		t.Fatalf("managed job must preserve the unknown commit outcome: %#v", job)
	}
}

func TestSQLImportOptionsHashSeparatesErrorPolicies(t *testing.T) {
	if buildSQLImportOptionsHash(false, DefaultSQLImportMaxStatementBytes) == buildSQLImportOptionsHash(true, DefaultSQLImportMaxStatementBytes) {
		t.Fatal("different SQL error policies must not share an options hash")
	}
	if buildSQLImportOptionsHash(false, 0) != buildSQLImportOptionsHash(false, DefaultSQLImportMaxStatementBytes) {
		t.Fatal("default SQL statement limit should have a canonical options hash")
	}
}

func TestImportDatabaseSQLMarksOutcomeUnknownWhenSourceChangesDuringExecution(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(path, []byte("INSERT INTO users(id) VALUES (1);\nINSERT INTO users(id) VALUES (2);"), 0o600); err != nil {
		t.Fatal(err)
	}
	mutated := false
	database := &fakeSQLFileBatchDB{execError: func(string) error {
		if mutated {
			return nil
		}
		mutated = true
		file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Errorf("open SQL source for mutation: %v", err)
			return nil
		}
		if _, err := file.WriteString("\nSELECT 3;"); err != nil {
			t.Errorf("mutate SQL source: %v", err)
		}
		if err := file.Close(); err != nil {
			t.Errorf("close mutated SQL source: %v", err)
		}
		return nil
	}}
	installSQLImportTestDatabase(t, database)
	app := newManagedSQLImportTestApp(t)
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
		"app", path, "sql-import-mutated", true,
	)
	if result.Success {
		t.Fatalf("mutated SQL source must not report a certain success: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok || payload["sourceChanged"] != true || payload["outcomeUnknown"] != true {
		t.Fatalf("unexpected source-change payload: %#v", result.Data)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("sql-import-mutated")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusUnknown || !job.OutcomeUnknown {
		t.Fatalf("unexpected source-change job: %#v", job)
	}
}

func TestImportDatabaseSQLCanCancelFullPreflightBeforeDatabaseOpen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(path, []byte("INSERT INTO users(id) VALUES (1);"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalHook := sqlFilePreflightReadHook
	t.Cleanup(func() { sqlFilePreflightReadHook = originalHook })
	entered := make(chan struct{})
	var once sync.Once
	sqlFilePreflightReadHook = func(ctx context.Context) {
		once.Do(func() { close(entered) })
		<-ctx.Done()
	}

	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	opened := false
	newDatabaseFunc = func(string) (db.Database, error) {
		opened = true
		return &fakeSQLFileBatchDB{}, nil
	}
	app := newManagedSQLImportTestApp(t)
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- app.ImportDatabaseSQL(
			connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
			"app", path, "sql-import-preflight-cancel", false,
		)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("SQL preflight did not start")
	}
	if cancelResult := app.CancelSQLFileExecution("sql-import-preflight-cancel"); !cancelResult.Success {
		t.Fatalf("cancel failed: %#v", cancelResult)
	}
	var result connection.QueryResult
	select {
	case result = <-resultCh:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled SQL preflight did not unwind")
	}
	if result.Success {
		t.Fatalf("cancelled preflight reported success: %#v", result)
	}
	payload, _ := result.Data.(map[string]interface{})
	if payload["cancelled"] != true || opened {
		t.Fatalf("result=%#v opened=%v, want cancellation before database open", result, opened)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("sql-import-preflight-cancel")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusCancelled {
		t.Fatalf("status = %q, want cancelled", job.Status)
	}
}

func TestImportDatabaseSQLMarksInFlightCancellationOutcomeUnknown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(path, []byte("INSERT INTO users(id) VALUES (1);"), 0o600); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	database := &fakeSQLFileBatchDB{execError: func(query string) error {
		if strings.Contains(query, "INSERT INTO users") {
			once.Do(func() { close(entered) })
			<-release
			return context.Canceled
		}
		return nil
	}}
	installSQLImportTestDatabase(t, database)
	app := newManagedSQLImportTestApp(t)
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- app.ImportDatabaseSQL(
			connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306},
			"app", path, "sql-import-write-cancel", true,
		)
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("SQL write did not start")
	}
	if cancelResult := app.CancelSQLFileExecution("sql-import-write-cancel"); !cancelResult.Success {
		t.Fatalf("cancel failed: %#v", cancelResult)
	}
	close(release)
	var result connection.QueryResult
	select {
	case result = <-resultCh:
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled SQL write did not unwind")
	}
	payload, _ := result.Data.(map[string]interface{})
	if result.Success || payload["cancelled"] != true || payload["outcomeUnknown"] != true {
		t.Fatalf("in-flight cancellation must report an unknown outcome: %#v", result)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("sql-import-write-cancel")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusUnknown || !job.OutcomeUnknown {
		t.Fatalf("managed job must preserve the unknown cancellation outcome: %#v", job)
	}
}
