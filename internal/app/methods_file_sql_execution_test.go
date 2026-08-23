package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestResolveSQLFileExecutionProgressPercentReservesCompletionForTerminalState(t *testing.T) {
	tests := []struct {
		name      string
		status    string
		bytesRead int64
		totalSize int64
		want      float64
	}{
		{name: "running reader reached eof", status: "running", bytesRead: 128, totalSize: 128, want: 99},
		{name: "running partial read", status: "running", bytesRead: 64, totalSize: 128, want: 50},
		{name: "done", status: "done", bytesRead: 128, totalSize: 128, want: 100},
		{name: "unknown size", status: "running", bytesRead: 64, totalSize: 0, want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveSQLFileExecutionProgressPercent(tt.status, tt.bytesRead, tt.totalSize); got != tt.want {
				t.Fatalf("percent = %v, want %v", got, tt.want)
			}
		})
	}
}

type fakeSQLFileBatchDB struct {
	batchCalls   int
	execCalls    int
	batchQueries []string
	execQueries  []string
	failBatch    bool
	failBatchSQL string
	batchError   error
	failExecSQL  string
	execError    func(string) error
	onBatch      func()
	session      *fakeSQLFileSessionDB
}

func (f *fakeSQLFileBatchDB) Connect(config connection.ConnectionConfig) error {
	return nil
}

func (f *fakeSQLFileBatchDB) Close() error {
	return nil
}

func (f *fakeSQLFileBatchDB) Ping() error {
	return nil
}

func (f *fakeSQLFileBatchDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, nil
}

func (f *fakeSQLFileBatchDB) Exec(query string) (int64, error) {
	f.execCalls++
	f.execQueries = append(f.execQueries, query)
	if f.execError != nil {
		if err := f.execError(query); err != nil {
			return 0, err
		}
	}
	if f.failExecSQL != "" && strings.Contains(query, f.failExecSQL) {
		return 0, errors.New("exec failed")
	}
	return 1, nil
}

func (f *fakeSQLFileBatchDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	f.batchCalls++
	f.batchQueries = append(f.batchQueries, query)
	if f.onBatch != nil {
		f.onBatch()
	}
	if f.failBatch || (f.failBatchSQL != "" && strings.Contains(query, f.failBatchSQL)) {
		if f.batchError != nil {
			return 0, f.batchError
		}
		return 0, errors.New("batch failed")
	}
	return int64(strings.Count(query, "INSERT")), nil
}

func TestExecuteSQLFileStreamRedactsBatchExecutionErrors(t *testing.T) {
	const secret = "password=super-secret-token"
	fakeDB := &fakeSQLFileBatchDB{
		failBatch:  true,
		batchError: errors.New("duplicate key value is (alice@example.com); " + secret),
	}
	input := "INSERT INTO demo(email) VALUES ('alice@example.com');"

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "postgres",
		ContinueOnError: false,
		Text: func(key string, params map[string]any) string {
			return fmt.Sprintf("%s: %v", key, params["detail"])
		},
	}, nil)
	if err == nil {
		t.Fatal("failed batch must stop SQL file execution")
	}
	combined := err.Error() + " " + strings.Join(result.Errors, " ")
	for _, sensitive := range []string{secret, "super-secret-token", "alice@example.com"} {
		if strings.Contains(combined, sensitive) {
			t.Fatalf("batch error leaked %q: %s", sensitive, combined)
		}
	}
}

func TestExecuteSQLFileStreamDoesNotContinueAfterUnknownWriteOutcome(t *testing.T) {
	database := &fakeSQLFileBatchDB{execError: func(query string) error {
		if strings.HasPrefix(query, "CREATE TABLE") {
			return db.MarkWriteOutcomeUnknown(errors.New("write response lost"))
		}
		return nil
	}}
	result, err := executeSQLFileStream(context.Background(), database, strings.NewReader("CREATE TABLE demo(id integer); INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
		DBType:          "postgres",
		TransactionMode: sqlFileTransactionModeOff,
		ContinueOnError: true,
	}, nil)
	if err == nil || !result.OutcomeUnknown {
		t.Fatalf("unknown write result = %#v, err=%v; want stopped unknown outcome", result, err)
	}
	if len(database.execQueries) != 1 || database.execQueries[0] != "CREATE TABLE demo(id integer)" {
		t.Fatalf("unknown write was continued or replayed: %#v", database.execQueries)
	}
}

func TestExecuteSQLFileBatchUnknownOutcomeDisablesFallback(t *testing.T) {
	database := &fakeSQLFileBatchDB{
		failBatch:  true,
		batchError: db.MarkWriteOutcomeUnknown(errors.New("batch response lost")),
	}
	canFallback, outcomeUnknown, err := executeSQLFileBatchWithOutcome(
		context.Background(), database, database, "mysql", "INSERT INTO demo(id) VALUES (1)", false, nil,
	)
	if err == nil || canFallback || !outcomeUnknown {
		t.Fatalf("batch unknown result = canFallback=%t outcomeUnknown=%t err=%v; want no fallback and unknown", canFallback, outcomeUnknown, err)
	}
}

func (f *fakeSQLFileBatchDB) GetDatabases() ([]string, error) {
	return nil, nil
}

func (f *fakeSQLFileBatchDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}

func (f *fakeSQLFileBatchDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}

func (f *fakeSQLFileBatchDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}

func (f *fakeSQLFileBatchDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *fakeSQLFileBatchDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *fakeSQLFileBatchDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *fakeSQLFileBatchDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

var _ db.BatchWriteExecer = (*fakeSQLFileBatchDB)(nil)

func (f *fakeSQLFileBatchDB) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	f.session = &fakeSQLFileSessionDB{parent: f}
	return f.session, nil
}

type fakeSQLFileSessionDB struct {
	parent    *fakeSQLFileBatchDB
	closed    bool
	discarded bool
}

type fakeSQLFileBatchCapabilityDB struct {
	*fakeSQLFileBatchDB
	batchWritesEnabled bool
}

type fakeSQLFileUnpinnedDB struct {
	db.Database
	execCalls int
}

func (*fakeSQLFileUnpinnedDB) Connect(connection.ConnectionConfig) error { return nil }
func (*fakeSQLFileUnpinnedDB) Close() error                              { return nil }
func (*fakeSQLFileUnpinnedDB) Ping() error                               { return nil }

func (database *fakeSQLFileUnpinnedDB) Exec(string) (int64, error) {
	database.execCalls++
	return 1, nil
}

func (f *fakeSQLFileBatchCapabilityDB) SupportsBatchWrites() bool {
	return f != nil && f.batchWritesEnabled
}

func (s *fakeSQLFileSessionDB) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *fakeSQLFileSessionDB) ExecContext(ctx context.Context, query string) (int64, error) {
	return s.parent.Exec(query)
}

func (s *fakeSQLFileSessionDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	return s.parent.ExecBatchContext(ctx, query)
}

func (s *fakeSQLFileSessionDB) Close() error {
	s.closed = true
	return nil
}

func (s *fakeSQLFileSessionDB) Discard() error {
	s.discarded = true
	return nil
}

func TestExecuteSQLFileStreamBatchesWriteStatements(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"INSERT INTO demo(id) VALUES (3);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 3 || result.Failed != 0 {
		t.Fatalf("expected 3 executed and 0 failed, got %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("expected one batch call, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 2 {
		t.Fatalf("expected transaction wrapper exec calls only, got %d", fakeDB.execCalls)
	}
	if fakeDB.execQueries[0] != "START TRANSACTION" || fakeDB.execQueries[1] != "COMMIT" {
		t.Fatalf("expected transaction wrapper around batch, got %#v", fakeDB.execQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatalf("expected SQL file import to use and close an isolated session")
	}
	if !strings.Contains(fakeDB.batchQueries[0], "INSERT INTO demo(id) VALUES (1);\nINSERT INTO demo(id) VALUES (2)") {
		t.Fatalf("expected batched SQL to join statements, got %q", fakeDB.batchQueries[0])
	}
}

func TestExecuteSQLFileStreamMarksAutomaticBatchTransactionFinishFailureUnknown(t *testing.T) {
	tests := []struct {
		name      string
		failBatch bool
		finishSQL string
	}{
		{name: "commit fails", finishSQL: "COMMIT"},
		{name: "rollback fails", failBatch: true, finishSQL: "ROLLBACK"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fakeDB := &fakeSQLFileBatchDB{
				failBatch:   test.failBatch,
				failExecSQL: test.finishSQL,
			}
			input := "INSERT INTO demo(id) VALUES (1);\nINSERT INTO demo(id) VALUES (2);"

			result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
				DBType:             "mysql",
				BatchMaxStatements: 100,
				BatchMaxBytes:      1024,
				ContinueOnError:    false,
			}, nil)
			if err == nil {
				t.Fatal("failed transaction finish must stop SQL file execution")
			}
			if !result.OutcomeUnknown {
				t.Fatalf("failed %s after dispatch must retain an unknown commit outcome: %#v", test.finishSQL, result)
			}
		})
	}
}

func TestExecuteSQLFileStreamSkipsBatchAttemptWhenRuntimeCapabilityIsDisabled(t *testing.T) {
	baseDB := &fakeSQLFileBatchDB{}
	fakeDB := &fakeSQLFileBatchCapabilityDB{
		fakeSQLFileBatchDB: baseDB,
		batchWritesEnabled: false,
	}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 2 || result.Failed != 0 {
		t.Fatalf("expected both statements to execute sequentially, got %#v", result)
	}
	if baseDB.batchCalls != 0 {
		t.Fatalf("disabled runtime capability still attempted %d batches", baseDB.batchCalls)
	}
	if baseDB.execCalls != 2 {
		t.Fatalf("expected two direct statement calls without failed batch preflight, got %d: %#v", baseDB.execCalls, baseDB.execQueries)
	}
}

func TestExecuteSQLFileStreamFlushesBatchBeforeReadStatement(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"SELECT * FROM demo;",
		"INSERT INTO demo(id) VALUES (3);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 4 || result.Failed != 0 {
		t.Fatalf("expected 4 executed and 0 failed, got %#v", result)
	}
	if fakeDB.batchCalls != 2 {
		t.Fatalf("expected two batch calls around read statement, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 5 {
		t.Fatalf("expected transaction wrappers plus one read exec call, got %d", fakeDB.execCalls)
	}
	if fakeDB.execQueries[2] != "SELECT * FROM demo" {
		t.Fatalf("expected read statement to execute outside batch, got %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamUsesSafeSequentialExecutionForMySQLFamilyContinueOnError(t *testing.T) {
	for _, dbType := range []string{"mysql", "mariadb"} {
		t.Run(dbType, func(t *testing.T) {
			fakeDB := &fakeSQLFileBatchDB{failBatch: true, failExecSQL: "VALUES (2)"}
			input := strings.Join([]string{
				"INSERT INTO demo(id) VALUES (1);",
				"INSERT INTO demo(id) VALUES (2);",
				"INSERT INTO demo(id) VALUES (3);",
			}, "\n")

			result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
				DBType:             dbType,
				BatchMaxStatements: 100,
				BatchMaxBytes:      1024,
				ContinueOnError:    true,
			}, nil)
			if err != nil {
				t.Fatalf("executeSQLFileStream returned error: %v", err)
			}
			if result.Executed != 2 || result.Failed != 1 {
				t.Fatalf("expected 2 executed and 1 failed, got %#v", result)
			}
			if fakeDB.batchCalls != 0 {
				t.Fatalf("%s continue mode must not batch before knowing whether writes are transactional, got %d calls", dbType, fakeDB.batchCalls)
			}
			if fakeDB.execCalls != 3 {
				t.Fatalf("expected exactly 3 sequential statement calls, got %d", fakeDB.execCalls)
			}
			if fakeDB.execQueries[0] != "INSERT INTO demo(id) VALUES (1)" || fakeDB.execQueries[2] != "INSERT INTO demo(id) VALUES (3)" {
				t.Fatalf("unexpected sequential execution order: %#v", fakeDB.execQueries)
			}
			if len(result.Errors) != 1 || result.Errors[0] != "file.backend.message.statement_failed" {
				t.Fatalf("expected per-statement error for second statement, got %#v", result.Errors)
			}
		})
	}
}

func TestExecuteSQLFileStreamAdaptivelyNarrowsLargeFailedBatchInContinueMode(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{
		failBatchSQL: "VALUES (33)",
		failExecSQL:  "VALUES (33)",
	}
	statements := make([]string, 64)
	for index := range statements {
		statements[index] = fmt.Sprintf("INSERT INTO demo(id) VALUES (%d);", index+1)
	}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(strings.Join(statements, "\n")), sqlFileExecutionOptions{
		DBType:             "postgres",
		BatchMaxStatements: 100,
		BatchMaxBytes:      64 * 1024,
		ContinueOnError:    true,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 63 || result.Failed != 1 {
		t.Fatalf("expected 63 executed and 1 failed, got %#v", result)
	}
	if fakeDB.batchCalls != 5 {
		t.Fatalf("expected five adaptive batch attempts, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls >= 40 {
		t.Fatalf("adaptive isolation regressed toward whole-batch sequential replay: execCalls=%d", fakeDB.execCalls)
	}
}

func TestExecuteSQLFileStreamStopsAfterFailedBatchWithoutSequentialReplay(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failBatch: true, failExecSQL: "VALUES (2)"}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"INSERT INTO demo(id) VALUES (3);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
		ContinueOnError:    false,
	}, nil)
	if err == nil {
		t.Fatal("expected failed batch to stop SQL file execution")
	}
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected stop-on-error sentinel, got %v", err)
	}
	if result.Executed != 0 || result.Failed != 1 {
		t.Fatalf("expected 0 executed and 1 observed failure, got %#v", result)
	}
	if !result.OutcomeUnknown {
		t.Fatalf("MySQL-family batch rollback cannot prove non-transactional tables were restored: %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("expected one failed batch attempt, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 2 {
		t.Fatalf("expected only transaction begin and rollback, got %d calls: %#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != "START TRANSACTION" || fakeDB.execQueries[1] != "ROLLBACK" {
		t.Fatalf("expected failed batch to roll back without replay, got %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamDoesNotReplayWhenAutomaticBatchBeginFails(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "BEGIN"}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "postgres",
		ContinueOnError: true,
	}, nil)
	if err == nil {
		t.Fatal("expected failed automatic batch transaction to stop execution")
	}
	if result.Executed != 0 || result.Failed != 0 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("batch SQL must not run after START TRANSACTION fails, got %d calls", fakeDB.batchCalls)
	}
	wantQueries := []string{"BEGIN", "ROLLBACK"}
	if fmt.Sprint(fakeDB.execQueries) != fmt.Sprint(wantQueries) {
		t.Fatalf("failed batch BEGIN was replayed or left dirty: got %#v want %#v", fakeDB.execQueries, wantQueries)
	}
}

func TestExecuteSQLFileStreamTreatsCancelledBatchAsCancellationWithoutReplay(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	fakeDB := &fakeSQLFileBatchDB{
		failBatch: true,
		onBatch:   cancel,
	}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(ctx, fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "postgres",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
		ContinueOnError:    true,
	}, nil)
	if err == nil || err.Error() != "已取消" {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if result.Executed != 0 || result.Failed != 0 {
		t.Fatalf("cancellation must not be counted as a SQL failure, got %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("expected one interrupted batch attempt, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 2 {
		t.Fatalf("expected only transaction begin and rollback, got %d calls: %#v", fakeDB.execCalls, fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamMarksInFlightStatementCancellationUnknown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	fakeDB := &fakeSQLFileBatchDB{execError: func(query string) error {
		if strings.Contains(query, "INSERT INTO demo") {
			cancel()
			return context.Canceled
		}
		return nil
	}}

	result, err := executeSQLFileStream(ctx, fakeDB, strings.NewReader("INSERT INTO demo(id) VALUES (1);"), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if !result.OutcomeUnknown || result.Executed != 0 || result.Failed != 0 {
		t.Fatalf("in-flight cancellation must retain unknown commit outcome: %#v", result)
	}
}

func TestExecuteSQLFileStreamDiscardsSuccessfulSessionToPreventStateLeak(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader("USE tenant_b;"), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if err != nil || result.Executed != 1 || result.Failed != 0 {
		t.Fatalf("successful session-scoped statement failed: result=%#v err=%v", result, err)
	}
	if fakeDB.session == nil || !fakeDB.session.discarded || !fakeDB.session.closed {
		t.Fatalf("successful SQL-file session must be discarded before returning to the pool: %#v", fakeDB.session)
	}
}

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

func TestExecuteSQLFileStreamStopsAfterSingleStatementError(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "CREATE TABLE broken"}
	input := strings.Join([]string{
		"CREATE TABLE broken(id INT);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: false,
	}, nil)
	if !errors.Is(err, errSQLFileStoppedOnError) {
		t.Fatalf("expected stop-on-error sentinel, got %v", err)
	}
	if result.Executed != 0 || result.Failed != 1 {
		t.Fatalf("expected the first failed statement to stop execution, got %#v", result)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected no later write batch, got %d batch calls", fakeDB.batchCalls)
	}
	if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != "CREATE TABLE broken(id INT)" {
		t.Fatalf("expected only the failing statement to run, got %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamCapsRetainedErrorDetailsInContinueMode(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failExecSQL: "CREATE TABLE broken_"}
	statements := make([]string, 25)
	for index := range statements {
		statements[index] = fmt.Sprintf("CREATE TABLE broken_%d(id INT);", index)
	}

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(strings.Join(statements, "\n")), sqlFileExecutionOptions{
		DBType:          "mysql",
		ContinueOnError: true,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 0 || result.Failed != 25 {
		t.Fatalf("unexpected execution counters: %#v", result)
	}
	if len(result.Errors) != sqlFileMaxErrorDetails {
		t.Fatalf("retained %d error details, want cap %d", len(result.Errors), sqlFileMaxErrorDetails)
	}
}

func TestExecuteSQLFileStreamDoesNotRetryFailedOversizedStatement(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failBatch: true}
	largeValue := strings.Repeat("x", 256)
	input := fmt.Sprintf("INSERT INTO demo(value) VALUES ('%s');", largeValue)

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "postgres",
		BatchMaxStatements: 100,
		BatchMaxBytes:      64,
		ContinueOnError:    true,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 0 || result.Failed != 1 {
		t.Fatalf("expected the oversized statement failure to be recorded once, got %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("expected one oversized statement attempt, got %d", fakeDB.batchCalls)
	}
	if len(fakeDB.execQueries) != 2 || fakeDB.execQueries[0] != "BEGIN" || fakeDB.execQueries[1] != "ROLLBACK" {
		t.Fatalf("expected no second execution of the oversized statement, got %#v", fakeDB.execQueries)
	}
}

func TestExecuteSQLFileStreamUsesLocalizedStatementFailure(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{failBatch: true, failExecSQL: "VALUES (2)"}
	input := strings.Join([]string{
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
		ContinueOnError:    true,
		Text: func(key string, params map[string]any) string {
			if key != "file.backend.message.statement_failed" {
				t.Fatalf("unexpected i18n key %q", key)
			}
			return fmt.Sprintf("localized statement %v failed: %v SQL=%v", params["index"], params["detail"], params["sql"])
		},
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if len(result.Errors) != 1 {
		t.Fatalf("expected one localized statement error, got %#v", result.Errors)
	}
	if !strings.Contains(result.Errors[0], "localized statement 2 failed") || !strings.Contains(result.Errors[0], "VALUES (?)") {
		t.Fatalf("expected localized per-statement error with redacted SQL snippet, got %#v", result.Errors)
	}
	if strings.Contains(result.Errors[0], "VALUES (2)") {
		t.Fatalf("expected statement failure to omit SQL literal values, got %#v", result.Errors)
	}
}

func TestExecuteSQLFileStreamDoesNotBatchSessionControlStatements(t *testing.T) {
	fakeDB := &fakeSQLFileBatchDB{}
	input := strings.Join([]string{
		"SET FOREIGN_KEY_CHECKS=0;",
		"INSERT INTO demo(id) VALUES (1);",
		"INSERT INTO demo(id) VALUES (2);",
		"CREATE TABLE demo2(id INT);",
		"INSERT INTO demo2(id) VALUES (3);",
	}, "\n")

	result, err := executeSQLFileStream(context.Background(), fakeDB, strings.NewReader(input), sqlFileExecutionOptions{
		DBType:             "mysql",
		BatchMaxStatements: 100,
		BatchMaxBytes:      1024,
	}, nil)
	if err != nil {
		t.Fatalf("executeSQLFileStream returned error: %v", err)
	}
	if result.Executed != 5 || result.Failed != 0 {
		t.Fatalf("expected 5 executed and 0 failed, got %#v", result)
	}
	if fakeDB.batchCalls != 2 {
		t.Fatalf("expected two DML batch calls split by control/DDL statements, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 6 {
		t.Fatalf("expected SET, CREATE, and transaction wrappers to execute sequentially, got %d", fakeDB.execCalls)
	}
	if fakeDB.execQueries[0] != "SET FOREIGN_KEY_CHECKS=0" || fakeDB.execQueries[3] != "CREATE TABLE demo2(id INT)" {
		t.Fatalf("unexpected sequential statements: %#v", fakeDB.execQueries)
	}
}

type chunkedReader struct {
	data []byte
	step int
}

func (r *chunkedReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	n := r.step
	if n <= 0 || n > len(r.data) {
		n = len(r.data)
	}
	if n > len(p) {
		n = len(p)
	}
	copy(p, r.data[:n])
	r.data = r.data[n:]
	return n, nil
}

func TestStreamSQLFileHandlesLongSingleLineAcrossChunks(t *testing.T) {
	longValue := strings.Repeat("x", 5*1024*1024)
	input := fmt.Sprintf("INSERT INTO demo(value) VALUES ('%s');SELECT 1;", longValue)
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 257}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%d", count, len(statements))
	}
	if !strings.HasPrefix(statements[0], "INSERT INTO demo(value)") {
		t.Fatalf("expected first statement to be insert, got %.80q", statements[0])
	}
	if statements[1] != "SELECT 1" {
		t.Fatalf("expected second statement SELECT 1, got %q", statements[1])
	}
}

func TestStreamSQLFileHandlesSplitTokenBoundaries(t *testing.T) {
	input := strings.Join([]string{
		"SELECT 1 -- comment; still comment",
		"SELECT 'it''s ok';",
		"SELECT $tag$hello;world$tag$;",
		"SELECT 2；",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 1}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 3 || len(statements) != 3 {
		t.Fatalf("expected 3 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != "SELECT 1 -- comment; still comment\nSELECT 'it''s ok'" {
		t.Fatalf("unexpected first statement: %q", statements[0])
	}
	if statements[1] != "SELECT $tag$hello;world$tag$" {
		t.Fatalf("unexpected dollar-quoted statement: %q", statements[1])
	}
	if statements[2] != "SELECT 2" {
		t.Fatalf("unexpected full-width semicolon statement: %q", statements[2])
	}
}

func TestStreamSQLFileKeepsOracleAnonymousBlockTogether(t *testing.T) {
	input := strings.Join([]string{
		"BEGIN",
		"  INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
		"  UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
		"  DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
		"END;",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 3}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"BEGIN",
		"  INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');",
		"  UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';",
		"  DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected anonymous block statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileKeepsOracleCreateProcedureTogether(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,",
		"  out_acceptno OUT t_accept_h.acceptno%TYPE",
		") IS",
		"  v_busno t_tally_accept_h.busno%TYPE;",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"  IF v_count > 0 THEN",
		"    out_acceptno := p_tallyacceptno;",
		"  END IF;",
		"END;",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 5}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,",
		"  out_acceptno OUT t_accept_h.acceptno%TYPE",
		") IS",
		"  v_busno t_tally_accept_h.busno%TYPE;",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"  IF v_count > 0 THEN",
		"    out_acceptno := p_tallyacceptno;",
		"  END IF;",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected create procedure statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileKeepsOracleCreateProcedureCursorCaseExpressionTogether(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_accept_to_add(",
		"  p_acceptno IN t_accept_h.acceptno%TYPE",
		") IS",
		"  CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS",
		"    SELECT si.compid, si.batid, si.wareid",
		"    FROM t_store_i si",
		"    ORDER BY CASE",
		"      WHEN p_ind = '1' THEN",
		"        to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))",
		"      WHEN p_ind = '2' THEN",
		"        lpad(to_char(floor(si.wareqty)), 10, '0')",
		"      ELSE",
		"        to_char(si.batid)",
		"    END,si.batid;",
		"BEGIN",
		"  NULL;",
		"END;",
		"/",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 4}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_accept_to_add(",
		"  p_acceptno IN t_accept_h.acceptno%TYPE",
		") IS",
		"  CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS",
		"    SELECT si.compid, si.batid, si.wareid",
		"    FROM t_store_i si",
		"    ORDER BY CASE",
		"      WHEN p_ind = '1' THEN",
		"        to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))",
		"      WHEN p_ind = '2' THEN",
		"        lpad(to_char(floor(si.wareqty)), 10, '0')",
		"      ELSE",
		"        to_char(si.batid)",
		"    END,si.batid;",
		"BEGIN",
		"  NULL;",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected create procedure statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileSkipsOracleSqlPlusSlashDelimiter(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE",
		") IS",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"END;",
		"/",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 2}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 2 || len(statements) != 2 {
		t.Fatalf("expected 2 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PROCEDURE proc_tally2accept(",
		"  p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE",
		") IS",
		"  v_count PLS_INTEGER;",
		"BEGIN",
		"  SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;",
		"END;",
	}, "\n") {
		t.Fatalf("unexpected create procedure statement: %q", statements[0])
	}
	if statements[1] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected second statement: %q", statements[1])
	}
}

func TestStreamSQLFileKeepsOraclePackageSpecAndBodyTogether(t *testing.T) {
	input := strings.Join([]string{
		"CREATE OR REPLACE PACKAGE pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER);",
		"END pkg_order;",
		"/",
		"CREATE OR REPLACE PACKAGE BODY pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER) IS",
		"  BEGIN",
		"    NULL;",
		"  END sync_order;",
		"END pkg_order;",
		"/ -- SQLPlus delimiter from PL/SQL tools",
		"SELECT 1 FROM dual;",
	}, "\n")
	var statements []string

	count, err := streamSQLFile(&chunkedReader{data: []byte(input), step: 3}, func(index int, stmt string) error {
		statements = append(statements, stmt)
		return nil
	})
	if err != nil {
		t.Fatalf("streamSQLFile returned error: %v", err)
	}
	if count != 3 || len(statements) != 3 {
		t.Fatalf("expected 3 statements, got count=%d statements=%#v", count, statements)
	}
	if statements[0] != strings.Join([]string{
		"CREATE OR REPLACE PACKAGE pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER);",
		"END pkg_order;",
	}, "\n") {
		t.Fatalf("unexpected package spec statement: %q", statements[0])
	}
	if statements[1] != strings.Join([]string{
		"CREATE OR REPLACE PACKAGE BODY pkg_order AS",
		"  PROCEDURE sync_order(p_id IN NUMBER) IS",
		"  BEGIN",
		"    NULL;",
		"  END sync_order;",
		"END pkg_order;",
	}, "\n") {
		t.Fatalf("unexpected package body statement: %q", statements[1])
	}
	if statements[2] != "SELECT 1 FROM dual" {
		t.Fatalf("unexpected third statement: %q", statements[2])
	}
}

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
