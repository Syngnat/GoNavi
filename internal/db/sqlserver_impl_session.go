//go:build gonavi_full_drivers || gonavi_sqlserver_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/golang-sql/sqlexp"
)

func (e *sqlServerSessionExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlServerSessionExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	if e == nil || e.conn == nil {
		return 0, fmt.Errorf("连接未打开")
	}
	res, err := e.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return sqlServerRowsAffected(query, res)
}

func sqlServerRowsAffected(query string, res sql.Result) (int64, error) {
	if res == nil {
		return 0, nil
	}
	affected, err := res.RowsAffected()
	if err == nil {
		return affected, nil
	}
	if sqlServerAllowsUnknownRowsAffected(query) {
		return 0, nil
	}
	return 0, err
}

func sqlServerAllowsUnknownRowsAffected(query string) bool {
	trimmed := strings.TrimSpace(query)
	if trimmed == "" {
		return false
	}
	fields := strings.Fields(trimmed)
	if len(fields) == 0 {
		return false
	}
	switch strings.ToLower(fields[0]) {
	case "begin", "commit", "rollback", "save":
		return true
	default:
		return false
	}
}

func (e *sqlServerSessionExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	rows, columns, _, err := e.QueryWithMessages(query)
	return rows, columns, err
}

func (e *sqlServerSessionExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	rows, columns, _, err := e.QueryContextWithMessages(ctx, query)
	return rows, columns, err
}

func (e *sqlServerSessionExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if e == nil || e.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	retmsg := &sqlexp.ReturnMessage{}
	rows, err := e.conn.QueryContext(ctx, query, retmsg)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (e *sqlServerSessionExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlServerSessionExecer) QueryWithMessages(query string) ([]map[string]interface{}, []string, []string, error) {
	return e.QueryContextWithMessages(context.Background(), query)
}

func (e *sqlServerSessionExecer) QueryContextWithMessages(ctx context.Context, query string) ([]map[string]interface{}, []string, []string, error) {
	results, messages, err := e.QueryMultiContextWithMessages(ctx, query)
	if err != nil {
		return nil, nil, nil, err
	}
	if len(results) == 0 {
		return []map[string]interface{}{}, []string{}, messages, nil
	}
	first := results[0]
	if first.Rows == nil {
		first.Rows = []map[string]interface{}{}
	}
	if first.Columns == nil {
		first.Columns = []string{}
	}
	return first.Rows, first.Columns, messages, nil
}

func (e *sqlServerSessionExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	results, _, err := e.QueryMultiWithMessages(query)
	return results, err
}

func (e *sqlServerSessionExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, _, err := e.QueryMultiContextWithMessages(ctx, query)
	return results, err
}

func (e *sqlServerSessionExecer) QueryMultiWithMessages(query string) ([]connection.ResultSetData, []string, error) {
	return e.QueryMultiContextWithMessages(context.Background(), query)
}

func (e *sqlServerSessionExecer) QueryMultiContextWithMessages(ctx context.Context, query string) ([]connection.ResultSetData, []string, error) {
	if e == nil || e.conn == nil {
		return nil, nil, fmt.Errorf("连接未打开")
	}
	retmsg := &sqlexp.ReturnMessage{}
	rows, err := e.conn.QueryContext(ctx, query, retmsg)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanSQLServerRowsWithMessages(ctx, rows, retmsg)
}

func (e *sqlServerSessionExecer) Close() error {
	if e == nil || e.conn == nil {
		return nil
	}
	return e.conn.Close()
}

// Discard permanently evicts the pinned physical connection from database/sql.
// This is required when restoring session-scoped state such as SHOWPLAN_XML
// fails: returning that connection to the pool could make later queries return
// plans instead of executing normally.
func (e *sqlServerSessionExecer) Discard() error {
	if e == nil {
		return nil
	}
	return discardSQLConn(&e.conn)
}
