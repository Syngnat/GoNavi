package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
)

func TestImportDatabaseSQLRejectsDuplicateJobBeforeOpeningDatabase(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(filePath, []byte("SELECT 1;"), 0o600); err != nil {
		t.Fatal(err)
	}

	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup, registered := app.registerExclusiveRunningQuery("duplicate-sql-import", cancel, true)
	if !registered {
		t.Fatal("fixture registration failed")
	}
	defer cleanup()

	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	opened := false
	newDatabaseFunc = func(string) (db.Database, error) {
		opened = true
		return &fakeSQLFileBatchDB{}, nil
	}

	result := app.ImportDatabaseSQL(connection.ConnectionConfig{Type: "mysql"}, "app", filePath, "duplicate-sql-import", false)
	if result.Success {
		t.Fatalf("duplicate SQL import should fail: %#v", result)
	}
	if opened {
		t.Fatal("duplicate SQL import must be rejected before opening a database")
	}
	select {
	case <-ctx.Done():
		t.Fatal("duplicate import must not cancel the existing owner")
	default:
	}
}

func TestCancelSQLFileExecutionRetainsRegistrationUntilOwnerCleanup(t *testing.T) {
	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup, registered := app.registerImportTask("sql-import-cancel", cancel, importjob.KindSQL)
	if !registered {
		t.Fatal("fixture registration failed")
	}
	defer cleanup()

	first := app.CancelSQLFileExecution("sql-import-cancel")
	second := app.CancelSQLFileExecution("sql-import-cancel")
	if !first.Success || !second.Success {
		t.Fatalf("repeated cancellation should remain idempotent until owner exits: first=%#v second=%#v", first, second)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("cancel request did not reach task context")
	}
	app.queryMu.RLock()
	_, retained := app.runningQueries["sql-import-cancel"]
	app.queryMu.RUnlock()
	if !retained {
		t.Fatal("cancel request must not remove a task that is still unwinding")
	}
}
