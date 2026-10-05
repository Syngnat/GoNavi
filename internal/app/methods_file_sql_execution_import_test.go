package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestResolveSQLFileExecutionRunConfigUsesServerConnectionForGoNaviMySQLDatabaseBackup(t *testing.T) {
	preamble := strings.Join([]string{
		"-- GoNavi SQL Export",
		"-- Time: 2026-07-17 00:00:00",
		"-- Database: restore_target",
		"",
		"CREATE DATABASE IF NOT EXISTS `restore_target`;",
		"",
		"USE `restore_target`;",
	}, "\n")

	got := resolveSQLFileExecutionRunConfig(
		connection.ConnectionConfig{Type: "mysql", Database: "selected_target"},
		"selected_target",
		[]byte(preamble),
	)
	if got.Database != "" {
		t.Fatalf("GoNavi MySQL database backup must connect at server level before CREATE/USE, got database=%q", got.Database)
	}
}

func TestResolveSQLFileExecutionRunConfigKeepsSelectedDatabaseForRegularSQL(t *testing.T) {
	got := resolveSQLFileExecutionRunConfig(
		connection.ConnectionConfig{Type: "mysql", Database: "configured_default"},
		"selected_target",
		[]byte("CREATE TABLE demo(id INT);"),
	)
	if got.Database != "selected_target" {
		t.Fatalf("regular SQL must retain the selected database, got database=%q", got.Database)
	}
}

func TestResolveSQLFileExecutionRunConfigUsesServerConnectionForLegacyGoNaviMySQLDatabaseBackup(t *testing.T) {
	preamble := strings.Join([]string{
		"-- GoNavi SQL Export",
		"-- Time: 2026-07-11 00:00:00",
		"-- Database: legacy_restore_target",
		"",
		"USE `legacy_restore_target`;",
	}, "\n")

	got := resolveSQLFileExecutionRunConfig(
		connection.ConnectionConfig{Type: "mysql", Database: "selected_target"},
		"selected_target",
		[]byte(preamble),
	)
	if got.Database != "" {
		t.Fatalf("legacy GoNavi MySQL database backup must connect at server level before USE, got database=%q", got.Database)
	}
}

func TestBuildGoNaviMySQLDatabaseBackupBootstrapSQLOnlyForLegacyBackup(t *testing.T) {
	legacy := goNaviMySQLDatabaseBackupPreamble{databaseName: "legacy_restore_target"}
	if got := buildGoNaviMySQLDatabaseBackupBootstrapSQL(legacy); got != "CREATE DATABASE IF NOT EXISTS `legacy_restore_target`" {
		t.Fatalf("unexpected legacy bootstrap SQL: %q", got)
	}

	current := goNaviMySQLDatabaseBackupPreamble{
		databaseName:           "current_restore_target",
		includesCreateDatabase: true,
	}
	if got := buildGoNaviMySQLDatabaseBackupBootstrapSQL(current); got != "" {
		t.Fatalf("backup that already creates its database must not be bootstrapped again, got %q", got)
	}
}

func TestExecuteSQLFileStreamRunsGoNaviMySQLDatabaseBackupHeader(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"-- GoNavi SQL Export",
		"-- Database: restore_target",
		"CREATE DATABASE IF NOT EXISTS `restore_target`;",
		"USE `restore_target`;",
		"SET FOREIGN_KEY_CHECKS=0;",
		"CREATE TABLE users(id INT PRIMARY KEY);",
		"INSERT INTO users(id) VALUES (1);",
		"SET FOREIGN_KEY_CHECKS=1;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 6 || result.Failed != 0 {
		t.Fatalf("expected complete database backup header and statements to execute, got %#v", result)
	}
	joinedExec := strings.Join(fakeDB.execQueries, "\n")
	for _, expected := range []string{
		"CREATE DATABASE IF NOT EXISTS `restore_target`",
		"USE `restore_target`",
		"CREATE TABLE users(id INT PRIMARY KEY)",
		"SET FOREIGN_KEY_CHECKS=1",
	} {
		if !strings.Contains(joinedExec, expected) {
			t.Fatalf("expected backup statement %q to execute, queries=%#v", expected, fakeDB.execQueries)
		}
	}
	if len(fakeDB.batchQueries) != 1 || !strings.Contains(fakeDB.batchQueries[0], "INSERT INTO users(id) VALUES (1)") {
		t.Fatalf("expected INSERT data to be batched after schema restore, batches=%#v", fakeDB.batchQueries)
	}
}

func TestImportDatabaseSQLHonorsConnectionProtections(t *testing.T) {
	allowedFilePath := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(allowedFilePath, []byte("CREATE TABLE demo(id INT);"), 0o600); err != nil {
		t.Fatalf("write SQL import fixture: %v", err)
	}
	missingFilePath := filepath.Join(t.TempDir(), "missing.sql")

	tests := []struct {
		name       string
		protection connection.ConnectionProtectionConfig
		filePath   string
		wantBlock  bool
	}{
		{
			name:       "data import restricted",
			protection: connection.ConnectionProtectionConfig{RestrictDataImport: true},
			filePath:   missingFilePath,
			wantBlock:  true,
		},
		{
			name:       "structure edit restricted",
			protection: connection.ConnectionProtectionConfig{RestrictStructureEdit: true},
			filePath:   missingFilePath,
			wantBlock:  true,
		},
		{
			name:       "script execution restricted",
			protection: connection.ConnectionProtectionConfig{RestrictScriptExecution: true},
			filePath:   missingFilePath,
			wantBlock:  true,
		},
		{
			name:      "allowed",
			filePath:  allowedFilePath,
			wantBlock: false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			originalNewDatabaseFunc := newDatabaseFunc
			t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

			opened := false
			fakeDB := &fakeSQLFileBatchDB{}
			newDatabaseFunc = func(string) (db.Database, error) {
				opened = true
				return fakeDB, nil
			}

			app := NewApp()
			app.configDir = t.TempDir()
			result := app.ImportDatabaseSQL(connection.ConnectionConfig{
				Type:       "mysql",
				Protection: test.protection,
			}, "app", test.filePath, "database-import-protection-test", false)

			if test.wantBlock {
				if result.Success {
					t.Fatalf("ImportDatabaseSQL unexpectedly succeeded: %#v", result)
				}
				wantMessage := readOnlyConnectionActionBlockedMessageWithText(
					"connection.backend.action.import_data",
					app.appText,
				)
				if result.Message != wantMessage {
					t.Fatalf("blocked message = %q, want %q", result.Message, wantMessage)
				}
				if opened {
					t.Fatal("ImportDatabaseSQL opened a database despite connection protection")
				}
				return
			}

			if !result.Success {
				t.Fatalf("ImportDatabaseSQL returned failure: %#v", result)
			}
			if !opened {
				t.Fatal("ImportDatabaseSQL did not open a database on the allowed path")
			}
			if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != "CREATE TABLE demo(id INT)" {
				t.Fatalf("unexpected executed SQL: %#v", fakeDB.execQueries)
			}
		})
	}
}

func TestImportDatabaseSQLFailsClosedWithoutPinnedSession(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "database.sql")
	if err := os.WriteFile(filePath, []byte("CREATE TABLE demo(id INT);"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	database := &fakeSQLFileUnpinnedDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "mysql"},
		"app",
		filePath,
		"database-import-unpinned-test",
		false,
	)
	if result.Success || result.Message != app.appText("data_import.capability.reason.pinned_session_unavailable", nil) {
		t.Fatalf("unexpected unpinned result: %#v", result)
	}
	if database.execCalls != 0 {
		t.Fatalf("unpinned import executed %d statement(s)", database.execCalls)
	}
}

func TestImportDatabaseSQLRejectsUnsupportedDialectBeforeFileAccess(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	opened := false
	newDatabaseFunc = func(string) (db.Database, error) {
		opened = true
		return &fakeSQLFileUnpinnedDB{}, nil
	}

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "future-db"},
		"app",
		filepath.Join(t.TempDir(), "missing.sql"),
		"database-import-unsupported-test",
		false,
	)
	if result.Success || result.Message != app.appText("data_import.capability.reason.database_type_unsupported", nil) {
		t.Fatalf("unexpected unsupported-dialect result: %#v", result)
	}
	if opened {
		t.Fatal("unsupported database import opened a database")
	}
}

func TestExecuteSQLFileHonorsScriptExecutionProtection(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "script.sql")
	if err := os.WriteFile(filePath, []byte("DROP TABLE users;"), 0o600); err != nil {
		t.Fatal(err)
	}
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	opened := false
	newDatabaseFunc = func(string) (db.Database, error) {
		opened = true
		return &fakeSQLFileBatchDB{}, nil
	}

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ExecuteSQLFile(connection.ConnectionConfig{
		Type: "mysql",
		Protection: connection.ConnectionProtectionConfig{
			RestrictScriptExecution: true,
		},
	}, "app", filePath, "protected-script")
	if result.Success {
		t.Fatalf("protected SQL file unexpectedly succeeded: %#v", result)
	}
	if opened {
		t.Fatal("protected SQL file opened a database")
	}
}

func TestImportDatabaseSQLStopPolicyDoesNotReplayFailedBatch(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "database.sql")
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"INSERT INTO demo(id) VALUES (3);",
	}, "\n")
	if err := os.WriteFile(filePath, []byte(input), 0o600); err != nil {
		t.Fatalf("write SQL import fixture: %v", err)
	}

	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	fakeDB := &fakeSQLFileBatchDB{failBatch: true, failExecSQL: "VALUES (2)"}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ImportDatabaseSQL(connection.ConnectionConfig{Type: "mysql"}, "app", filePath, "database-import-stop-policy-test", false)
	if result.Success {
		t.Fatalf("ImportDatabaseSQL unexpectedly succeeded: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("result data type = %T, want map[string]interface{}", result.Data)
	}
	if payload["completed"] != false || payload["stoppedOnError"] != true {
		t.Fatalf("unexpected stop-on-error payload: %#v", payload)
	}
	if fakeDB.batchCalls != 1 || fakeDB.execCalls != 2 {
		t.Fatalf("failed database import replayed its batch: batchCalls=%d execCalls=%d queries=%#v", fakeDB.batchCalls, fakeDB.execCalls, fakeDB.execQueries)
	}
}

func TestImportDatabaseSQLContinuePolicyCompletesWithRecordedErrors(t *testing.T) {
	filePath := filepath.Join(t.TempDir(), "database.sql")
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"INSERT INTO demo(id) VALUES (3);",
	}, "\n")
	if err := os.WriteFile(filePath, []byte(input), 0o600); err != nil {
		t.Fatalf("write SQL import fixture: %v", err)
	}

	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	fakeDB := &fakeSQLFileBatchDB{failBatch: true, failExecSQL: "VALUES (2)"}
	newDatabaseFunc = func(string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewApp()
	app.configDir = t.TempDir()
	result := app.ImportDatabaseSQL(connection.ConnectionConfig{Type: "mysql"}, "app", filePath, "database-import-continue-policy-test", true)
	if result.Success {
		t.Fatalf("backend result with statement errors should remain unsuccessful: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("result data type = %T, want map[string]interface{}", result.Data)
	}
	if payload["completed"] != true || payload["stoppedOnError"] != false || payload["failed"] != 1 {
		t.Fatalf("unexpected completed-with-errors payload: %#v", payload)
	}
	if fakeDB.batchCalls != 0 || fakeDB.execCalls != 3 {
		t.Fatalf("MySQL continue policy must execute safely without a replayable batch: batchCalls=%d execCalls=%d queries=%#v", fakeDB.batchCalls, fakeDB.execCalls, fakeDB.execQueries)
	}
}
