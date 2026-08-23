package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type fakeMySQLGTIDImportDB struct {
	*fakeSQLFileBatchDB
	gtidExecuted  string
	serverVersion string
	queryCalls    []string
}

func (database *fakeMySQLGTIDImportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	database.queryCalls = append(database.queryCalls, query)
	return []map[string]interface{}{{
		"gtid_executed":  database.gtidExecuted,
		"server_version": database.serverVersion,
	}}, []string{"gtid_executed", "server_version"}, nil
}

func writeMySQLGTIDImportFixture(t *testing.T) string {
	t.Helper()
	filePath := filepath.Join(t.TempDir(), "mysqldump.sql")
	content := strings.Join([]string{
		"SET @OLD_SQL_MODE=@@SQL_MODE;",
		"SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'c289d954-7f57-11f1-99ab-fa163e2df103:1-618405';",
		"CREATE TABLE demo(id INT);",
	}, "\n")
	if err := os.WriteFile(filePath, []byte(content), 0o600); err != nil {
		t.Fatalf("write GTID import fixture: %v", err)
	}
	return filePath
}

func newMySQLGTIDImportTestApp(t *testing.T, database *fakeMySQLGTIDImportDB) *App {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	app := NewApp()
	app.configDir = t.TempDir()
	return app
}

func TestIsMySQLGTIDPurgedStatement(t *testing.T) {
	tests := []struct {
		name      string
		statement string
		want      bool
	}{
		{
			name:      "mysqldump assignment with version expression",
			statement: "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'server:1-9'",
			want:      true,
		},
		{
			name:      "global assignment with spaces",
			statement: "/* header */ SET GLOBAL GTID_PURGED := 'server:1-9'",
			want:      true,
		},
		{
			name:      "executable version comment",
			statement: "/*!80000 SET @@GLOBAL.GTID_PURGED='server:1-9' */",
			want:      true,
		},
		{
			name:      "string literal is not an assignment",
			statement: "SELECT 'SET @@GLOBAL.GTID_PURGED=server:1-9'",
			want:      false,
		},
		{
			name:      "session variable is unrelated",
			statement: "SET @GTID_PURGED='server:1-9'",
			want:      false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isMySQLGTIDPurgedStatement(test.statement); got != test.want {
				t.Fatalf("isMySQLGTIDPurgedStatement(%q) = %t, want %t", test.statement, got, test.want)
			}
		})
	}
}

func TestPreflightDatabaseSQLImportReportsGTIDDecisionBeforeExecution(t *testing.T) {
	database := &fakeMySQLGTIDImportDB{
		fakeSQLFileBatchDB: &fakeSQLFileBatchDB{},
		gtidExecuted:       "existing-server:1-10",
		serverVersion:      "8.0.39",
	}
	app := newMySQLGTIDImportTestApp(t, database)
	result := app.PreflightDatabaseSQLImport(
		connection.ConnectionConfig{Type: "mysql"},
		"app",
		writeMySQLGTIDImportFixture(t),
	)

	if !result.Success {
		t.Fatalf("preflight failed: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("preflight payload type = %T, want map[string]interface{}", result.Data)
	}
	if payload["containsMySQLGTIDPurged"] != true || payload["targetGTIDExecutedNonEmpty"] != true || payload["requiresGTIDDecision"] != true {
		t.Fatalf("unexpected GTID preflight payload: %#v", payload)
	}
	if database.execCalls != 0 || database.batchCalls != 0 {
		t.Fatalf("preflight executed database statements: exec=%d batch=%d", database.execCalls, database.batchCalls)
	}
}

func TestImportDatabaseSQLRejectsGTIDConflictBeforeAnyStatementByDefault(t *testing.T) {
	database := &fakeMySQLGTIDImportDB{
		fakeSQLFileBatchDB: &fakeSQLFileBatchDB{},
		gtidExecuted:       "existing-server:1-10",
		serverVersion:      "8.0.39",
	}
	app := newMySQLGTIDImportTestApp(t, database)
	result := app.ImportDatabaseSQL(
		connection.ConnectionConfig{Type: "mysql"},
		"app",
		writeMySQLGTIDImportFixture(t),
		"gtid-default-reject",
		false,
	)

	if result.Success {
		t.Fatalf("GTID-conflicting import unexpectedly succeeded: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok || payload["requiresGTIDDecision"] != true {
		t.Fatalf("unexpected conflict payload: %#v", result.Data)
	}
	if database.execCalls != 0 || database.batchCalls != 0 {
		t.Fatalf("conflicting import had side effects before prompting: exec=%d batch=%d queries=%#v", database.execCalls, database.batchCalls, database.execQueries)
	}
}

func TestImportDatabaseSQLWithGTIDSkipOmitsPurgedAssignment(t *testing.T) {
	database := &fakeMySQLGTIDImportDB{
		fakeSQLFileBatchDB: &fakeSQLFileBatchDB{},
		gtidExecuted:       "existing-server:1-10",
		serverVersion:      "8.0.39",
	}
	app := newMySQLGTIDImportTestApp(t, database)
	result := app.ImportDatabaseSQLWithOptions(
		connection.ConnectionConfig{Type: "mysql"},
		"app",
		writeMySQLGTIDImportFixture(t),
		"gtid-skip",
		false,
		"skip",
	)

	if !result.Success {
		t.Fatalf("skip-GTID import failed: %#v", result)
	}
	for _, query := range database.execQueries {
		if strings.Contains(strings.ToUpper(query), "GTID_PURGED") {
			t.Fatalf("skip mode executed GTID_PURGED: %#v", database.execQueries)
		}
	}
	if strings.Join(database.execQueries, "\n") != "SET @OLD_SQL_MODE=@@SQL_MODE\nCREATE TABLE demo(id INT)" {
		t.Fatalf("unexpected statements after GTID skip: %#v", database.execQueries)
	}
}

func TestImportDatabaseSQLWithGTIDResetRunsVersionCompatibleResetFirst(t *testing.T) {
	tests := []struct {
		name          string
		serverVersion string
		resetSQL      string
	}{
		{name: "MySQL 8.0", serverVersion: "8.0.39", resetSQL: "RESET MASTER"},
		{name: "MySQL 8.4", serverVersion: "8.4.3", resetSQL: "RESET BINARY LOGS AND GTIDS"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			database := &fakeMySQLGTIDImportDB{
				fakeSQLFileBatchDB: &fakeSQLFileBatchDB{},
				gtidExecuted:       "existing-server:1-10",
				serverVersion:      test.serverVersion,
			}
			app := newMySQLGTIDImportTestApp(t, database)
			result := app.ImportDatabaseSQLWithOptions(
				connection.ConnectionConfig{Type: "mysql"},
				"app",
				writeMySQLGTIDImportFixture(t),
				"gtid-reset-"+strings.ReplaceAll(test.serverVersion, ".", "-"),
				false,
				"reset",
			)

			if !result.Success {
				t.Fatalf("reset-GTID import failed: %#v", result)
			}
			if len(database.execQueries) < 2 || database.execQueries[0] != test.resetSQL {
				t.Fatalf("reset was not the first database statement: %#v", database.execQueries)
			}
			if !strings.Contains(strings.ToUpper(strings.Join(database.execQueries[1:], "\n")), "GTID_PURGED") {
				t.Fatalf("reset mode did not execute GTID_PURGED after reset: %#v", database.execQueries)
			}
		})
	}
}

func TestSQLImportOptionsHashSeparatesMySQLGTIDModes(t *testing.T) {
	reject := buildSQLImportOptionsHashWithGTIDMode(false, DefaultSQLImportMaxStatementBytes, sqlFileTransactionModeOff, mysqlGTIDImportModeReject)
	skip := buildSQLImportOptionsHashWithGTIDMode(false, DefaultSQLImportMaxStatementBytes, sqlFileTransactionModeOff, mysqlGTIDImportModeSkip)
	reset := buildSQLImportOptionsHashWithGTIDMode(false, DefaultSQLImportMaxStatementBytes, sqlFileTransactionModeOff, mysqlGTIDImportModeReset)
	if reject == skip || reject == reset || skip == reset {
		t.Fatalf("GTID import modes produced identical options hashes: reject=%s skip=%s reset=%s", reject, skip, reset)
	}
}
