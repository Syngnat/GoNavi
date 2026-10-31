package app

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/hivesql"
)

func TestHiveTransferSQLFilePinsSessionAndNeverUsesTransactionsOrBatch(t *testing.T) {
	literal, err := hivesql.Value("STRING", "C:\\end\\';still-one-value")
	if err != nil {
		t.Fatal(err)
	}
	input := "SET hive.exec.dynamic.partition=true; USE source; CREATE TEMPORARY TABLE tmp (s STRING); INSERT INTO TABLE tmp SELECT " + literal + ";"
	database := &hiveTransferFake{}
	var progress []sqlFileExecutionProgress
	result, err := executeSQLFileStream(context.Background(), database, strings.NewReader(input), sqlFileExecutionOptions{
		DBType: "hive", PinDatabase: "target", BatchMaxStatements: 1,
		OnProgress: func(value sqlFileExecutionProgress) { progress = append(progress, value) },
	}, func() int64 { return int64(len(input)) })
	if err != nil || result.Executed != 4 || result.Failed != 0 || result.OutcomeUnknown {
		t.Fatalf("result=%#v err=%v", result, err)
	}
	if database.opened != 1 || database.rootExec != 0 || database.batchCalls != 0 || database.session.batchCalls != 0 || database.session.closed != 1 || database.session.discarded != 1 {
		t.Fatalf("unsafe session/batch lifecycle: %#v / %#v", database, database.session)
	}
	if got := database.session.statements[1]; got != "USE "+hivesql.QuoteIdentifier("target") {
		t.Fatalf("USE was not pinned: %q", got)
	}
	if !strings.HasSuffix(database.session.statements[3], literal) || len(progress) != 4 {
		t.Fatalf("literal/progress mismatch: %#v / %#v", database.session.statements, progress)
	}
	for _, statement := range database.session.statements {
		upper := strings.ToUpper(statement)
		for _, forbidden := range []string{"BEGIN", "START TRANSACTION", "COMMIT", "ROLLBACK", "FOREIGN_KEY_CHECKS"} {
			if strings.HasPrefix(upper, forbidden) {
				t.Fatalf("Hive must not inherit MySQL session machinery: %s", statement)
			}
		}
	}
}

func TestHiveTransferSQLFileRequiresRealPinnedSession(t *testing.T) {
	database := &fakeExportQueryDB{}
	result, err := executeSQLFileStream(context.Background(), database, strings.NewReader("SELECT 1;"), sqlFileExecutionOptions{DBType: "hive"}, nil)
	if err == nil || result.Executed != 0 {
		t.Fatalf("unpinned Hive execution accepted: %#v, %v", result, err)
	}
}

func TestHiveTransferSQLFileFailureOutcomes(t *testing.T) {
	for _, test := range []struct {
		name                     string
		continueOnError          bool
		failure                  error
		wantExecuted, wantFailed int
		wantError, unknown       bool
	}{
		{name: "stop", failure: errors.New("invalid statement"), wantExecuted: 1, wantFailed: 1, wantError: true},
		{name: "continue", continueOnError: true, failure: errors.New("invalid statement"), wantExecuted: 2, wantFailed: 1},
		{name: "ambiguous stops continue", continueOnError: true, failure: db.MarkWriteOutcomeUnknown(errors.New("response lost")), wantExecuted: 1, wantFailed: 1, wantError: true, unknown: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := &hiveTransferFake{session: &hiveTransferSession{failAt: 2, failure: test.failure}}
			result, err := executeSQLFileStream(context.Background(), database, strings.NewReader("SELECT 1; SELECT 2; SELECT 3;"), sqlFileExecutionOptions{DBType: "hive", ContinueOnError: test.continueOnError}, nil)
			if (err != nil) != test.wantError || result.Executed != test.wantExecuted || result.Failed != test.wantFailed || result.OutcomeUnknown != test.unknown {
				t.Fatalf("result=%#v err=%v", result, err)
			}
			if database.session.closed != 1 || database.session.discarded != 1 {
				t.Fatalf("session leaked: %#v", database.session)
			}
		})
	}
}

func TestHiveTransferSQLFileCancellationAndCleanupErrors(t *testing.T) {
	t.Run("cancel", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		database := &hiveTransferFake{session: &hiveTransferSession{afterExec: cancel}}
		result, err := executeSQLFileStream(ctx, database, strings.NewReader("SELECT 1; SELECT 2;"), sqlFileExecutionOptions{DBType: "hive"}, nil)
		if !errors.Is(err, context.Canceled) || result.Executed != 1 || database.session.closed != 1 {
			t.Fatalf("cancel result=%#v err=%v session=%#v", result, err, database.session)
		}
	})
	t.Run("cleanup errors propagate", func(t *testing.T) {
		errClose, errDiscard := errors.New("close failure"), errors.New("discard failure")
		database := &hiveTransferFake{session: &hiveTransferSession{closeError: errClose, discardError: errDiscard}}
		_, err := executeSQLFileStream(context.Background(), database, strings.NewReader("SELECT 1;"), sqlFileExecutionOptions{DBType: "hive"}, nil)
		if !errors.Is(err, errClose) || !errors.Is(err, errDiscard) {
			t.Fatal(err)
		}
	})
}

func TestHiveTransferSQLPreflightRejectsClientCommandsAndTransactions(t *testing.T) {
	for _, test := range []struct {
		statement string
		safe      bool
		code      SQLImportPreflightReasonCode
	}{
		{statement: "!connect jdbc:hive2://host", code: SQLImportPreflightHiveClientCommand},
		{statement: "source restore.hql", code: SQLImportPreflightHiveClientCommand},
		{statement: "SELECT 1\n!sh rm", code: SQLImportPreflightHiveClientCommand},
		{statement: "SELECT '!connect'", safe: true},
		{statement: "SELECT 'line\n!sh quoted'", safe: true},
		{statement: "-- !sh ignored\nSELECT 1", safe: true},
		{statement: "SET hive.exec.dynamic.partition=true", safe: true},
		{statement: "USE warehouse", safe: true},
		{statement: "BEGIN", code: SQLImportPreflightHiveTransactionControl},
		{statement: "START TRANSACTION", code: SQLImportPreflightHiveTransactionControl},
		{statement: "COMMIT", code: SQLImportPreflightHiveTransactionControl},
		{statement: "ROLLBACK", code: SQLImportPreflightHiveTransactionControl},
		{statement: "SAVEPOINT s", code: SQLImportPreflightHiveTransactionControl},
		{statement: "SET autocommit=false", code: SQLImportPreflightHiveTransactionControl},
	} {
		t.Run(test.statement, func(t *testing.T) {
			result := PreflightSQLStatement(test.statement, "hive", 3)
			if result.Safe != test.safe || (!test.safe && (result.Reason == nil || result.Reason.Code != test.code || result.Reason.StatementIndex != 3)) {
				t.Fatalf("preflight %#v", result)
			}
		})
	}
	result, err := executeSQLFileStream(context.Background(), &hiveTransferFake{}, strings.NewReader("BEGIN; SELECT 1;"), sqlFileExecutionOptions{DBType: "hive"}, nil)
	if err == nil || result.Executed != 0 {
		t.Fatalf("transaction was sent to Hive: %#v %v", result, err)
	}
}

func TestHiveTransferSQLProgressIsBounded(t *testing.T) {
	var count int
	runner := hiveSQLFileRunner{ctx: context.Background(), execer: &hiveTransferSession{}, options: sqlFileExecutionOptions{OnProgress: func(sqlFileExecutionProgress) { count++ }}}
	for i := 0; i < 20; i++ {
		if err := runner.consume(i, "SELECT 1"); err != nil {
			t.Fatal(err)
		}
	}
	if count != 10 || runner.result.Executed != 20 {
		t.Fatalf("progress count=%d executed=%d", count, runner.result.Executed)
	}
}

func TestHiveTransferSQLBackupBootstrapsDeletedDatabase(t *testing.T) {
	for _, sql := range []string{"CREATE DATABASE source", "CREATE DATABASE IF NOT EXISTS source;"} {
		got := pinSQLFileImportDatabase("hive", sql, "target")
		if !strings.HasSuffix(got, hivesql.QuoteIdentifier("target")) || strings.Contains(got, "source") {
			t.Fatalf("Hive CREATE DATABASE was not pinned: %s", got)
		}
	}
	if got := pinHiveCreateDatabase("CREATE TABLE source (id INT)", "target"); got != "CREATE TABLE source (id INT)" {
		t.Fatal(got)
	}
	if got := pinHiveCreateDatabase("CREATE DATABASE source LOCATION 's3://bucket'", "target"); got != "CREATE DATABASE source LOCATION 's3://bucket'" {
		t.Fatal(got)
	}
	var buffer bytes.Buffer
	writer := bufio.NewWriter(&buffer)
	if err := writeSQLDatabaseBackupHeader(writer, connection.ConnectionConfig{Type: "hive"}, "warehouse"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Flush(); err != nil {
		t.Fatal(err)
	}
	preamble := buffer.Bytes()
	if !hiveBackupCreatesDatabase(preamble) {
		t.Fatalf("missing Hive bootstrap: %s", preamble)
	}
	got := resolveSQLFileExecutionRunConfig(connection.ConnectionConfig{Type: "hive", Database: "warehouse"}, "warehouse", preamble)
	if got.Database != "" {
		t.Fatalf("cannot restore a deleted Hive database: %#v", got)
	}
	got = resolveSQLFileExecutionRunConfig(connection.ConnectionConfig{Type: "hive"}, "selected", []byte("SELECT 1;"))
	if got.Database != "selected" || hiveBackupCreatesDatabase([]byte("CREATE DATABASE IF NOT EXISTS x")) {
		t.Fatalf("regular SQL changed its selected database: %#v", got)
	}
}
