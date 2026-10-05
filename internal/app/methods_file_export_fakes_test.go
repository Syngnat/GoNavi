package app

import (
	"context"
	"fmt"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type fakeExportQueryDB struct {
	data []map[string]interface{}
	cols []string
	err  error
	defs []connection.ColumnDefinition

	lastQuery          string
	queries            []string
	lastContextTimeout time.Duration
	hasContextDeadline bool
	lastQueryContext   context.Context
}

type fakeStreamExportDB struct {
	fakeExportQueryDB
	streamData    []map[string]interface{}
	streamCols    []string
	streamHits    int
	queryHits     int
	streamStarted chan context.Context
	streamBlock   bool
}

type fakeValueStreamExportDB struct {
	fakeExportQueryDB
	streamCols   []string
	streamValues [][]interface{}
	streamHits   int
	queryHits    int
	valueHits    int
}

type fakeGeneratedValueStreamExportDB struct {
	streamCols []string
	rowCount   int
	streamHits int
	valueHits  int
}

type exportContextTestConsumer struct{}

func (exportContextTestConsumer) SetColumns([]string) error { return nil }

func (exportContextTestConsumer) ConsumeRow(map[string]interface{}) error { return nil }

type fakeSQLDumpExportDB struct {
	fakeExportQueryDB
	tables    []string
	createSQL string
	createErr error
}

type fakePostgresCommentExportDB struct {
	fakeSQLDumpExportDB
	tableComment      string
	tableCommentErr   error
	commentSchema     string
	commentTable      string
	tableCommentCalls int
}

type captureExportProgressEmitter struct {
	events []exportProgressPayload
}

func (e *captureExportProgressEmitter) Emit(name string, args ...any) {
	if name != exportProgressEvent || len(args) == 0 {
		return
	}
	payload, ok := args[0].(exportProgressPayload)
	if ok {
		e.events = append(e.events, payload)
	}
}

func (f *fakeExportQueryDB) Connect(config connection.ConnectionConfig) error { return nil }

func (f *fakeExportQueryDB) Close() error { return nil }

func (f *fakeExportQueryDB) Ping() error { return nil }

func (f *fakeExportQueryDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.lastQuery = query
	f.queries = append(f.queries, query)
	return f.data, f.cols, f.err
}

func (f *fakeExportQueryDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.lastQuery = query
	f.queries = append(f.queries, query)
	f.lastQueryContext = ctx
	if deadline, ok := ctx.Deadline(); ok {
		f.hasContextDeadline = true
		f.lastContextTimeout = time.Until(deadline)
	}
	return f.data, f.cols, f.err
}

func (f *fakeExportQueryDB) Exec(query string) (int64, error) { return 0, nil }

func (f *fakeExportQueryDB) GetDatabases() ([]string, error) { return nil, nil }

func (f *fakeExportQueryDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}

func (f *fakeExportQueryDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}

func (f *fakeExportQueryDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return f.defs, nil
}

func (f *fakeExportQueryDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *fakeExportQueryDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *fakeExportQueryDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *fakeExportQueryDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeSQLDumpExportDB) GetTables(dbName string) ([]string, error) {
	return append([]string(nil), f.tables...), nil
}

func (f *fakeSQLDumpExportDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return f.createSQL, f.createErr
}

func (f *fakePostgresCommentExportDB) GetTableComment(dbName, tableName string) (string, error) {
	f.tableCommentCalls++
	f.commentSchema = dbName
	f.commentTable = tableName
	return f.tableComment, f.tableCommentErr
}

func (f *fakeStreamExportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.Query(query)
}

func (f *fakeStreamExportDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.QueryContext(ctx, query)
}

func (f *fakeStreamExportDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeStreamExportDB) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamHits++
	f.lastQuery = query
	f.lastQueryContext = ctx
	if f.streamStarted != nil {
		select {
		case f.streamStarted <- ctx:
		default:
		}
	}
	if f.streamBlock {
		<-ctx.Done()
		return ctx.Err()
	}
	if err := consumer.SetColumns(f.streamCols); err != nil {
		return err
	}
	for _, row := range f.streamData {
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeValueStreamExportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.Query(query)
}

func (f *fakeValueStreamExportDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	f.queryHits++
	return f.fakeExportQueryDB.QueryContext(ctx, query)
}

func (f *fakeValueStreamExportDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeValueStreamExportDB) StreamQueryContext(_ context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamHits++
	f.lastQuery = query
	if err := consumer.SetColumns(f.streamCols); err != nil {
		return err
	}
	if valueConsumer, ok := consumer.(db.QueryStreamValueConsumer); ok {
		for _, row := range f.streamValues {
			f.valueHits++
			if err := valueConsumer.ConsumeRowValues(row); err != nil {
				return err
			}
		}
		return nil
	}
	for _, row := range f.streamValues {
		entry := make(map[string]interface{}, len(f.streamCols))
		for idx, column := range f.streamCols {
			if idx < len(row) {
				entry[column] = row[idx]
			}
		}
		if err := consumer.ConsumeRow(entry); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeGeneratedValueStreamExportDB) Connect(config connection.ConnectionConfig) error {
	return nil
}

func (f *fakeGeneratedValueStreamExportDB) Close() error { return nil }

func (f *fakeGeneratedValueStreamExportDB) Ping() error { return nil }

func (f *fakeGeneratedValueStreamExportDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, context.DeadlineExceeded
}

func (f *fakeGeneratedValueStreamExportDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return nil, nil, context.DeadlineExceeded
}

func (f *fakeGeneratedValueStreamExportDB) Exec(query string) (int64, error) { return 0, nil }

func (f *fakeGeneratedValueStreamExportDB) GetDatabases() ([]string, error) { return nil, nil }

func (f *fakeGeneratedValueStreamExportDB) GetTables(dbName string) ([]string, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetCreateStatement(dbName, tableName string) (string, error) {
	return "", nil
}

func (f *fakeGeneratedValueStreamExportDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}

func (f *fakeGeneratedValueStreamExportDB) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *fakeGeneratedValueStreamExportDB) StreamQueryContext(_ context.Context, query string, consumer db.QueryStreamConsumer) error {
	f.streamHits++
	if err := consumer.SetColumns(f.streamCols); err != nil {
		return err
	}
	valueConsumer, ok := consumer.(db.QueryStreamValueConsumer)
	if !ok {
		return fmt.Errorf("value stream consumer required")
	}
	for i := 0; i < f.rowCount; i++ {
		f.valueHits++
		if err := valueConsumer.ConsumeRowValues([]interface{}{
			i + 1,
			"benchmark-user",
			"plain export payload without timezone marker",
			"2026-06-17 12:34:56",
			"enabled",
		}); err != nil {
			return err
		}
	}
	return nil
}
