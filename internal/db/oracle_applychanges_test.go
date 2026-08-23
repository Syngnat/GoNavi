package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

const oracleRecordingDriverName = "gonavi_oracle_recording"

var (
	registerOracleRecordingDriverOnce sync.Once
	oracleRecordingDriverMu           sync.Mutex
	oracleRecordingDriverSeq          int
	oracleRecordingDriverStates       = map[string]*oracleRecordingState{}
)

type oracleRecordingState struct {
	mu                       sync.Mutex
	execQueries              []string
	execArgs                 [][]driver.NamedValue
	execStarted              chan struct{}
	execRelease              chan struct{}
	blockExecUntilCanceled   bool
	queries                  []string
	beginCalls               int
	rowsAffected             int64
	execErrors               map[string]error
	closeCalls               int
	txCommitErr              error
	txRollbackErr            error
	queryResults             map[string]oracleRecordingQueryResult
	queryError               error
	disableDefaultTabColumns bool
}

type oracleRecordingQueryResult struct {
	columns     []string
	columnTypes []string
	nullable    []bool
	rows        [][]driver.Value
}

func (s *oracleRecordingState) snapshotExecQueries() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.execQueries...)
}

func (s *oracleRecordingState) snapshotExecArgs() [][]driver.NamedValue {
	s.mu.Lock()
	defer s.mu.Unlock()

	result := make([][]driver.NamedValue, len(s.execArgs))
	for i, args := range s.execArgs {
		result[i] = append([]driver.NamedValue(nil), args...)
	}
	return result
}

func (s *oracleRecordingState) snapshotQueries() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.queries...)
}

func (s *oracleRecordingState) snapshotBeginCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.beginCalls
}

func (s *oracleRecordingState) snapshotCloseCalls() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeCalls
}

type oracleRecordingDriver struct{}

func (oracleRecordingDriver) Open(name string) (driver.Conn, error) {
	oracleRecordingDriverMu.Lock()
	state := oracleRecordingDriverStates[name]
	oracleRecordingDriverMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("recording state not found: %s", name)
	}
	return &oracleRecordingConn{state: state}, nil
}

type oracleRecordingConn struct {
	state *oracleRecordingState
}

func (c *oracleRecordingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, fmt.Errorf("prepare not supported in oracle recording driver: %s", query)
}

func (c *oracleRecordingConn) Close() error {
	c.state.mu.Lock()
	c.state.closeCalls++
	c.state.mu.Unlock()
	return nil
}

func (c *oracleRecordingConn) Begin() (driver.Tx, error) {
	c.state.mu.Lock()
	c.state.beginCalls++
	c.state.mu.Unlock()
	return &oracleRecordingTx{state: c.state}, nil
}

func (c *oracleRecordingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	c.state.execQueries = append(c.state.execQueries, query)
	c.state.execArgs = append(c.state.execArgs, append([]driver.NamedValue(nil), args...))
	blockUntilCanceled := c.state.blockExecUntilCanceled && query != "ROLLBACK"
	execStarted := c.state.execStarted
	execRelease := c.state.execRelease
	rowsAffected := c.state.rowsAffected
	execErr := c.state.execErrors[query]
	c.state.mu.Unlock()

	if blockUntilCanceled {
		select {
		case execStarted <- struct{}{}:
		default:
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-execRelease:
			return nil, fmt.Errorf("recording execution released without cancellation")
		}
	}
	if execErr != nil {
		return nil, execErr
	}
	return driver.RowsAffected(rowsAffected), nil
}

func (c *oracleRecordingConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.state.mu.Lock()
	c.state.queries = append(c.state.queries, query)
	disableDefaultTabColumns := c.state.disableDefaultTabColumns
	if err := c.state.queryError; err != nil {
		c.state.mu.Unlock()
		return nil, err
	}
	if result, ok := c.state.queryResults[query]; ok {
		c.state.mu.Unlock()
		return &oracleRecordingRows{
			columns:     append([]string(nil), result.columns...),
			columnTypes: append([]string(nil), result.columnTypes...),
			nullable:    append([]bool(nil), result.nullable...),
			rows:        cloneOracleRecordingRows(result.rows),
		}, nil
	}
	c.state.mu.Unlock()

	if strings.Contains(strings.ToLower(query), "tab_columns") && !disableDefaultTabColumns {
		return &oracleRecordingRows{
			columns: []string{"COLUMN_NAME", "DATA_TYPE", "NULLABLE", "DATA_DEFAULT", "COLUMN_KEY", "COMMENT"},
			rows: [][]driver.Value{
				{"UPDATED_AT", "TIMESTAMP", "YES", nil, "", "更新时间"},
				{"CREATED_AT", "DATE", "NO", nil, "", nil},
			},
		}, nil
	}
	return &oracleRecordingRows{}, nil
}

func cloneOracleRecordingRows(src [][]driver.Value) [][]driver.Value {
	dst := make([][]driver.Value, len(src))
	for i, row := range src {
		dst[i] = append([]driver.Value(nil), row...)
	}
	return dst
}

var _ driver.ExecerContext = (*oracleRecordingConn)(nil)
var _ driver.QueryerContext = (*oracleRecordingConn)(nil)

type oracleRecordingTx struct {
	state *oracleRecordingState
}

func (tx *oracleRecordingTx) Commit() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	return tx.state.txCommitErr
}

func (tx *oracleRecordingTx) Rollback() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	return tx.state.txRollbackErr
}

type oracleRecordingRows struct {
	columns     []string
	columnTypes []string
	nullable    []bool
	rows        [][]driver.Value
	index       int
}

func (r *oracleRecordingRows) Columns() []string {
	return append([]string(nil), r.columns...)
}

func (r *oracleRecordingRows) Close() error { return nil }

func (r *oracleRecordingRows) ColumnTypeDatabaseTypeName(index int) string {
	if index < 0 || index >= len(r.columnTypes) {
		return ""
	}
	return r.columnTypes[index]
}

func (r *oracleRecordingRows) ColumnTypeNullable(index int) (nullable, ok bool) {
	if index < 0 || index >= len(r.nullable) {
		return false, false
	}
	return r.nullable[index], true
}

func (r *oracleRecordingRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	for idx := range dest {
		if idx < len(row) {
			dest[idx] = row[idx]
		}
	}
	r.index++
	return nil
}

func openOracleRecordingDB(t *testing.T) (*sql.DB, *oracleRecordingState) {
	t.Helper()
	registerOracleRecordingDriverOnce.Do(func() {
		sql.Register(oracleRecordingDriverName, oracleRecordingDriver{})
	})

	oracleRecordingDriverMu.Lock()
	oracleRecordingDriverSeq++
	dsn := fmt.Sprintf("oracle-recording-%d", oracleRecordingDriverSeq)
	state := &oracleRecordingState{rowsAffected: 1, queryResults: map[string]oracleRecordingQueryResult{}}
	oracleRecordingDriverStates[dsn] = state
	oracleRecordingDriverMu.Unlock()

	dbConn, err := sql.Open(oracleRecordingDriverName, dsn)
	if err != nil {
		t.Fatalf("打开 recording db 失败: %v", err)
	}

	t.Cleanup(func() {
		_ = dbConn.Close()
		oracleRecordingDriverMu.Lock()
		delete(oracleRecordingDriverStates, dsn)
		oracleRecordingDriverMu.Unlock()
	})

	return dbConn, state
}

func TestOracleOpenTransactionExecerUsesPinnedSessionTransactionSQL(t *testing.T) {
	t.Parallel()

	for _, tt := range []struct {
		name         string
		finish       func(TransactionExecer) error
		wantFinalSQL string
	}{
		{
			name: "commit",
			finish: func(tx TransactionExecer) error {
				return tx.Commit()
			},
			wantFinalSQL: "COMMIT",
		},
		{
			name: "rollback",
			finish: func(tx TransactionExecer) error {
				return tx.Rollback()
			},
			wantFinalSQL: "ROLLBACK",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			dbConn, state := openOracleRecordingDB(t)
			oracleDB := &OracleDB{conn: dbConn}
			stmt := "UPDATE USERS SET NAME = 'new' WHERE ID = 1"

			tx, err := oracleDB.OpenTransactionExecer(context.Background())
			if err != nil {
				t.Fatalf("OpenTransactionExecer returned error: %v", err)
			}
			if _, err := tx.ExecContext(context.Background(), stmt); err != nil {
				t.Fatalf("ExecContext returned error: %v", err)
			}
			if err := tt.finish(tx); err != nil {
				t.Fatalf("finish returned error: %v", err)
			}
			if err := tx.Close(); err != nil {
				t.Fatalf("Close returned error: %v", err)
			}

			if got := state.snapshotBeginCalls(); got != 0 {
				t.Fatalf("expected Oracle transaction execer not to call database/sql Begin, got %d", got)
			}
			wantExecs := []string{stmt, tt.wantFinalSQL}
			if got := state.snapshotExecQueries(); !reflect.DeepEqual(got, wantExecs) {
				t.Fatalf("expected exec queries %#v, got %#v", wantExecs, got)
			}
		})
	}
}

func TestOracleApplyChangesUsesPinnedSessionTransactionSQL(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"ID": 7,
			},
			Values: map[string]interface{}{
				"NAME": "new-name",
			},
		}},
	}

	if err := oracleDB.ApplyChanges("MYCIMLED.EDC_LOG", changes); err != nil {
		t.Fatalf("ApplyChanges() unexpected error: %v", err)
	}
	if got := state.snapshotBeginCalls(); got != 0 {
		t.Fatalf("expected Oracle ApplyChanges not to call database/sql Begin, got %d", got)
	}
	wantExecs := []string{
		`UPDATE "MYCIMLED"."EDC_LOG" SET "NAME" = :1 WHERE "ID" = :2`,
		"COMMIT",
	}
	if got := state.snapshotExecQueries(); !reflect.DeepEqual(got, wantExecs) {
		t.Fatalf("expected Oracle ApplyChanges pinned-session execs %#v, got %#v", wantExecs, got)
	}
}

func TestOracleApplyChangesContextCancelsInFlightStatementAndRollsBack(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	state.mu.Lock()
	state.blockExecUntilCanceled = true
	state.execStarted = make(chan struct{}, 1)
	state.execRelease = make(chan struct{})
	state.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- (&OracleDB{conn: dbConn}).ApplyChangesContext(ctx, "APP.USERS", connection.ChangeSet{
			Updates: []connection.UpdateRow{{
				Keys:   map[string]interface{}{"ID": 42},
				Values: map[string]interface{}{"NAME": "cancel-me"},
			}},
		})
	}()

	select {
	case <-state.execStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not reach the context-aware SQL execution path")
	}

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("ApplyChangesContext error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}

	wantExecs := []string{`UPDATE "APP"."USERS" SET "NAME" = :1 WHERE "ID" = :2`, "ROLLBACK"}
	if got := state.snapshotExecQueries(); !reflect.DeepEqual(got, wantExecs) {
		t.Fatalf("expected canceled statement followed by independent rollback, got %#v", got)
	}
}

var _ BatchApplierContext = (*OracleDB)(nil)

func TestOracleApplyChangesRollsBackPinnedSessionOnError(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 0
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"ID": 7,
			},
			Values: map[string]interface{}{
				"NAME": "new-name",
			},
		}},
	}

	err := oracleDB.ApplyChanges("MYCIMLED.EDC_LOG", changes)
	if err == nil {
		t.Fatal("expected ApplyChanges to return update row-count error")
	}
	if got := state.snapshotBeginCalls(); got != 0 {
		t.Fatalf("expected Oracle ApplyChanges not to call database/sql Begin, got %d", got)
	}
	wantExecs := []string{
		`UPDATE "MYCIMLED"."EDC_LOG" SET "NAME" = :1 WHERE "ID" = :2`,
		"ROLLBACK",
	}
	if got := state.snapshotExecQueries(); !reflect.DeepEqual(got, wantExecs) {
		t.Fatalf("expected Oracle ApplyChanges pinned-session rollback execs %#v, got %#v", wantExecs, got)
	}
}

func TestOracleApplyChangesDiscardsPinnedConnectionWhenRollbackFails(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	statementSQL := `UPDATE "APP"."USERS" SET "NAME" = :1 WHERE "ID" = :2`
	rollbackErr := errors.New("rollback response lost")
	state.mu.Lock()
	state.execErrors = map[string]error{
		statementSQL: errors.New("known statement rejection"),
		"ROLLBACK":   rollbackErr,
	}
	state.mu.Unlock()

	err := (&OracleDB{conn: dbConn}).ApplyChangesContext(context.Background(), "APP.USERS", connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"ID": int64(1)},
			Values: map[string]interface{}{"NAME": "alice"},
		}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, rollbackErr) {
		t.Fatalf("rollback failure must mark the result unknown and preserve its cause, got %v", err)
	}
	if got := state.snapshotCloseCalls(); got != 1 {
		t.Fatalf("rollback failure must discard the pinned physical connection, close calls = %d", got)
	}
}

func TestOracleApplyChangesMarksManualCommitFailureOutcomeUnknown(t *testing.T) {
	dbConn, state := openOracleRecordingDB(t)
	commitErr := errors.New("commit response lost")
	state.mu.Lock()
	state.execErrors = map[string]error{"COMMIT": commitErr}
	state.mu.Unlock()

	err := (&OracleDB{conn: dbConn}).ApplyChangesContext(context.Background(), "APP.USERS", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"ID": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("manual COMMIT failure must mark the result unknown and preserve its cause, got %v", err)
	}
	if got := state.snapshotExecQueries(); !reflect.DeepEqual(got, []string{
		`INSERT INTO "APP"."USERS" ("ID") VALUES (:1)`,
		"COMMIT",
		"ROLLBACK",
	}) {
		t.Fatalf("unexpected manual transaction sequence after COMMIT failure: %#v", got)
	}
}

func TestOracleApplyChangesReturnsErrorWhenUpdateMatchesNoRows(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 0
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"ID": 7,
			},
			Values: map[string]interface{}{
				"NAME": "new-name",
			},
		}},
	}

	err := oracleDB.ApplyChanges("MYCIMLED.EDC_LOG", changes)
	if err == nil {
		t.Fatal("期望更新未匹配到行时返回错误，实际为 nil")
	}
	if !strings.Contains(err.Error(), "更新未生效") {
		t.Fatalf("错误信息应提示更新未生效，实际=%v", err)
	}
}

func TestOracleApplyChangesReturnsErrorWhenUpdateAffectsMultipleRows(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 2
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"ID": 7,
			},
			Values: map[string]interface{}{
				"NAME": "new-name",
			},
		}},
	}

	err := oracleDB.ApplyChanges("MYCIMLED.EDC_LOG", changes)
	if err == nil {
		t.Fatal("期望更新影响多行时返回错误，实际为 nil")
	}
	if !strings.Contains(err.Error(), "影响了 2 行") {
		t.Fatalf("错误信息应提示影响多行，实际=%v", err)
	}
}

func TestOracleApplyChangesReturnsErrorWhenDeleteAffectsMultipleRows(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 2
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{{
			"STATUS": "stale",
		}},
	}

	err := oracleDB.ApplyChanges("MYCIMLED.EDC_LOG", changes)
	if err == nil {
		t.Fatal("期望删除影响多行时返回错误，实际为 nil")
	}
	if !strings.Contains(err.Error(), "影响了 2 行") {
		t.Fatalf("错误信息应提示影响多行，实际=%v", err)
	}
}

func TestOracleApplyChangesNormalizesTemporalStringsForUpdate(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"CREATED_AT": "2026-03-05T10:30:00Z",
			},
			Values: map[string]interface{}{
				"UPDATED_AT": "2026-04-01T12:13:14.123456789Z",
			},
		}},
	}

	if err := oracleDB.ApplyChanges("EVENTS", changes); err != nil {
		t.Fatalf("ApplyChanges 返回错误: %v", err)
	}

	executions := state.snapshotExecArgs()
	if len(executions) == 0 {
		t.Fatal("期望至少执行 1 条更新，实际没有执行")
	}
	args := executions[0]
	if len(args) != 2 {
		t.Fatalf("期望 2 个绑定参数，实际 %d 个: %#v", len(args), args)
	}
	if _, ok := args[0].Value.(time.Time); !ok {
		t.Fatalf("更新时间字段应绑定为 time.Time，实际=%#v(%T)", args[0].Value, args[0].Value)
	}
	if _, ok := args[1].Value.(time.Time); !ok {
		t.Fatalf("日期主键字段应绑定为 time.Time，实际=%#v(%T)", args[1].Value, args[1].Value)
	}
}

func TestOracleApplyChangesUsesUnquotedRowIDLocator(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	oracleDB := &OracleDB{conn: dbConn}

	changes := connection.ChangeSet{
		LocatorStrategy: "oracle-rowid",
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"ROWID": "AAAA",
			},
			Values: map[string]interface{}{
				"NAME": "new-name",
			},
		}},
	}

	if err := oracleDB.ApplyChanges("MYCIMLED.EDC_LOG", changes); err != nil {
		t.Fatalf("ApplyChanges 返回错误: %v", err)
	}

	executions := state.snapshotExecQueries()
	if len(executions) == 0 {
		t.Fatal("期望至少执行 1 条更新，实际没有执行")
	}
	query := executions[0]
	if !strings.Contains(query, "ROWID = :2") {
		t.Fatalf("ROWID 定位条件不正确: %s", query)
	}
	if strings.Contains(query, "\"ROWID\" =") {
		t.Fatalf("ROWID 不应被当作普通列引用: %s", query)
	}
}

func TestMySQLApplyChangesReturnsErrorWhenUpdateAffectsMultipleRows(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 2
	mysqlDB := &MySQLDB{conn: dbConn}

	changes := connection.ChangeSet{
		Updates: []connection.UpdateRow{{
			Keys: map[string]interface{}{
				"id": 7,
			},
			Values: map[string]interface{}{
				"name": "new-name",
			},
		}},
	}

	err := mysqlDB.ApplyChanges("users", changes)
	if err == nil {
		t.Fatal("期望 MySQL 更新影响多行时返回错误，实际为 nil")
	}
	if !strings.Contains(err.Error(), "影响了 2 行") {
		t.Fatalf("错误信息应提示影响多行，实际=%v", err)
	}
}

func TestMySQLApplyChangesBatchesLargeInsertRows(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 1000
	mysqlDB := &MySQLDB{conn: dbConn}

	rows := make([]map[string]interface{}, 1201)
	for i := range rows {
		rows[i] = map[string]interface{}{
			"id":   i + 1,
			"name": fmt.Sprintf("name-%d", i+1),
		}
	}

	if err := mysqlDB.ApplyChanges("users", connection.ChangeSet{Inserts: rows}); err != nil {
		t.Fatalf("ApplyChanges() unexpected error: %v", err)
	}

	executions := state.snapshotExecQueries()
	if len(executions) != 2 {
		t.Fatalf("期望 1201 行插入拆成 2 条批量 INSERT，实际 %d 条：%v", len(executions), executions)
	}
	for _, query := range executions {
		if !strings.HasPrefix(query, "INSERT INTO `users` (`id`, `name`) VALUES ") {
			t.Fatalf("批量 INSERT 语句格式不正确: %s", query)
		}
		if got := strings.Count(query, "(?, ?)"); got == 0 || got > defaultMySQLInsertBatchSize {
			t.Fatalf("批量 INSERT values 数量异常，got=%d query=%s", got, query)
		}
	}
	if got := strings.Count(executions[0], "(?, ?)"); got != defaultMySQLInsertBatchSize {
		t.Fatalf("第一批 values=%d, want %d", got, defaultMySQLInsertBatchSize)
	}
	if got := strings.Count(executions[1], "(?, ?)"); got != 201 {
		t.Fatalf("第二批 values=%d, want 201", got)
	}
}

func TestMySQLInsertBatchSizeRespectsArgumentLimit(t *testing.T) {
	t.Parallel()

	if got := batchInsertRowLimit(2, defaultMySQLInsertBatchSize, maxMySQLInsertBatchArgs); got != defaultMySQLInsertBatchSize {
		t.Fatalf("2 列批大小=%d, want %d", got, defaultMySQLInsertBatchSize)
	}
	if got := batchInsertRowLimit(100, defaultMySQLInsertBatchSize, maxMySQLInsertBatchArgs); got != 600 {
		t.Fatalf("100 列批大小=%d, want 600", got)
	}
	if got := batchInsertRowLimit(70000, defaultMySQLInsertBatchSize, maxMySQLInsertBatchArgs); got != 1 {
		t.Fatalf("超宽表批大小=%d, want 1", got)
	}
}

func TestPostgresApplyChangesReturnsErrorWhenDeleteAffectsMultipleRows(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	state.rowsAffected = 2
	postgresDB := &PostgresDB{conn: dbConn}

	changes := connection.ChangeSet{
		Deletes: []map[string]interface{}{{
			"id": 7,
		}},
	}

	err := postgresDB.ApplyChanges("public.users", changes)
	if err == nil {
		t.Fatal("期望 PostgreSQL 删除影响多行时返回错误，实际为 nil")
	}
	if !strings.Contains(err.Error(), "影响了 2 行") {
		t.Fatalf("错误信息应提示影响多行，实际=%v", err)
	}
}

func TestPostgresApplyChangesExecutesDefaultValuesForEmptyInsert(t *testing.T) {
	t.Parallel()

	dbConn, state := openOracleRecordingDB(t)
	postgresDB := &PostgresDB{conn: dbConn}

	err := postgresDB.ApplyChanges("public.users", connection.ChangeSet{
		Inserts: []map[string]interface{}{{}},
	})
	if err != nil {
		t.Fatalf("ApplyChanges() error = %v", err)
	}

	queries := state.snapshotExecQueries()
	if len(queries) != 1 || queries[0] != `INSERT INTO "public"."users" DEFAULT VALUES` {
		t.Fatalf("default-only insert queries = %#v", queries)
	}
}
