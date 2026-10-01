package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestImportDatabaseSQLExecutesDamengFileOnPinnedSession(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "database.sql")
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")
	if err := os.WriteFile(filePath, []byte(input), 0o600); err != nil {
		t.Fatalf("write SQL import fixture: %v", err)
	}

	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	fakeDB := &fakeSQLFileBatchDB{}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "dameng"},
		"SYSDBA",
		filePath,
		"database-import-dameng-sql-test",
		false,
	)
	if !result.Success {
		t.Fatalf("Dameng SQL import failed: %#v", result)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatalf("expected Dameng SQL import to use and close a pinned session")
	}
	if fakeDB.execCalls == 0 && fakeDB.batchCalls == 0 {
		t.Fatalf("Dameng SQL import executed no statements: exec=%#v batch=%#v", fakeDB.execQueries, fakeDB.batchQueries)
	}
}

func TestImportDatabaseSQLFailsClosedForDamengWithoutPinnedSession(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(filePath, []byte("CREATE TABLE demo(id INT);"), 0o600); err != nil {
		t.Fatal(err)
	}
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &fakeSQLFileUnpinnedDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "dameng"},
		"SYSDBA",
		filePath,
		"database-import-dameng-unpinned-test",
		false,
	)
	if result.Success || result.Message != app.appText("data_import.capability.reason.pinned_session_unavailable", nil) {
		t.Fatalf("unexpected unpinned Dameng result: %#v", result)
	}
	if database.execCalls != 0 {
		t.Fatalf("unpinned Dameng import executed %d statement(s)", database.execCalls)
	}
}
