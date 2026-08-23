package app

import (
	"context"
	"database/sql"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

type fakeBatchWriteDB struct {
	batchCalls        int
	execCalls         int
	pingCalls         int
	execQueries       []string
	lastQuery         string
	lastCtx           context.Context
	queryCalls        int
	queryQueries      []string
	queryMap          map[string][]map[string]interface{}
	fieldMap          map[string][]string
	messageMap        map[string][]string
	multiResult       map[string][]connection.ResultSetData
	queryErr          map[string]error
	execErr           map[string]error
	execAffected      map[string]int64
	batchErr          error
	execDelay         map[string]time.Duration
	execStarted       chan<- string
	execRelease       <-chan struct{}
	execIgnoreContext bool
	session           *fakeBatchWriteSession
}

type fakeNativeMultiResultDB struct {
	*fakeBatchWriteDB
	multiCalls       int
	partialResultErr map[string]error
}

type fakeEmptyNativeMultiResultDB struct {
	*fakeBatchWriteDB
	multiCalls int
	results    []connection.ResultSetData
	messages   []string
}

func (f *fakeNativeMultiResultDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiWithMessages(query)
	return results, err
}

func (f *fakeNativeMultiResultDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return f.QueryMultiContextWithMessages(context.Background(), query)
}

func (f *fakeNativeMultiResultDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiContextWithMessages(ctx, query)
	return results, err
}

func (f *fakeNativeMultiResultDB) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	f.multiCalls++
	if err := f.queryErr[query]; err != nil {
		return nil, nil, err
	}
	if multi := f.multiResult[query]; len(multi) > 0 {
		return cloneResultSets(multi), append([]string(nil), f.messageMap[query]...), f.partialResultErr[query]
	}
	rows, columns, messages, err := f.QueryContextWithMessages(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	return []connection.ResultSetData{{
		Rows:     rows,
		Columns:  columns,
		Messages: append([]string(nil), messages...),
	}}, append([]string(nil), messages...), nil
}

func (f *fakeEmptyNativeMultiResultDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiWithMessages(query)
	return results, err
}

func (f *fakeEmptyNativeMultiResultDB) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return f.QueryMultiContextWithMessages(context.Background(), query)
}

func (f *fakeEmptyNativeMultiResultDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, _, err := f.QueryMultiContextWithMessages(ctx, query)
	return results, err
}

func (f *fakeEmptyNativeMultiResultDB) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	f.multiCalls++
	if err := f.queryErr[query]; err != nil {
		return nil, nil, err
	}
	if f.results != nil {
		return cloneResultSets(f.results), append([]string(nil), f.messages...), nil
	}
	return []connection.ResultSetData{}, nil, nil
}

func (f *fakeBatchWriteDB) Connect(config connection.ConnectionConfig) error {
	return nil
}

func (f *fakeBatchWriteDB) Close() error {
	return nil
}

func (f *fakeBatchWriteDB) Ping() error {
	f.pingCalls++
	return nil
}

func (f *fakeBatchWriteDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryCalls++
	if err := f.queryErr[query]; err != nil {
		return nil, nil, err
	}
	return f.queryMap[query], f.fieldMap[query], nil
}

func (f *fakeBatchWriteDB) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	rows, fields, err := f.Query(query)
	return rows, fields, f.messageMap[query], err
}

func (f *fakeBatchWriteDB) Exec(query string) (int64, error) {
	f.execCalls++
	f.execQueries = append(f.execQueries, query)
	if err := f.execErr[query]; err != nil {
		return 0, err
	}
	if affected, ok := f.execAffected[query]; ok {
		return affected, nil
	}
	return 1, nil
}

func (f *fakeBatchWriteDB) GetDatabases() ([]string, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}

func (f *fakeBatchWriteDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeBatchWriteDB) ExecContext(ctx context.Context, query string) (int64, error) {
	f.lastCtx = ctx
	f.execCalls++
	f.execQueries = append(f.execQueries, query)
	if f.execStarted != nil {
		select {
		case f.execStarted <- query:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	if f.execRelease != nil {
		if f.execIgnoreContext {
			<-f.execRelease
		} else {
			select {
			case <-f.execRelease:
			case <-ctx.Done():
				return 0, ctx.Err()
			}
		}
	}
	if delay := f.execDelay[query]; delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
	if err := f.execErr[query]; err != nil {
		return 0, err
	}
	if affected, ok := f.execAffected[query]; ok {
		return affected, nil
	}
	return 1, nil
}

func (f *fakeBatchWriteDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.lastCtx = ctx
	f.queryCalls++
	f.queryQueries = append(f.queryQueries, query)
	if err := f.queryErr[query]; err != nil {
		return nil, nil, err
	}
	return f.queryMap[query], f.fieldMap[query], nil
}

func (f *fakeBatchWriteDB) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	rows, fields, err := f.QueryContext(ctx, query)
	return rows, fields, f.messageMap[query], err
}

func (f *fakeBatchWriteDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	f.batchCalls++
	f.lastQuery = query
	if f.batchErr != nil {
		return 0, f.batchErr
	}
	return 500, nil
}

func (f *fakeBatchWriteDB) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	f.session = &fakeBatchWriteSession{parent: f}
	return f.session, nil
}

type fakeBatchWriteSession struct {
	parent     *fakeBatchWriteDB
	queryCalls int
	execCalls  int
	batchCalls int
	closed     bool
}

func (s *fakeBatchWriteSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return s.QueryContext(context.Background(), query)
}

func (s *fakeBatchWriteSession) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	s.queryCalls++
	return s.parent.QueryContext(ctx, query)
}

func (s *fakeBatchWriteSession) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return s.QueryContextWithMessages(context.Background(), query)
}

func (s *fakeBatchWriteSession) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	s.queryCalls++
	return s.parent.QueryContextWithMessages(ctx, query)
}

func (s *fakeBatchWriteSession) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return s.QueryMultiContext(context.Background(), query)
}

func (s *fakeBatchWriteSession) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if multi := s.parent.multiResult[query]; len(multi) > 0 {
		s.queryCalls++
		return cloneResultSets(multi), nil
	}
	rows, columns, err := s.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return []connection.ResultSetData{{Rows: rows, Columns: columns}}, nil
}

func (s *fakeBatchWriteSession) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return s.QueryMultiContextWithMessages(context.Background(), query)
}

func (s *fakeBatchWriteSession) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	if err := s.parent.queryErr[query]; err != nil {
		s.queryCalls++
		return nil, nil, err
	}
	if multi := s.parent.multiResult[query]; len(multi) > 0 {
		s.queryCalls++
		return cloneResultSets(multi), append([]string(nil), s.parent.messageMap[query]...), nil
	}
	rows, columns, messages, err := s.QueryContextWithMessages(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	return []connection.ResultSetData{{
		Rows:     rows,
		Columns:  columns,
		Messages: append([]string(nil), messages...),
	}}, append([]string(nil), messages...), nil
}

func (s *fakeBatchWriteSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *fakeBatchWriteSession) ExecContext(ctx context.Context, query string) (int64, error) {
	s.execCalls++
	return s.parent.ExecContext(ctx, query)
}

func (s *fakeBatchWriteSession) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	s.batchCalls++
	return s.parent.ExecBatchContext(ctx, query)
}

func (s *fakeBatchWriteSession) Close() error {
	s.closed = true
	return nil
}

type fakeTransactionalDB struct {
	fakeBatchWriteDB
	txSession *fakeTransactionSession
}

func (f *fakeTransactionalDB) OpenTransactionExecer(ctx context.Context) (db.TransactionExecer, error) {
	f.txSession = &fakeTransactionSession{
		fakeBatchWriteSession: fakeBatchWriteSession{parent: &f.fakeBatchWriteDB},
		beginCtx:              ctx,
	}
	return f.txSession, nil
}

type fakeTransactionSession struct {
	fakeBatchWriteSession
	beginCtx      context.Context
	commitCalls   int
	rollbackCalls int
}

func (s *fakeTransactionSession) Commit() error {
	if s.beginCtx != nil && s.beginCtx.Err() != nil {
		return sql.ErrTxDone
	}
	s.commitCalls++
	return nil
}

func (s *fakeTransactionSession) Rollback() error {
	if s.beginCtx != nil && s.beginCtx.Err() != nil {
		return sql.ErrTxDone
	}
	s.rollbackCalls++
	return nil
}

func cloneResultSets(input []connection.ResultSetData) []connection.ResultSetData {
	if len(input) == 0 {
		return nil
	}
	cloned := make([]connection.ResultSetData, 0, len(input))
	for _, item := range input {
		rows := make([]map[string]interface{}, 0, len(item.Rows))
		for _, row := range item.Rows {
			if row == nil {
				rows = append(rows, nil)
				continue
			}
			rowCopy := make(map[string]interface{}, len(row))
			for key, value := range row {
				rowCopy[key] = value
			}
			rows = append(rows, rowCopy)
		}
		cloned = append(cloned, connection.ResultSetData{
			Rows:           rows,
			Columns:        append([]string(nil), item.Columns...),
			Messages:       append([]string(nil), item.Messages...),
			StatementIndex: item.StatementIndex,
		})
	}
	return cloned
}

func TestDBQueryMultiInTransactionSerializesCommitWithInFlightStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	initialStatement := "UPDATE users SET active = 1 WHERE id = 1"
	followUpStatement := "UPDATE users SET active = 0 WHERE id = 2"
	fakeDB := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		execAffected: map[string]int64{initialStatement: 1, followUpStatement: 1},
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	started := app.DBQueryMultiTransactional(config, "main", initialStatement, "tx-serialize-start")
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("start managed transaction: %#v", started)
	}

	execStarted := make(chan string, 1)
	execRelease := make(chan struct{})
	fakeDB.execStarted = execStarted
	fakeDB.execRelease = execRelease
	queryDone := make(chan connection.QueryResult, 1)
	go func() {
		queryDone <- app.DBQueryMultiInTransaction(started.TransactionID, followUpStatement, "tx-serialize-follow-up")
	}()

	select {
	case statement := <-execStarted:
		if statement != followUpStatement {
			close(execRelease)
			t.Fatalf("blocked statement = %q, want %q", statement, followUpStatement)
		}
	case <-time.After(2 * time.Second):
		close(execRelease)
		t.Fatal("follow-up statement did not start")
	}

	commitDone := make(chan connection.QueryResult, 1)
	go func() {
		commitDone <- app.DBCommitTransaction(started.TransactionID)
	}()
	select {
	case result := <-commitDone:
		close(execRelease)
		t.Fatalf("commit completed while statement was still in flight: %#v", result)
	case <-time.After(75 * time.Millisecond):
	}

	close(execRelease)
	if result := <-queryDone; !result.Success {
		t.Fatalf("follow-up statement failed: %#v", result)
	}
	if result := <-commitDone; !result.Success {
		t.Fatalf("commit after follow-up failed: %#v", result)
	}
	if fakeDB.txSession.commitCalls != 1 || !fakeDB.txSession.closed {
		t.Fatalf("transaction was not committed exactly once after execution: commitCalls=%d closed=%v", fakeDB.txSession.commitCalls, fakeDB.txSession.closed)
	}
}

func TestRollbackPendingSQLTransactionsWaitsForInFlightStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	initialStatement := "UPDATE users SET active = 1 WHERE id = 1"
	followUpStatement := "UPDATE users SET active = 0 WHERE id = 2"
	fakeDB := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		execAffected: map[string]int64{initialStatement: 1, followUpStatement: 1},
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	started := app.DBQueryMultiTransactional(config, "main", initialStatement, "tx-shutdown-start")
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("start managed transaction: %#v", started)
	}

	execStarted := make(chan string, 1)
	execRelease := make(chan struct{})
	fakeDB.execStarted = execStarted
	fakeDB.execRelease = execRelease
	queryDone := make(chan connection.QueryResult, 1)
	go func() {
		queryDone <- app.DBQueryMultiInTransaction(started.TransactionID, followUpStatement, "tx-shutdown-follow-up")
	}()
	select {
	case <-execStarted:
	case <-time.After(2 * time.Second):
		close(execRelease)
		t.Fatal("follow-up statement did not start")
	}

	shutdownDone := make(chan struct{})
	go func() {
		app.rollbackPendingSQLTransactionsOnShutdown()
		close(shutdownDone)
	}()
	select {
	case <-shutdownDone:
		close(execRelease)
		t.Fatal("shutdown rollback completed while statement was still in flight")
	case <-time.After(75 * time.Millisecond):
	}

	close(execRelease)
	if result := <-queryDone; !result.Success {
		t.Fatalf("follow-up statement failed: %#v", result)
	}
	select {
	case <-shutdownDone:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown rollback did not finish after statement completed")
	}
	if fakeDB.txSession.rollbackCalls != 1 || !fakeDB.txSession.closed {
		t.Fatalf("transaction was not rolled back exactly once after execution: rollbackCalls=%d closed=%v", fakeDB.txSession.rollbackCalls, fakeDB.txSession.closed)
	}
}

func TestDBQueryMultiKeepsOracleAnonymousBlockAsSingleStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `BEGIN
    INSERT INTO tmp_disable_trigger (table_name) VALUES ('t_memcard_reg');
    UPDATE t_memcard_reg SET CARDLEVEL = 1 WHERE MEMCARDNO = '8032277312';
    DELETE FROM tmp_disable_trigger WHERE table_name = 't_memcard_reg';
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-plsql-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected PL/SQL block to skip batch path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != query {
		t.Fatalf("expected PL/SQL block to stay intact, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiExecutesOracleCompileStatementWithoutTrailingDelimiter(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}

	result := app.DBQueryMulti(config, "ORCLPDB1", `ALTER PROCEDURE "APP"."P_REBUILD" COMPILE;`, "oracle-compile-test")
	if !result.Success {
		t.Fatalf("expected Oracle compile statement success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected Oracle DDL to use the direct execution path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one Oracle compile exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if got, want := fakeDB.execQueries[0], `ALTER PROCEDURE "APP"."P_REBUILD" COMPILE`; got != want {
		t.Fatalf("expected trailing delimiter to be removed before Oracle compile execution, got %q", got)
	}
}

func TestDBQueryMultiKeepsOracleCreateProcedureAsSingleStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
    p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE,
    out_acceptno OUT t_accept_h.acceptno%TYPE
) IS
    v_busno t_tally_accept_h.busno%TYPE;
    v_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;
    IF v_count > 0 THEN
        out_acceptno := p_tallyacceptno;
    END IF;
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-create-procedure-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected CREATE PROCEDURE to skip batch path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != query {
		t.Fatalf("expected CREATE PROCEDURE to stay intact, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiKeepsOracleCreateProcedureCursorCaseExpressionAsSingleStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE proc_accept_to_add(
    p_acceptno IN t_accept_h.acceptno%TYPE
) IS
    CURSOR cur_store_same(p_ind s_sys_ini.inipara%TYPE) IS
        SELECT si.compid, si.batid, si.wareid
        FROM   t_store_i si
        ORDER  BY CASE
                      WHEN p_ind = '1' THEN
                       to_char(si.invalidate - to_date('19700101', 'yyyymmdd'))
                      WHEN p_ind = '2' THEN
                       lpad(to_char(floor(si.wareqty)), 10, '0')
                      ELSE
                       to_char(si.batid)
                  END,si.batid;
BEGIN
    NULL;
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-create-procedure-cursor-case-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected CREATE PROCEDURE to skip batch path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != query {
		t.Fatalf("expected CREATE PROCEDURE to stay intact, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiSkipsOracleSqlPlusSlashDelimiter(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
    p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE
) IS
    v_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;
END;
/`
	wantExecuted := `CREATE OR REPLACE PROCEDURE proc_tally2accept(
    p_tallyacceptno IN t_tally_accept_h.acceptno%TYPE
) IS
    v_count PLS_INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_count FROM t_tally_accept_h WHERE acceptno = p_tallyacceptno;
END;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-sqlplus-slash-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != wantExecuted {
		t.Fatalf("expected slash delimiter to be skipped, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiSkipsOracleSqlPlusSlashDelimiterWithSemicolon(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_msg_out OUT NVARCHAR2
) AS
BEGIN
    p_msg_out := '';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := SQLERRM;
END cproc_tzhssr_order2sale_A1;
/;`
	wantExecuted := `CREATE OR REPLACE PROCEDURE cproc_tzhssr_order2sale_A1(
    p_msg_out OUT NVARCHAR2
) AS
BEGIN
    p_msg_out := '';
EXCEPTION
    WHEN OTHERS THEN
        p_msg_out := SQLERRM;
END cproc_tzhssr_order2sale_A1;`

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-sqlplus-slash-semicolon-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.execCalls != 1 || len(fakeDB.execQueries) != 1 {
		t.Fatalf("expected one sequential exec call, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != wantExecuted {
		t.Fatalf("expected slash delimiter with semicolon to be skipped, got %q", fakeDB.execQueries[0])
	}
}

func TestDBQueryMultiKeepsOraclePackageSpecAndBodyTogether(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "oracle",
		Host: "127.0.0.1",
		Port: 1521,
		User: "app",
	}
	query := `CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER);
END pkg_order;
/
CREATE OR REPLACE PACKAGE BODY pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER) IS
    BEGIN
        NULL;
    END sync_order;
END pkg_order;
/ -- SQLPlus delimiter from PL/SQL tools`
	wantExecuted := []string{
		`CREATE OR REPLACE PACKAGE pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER);
END pkg_order;`,
		`CREATE OR REPLACE PACKAGE BODY pkg_order AS
    PROCEDURE sync_order(p_id IN NUMBER) IS
    BEGIN
        NULL;
    END sync_order;
END pkg_order;`,
	}

	result := app.DBQueryMulti(config, "ORCLPDB1", query, "oracle-package-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.execCalls != 2 || len(fakeDB.execQueries) != 2 {
		t.Fatalf("expected two sequential exec calls, got execCalls=%d queries=%#v", fakeDB.execCalls, fakeDB.execQueries)
	}
	if !reflect.DeepEqual(fakeDB.execQueries, wantExecuted) {
		t.Fatalf("expected package spec/body to stay intact, got %#v", fakeDB.execQueries)
	}
}

var _ db.BatchWriteExecer = (*fakeBatchWriteDB)(nil)
var _ db.SessionExecerProvider = (*fakeBatchWriteDB)(nil)
var _ db.QueryMessageExecer = (*fakeBatchWriteDB)(nil)
var _ db.StatementQueryMessageExecer = (*fakeBatchWriteSession)(nil)

func TestDBQueryWithCancelReturnsResultSetForExecStoredProcedure(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_who2"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"SPID": 52, "STATUS": "RUNNABLE"},
			},
		},
		fieldMap: map[string][]string{
			query: {"SPID", "STATUS"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryWithCancel(config, "master", query, "sp-who2-test")
	if !result.Success {
		t.Fatalf("expected DBQueryWithCancel success, got failure: %s", result.Message)
	}
	rows, ok := result.Data.([]map[string]interface{})
	if !ok {
		t.Fatalf("expected []map[string]interface{}, got %T", result.Data)
	}
	if len(rows) != 1 || rows[0]["SPID"] != 52 {
		t.Fatalf("unexpected rows: %#v", rows)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryWithCancelRoutesMilvusJSONSearchToQuery(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := `{"search":"products","vector":[0.1,0.2,0.3],"limit":1}`
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"id": 1, "distance": 0.01}},
		},
		fieldMap: map[string][]string{
			query: {"id", "distance"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryWithCancel(
		connection.ConnectionConfig{Type: "milvus", Host: "127.0.0.1", Port: 19530},
		"default",
		query,
		"milvus-search-test",
	)
	if !result.Success {
		t.Fatalf("expected Milvus JSON search success, got failure: %s", result.Message)
	}
	if fakeDB.queryCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("expected query path only, queryCalls=%d execCalls=%d", fakeDB.queryCalls, fakeDB.execCalls)
	}
}

func TestDBQueryWithCancelRoutesMilvusSelectPreviewToQuery(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := `SELECT * FROM "products" LIMIT 101 OFFSET 0`
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"id": 1, "category": "book"}},
		},
		fieldMap: map[string][]string{
			query: {"id", "category"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryWithCancel(
		connection.ConnectionConfig{Type: "milvus", Host: "127.0.0.1", Port: 19530},
		"default",
		query,
		"milvus-select-preview-test",
	)
	if !result.Success {
		t.Fatalf("expected Milvus SELECT preview success, got failure: %s", result.Message)
	}
	if fakeDB.queryCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("expected query path only, queryCalls=%d execCalls=%d", fakeDB.queryCalls, fakeDB.execCalls)
	}
}

func TestDBQueryWithCancelReturnsMessagesForSQLServerQuery(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SET STATISTICS IO ON"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {},
		},
		fieldMap: map[string][]string{
			query: {},
		},
		messageMap: map[string][]string{
			query: {"Table 'users'. Scan count 1, logical reads 3."},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryWithCancel(config, "master", query, "statistics-io-test")
	if !result.Success {
		t.Fatalf("expected DBQueryWithCancel success, got failure: %s", result.Message)
	}
	if len(result.Messages) != 1 || result.Messages[0] == "" {
		t.Fatalf("expected SQL Server messages to be returned, got %#v", result.Messages)
	}
}

func TestDBQueryWithCancel_DuckDBQueriesDoNotInheritConnectTimeout(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	query := "SELECT 1"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"value": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "duckdb", Host: ":memory:", Timeout: 1}

	result := app.DBQueryWithCancel(config, "main", query, "duckdb-no-deadline-test")
	if !result.Success {
		t.Fatalf("expected DuckDB DBQueryWithCancel success, got failure: %s", result.Message)
	}
	if fakeDB.lastCtx == nil {
		t.Fatal("expected DuckDB query path to receive a context")
	}
	if _, ok := fakeDB.lastCtx.Deadline(); ok {
		t.Fatal("expected DuckDB query context to avoid connection-timeout deadline")
	}
}

func TestDBQueryMulti_MySQLQueriesDoNotInheritConnectTimeout(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"value": 1}},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Timeout: 1}

	result := app.DBQueryMulti(config, "testdb", query, "mysql-no-connect-deadline-test")
	if !result.Success {
		t.Fatalf("expected MySQL DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.lastCtx == nil {
		t.Fatal("expected MySQL query path to receive a context")
	}
	if _, ok := fakeDB.lastCtx.Deadline(); ok {
		t.Fatal("expected MySQL query context to avoid connection-timeout deadline")
	}
}

func TestDBQueryMultiPreservesPerStatementResultsForMultipleWriteStatements(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "DELETE FROM assets_asset"
	secondStmt := "DELETE FROM assets_assetcategory"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  5,
			secondStmt: 10,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "mysql",
		Host: "127.0.0.1",
		Port: 1433,
		User: "sa",
	}
	query := firstStmt + ";\n" + secondStmt + ";"

	result := app.DBQueryMulti(config, "testdb", query, "batch-write-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected multiple write statements to skip batch path so each result can be preserved, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 2 {
		t.Fatalf("expected sequential exec path to run twice, got execCalls=%d", fakeDB.execCalls)
	}
	if len(fakeDB.execQueries) != 2 || fakeDB.execQueries[0] != firstStmt || fakeDB.execQueries[1] != secondStmt {
		t.Fatalf("expected sequential execs to preserve statement order, got %#v", fakeDB.execQueries)
	}

	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected one affectedRows result set per statement, got %#v", resultSets)
	}
	if len(resultSets[0].Rows) != 1 || len(resultSets[1].Rows) != 1 {
		t.Fatalf("expected both result sets to contain a single affectedRows row, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["affectedRows"]; got != int64(5) {
		t.Fatalf("expected first affectedRows=5, got %#v", got)
	}
	if got := resultSets[1].Rows[0]["affectedRows"]; got != int64(10) {
		t.Fatalf("expected second affectedRows=10, got %#v", got)
	}
}

func TestDBQueryMultiTransactionalKeepsDMLTransactionOpenUntilCommit(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  1,
			secondStmt: 3,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", firstStmt+";\n"+secondStmt+";", "tx-query")
	if !result.Success {
		t.Fatalf("expected transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected transactional query to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected transaction session to stay open before commit")
	}
	wantExecs := []string{"START TRANSACTION", firstStmt, secondStmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}

	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected one affectedRows result per DML statement, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["affectedRows"]; got != int64(1) {
		t.Fatalf("expected first affectedRows=1, got %#v", got)
	}
	if got := resultSets[1].Rows[0]["affectedRows"]; got != int64(3) {
		t.Fatalf("expected second affectedRows=3, got %#v", got)
	}

	commitResult := app.DBCommitTransaction(result.TransactionID)
	if !commitResult.Success {
		t.Fatalf("expected commit success, got failure: %s", commitResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected transaction session to close after commit")
	}
	if got := fakeDB.execQueries[len(fakeDB.execQueries)-1]; got != "COMMIT" {
		t.Fatalf("expected final exec to be COMMIT, got %q", got)
	}
}

func TestDBQueryMultiTransactionalKeepsSQLServerBeginEndBlockOpenUntilRollback(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	block := `BEGIN
    UPDATE users SET name = 'new' WHERE id = 1;
END;`
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{block: 1},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMultiTransactional(config, "testdb", block, "sqlserver-begin-end-tx-query")
	if !result.Success {
		t.Fatalf("expected SQL Server BEGIN...END transaction success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected SQL Server transactional block to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected SQL Server transaction session to stay open before rollback")
	}
	if !reflect.DeepEqual(fakeDB.execQueries, []string{"BEGIN TRANSACTION"}) {
		t.Fatalf("expected SQL Server transaction begin before rollback, got %#v", fakeDB.execQueries)
	}
	if !reflect.DeepEqual(fakeDB.queryQueries, []string{block}) {
		t.Fatalf("expected SQL Server block to execute through the pinned query session, got %#v", fakeDB.queryQueries)
	}

	rollbackResult := app.DBRollbackTransaction(result.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected SQL Server rollback success, got failure: %s", rollbackResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected SQL Server transaction session to close after rollback")
	}
	wantExecs := []string{"BEGIN TRANSACTION", "ROLLBACK TRANSACTION"}
	if !reflect.DeepEqual(fakeDB.execQueries, wantExecs) {
		t.Fatalf("expected SQL Server rollback without commit, got %#v", fakeDB.execQueries)
	}
}

func TestDBQueryMultiTransactionalKeepsTrailingCommentInsideManagedTransaction(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	statement := "DELETE FROM users WHERE id = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{statement: 1},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}
	result := app.DBQueryMultiTransactional(
		config,
		"main",
		statement+"; -- keep this operation pending",
		"tx-trailing-comment",
	)

	if !result.Success {
		t.Fatalf("expected transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected trailing comment to preserve pending transaction, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if strings.Contains(result.Message, "逐条执行") {
		t.Fatalf("expected trailing comment to avoid sequential fallback message, got %q", result.Message)
	}
	wantExecs := []string{"START TRANSACTION", statement}
	if !reflect.DeepEqual(fakeDB.execQueries, wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 {
		t.Fatalf("expected one DML result set, got %T %#v", result.Data, result.Data)
	}

	rollbackResult := app.DBRollbackTransaction(result.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected rollback success, got failure: %s", rollbackResult.Message)
	}
}

func TestDBQueryMultiInTransactionReusesPendingManagedSessionForReadQueries(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	updateStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	readStmt := "SELECT name FROM users WHERE id = 1"
	fakeDB := &fakeTransactionalDB{
		fakeBatchWriteDB: fakeBatchWriteDB{
			execAffected: map[string]int64{
				updateStmt: 1,
			},
			queryMap: map[string][]map[string]interface{}{
				readStmt: {
					{"name": "new"},
				},
			},
			fieldMap: map[string][]string{
				readStmt: {"name"},
			},
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	startResult := app.DBQueryMultiTransactional(config, "main", updateStmt, "tx-query")
	if !startResult.Success {
		t.Fatalf("expected transactional update success, got failure: %s", startResult.Message)
	}
	if startResult.TransactionID == "" || !startResult.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", startResult.TransactionID, startResult.TransactionPending)
	}
	if fakeDB.txSession == nil {
		t.Fatal("expected transaction provider session to be opened")
	}
	if fakeDB.txSession.closed {
		t.Fatal("expected transaction session to stay open before follow-up read")
	}

	readResult := app.DBQueryMultiInTransaction(startResult.TransactionID, readStmt, "tx-query-read")
	if !readResult.Success {
		t.Fatalf("expected in-transaction read success, got failure: %s", readResult.Message)
	}
	if readResult.TransactionID != startResult.TransactionID || !readResult.TransactionPending {
		t.Fatalf("expected follow-up read to preserve pending transaction metadata, got id=%q pending=%v", readResult.TransactionID, readResult.TransactionPending)
	}
	if fakeDB.txSession.queryCalls == 0 {
		t.Fatal("expected follow-up read to execute on the pinned transaction session")
	}
	if fakeDB.txSession.closed {
		t.Fatal("expected transaction session to remain open after follow-up read")
	}

	resultSets, ok := readResult.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData from in-transaction read, got %T", readResult.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one read result set, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "new" {
		t.Fatalf("expected in-transaction read to return updated value, got %#v", got)
	}

	rollbackResult := app.DBRollbackTransaction(startResult.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected rollback success after follow-up read, got failure: %s", rollbackResult.Message)
	}
	if !fakeDB.txSession.closed {
		t.Fatal("expected transaction session to close after rollback")
	}
}

func TestDBQueryMultiTransactionalUsesImplicitSessionTransactionForOracle(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  1,
			secondStmt: 3,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

	result := app.DBQueryMultiTransactional(config, "ORCLPDB1", firstStmt+";\n"+secondStmt+";", "oracle-tx-query")
	if !result.Success {
		t.Fatalf("expected Oracle transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected Oracle transactional query to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected Oracle transaction session to stay open before commit")
	}
	wantExecs := []string{firstStmt, secondStmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected implicit transaction exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}

	commitResult := app.DBCommitTransaction(result.TransactionID)
	if !commitResult.Success {
		t.Fatalf("expected Oracle commit success, got failure: %s", commitResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected Oracle transaction session to close after commit")
	}
	wantExecs = append(wantExecs, "COMMIT")
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected Oracle implicit transaction COMMIT on pinned session, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalKeepsOracleAnonymousBlockTransactionOpenUntilRollback(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := `BEGIN
    UPDATE users SET name = 'new' WHERE id = 1;
    DELETE FROM audit_logs WHERE user_id = 1;
END;`
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 2,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

	result := app.DBQueryMultiTransactional(config, "ORCLPDB1", stmt, "oracle-anonymous-block-tx-query")
	if !result.Success {
		t.Fatalf("expected Oracle anonymous block transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected Oracle anonymous block to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected Oracle anonymous block transaction session to stay open before rollback")
	}
	if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != stmt {
		t.Fatalf("expected Oracle anonymous block to execute as a single statement before rollback, got %#v", fakeDB.execQueries)
	}

	rollbackResult := app.DBRollbackTransaction(result.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected Oracle anonymous block rollback success, got failure: %s", rollbackResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected Oracle anonymous block transaction session to close after rollback")
	}
	wantExecs := []string{stmt, "ROLLBACK"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected Oracle anonymous block rollback on pinned session, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalOraclePrefersTransactionProviderForFinish(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	for _, tt := range []struct {
		name              string
		finish            func(*App, string) connection.QueryResult
		wantCommitCalls   int
		wantRollbackCalls int
	}{
		{
			name: "commit",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBCommitTransaction(transactionID)
			},
			wantCommitCalls: 1,
		},
		{
			name: "rollback",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBRollbackTransaction(transactionID)
			},
			wantRollbackCalls: 1,
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			stmt := "UPDATE users SET name = 'new' WHERE id = 1"
			fakeDB := &fakeTransactionalDB{
				fakeBatchWriteDB: fakeBatchWriteDB{
					execAffected: map[string]int64{
						stmt: 1,
					},
					execErr: map[string]error{
						"COMMIT":   errors.New("oracle commit rows affected unavailable"),
						"ROLLBACK": errors.New("oracle rollback rows affected unavailable"),
					},
				},
			}
			newDatabaseFunc = func(dbType string) (db.Database, error) {
				return fakeDB, nil
			}

			app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

			result := app.DBQueryMultiTransactional(config, "ORCLPDB1", stmt, "oracle-provider-finish-"+tt.name)
			if !result.Success {
				t.Fatalf("expected Oracle transactional query success, got failure: %s", result.Message)
			}
			if result.TransactionID == "" || !result.TransactionPending {
				t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
			}
			if fakeDB.session != nil {
				t.Fatal("expected Oracle to use transaction provider instead of plain session provider")
			}
			if fakeDB.txSession == nil {
				t.Fatal("expected Oracle to open a transaction provider session")
			}

			finishResult := tt.finish(app, result.TransactionID)
			if !finishResult.Success {
				t.Fatalf("expected Oracle transaction %s success through transaction provider, got failure: %s", tt.name, finishResult.Message)
			}
			if fakeDB.txSession.commitCalls != tt.wantCommitCalls {
				t.Fatalf("expected commitCalls=%d, got %d", tt.wantCommitCalls, fakeDB.txSession.commitCalls)
			}
			if fakeDB.txSession.rollbackCalls != tt.wantRollbackCalls {
				t.Fatalf("expected rollbackCalls=%d, got %d", tt.wantRollbackCalls, fakeDB.txSession.rollbackCalls)
			}
			if !fakeDB.txSession.closed {
				t.Fatal("expected transaction provider session to close after finish")
			}
			for _, query := range fakeDB.execQueries {
				if query == "COMMIT" || query == "ROLLBACK" {
					t.Fatalf("expected finish to avoid plain ExecContext(%q), got exec queries %#v", query, fakeDB.execQueries)
				}
			}
		})
	}
}

func TestDBQueryMultiTransactionalUsesOracleImplicitSessionForOceanBaseOracleProtocol(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	stmt := "UPDATE USERS SET NAME = 'new' WHERE ID = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 1,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              "127.0.0.1",
		Port:              2881,
		User:              "app",
		OceanBaseProtocol: "oracle",
	}

	result := app.DBQueryMultiTransactional(config, "APP", stmt, "ob-oracle-tx-query")
	if !result.Success {
		t.Fatalf("expected OceanBase Oracle transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected OceanBase Oracle transactional query to open a pinned Oracle-style session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected OceanBase Oracle transaction session to stay open before commit")
	}
	if len(fakeDB.execQueries) != 1 || fakeDB.execQueries[0] != stmt {
		t.Fatalf("expected OceanBase Oracle to skip START TRANSACTION and execute only DML before commit, got %#v", fakeDB.execQueries)
	}

	commitResult := app.DBCommitTransaction(result.TransactionID)
	if !commitResult.Success {
		t.Fatalf("expected OceanBase Oracle commit success, got failure: %s", commitResult.Message)
	}
	wantExecs := []string{stmt, "COMMIT"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected OceanBase Oracle implicit transaction COMMIT on pinned session, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalOracleImplicitSessionOutlivesAppContextCancellation(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	for _, tt := range []struct {
		name         string
		finish       func(*App, string) connection.QueryResult
		wantFinalSQL string
	}{
		{
			name: "commit",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBCommitTransaction(transactionID)
			},
			wantFinalSQL: "COMMIT",
		},
		{
			name: "rollback",
			finish: func(app *App, transactionID string) connection.QueryResult {
				return app.DBRollbackTransaction(transactionID)
			},
			wantFinalSQL: "ROLLBACK",
		},
	} {
		t.Run(tt.name, func(t *testing.T) {
			stmt := "UPDATE users SET name = 'new' WHERE id = 1"
			fakeDB := &fakeBatchWriteDB{
				execAffected: map[string]int64{
					stmt: 1,
				},
			}
			newDatabaseFunc = func(dbType string) (db.Database, error) {
				return fakeDB, nil
			}

			appCtx, cancelAppCtx := context.WithCancel(context.Background())
			app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			app.ctx = appCtx
			config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

			result := app.DBQueryMultiTransactional(config, "ORCLPDB1", stmt, "oracle-tx-context-"+tt.name)
			if !result.Success {
				t.Fatalf("expected Oracle transactional query success, got failure: %s", result.Message)
			}
			if result.TransactionID == "" || !result.TransactionPending {
				t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
			}

			cancelAppCtx()
			finishResult := tt.finish(app, result.TransactionID)
			if !finishResult.Success {
				t.Fatalf("expected Oracle transaction %s success after app context cancellation, got failure: %s", tt.name, finishResult.Message)
			}
			if fakeDB.session == nil || !fakeDB.session.closed {
				t.Fatal("expected Oracle transaction session to close after finish")
			}
			if len(fakeDB.execQueries) != 2 || fakeDB.execQueries[0] != stmt || fakeDB.execQueries[1] != tt.wantFinalSQL {
				t.Fatalf("expected Oracle implicit transaction to finish with %s, got %#v", tt.wantFinalSQL, fakeDB.execQueries)
			}
		})
	}
}

func TestDBQueryMultiTransactionalRollsBackOracleImplicitSessionOnDMLFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execErr: map[string]error{
			secondStmt: errors.New("delete failed"),
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

	result := app.DBQueryMultiTransactional(config, "ORCLPDB1", firstStmt+";\n"+secondStmt+";", "oracle-tx-failure")
	if result.Success {
		t.Fatal("expected Oracle transactional query failure")
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected failed transaction not to be exposed, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected Oracle transactional query to open a pinned session")
	}
	if !fakeDB.session.closed {
		t.Fatal("expected failed Oracle transaction session to close")
	}
	wantExecs := []string{firstStmt, secondStmt, "ROLLBACK"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected Oracle implicit transaction rollback, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalTreatsWithDMLAsManagedWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "WITH target AS (SELECT id FROM users WHERE active = 1) UPDATE users SET synced = 1 WHERE id IN (SELECT id FROM target)"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 2,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMultiTransactional(config, "main", stmt, "with-dml-query")
	if !result.Success {
		t.Fatalf("expected transactional WITH DML success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || fakeDB.session.closed {
		t.Fatal("expected WITH DML transaction session to stay open")
	}
	wantExecs := []string{"BEGIN", stmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalTreatsDataChangingCTEAsManagedWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			stmt: {{"id": 41}, {"id": 42}},
		},
		fieldMap: map[string][]string{
			stmt: {"id"},
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMultiTransactional(config, "main", stmt, "cte-write-query")
	if !result.Success {
		t.Fatalf("expected transactional data-changing CTE success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || fakeDB.session.closed {
		t.Fatal("expected data-changing CTE transaction session to stay open")
	}
	wantExecs := []string{"BEGIN"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
	if fakeDB.session.queryCalls == 0 {
		t.Fatal("expected data-changing CTE SELECT to query returned rows inside the transaction")
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 2 {
		t.Fatalf("expected returned rows from data-changing CTE, got %#v", resultSets)
	}
}

func TestDBQueryMultiTransactionalRollsBackAndClosesOnDMLFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execErr: map[string]error{
			secondStmt: errors.New("delete failed"),
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", firstStmt+";\n"+secondStmt+";", "tx-query")
	if result.Success {
		t.Fatal("expected transactional query failure")
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected failed transaction not to be exposed, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatal("expected failed transaction session to close")
	}
	wantExecs := []string{"START TRANSACTION", firstStmt, secondStmt, "ROLLBACK"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalSkipsManagedTransactionForReadOnlySQL(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1 AS value"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"value": 1}},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", query, "read-query")
	if !result.Success {
		t.Fatalf("expected read-only query success, got failure: %s", result.Message)
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected read-only query not to start managed transaction, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if len(fakeDB.execQueries) != 0 {
		t.Fatalf("expected no transaction wrapper execs for read-only query, got %#v", fakeDB.execQueries)
	}
}

func TestDBQueryMultiTransactionalSkipsManagedTransactionForExplicitTransactionSQL(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "UPDATE users SET name = 'new' WHERE id = 1"
	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", "BEGIN;\n"+stmt+";\nCOMMIT;", "explicit-tx-query")
	if !result.Success {
		t.Fatalf("expected explicit transaction SQL success, got failure: %s", result.Message)
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected explicit transaction SQL not to be managed, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if len(fakeDB.execQueries) != 3 {
		t.Fatalf("expected explicit transaction statements only, got %#v", fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != "BEGIN" || fakeDB.execQueries[1] != stmt || fakeDB.execQueries[2] != "COMMIT" {
		t.Fatalf("expected explicit transaction statements unchanged, got %#v", fakeDB.execQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatal("expected normal DBQueryMulti session to close after explicit transaction SQL")
	}
}

func TestDBQueryMultiPrefersResultSetForExecStoredProcedure(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_who2"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"SPID": 77, "STATUS": "SUSPENDED"},
			},
		},
		fieldMap: map[string][]string{
			query: {"SPID", "STATUS"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sp-who2-multi-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
		t.Fatalf("unexpected result sets: %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["SPID"]; got != 77 {
		t.Fatalf("expected SPID=77, got %#v", got)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryMultiDoesNotBatchExecStoredProcedureAsWriteStatement(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_who2"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"SPID": 88, "STATUS": "RUNNING"},
			},
		},
		fieldMap: map[string][]string{
			query: {"SPID", "STATUS"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sp-who2-batch-guard-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected stored procedure to skip batch write path, got batchCalls=%d", fakeDB.batchCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 {
		t.Fatalf("unexpected result sets: %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["SPID"]; got != 88 {
		t.Fatalf("expected SPID=88, got %#v", got)
	}
}

func TestDBQueryMultiSurfacesUnknownBatchWriteOutcome(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	query := "UPDATE demo SET value = 2"
	fakeDB := &fakeBatchWriteDB{batchErr: db.MarkWriteOutcomeUnknown(errors.New("write response lost"))}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryMulti(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432}, "app", query, "cli-unknown-batch")
	if result.Success {
		t.Fatalf("unknown batch write unexpectedly succeeded: %#v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["outcomeUnknown"] != true {
		t.Fatalf("unknown batch write did not expose outcomeUnknown: %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("unknown batch write was retried: batchCalls=%d", fakeDB.batchCalls)
	}
}

func TestDBQueryMultiDoesNotReplayOpaqueConnectionLossWrite(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	query := "UPDATE demo SET value = 3"
	fakeDB := &fakeBatchWriteDB{batchErr: errors.New("connection reset by peer")}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryMulti(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432}, "app", query, "cli-opaque-batch")
	if result.Success {
		t.Fatalf("opaque connection-loss write unexpectedly succeeded: %#v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["outcomeUnknown"] != true {
		t.Fatalf("opaque connection-loss write did not expose outcomeUnknown: %#v", result)
	}
	if fakeDB.batchCalls != 1 {
		t.Fatalf("opaque connection-loss write was replayed: batchCalls=%d", fakeDB.batchCalls)
	}
}

func TestDBQueryWithCancelDoesNotReplayOpaqueConnectionLossReturningWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	query := "INSERT INTO audit_logs(id) VALUES (3) RETURNING id"
	fakeDB := &fakeBatchWriteDB{queryErr: map[string]error{query: errors.New("connection reset by peer")}}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryWithCancel(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432}, "app", query, "cli-opaque-returning")
	if result.Success {
		t.Fatalf("opaque connection-loss returning write unexpectedly succeeded: %#v", result)
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["outcomeUnknown"] != true {
		t.Fatalf("opaque connection-loss returning write did not expose outcomeUnknown: %#v", result)
	}
	if fakeDB.queryCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("opaque connection-loss returning write was replayed: queryCalls=%d execCalls=%d", fakeDB.queryCalls, fakeDB.execCalls)
	}
}

func TestDBQueryMultiRunsSQLServerStatisticsBatchNatively(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SET STATISTICS IO, TIME ON;\nSELECT 1 AS value;"
	baseDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:     []map[string]interface{}{},
					Columns:  []string{},
					Messages: []string{"SQL Server parse and compile time: CPU time = 0 ms."},
				},
				{
					Rows:     []map[string]interface{}{{"value": 1}},
					Columns:  []string{"value"},
					Messages: []string{"Table 'users'. Scan count 1, logical reads 3."},
				},
			},
		},
		messageMap: map[string][]string{
			query: {"Table 'users'. Scan count 1, logical reads 3."},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-statistics-native-batch-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if strings.Contains(result.Message, "逐条执行") {
		t.Fatalf("expected SQL Server statistics batch to avoid sequential fallback warning, got %q", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one native multi-result batch call, got %d", fakeDB.multiCalls)
	}
	if baseDB.session != nil {
		t.Fatal("expected native SQL Server batch to avoid sequential session fallback")
	}
	if baseDB.queryCalls != 0 || baseDB.execCalls != 0 {
		t.Fatalf("expected native batch to avoid per-statement query/exec calls, queryCalls=%d execCalls=%d", baseDB.queryCalls, baseDB.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two native result sets, got %#v", resultSets)
	}
	if got := resultSets[1].Rows[0]["value"]; got != 1 {
		t.Fatalf("expected SELECT result value=1, got %#v", got)
	}
	if len(result.Messages) != 1 || !strings.Contains(result.Messages[0], "logical reads") {
		t.Fatalf("expected SQL Server statistics message to be returned, got %#v", result.Messages)
	}
}

func TestDBQueryMultiFallsBackWhenNativeReadOnlyBatchReturnsEmptyResults(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1 AS value"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"value": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeEmptyNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-empty-native-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected empty native result to fall back to pinned session query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected fallback to query through pinned session once, got %d", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one fallback result set, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["value"]; got != 1 {
		t.Fatalf("expected fallback SELECT result value=1, got %#v", got)
	}
}

func TestDBQueryMultiFallsBackWhenNativeReadOnlyBatchReturnsBlankResultSet(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM mes_work_order"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1, "code": "MO-1"},
			},
		},
		fieldMap: map[string][]string{
			query: {"id", "code"},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeEmptyNativeMultiResultDB{
		fakeBatchWriteDB: baseDB,
		results: []connection.ResultSetData{{
			Rows:     []map[string]interface{}{},
			Columns:  []string{},
			Messages: []string{"driver returned an empty native result set"},
		}},
		messages: []string{"driver returned an empty native result set"},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMulti(config, "main", query, "blank-native-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected blank native result set to fall back to pinned session query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected fallback to query through pinned session once, got %d", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one fallback result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"id", "code"}) {
		t.Fatalf("expected fallback columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["code"]; got != "MO-1" {
		t.Fatalf("expected fallback SELECT result code=MO-1, got %#v", got)
	}
}

func TestDBQueryMultiFallsBackWhenSQLServerReadReturnsOnlyAffectedRowsStatus(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT name FROM sys.databases"
	statusOnlyResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
		Columns: []string{"affectedRows"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"name": "master"}},
		},
		fieldMap: map[string][]string{
			query: {"name"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: statusOnlyResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeEmptyNativeMultiResultDB{
		fakeBatchWriteDB: baseDB,
		results:          statusOnlyResult,
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "custom", Driver: "mssql", Host: "127.0.0.1", Port: 1433, User: "sa"}
	result := app.DBQueryMulti(config, "master", query, "sqlserver-affected-only-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one top-level native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil || baseDB.session.queryCalls != 2 {
		t.Fatalf("expected status-only result to retry session multi then plain query, session=%#v", baseDB.session)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 {
		t.Fatalf("expected one fallback result set, got %#v", result.Data)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("expected fallback SQL Server row name=master, got %#v", got)
	}
	if got := queryResultRowsReturned(result); got != 1 {
		t.Fatalf("expected SQL audit rows returned = 1, got %d", got)
	}
}

func TestDBQueryMultiFallsBackToPlainQueryWhenSequentialMultiStillReturnsBlankResultSet(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM ldf_server.mes_work_order"
	blankNativeResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"work_order": "MO-20260629"},
			},
		},
		fieldMap: map[string][]string{
			query: {"work_order"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: blankNativeResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMulti(config, "ldf_server_dbs_dev", query, "sequential-blank-native-read-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 1 {
		t.Fatalf("expected one top-level native multi-result attempt, got %d", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for sequential fallback")
	}
	if baseDB.session.queryCalls != 2 {
		t.Fatalf("expected sequential multi-result attempt plus plain query fallback, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one plain query fallback result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"work_order"}) {
		t.Fatalf("expected fallback columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["work_order"]; got != "MO-20260629" {
		t.Fatalf("expected fallback SELECT result work_order=MO-20260629, got %#v", got)
	}
}

func TestDBQueryMultiPrefersPlainQueryForKingbaseReadResults(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM ldf_server.mes_work_order"
	nativeEmptyRowsResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{"id", "work_order"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1001, "work_order": "MO-20260629"},
			},
		},
		fieldMap: map[string][]string{
			query: {"id", "work_order"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: nativeEmptyRowsResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "kingbase", Host: "127.0.0.1", Port: 54321, User: "system"}

	result := app.DBQueryMulti(config, "ldf_server_dbs_dev", query, "kingbase-plain-query-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("expected kingbase read query to skip top-level native multi-result path, got %d calls", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for kingbase read query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected kingbase read query to use plain session query once, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"id", "work_order"}) {
		t.Fatalf("expected plain query columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["work_order"]; got != "MO-20260629" {
		t.Fatalf("expected plain query SELECT result work_order=MO-20260629, got %#v", got)
	}
}

func TestDBQueryMultiSuccessfulKingbaseQueryRefreshesCachedHealthTimestamp(t *testing.T) {
	installFakeOptionalDriverRuntime(t)

	query := "SELECT * FROM ldf_server.andon_dash_events LIMIT 101 OFFSET 0"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"id"},
		},
		queryErr: map[string]error{},
	}
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:     "kingbase",
		Host:     "127.0.0.1",
		Port:     54321,
		User:     "system",
		Database: "ldf_server_dbs_dev",
	}
	key := getCacheKey(config)
	previousHealthyAt := time.Now().Add(-10 * time.Second)
	app.dbCache[key] = cachedDatabase{
		inst:     fakeDB,
		lastPing: previousHealthyAt,
		config:   normalizeCacheKeyConfig(config),
	}

	result := app.DBQueryMulti(config, config.Database, query, "kingbase-refresh-cache-health-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.pingCalls != 0 {
		t.Fatalf("expected a recently healthy cached connection to skip foreground Ping, got %d calls", fakeDB.pingCalls)
	}
	if got := app.dbCache[key].lastPing; !got.After(previousHealthyAt) {
		t.Fatalf("expected successful query to refresh cached health timestamp, before=%s after=%s", previousHealthyAt, got)
	}
}

func TestDBQueryMultiPrefersPlainQueryForDamengReadResults(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM PUB_TIMER"
	nativeEmptyRowsResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{"ID", "NAME"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"ID": 1, "NAME": "timer_a"},
			},
		},
		fieldMap: map[string][]string{
			query: {"ID", "NAME"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: nativeEmptyRowsResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "custom", Driver: "dm8", Host: "127.0.0.1", Port: 5236, User: "SYSDBA"}

	result := app.DBQueryMulti(config, "SYSDBA", query, "dameng-plain-query-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("expected dameng read query to skip top-level native multi-result path, got %d calls", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for dameng read query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected dameng read query to use plain session query once, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"ID", "NAME"}) {
		t.Fatalf("expected plain query columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["NAME"]; got != "timer_a" {
		t.Fatalf("expected plain query SELECT result NAME=timer_a, got %#v", got)
	}
}

func TestDBQueryMultiPrefersPlainQueryForOceanBaseOracleReadResults(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT * FROM EINP_BASICINFO.AC01"
	nativeEmptyRowsResult := []connection.ResultSetData{{
		Rows:    []map[string]interface{}{},
		Columns: []string{"AAC001", "AAC003"},
	}}
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"AAC001": 1001, "AAC003": "张三"},
			},
		},
		fieldMap: map[string][]string{
			query: {"AAC001", "AAC003"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: nativeEmptyRowsResult,
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type:              "oceanbase",
		Host:              "127.0.0.1",
		Port:              2881,
		User:              "SBDEVREAD",
		OceanBaseProtocol: "oracle",
	}

	result := app.DBQueryMulti(config, "SBDEV", query, "oceanbase-oracle-plain-query-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.multiCalls != 0 {
		t.Fatalf("expected OceanBase Oracle read query to skip top-level native multi-result path, got %d calls", fakeDB.multiCalls)
	}
	if baseDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for OceanBase Oracle read query")
	}
	if baseDB.session.queryCalls != 1 {
		t.Fatalf("expected OceanBase Oracle read query to use plain session query once, got %d calls", baseDB.session.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if !reflect.DeepEqual(resultSets[0].Columns, []string{"AAC001", "AAC003"}) {
		t.Fatalf("expected plain query columns, got %#v", resultSets[0].Columns)
	}
	if got := resultSets[0].Rows[0]["AAC003"]; got != "张三" {
		t.Fatalf("expected plain query SELECT result AAC003=张三, got %#v", got)
	}
}

func TestDBQueryMultiUsesPinnedSessionForSequentialFallback(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			"SELECT 1 AS value": {
				{"value": 1},
			},
		},
		fieldMap: map[string][]string{
			"SELECT 1 AS value": {"value"},
		},
		messageMap: map[string][]string{
			"SET NOCOUNT ON": {"NOCOUNT 已开启"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", "SET NOCOUNT ON;\nSELECT 1 AS value;", "session-fallback-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.session == nil {
		t.Fatal("expected DBQueryMulti to open a pinned session for sequential fallback")
	}
	if !fakeDB.session.closed {
		t.Fatal("expected DBQueryMulti to close the pinned session")
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected SQL Server SET statement to avoid exec-only path, got execCalls=%d", fakeDB.session.execCalls)
	}
	if fakeDB.session.queryCalls != 2 {
		t.Fatalf("expected both statements to query through pinned session, got queryCalls=%d", fakeDB.session.queryCalls)
	}
	if fakeDB.queryCalls != 2 {
		t.Fatalf("expected exactly two underlying query calls, got %d", fakeDB.queryCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two result sets, got %#v", resultSets)
	}
	if len(resultSets[0].Messages) != 1 || resultSets[0].Messages[0] != "NOCOUNT 已开启" {
		t.Fatalf("expected first result set to keep session message, got %#v", resultSets[0].Messages)
	}
	if got := resultSets[1].Rows[0]["value"]; got != 1 {
		t.Fatalf("expected second result set value=1, got %#v", got)
	}
}

func TestDBQueryMultiKeepsAllResultSetsFromSingleSQLServerStatement(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_helpdb"
	fakeDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:    []map[string]interface{}{{"name": "master"}},
					Columns: []string{"name"},
				},
				{
					Rows:    []map[string]interface{}{{"owner": "sa"}},
					Columns: []string{"owner"},
				},
			},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sp-helpdb-multi-result-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two result sets, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("expected first result set to keep master row, got %#v", got)
	}
	if got := resultSets[1].Rows[0]["owner"]; got != "sa" {
		t.Fatalf("expected second result set to keep owner row, got %#v", got)
	}
	if resultSets[0].StatementIndex != 1 || resultSets[1].StatementIndex != 1 {
		t.Fatalf("expected both result sets to map to the first statement, got %#v", resultSets)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryMultiNormalizesSingleSQLServerSelectAffectedRowsStatementIndex(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "select * from c_dddw"
	fakeDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:    []map[string]interface{}{{"dddwno": "001", "dddwlist": "demo"}},
					Columns: []string{"dddwno", "dddwlist"},
				},
				{
					Rows:    []map[string]interface{}{{"affectedRows": int64(846)}},
					Columns: []string{"affectedRows"},
				},
			},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "hydee", query, "sqlserver-select-affectedrows-index-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected two result sets, got %#v", resultSets)
	}
	if resultSets[0].StatementIndex != 1 || resultSets[1].StatementIndex != 1 {
		t.Fatalf("expected select result and trailing affectedRows result to share statementIndex=1, got %#v", resultSets)
	}
}

func TestDBQueryMultiNormalizesSQLServerSelectAffectedRowsPairsByStatement(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1;\nSELECT 2;"
	baseDB := &fakeBatchWriteDB{
		multiResult: map[string][]connection.ResultSetData{
			query: {
				{
					Rows:    []map[string]interface{}{{"value": int64(1)}},
					Columns: []string{"value"},
				},
				{
					Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
					Columns: []string{"affectedRows"},
				},
				{
					Rows:    []map[string]interface{}{{"value": int64(2)}},
					Columns: []string{"value"},
				},
				{
					Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
					Columns: []string{"affectedRows"},
				},
			},
		},
		queryErr: map[string]error{},
	}
	fakeDB := &fakeNativeMultiResultDB{fakeBatchWriteDB: baseDB}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-select-pairs-index-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 4 {
		t.Fatalf("expected four raw SQL Server result sets, got %#v", resultSets)
	}
	wantStatementIndexes := []int{1, 1, 2, 2}
	for idx, want := range wantStatementIndexes {
		if got := resultSets[idx].StatementIndex; got != want {
			t.Fatalf("result set %d statementIndex = %d, want %d; all results: %#v", idx, got, want, resultSets)
		}
	}
}

func TestNormalizeNativeResultStatementIndexesKeepsAmbiguousSQLServerResultsUnassigned(t *testing.T) {
	statements := []string{"SELECT 1", "SELECT 2"}
	results := []connection.ResultSetData{
		{Rows: []map[string]interface{}{{"first": int64(1)}}, Columns: []string{"first"}},
		{Rows: []map[string]interface{}{{"second": int64(2)}}, Columns: []string{"second"}},
		{Rows: []map[string]interface{}{{"affectedRows": int64(1)}}, Columns: []string{"affectedRows"}},
		{Rows: []map[string]interface{}{{"affectedRows": int64(1)}}, Columns: []string{"affectedRows"}},
	}

	normalizeNativeResultStatementIndexes("sqlserver", statements, results)

	for idx, result := range results {
		if result.StatementIndex != 0 {
			t.Fatalf("ambiguous result set %d received guessed statementIndex=%d: %#v", idx, result.StatementIndex, results)
		}
	}
}

func TestDBQueryMultiTreatsBareSQLServerProcedureCallAsQueryFirst(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := `p_get_select c_dyscript,'projectid = 1',1`
	fakeDB := &fakeBatchWriteDB{
		messageMap: map[string][]string{
			query: {`INSERT c_dyscript(id,name) values (1,"demo")`},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-bare-proc-query-first-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.session == nil {
		t.Fatal("expected bare SQL Server procedure call to use a pinned query session")
	}
	if fakeDB.session.queryCalls != 1 {
		t.Fatalf("expected one session query call, got %d", fakeDB.session.queryCalls)
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.session.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if len(resultSets[0].Rows) != 0 || len(resultSets[0].Columns) != 0 {
		t.Fatalf("expected message-only result set, got %#v", resultSets[0])
	}
	if len(resultSets[0].Messages) != 1 || !strings.Contains(resultSets[0].Messages[0], "INSERT c_dyscript") {
		t.Fatalf("expected procedure output message to be preserved, got %#v", resultSets[0].Messages)
	}
}

func TestDBQueryMultiTreatsReturningWriteAsQueryFirst(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "INSERT INTO audit_logs(id) VALUES (1) RETURNING id"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"id"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMulti(config, "main", query, "postgres-returning-query-first-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected RETURNING write to skip batch exec path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || fakeDB.session.queryCalls != 1 {
		t.Fatalf("expected RETURNING write to query through pinned session, got session=%#v", fakeDB.session)
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.session.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 || resultSets[0].Rows[0]["id"] != 1 {
		t.Fatalf("expected RETURNING rows to be preserved, got %#v", resultSets)
	}
}

func TestDBQueryMultiTreatsSQLServerOutputWriteAsQueryFirst(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "UPDATE users SET name = 'next' OUTPUT inserted.id WHERE id = 1"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"id"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-output-query-first-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected OUTPUT write to skip batch exec path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || fakeDB.session.queryCalls != 1 {
		t.Fatalf("expected OUTPUT write to query through pinned session, got session=%#v", fakeDB.session)
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.session.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 || resultSets[0].Rows[0]["id"] != 1 {
		t.Fatalf("expected OUTPUT rows to be preserved, got %#v", resultSets)
	}
}

func TestDBQueryMultiTreatsWrappedMessageBlocksAsQueryFirst(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	sqlServerQuery := "IF 1 = 1 PRINT 'done'"
	postgresQuery := "DO $$ BEGIN RAISE NOTICE 'done'; END $$"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			sqlServerQuery: {},
			postgresQuery:  {},
		},
		fieldMap: map[string][]string{
			sqlServerQuery: {},
			postgresQuery:  {},
		},
		messageMap: map[string][]string{
			sqlServerQuery: {"done"},
			postgresQuery:  {"done"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))

	sqlServerResult := app.DBQueryMulti(connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}, "master", sqlServerQuery, "sqlserver-print-block-test")
	if !sqlServerResult.Success {
		t.Fatalf("expected SQL Server block success, got failure: %s", sqlServerResult.Message)
	}

	postgresResult := app.DBQueryMulti(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}, "main", postgresQuery, "postgres-notice-block-test")
	if !postgresResult.Success {
		t.Fatalf("expected PostgreSQL notice block success, got failure: %s", postgresResult.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected message blocks to skip batch exec path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected message blocks to avoid shared exec path, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryMultiTransactionalTreatsSelectIntoAsManagedWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "SELECT * INTO archived_users FROM users"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 12,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMultiTransactional(config, "main", stmt, "select-into-managed-tx-test")
	if !result.Success {
		t.Fatalf("expected managed SELECT INTO success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || fakeDB.session.closed {
		t.Fatal("expected managed SELECT INTO transaction session to stay open")
	}
	wantExecs := []string{"BEGIN", stmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestExecuteManagedSQLTransactionStatementsPrefersPlainQueryForDamengReadResults(t *testing.T) {
	query := "SELECT * FROM PUB_TIMER"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"ID": 1, "NAME": "timer_a"},
			},
		},
		fieldMap: map[string][]string{
			query: {"ID", "NAME"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: {{
				Rows:    []map[string]interface{}{},
				Columns: []string{"ID", "NAME"},
			}},
		},
		queryErr: map[string]error{},
	}
	session := &fakeBatchWriteSession{parent: baseDB}

	results, err := executeManagedSQLTransactionStatements(
		context.Background(),
		session,
		connection.ConnectionConfig{Type: "custom", Driver: "dm8"},
		[]string{query},
		nil,
	)
	if err != nil {
		t.Fatalf("expected executeManagedSQLTransactionStatements success, got %v", err)
	}
	if session.queryCalls != 1 {
		t.Fatalf("expected dameng managed read query to use plain query once, got %d calls", session.queryCalls)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result set, got %#v", results)
	}
	if !reflect.DeepEqual(results[0].Columns, []string{"ID", "NAME"}) {
		t.Fatalf("expected plain query columns, got %#v", results[0].Columns)
	}
	if got := results[0].Rows[0]["NAME"]; got != "timer_a" {
		t.Fatalf("expected plain query SELECT result NAME=timer_a, got %#v", got)
	}
}

func TestExecuteManagedSQLTransactionStatementsFallsBackWhenSQLServerReadReturnsOnlyAffectedRowsStatus(t *testing.T) {
	query := "SELECT name FROM sys.databases"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"name": "master"}},
		},
		fieldMap: map[string][]string{
			query: {"name"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: {{
				Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
				Columns: []string{"affectedRows"},
			}},
		},
		queryErr: map[string]error{},
	}
	session := &fakeBatchWriteSession{parent: baseDB}

	results, err := executeManagedSQLTransactionStatements(
		context.Background(),
		session,
		connection.ConnectionConfig{Type: "sqlserver"},
		[]string{query},
		nil,
	)
	if err != nil {
		t.Fatalf("expected executeManagedSQLTransactionStatements success, got %v", err)
	}
	if session.queryCalls != 2 {
		t.Fatalf("expected SQL Server status-only result plus plain query fallback, got %d calls", session.queryCalls)
	}
	if len(results) != 1 || len(results[0].Rows) != 1 {
		t.Fatalf("expected one fallback result row, got %#v", results)
	}
	if got := results[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("expected fallback SQL Server row name=master, got %#v", got)
	}
	if got := queryResultRowsReturned(connection.QueryResult{Success: true, Data: results}); got != 1 {
		t.Fatalf("expected SQL audit rows returned = 1, got %d", got)
	}
}

func TestExecuteManagedSQLTransactionStatementsPrefersPlainQueryForOceanBaseOracleReadResults(t *testing.T) {
	query := "SELECT * FROM EINP_BASICINFO.AC01"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"AAC001": 1001, "AAC003": "张三"},
			},
		},
		fieldMap: map[string][]string{
			query: {"AAC001", "AAC003"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: {{
				Rows:    []map[string]interface{}{},
				Columns: []string{"AAC001", "AAC003"},
			}},
		},
		queryErr: map[string]error{},
	}
	session := &fakeBatchWriteSession{parent: baseDB}

	results, err := executeManagedSQLTransactionStatements(
		context.Background(),
		session,
		connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"},
		[]string{query},
		nil,
	)
	if err != nil {
		t.Fatalf("expected executeManagedSQLTransactionStatements success, got %v", err)
	}
	if session.queryCalls != 1 {
		t.Fatalf("expected OceanBase Oracle managed read query to use plain query once, got %d calls", session.queryCalls)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result set, got %#v", results)
	}
	if !reflect.DeepEqual(results[0].Columns, []string{"AAC001", "AAC003"}) {
		t.Fatalf("expected plain query columns, got %#v", results[0].Columns)
	}
	if got := results[0].Rows[0]["AAC003"]; got != "张三" {
		t.Fatalf("expected plain query SELECT result AAC003=张三, got %#v", got)
	}
}
