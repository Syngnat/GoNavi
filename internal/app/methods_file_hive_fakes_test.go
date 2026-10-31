package app

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type hiveTransferFake struct {
	fakeExportQueryDB
	views          []string
	viewError      error
	ddl            string
	ddlByTable     map[string]string
	tables         []string
	partitions     []string
	rows           []map[string]interface{}
	columns        []string
	inserts        []map[string]interface{}
	appliedContext context.Context
	streamQueries  []string
	session        *hiveTransferSession
	opened         int
	rootExec       int
	batchCalls     int
	applyError     error
	columnError    error
	partitionError error
}

func (f *hiveTransferFake) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	f.queries = append(f.queries, query)
	if strings.HasPrefix(query, "SHOW CREATE TABLE ") {
		ddl := f.ddl
		if f.ddlByTable != nil {
			ddl = f.ddlByTable[strings.TrimPrefix(query, "SHOW CREATE TABLE ")]
		}
		if ddl == "" {
			return nil, nil, fmt.Errorf("missing test DDL for %s", query)
		}
		rows := make([]map[string]interface{}, 0)
		for _, line := range strings.Split(ddl, "\n") {
			rows = append(rows, map[string]interface{}{"createtab_stmt": line})
		}
		return rows, []string{"createtab_stmt"}, nil
	}
	return f.fakeExportQueryDB.QueryContext(ctx, query)
}

func (f *hiveTransferFake) HiveViews(ctx context.Context, _ string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return f.views, f.viewError
}

func (f *hiveTransferFake) GetTables(string) ([]string, error) { return f.tables, nil }

func (f *hiveTransferFake) GetColumnsContext(ctx context.Context, _, _ string) ([]connection.ColumnDefinition, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return f.defs, f.columnError
}

func (f *hiveTransferFake) StreamQuery(query string, consumer db.QueryStreamConsumer) error {
	return f.StreamQueryContext(context.Background(), query, consumer)
}

func (f *hiveTransferFake) StreamQueryContext(ctx context.Context, query string, consumer db.QueryStreamConsumer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	f.streamQueries = append(f.streamQueries, query)
	if strings.HasPrefix(query, "SHOW PARTITIONS ") {
		if f.partitionError != nil {
			return f.partitionError
		}
		if err := consumer.SetColumns([]string{"partition"}); err != nil {
			return err
		}
		for _, partition := range f.partitions {
			if err := consumer.ConsumeRow(map[string]interface{}{"partition": partition}); err != nil {
				return err
			}
		}
		return nil
	}
	if err := consumer.SetColumns(f.columns); err != nil {
		return err
	}
	for _, row := range f.rows {
		if err := consumer.ConsumeRow(row); err != nil {
			return err
		}
	}
	return nil
}

func (f *hiveTransferFake) ApplyChanges(table string, changes connection.ChangeSet) error {
	return f.ApplyChangesContext(context.Background(), table, changes)
}

func (f *hiveTransferFake) ApplyChangesContext(ctx context.Context, _ string, changes connection.ChangeSet) error {
	f.appliedContext = ctx
	if err := ctx.Err(); err != nil {
		return err
	}
	f.inserts = append(f.inserts, cloneImportRows(changes.Inserts)...)
	return f.applyError
}

func (f *hiveTransferFake) SupportsBatchApply() bool  { return true }
func (f *hiveTransferFake) SupportsBatchWrites() bool { return true }

func (f *hiveTransferFake) Exec(query string) (int64, error) {
	f.rootExec++
	return 0, fmt.Errorf("root Exec must not run: %s", query)
}

func (f *hiveTransferFake) ExecBatchContext(context.Context, string) (int64, error) {
	f.batchCalls++
	return 0, fmt.Errorf("Hive must not batch SQL file statements")
}

func (f *hiveTransferFake) OpenSessionExecer(ctx context.Context) (db.StatementExecer, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	f.opened++
	if f.session == nil {
		f.session = &hiveTransferSession{}
	}
	return f.session, nil
}

type hiveTransferSession struct {
	statements   []string
	closed       int
	discarded    int
	failAt       int
	failure      error
	closeError   error
	discardError error
	afterExec    func()
	batchCalls   int
}

func (s *hiveTransferSession) Exec(query string) (int64, error) {
	return s.ExecContext(context.Background(), query)
}

func (s *hiveTransferSession) ExecContext(ctx context.Context, query string) (int64, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.statements = append(s.statements, query)
	if s.afterExec != nil {
		s.afterExec()
	}
	if s.failAt > 0 && len(s.statements) == s.failAt {
		return 0, s.failure
	}
	return 1, nil
}

func (s *hiveTransferSession) ExecBatchContext(context.Context, string) (int64, error) {
	s.batchCalls++
	return 0, fmt.Errorf("Hive file statements must be sequential")
}

func (s *hiveTransferSession) Close() error   { s.closed++; return s.closeError }
func (s *hiveTransferSession) Discard() error { s.discarded++; return s.discardError }
