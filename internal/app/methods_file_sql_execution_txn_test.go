package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestExecuteSQLFileStreamRollsBackOpenUserTransactionAfterStatementError(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "INSERT INTO broken"}
	input := strings.Join([]string{
		"START TRANSACTION;",
		"INSERT INTO broken(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected stop-on-error sentinel, got %v", err)
	}
	if result.Executed != 1 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	wantQueries := []string{"START TRANSACTION", "INSERT INTO broken(id) VALUES (1)", "ROLLBACK"}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("open transaction was not rolled back: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.closed || !fakeDB.session.discarded {
		t.Fatalf("an interrupted import session must be discarded after rollback: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamDiscardsSessionAfterErrorWithoutTrackedTransaction(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "CREATE TABLE broken"}

	_, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader("CREATE TABLE broken(id INT);"), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected stop-on-error sentinel, got %v", err)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("aborted SQL-file sessions may retain autocommit or other session state and must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamDiscardsSessionWhenOpenTransactionRollbackFails(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{
		execError: func(query string) error {
			if strings.Contains(query, "INSERT INTO broken") || query == "ROLLBACK" {
				return errors.New("forced execution failure")
			}
			return nil
		},
	}
	input := "START TRANSACTION;\nINSERT INTO broken(id) VALUES (1);"

	_, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected stop-on-error sentinel, got %v", err)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("rollback failure must discard then close the session: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamRejectsUnclosedUserTransactionAtEndOfFile(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := "START TRANSACTION;\nINSERT INTO demo(id) VALUES (1);"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected unclosed transaction to fail the import, got %v", err)
	}
	if result.Executed != 2 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	wantQueries := []string{"START TRANSACTION", "INSERT INTO demo(id) VALUES (1)", "ROLLBACK"}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("unclosed transaction was not rolled back: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
}

func TestExecuteSQLFileStreamDoesNotTreatOracleAnonymousBlockAsOpenTransaction(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	block := strings.Join([]string{
		"BEGIN",
		"  NULL;",
		"END;",
	}, "\n")
	input := block + "\n/\nSELECT 1 FROM dual;"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "oracle",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("Oracle anonymous block must not leave a synthetic transaction open: %v", err)
	}
	if result.Executed != 2 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	wantQueries := []string{block, "SELECT 1 FROM dual"}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("anonymous block execution changed unexpectedly: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.closed || !fakeDB.session.discarded {
		t.Fatalf("SQL-file session must be discarded even after a successful anonymous block: %#v", fakeDB.session)
	}
}

func TestUpdateSQLFileTransactionStateDistinguishesBlocksFromTransactions(t *testing.T) {
	tests := []struct {
		name          string
		dbType        string
		inTransaction bool
		stmt          string
		want          bool
	}{
		{name: "mysql bare begin", dbType: "mysql", stmt: "BEGIN", want: true},
		{name: "mysql begin work", dbType: "mysql", stmt: "BEGIN WORK", want: true},
		{name: "mariadb anonymous block", dbType: "mariadb", stmt: "BEGIN NOT ATOMIC\n  SET @value = 1;\nEND", want: false},
		{name: "postgres begin work", dbType: "postgres", stmt: "BEGIN WORK", want: true},
		{name: "postgres deferrable", dbType: "postgres", stmt: "BEGIN DEFERRABLE", want: true},
		{name: "postgres not deferrable", dbType: "postgres", stmt: "BEGIN NOT DEFERRABLE", want: true},
		{name: "postgres family oracle compatible block", dbType: "kingbase", stmt: "BEGIN\n  NULL;\nEND", want: false},
		{name: "oracle anonymous block", dbType: "oracle", stmt: "BEGIN\n  NULL;\nEND", want: false},
		{name: "oracle block preserves active transaction", dbType: "oracle", inTransaction: true, stmt: "BEGIN\n  NULL;\nEND", want: true},
		{name: "dameng anonymous block", dbType: "dameng", stmt: "BEGIN\n  NULL;\nEND", want: false},
		{name: "sqlserver control block", dbType: "sqlserver", stmt: "BEGIN\n  PRINT 'done';\nEND", want: false},
		{name: "sqlserver try block", dbType: "sqlserver", stmt: "BEGIN TRY\n  SELECT 1;\nEND TRY", want: false},
		{name: "sqlserver dialog", dbType: "sqlserver", stmt: "BEGIN DIALOG CONVERSATION @handle", want: false},
		{name: "sqlserver transaction", dbType: "sqlserver", stmt: "BEGIN TRANSACTION", want: true},
		{name: "sqlserver tran alias", dbType: "sqlserver", stmt: "BEGIN TRAN", want: true},
		{name: "sqlserver distributed transaction", dbType: "sqlserver", stmt: "BEGIN DISTRIBUTED TRANSACTION", want: true},
		{name: "sqlite deferred", dbType: "sqlite", stmt: "BEGIN DEFERRED", want: true},
		{name: "sqlite immediate", dbType: "sqlite", stmt: "BEGIN IMMEDIATE", want: true},
		{name: "sqlite exclusive", dbType: "sqlite", stmt: "BEGIN EXCLUSIVE TRANSACTION", want: true},
		{name: "unknown ansi atomic block", dbType: "custom", stmt: "BEGIN ATOMIC\n  VALUES 1;\nEND", want: false},
		{name: "leading comment before transaction", dbType: "postgres", stmt: "-- restore transaction\nBEGIN TRANSACTION", want: true},
		{name: "leading hash comment before mysql transaction", dbType: "mysql", stmt: "# restore transaction\nBEGIN", want: true},
		{name: "unrelated start preserves active transaction", dbType: "mysql", inTransaction: true, stmt: "START REPLICA", want: true},
		{name: "rollback to savepoint", dbType: "postgres", inTransaction: true, stmt: "ROLLBACK WORK TO SAVEPOINT before_import", want: true},
		{name: "rollback to savepoint with comment", dbType: "sqlite", inTransaction: true, stmt: "ROLLBACK /* keep outer transaction */ TRANSACTION TO before_import", want: true},
		{name: "commit and chain", dbType: "mysql", inTransaction: true, stmt: "COMMIT WORK AND CHAIN", want: true},
		{name: "commit and no chain", dbType: "mysql", inTransaction: true, stmt: "COMMIT AND NO CHAIN", want: false},
		{name: "rollback and chain", dbType: "postgres", inTransaction: true, stmt: "ROLLBACK AND CHAIN", want: true},
		{name: "postgres end transaction", dbType: "postgres", inTransaction: true, stmt: "END TRANSACTION", want: false},
		{name: "sqlite end transaction", dbType: "sqlite", inTransaction: true, stmt: "END TRANSACTION", want: false},
		{name: "postgres abort", dbType: "postgres", inTransaction: true, stmt: "ABORT", want: false},
		{name: "duckdb abort", dbType: "duckdb", inTransaction: true, stmt: "ABORT", want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := updateSQLFileTransactionState(test.dbType, test.inTransaction, test.stmt); got != test.want {
				t.Fatalf("transaction state = %v, want %v", got, test.want)
			}
		})
	}
}

func TestExecuteSQLFileStreamHandlesSQLServerBlocksAndTransactions(t *testing.T) {
	t.Run("control block", func(t *testing.T) {
		fakeDB := &fakeSQLFileBatchDB{}
		block := "BEGIN\n  PRINT 'done';\nEND"
		input := block + ";\nSELECT 1;"

		result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
			DBType:          "sqlserver",
			ContinueOnError: false,
		}, nil)
		if err != nil {
			t.Fatalf("SQL Server control block must not leave a synthetic transaction open: %v", err)
		}
		if result.Executed != 2 || result.Failed != 0 {
			t.Fatalf("unexpected execution counters: %#v", result)
		}
		wantQueries := []string{block + ";", "SELECT 1"}
		if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
			t.Fatalf("control block execution changed unexpectedly: got %#v want %#v", fakeDB.execQueries, wantQueries)
		}
	})

	t.Run("explicit transaction", func(t *testing.T) {
		fakeDB := &fakeSQLFileBatchDB{}
		input := "BEGIN TRAN;\nUPDATE demo SET value = 2;\nCOMMIT;"

		result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
			DBType:          "sqlserver",
			ContinueOnError: false,
		}, nil)
		if err != nil {
			t.Fatalf("SQL Server explicit transaction should complete normally: %v", err)
		}
		if result.Executed != 3 || result.Failed != 0 {
			t.Fatalf("unexpected execution counters: %#v", result)
		}
		wantQueries := []string{"BEGIN TRAN", "UPDATE demo SET value = 2", "COMMIT"}
		if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
			t.Fatalf("explicit transaction split changed unexpectedly: got %#v want %#v", fakeDB.execQueries, wantQueries)
		}
	})
}

func TestExecuteSQLFileStreamDoesNotReuseSQLServerSessionWithNestedTransactionOpen(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"BEGIN TRAN;",
		"BEGIN TRAN;",
		"INSERT INTO demo(id) VALUES (1);",
		"COMMIT;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "sqlserver",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("nested SQL Server transaction left open at EOF must fail, got %v", err)
	}
	if result.Executed != 4 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	wantQueries := []string{
		"BEGIN TRAN",
		"BEGIN TRAN",
		"INSERT INTO demo(id) VALUES (1)",
		"COMMIT",
		"ROLLBACK TRANSACTION",
	}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("remaining nested transaction was not rolled back: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("nested transaction session must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamDoesNotTreatSQLServerNamedRollbackAsTransactionEnd(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"BEGIN TRAN;",
		"SAVE TRANSACTION before_import;",
		"ROLLBACK TRANSACTION before_import;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "sqlserver",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("named SQL Server rollback has ambiguous savepoint semantics and must keep cleanup active, got %v", err)
	}
	if result.Executed != 3 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	wantQueries := []string{
		"BEGIN TRAN",
		"SAVE TRANSACTION before_import",
		"ROLLBACK TRANSACTION before_import",
		"ROLLBACK TRANSACTION",
	}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("named rollback session was not cleaned conservatively: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("named rollback session must not be reused: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamClosesSQLServerNamedOuterTransactionRollback(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"BEGIN TRANSACTION import_work;",
		"INSERT INTO demo(id) VALUES (1);",
		"ROLLBACK TRANSACTION import_work;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "sqlserver",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("rollback to the tracked outer transaction name must close it: %v", err)
	}
	if result.Executed != 3 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("dedicated SQL-file session must be discarded after named rollback: %#v", fakeDB.session)
	}
	if len(fakeDB.execQueries) != 3 {
		t.Fatalf("named outer rollback must not trigger an extra cleanup rollback: %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamKeepsCaseDistinctSQLServerSavepointTransactionOpen(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"BEGIN TRANSACTION ImportWork;",
		"SAVE TRANSACTION importwork;",
		"ROLLBACK TRANSACTION importwork;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "sqlserver",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("case-distinct savepoint rollback must leave the outer transaction open: %v", err)
	}
	if result.Executed != 3 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.execQueries[len(fakeDB.execQueries)-1] != "ROLLBACK TRANSACTION" {
		t.Fatalf("outer transaction was not cleaned up: %#v", fakeDB.execQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("savepoint rollback session must be discarded: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamClosesSQLServerTransactionAfterNamedRollbackAndCommit(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"BEGIN TRAN;",
		"SAVE TRANSACTION before_import;",
		"ROLLBACK TRANSACTION before_import;",
		"COMMIT;",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "sqlserver",
		ContinueOnError: false,
	}, nil)
	if err != nil {
		t.Fatalf("final COMMIT should close the transaction retained after named rollback: %v", err)
	}
	if result.Executed != 4 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("dedicated SQL-file session must be discarded after commit: %#v", fakeDB.session)
	}
}

func TestExecuteSQLFileStreamKeepsTransactionOpenWhenFinishStatementFailsInContinueMode(t *testing.T) {
	tests := []struct {
		name      string
		finishSQL string
	}{
		{name: "commit fails", finishSQL: "COMMIT"},
		{name: "rollback fails", finishSQL: "ROLLBACK"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fakeDB := &fakeSQLFileBatchDB{failExecSQL: test.finishSQL}
			input := strings.Join([]string{
				"START TRANSACTION;",
				"INSERT INTO demo(id) VALUES (1);",
				test.finishSQL + ";",
			}, "\n")

			result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
				DBType:          "mysql",
				ContinueOnError: true,
			}, nil)
			if !errors.Is(err, errSQLFileStoppedOnError) {
				t.Fatalf("failed transaction finish must leave cleanup active, got %v", err)
			}
			if result.Executed != 2 || result.Failed != 2 {
				t.Fatalf("unexpected execution counters: %#v", result)
			}
			if !result.OutcomeUnknown {
				t.Fatalf("failed user %s after dispatch must retain an unknown commit outcome: %#v", test.finishSQL, result)
			}
			if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
				t.Fatalf("unexpected cleanup state: %#v", fakeDB.session)
			}
			if fakeDB.execQueries[len(fakeDB.execQueries)-1] != "ROLLBACK" {
				t.Fatalf("expected final cleanup rollback, got %#v", fakeDB.execQueries)
			}
		})
	}
}

func TestExecuteSQLFileStreamMarksCancelledUserTransactionFinishUnknown(t *testing.T) {
	for _, finishSQL := range []string{"COMMIT", "ROLLBACK"} {
		t.Run(strings.ToLower(finishSQL), func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			fakeDB := &fakeSQLFileBatchDB{execError: func(query string) error {
				if query == finishSQL {
					cancel()
					return context.Canceled
				}
				return nil
			}}
			input := "START TRANSACTION;\nINSERT INTO demo(id) VALUES (1);\n" + finishSQL + ";"

			result, err := executeSQLFileStream(ctx, fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
				DBType:          "mysql",
				ContinueOnError: false,
			}, nil)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled %s returned %v", finishSQL, err)
			}
			if !result.OutcomeUnknown || result.Executed != 2 || result.Failed != 0 {
				t.Fatalf("cancelled %s after dispatch must retain an unknown outcome: %#v", finishSQL, result)
			}
		})
	}
}

func TestExecuteSQLFileStreamDoesNotOpenTransactionWhenStartFailsInContinueMode(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "START TRANSACTION"}
	input := "START TRANSACTION;\nCREATE TABLE demo(id INT);"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if err != nil {
		t.Fatalf("failed START must not create a synthetic unclosed transaction: %v", err)
	}
	if result.Executed != 1 || result.Failed != 1 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if len(fakeDB.execQueries) != 2 {
		t.Fatalf("failed START unexpectedly triggered cleanup: %#v", fakeDB.execQueries)
	}
}
