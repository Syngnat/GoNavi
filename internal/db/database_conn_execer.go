package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"

	"GoNavi-Wails/internal/connection"
)

type sqlConnStatementExecer struct {
	conn        *sql.Conn
	scanDialect string
}

func NewSQLConnStatementExecer(conn *sql.Conn) StatementExecer {
	return NewSQLConnStatementExecerWithDialect(conn, "")
}

func NewSQLConnStatementExecerWithDialect(conn *sql.Conn, scanDialect string) StatementExecer {
	return &sqlConnStatementExecer{conn: conn, scanDialect: scanDialect}
}

func localizedDatabaseRuntimeError(key string, params map[string]any) error {
	return fmt.Errorf("%s", localizedDriverRuntimeText(key, params))
}

func wrapDatabaseConnectionOpenError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s%w", localizedDriverRuntimeText("db.backend.error.connection_open_failed_prefix", nil), err)
}

func wrapDatabaseConnectionVerifyError(err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s%w", localizedDriverRuntimeText("db.backend.error.connection_verify_failed_prefix", nil), err)
}

func (e *sqlConnStatementExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	if e == nil || e.conn == nil {
		return 0, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	res, err := e.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *sqlConnStatementExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlConnStatementExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if e == nil || e.conn == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := e.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialectContext(ctx, rows, e.scanDialect)
}

func (e *sqlConnStatementExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(context.Background(), query)
}

func (e *sqlConnStatementExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	if e == nil || e.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	rows, err := e.conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRowsForDialect(rows, e.scanDialect, consumer)
}

func (e *sqlConnStatementExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlConnStatementExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if e == nil || e.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	rows, err := e.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialectContext(ctx, rows, e.scanDialect)
}

func (e *sqlConnStatementExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return e.QueryMultiContext(context.Background(), query)
}

func (e *sqlConnStatementExecer) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	return e.ExecContext(ctx, query)
}

func (e *sqlConnStatementExecer) Close() error {
	if e == nil || e.conn == nil {
		return nil
	}
	return e.conn.Close()
}

func discardSQLConn(connRef **sql.Conn) error {
	if connRef == nil || *connRef == nil {
		return nil
	}
	conn := *connRef
	err := conn.Raw(func(any) error { return driver.ErrBadConn })
	if errors.Is(err, driver.ErrBadConn) {
		// Raw returning ErrBadConn makes database/sql permanently evict the
		// physical connection instead of returning it to the idle pool. Clear
		// the wrapper reference so a deferred Close cannot touch it again.
		*connRef = nil
		return nil
	}
	return err
}

func (e *sqlConnStatementExecer) Discard() error {
	if e == nil {
		return nil
	}
	return discardSQLConn(&e.conn)
}
