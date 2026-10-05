package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestExecuteSQLFileStreamPreservesMySQLAutocommitOffRollbackSemantics(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"SET autocommit=0;",
		"INSERT INTO demo(id) VALUES (1);",
		"ROLLBACK;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("autocommit-controlled rollback should complete normally: %v", err)
	}
	if result.Executed != 3 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("autocommit=0 DML must not be wrapped in an auto-committed batch: %d batch calls", fakeDB.batchCalls)
	}
	wantQueries := []string{
		"SET autocommit=0",
		"INSERT INTO demo(id) VALUES (1)",
		"ROLLBACK",
	}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("autocommit-controlled transaction semantics changed: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("session left with autocommit=0 must be discarded after import: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamPreservesMariaDBAutocommitOffRollbackSemantics(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := "SET autocommit=0;\nINSERT INTO demo(id) VALUES (1);\nROLLBACK;"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mariadb",
		ContinueOnError: false,
	}, nil)
	if err != nil || result.Executed != 3 || result.Failed != 0 {
		t.Fatalf("MariaDB autocommit-controlled rollback failed: result=%#v err=%v", result, err)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("MariaDB autocommit=0 DML must not be auto-committed in a batch: %d calls", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("MariaDB session left with autocommit=0 must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamRollsBackUnfinishedMySQLAutocommitOffWorkAtEOF(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"SET autocommit=0;",
		"INSERT INTO demo(id) VALUES (1);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("unfinished autocommit=0 work must fail at EOF, got %v", err)
	}
	if result.Executed != 2 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	wantQueries := []string{
		"SET autocommit=0",
		"INSERT INTO demo(id) VALUES (1)",
		"ROLLBACK",
	}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("unfinished autocommit=0 work was not rolled back: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("unfinished autocommit=0 session must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamRecognizesMySQLDumpCompositeAutocommitOff(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"SET @OLD_AUTOCOMMIT=@@AUTOCOMMIT, AUTOCOMMIT=0;",
		"INSERT INTO demo(id) VALUES (1);",
		"ROLLBACK;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("dump-style autocommit-controlled rollback should complete normally: %v", err)
	}
	if result.Executed != 3 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("composite AUTOCOMMIT=0 must disable automatic batching: %d batch calls", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("session left with dump-controlled autocommit must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamDiscardsSessionAfterMySQLAutocommitVariableRestore(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader("SET AUTOCOMMIT=@OLD_AUTOCOMMIT;"), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("variable-based autocommit restore should execute normally: %v", err)
	}
	if result.Executed != 1 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("unknown restored autocommit state must not return to the pool: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamRecognizesMySQLAutocommitEnableImplicitCommit(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"SET AUTOCOMMIT=0;",
		"START TRANSACTION;",
		"INSERT INTO demo(id) VALUES (1);",
		"SET AUTOCOMMIT=1;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("enabling autocommit after an explicit transaction must commit it: %v", err)
	}
	if result.Executed != 4 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("autocommit-controlled DML must remain sequential: %d batch calls", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("dedicated SQL-file session must be discarded after restoring autocommit: %#v", fakeDB.session)
	}
	if strings.Contains(fmt.Sprint(fakeDB.execQueries), "ROLLBACK") {
		t.Fatalf("SET AUTOCOMMIT=1 already committed the transaction: %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamRecognizesMySQLFamilyDDLImplicitCommit(t *testing.T) {
	for _, dbType := range []string{"mysql", "mariadb"} {
		t.Run(dbType, func(t *testing.T) {
			fakeDB := &fakeSQLFileBatchDB{}
			input := strings.Join([]string{
				"START TRANSACTION;",
				"INSERT INTO demo(id) VALUES (1);",
				"CREATE TABLE demo_copy(id INT);",
			}, "\n")

			result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
				DBType:          dbType,
				ContinueOnError: false,
			}, nil)
			if err != nil {
				t.Fatalf("DDL implicit commit must close the tracked transaction: %v", err)
			}
			if result.Executed != 3 || result.Failed != 0 {
				t.Fatalf("unexpected execution counters: %#v", result)
			}
			wantQueries := []string{
				"START TRANSACTION",
				"INSERT INTO demo(id) VALUES (1)",
				"CREATE TABLE demo_copy(id INT)",
			}
			if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
				t.Fatalf("successful DDL triggered a synthetic EOF rollback: got %#v want %#v", fakeDB.execQueries, wantQueries)
			}
		})
	}
}

func TestExecuteSQLFileStreamRecognizesMySQLDDLPreCommitWhenDDLAttemptFails(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "CREATE TABLE broken"}
	input := strings.Join([]string{
		"START TRANSACTION;",
		"INSERT INTO demo(id) VALUES (1);",
		"CREATE TABLE broken(id INT);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if err != nil {
		t.Fatalf("failed DDL must not leave a synthetic transaction open after its pre-commit: %v", err)
	}
	if result.Executed != 2 || result.Failed != 1 {
		t.Fatalf("DDL failure must be counted exactly once: %#v", result)
	}
	wantQueries := []string{
		"START TRANSACTION",
		"INSERT INTO demo(id) VALUES (1)",
		"CREATE TABLE broken(id INT)",
	}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("failed DDL triggered an invalid EOF rollback: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
}

func TestExecuteSQLFileStreamDoesNotTreatMySQLTemporaryTableDDLAsImplicitCommit(t *testing.T) {
	for _, ddl := range []string{
		"CREATE TEMPORARY TABLE temp_import(id INT)",
		"DROP TEMPORARY TABLE temp_import",
	} {
		t.Run(strings.Fields(ddl)[0], func(t *testing.T) {
			fakeDB := &fakeSQLFileBatchDB{}
			input := "START TRANSACTION;\n" + ddl + ";"

			result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
				DBType:          "mysql",
				ContinueOnError: false,
			}, nil)
			if !errors.Is(err, errSQLFileStoppedOnError) {
				t.Fatalf("temporary-table DDL must leave the explicit transaction open, got %v", err)
			}
			if result.Executed != 2 || result.Failed != 1 {
				t.Fatalf("unexpected execution counters: %#v", result)
			}
			if fakeDB.execQueries[len(fakeDB.execQueries)-1] != "ROLLBACK" {
				t.Fatalf("temporary-table transaction was not rolled back: %#v", fakeDB.execQueries)
			}
		})
	}
}

func TestSQLFileMySQLImplicitCommitClassificationAvoidsConditionalFalsePositives(t *testing.T) {
	tests := []struct {
		name string
		stmt string
		want bool
	}{
		{name: "set password", stmt: "SET PASSWORD FOR 'app'@'%' = 'secret'", want: true},
		{name: "reset replica", stmt: "RESET REPLICA ALL", want: true},
		{name: "reset persist exception", stmt: "RESET PERSIST IF EXISTS max_connections", want: false},
		{name: "lock tables", stmt: "LOCK TABLES demo WRITE", want: true},
		{name: "lock instance is not table lock", stmt: "LOCK INSTANCE FOR BACKUP", want: false},
		{name: "conditional unlock tables", stmt: "UNLOCK TABLES", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := sqlFileMySQLImplicitCommitBeforeStatement("mysql", test.stmt); got != test.want {
				t.Fatalf("sqlFileMySQLImplicitCommitBeforeStatement(%q) = %v, want %v", test.stmt, got, test.want)
			}
		})
	}
}

func TestExecuteSQLFileStreamDoesNotAssumeUnmatchedMySQLUnlockCommits(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := "START TRANSACTION;\nINSERT INTO demo(id) VALUES (1);\nUNLOCK TABLES;"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("UNLOCK TABLES without a tracked table lock must not clear the transaction: %v", err)
	}
	if result.Executed != 3 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.execQueries[len(fakeDB.execQueries)-1] != "ROLLBACK" {
		t.Fatalf("uncommitted work must be rolled back: %#v", fakeDB.execQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("uncertain transaction session must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamPreservesMySQLTableLocksUntilUnlock(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := "LOCK TABLES demo WRITE;\nINSERT INTO demo(id) VALUES (1);\nUNLOCK TABLES;"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil || result.Executed != 3 || result.Failed != 0 {
		t.Fatalf("tracked LOCK/UNLOCK TABLES sequence failed: result=%#v err=%v", result, err)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("automatic transaction batching would release LOCK TABLES: %d calls", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("dedicated SQL-file session must be discarded after unlocking tables: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamDiscardsMySQLSessionWithTableLocksAtEOF(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader("LOCK TABLES demo WRITE;"), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil || result.Executed != 1 || result.Failed != 0 {
		t.Fatalf("LOCK TABLES execution failed: result=%#v err=%v", result, err)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("session retaining table locks must not return to the pool: %#v", fakeDB.session)
	}
}
