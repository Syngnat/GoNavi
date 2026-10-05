package app

import (
	"context"
	"errors"
	"fmt"
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
