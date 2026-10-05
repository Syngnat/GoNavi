package app

import (
	"context"
	"database/sql"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
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
	queryDelay        map[string]time.Duration
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
	if delay := f.queryDelay[query]; delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		}
	}
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

var _ db.BatchWriteExecer = (*fakeBatchWriteDB)(nil)

var _ db.SessionExecerProvider = (*fakeBatchWriteDB)(nil)

var _ db.QueryMessageExecer = (*fakeBatchWriteDB)(nil)

var _ db.StatementQueryMessageExecer = (*fakeBatchWriteSession)(nil)
