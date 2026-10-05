package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
)

type sqlConnTransactionExecer struct {
	mu                sync.Mutex
	conn              *sql.Conn
	done              bool
	state             sqlTransactionState
	rollbackAttempted bool
	commitSQL         string
	rollbackSQL       string
	scanDialect       string
}

type sqlTransactionState uint8

const (
	sqlTransactionStateOpen sqlTransactionState = iota
	sqlTransactionStateFinishing
	sqlTransactionStateFinished
	sqlTransactionStateUnknown
)

func NewSQLConnTransactionExecer(conn *sql.Conn, commitSQL string, rollbackSQL string) TransactionExecer {
	return NewSQLConnTransactionExecerWithDialect(conn, commitSQL, rollbackSQL, "")
}

func NewSQLConnTransactionExecerWithDialect(conn *sql.Conn, commitSQL string, rollbackSQL string, scanDialect string) TransactionExecer {
	return &sqlConnTransactionExecer{
		conn:        conn,
		commitSQL:   strings.TrimSpace(commitSQL),
		rollbackSQL: strings.TrimSpace(rollbackSQL),
		scanDialect: scanDialect,
	}
}

func (e *sqlConnTransactionExecer) activeConn() (*sql.Conn, error) {
	if e == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.conn == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	if e.done || e.state != sqlTransactionStateOpen {
		return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_already_finished", nil)
	}
	return e.conn, nil
}

func (e *sqlConnTransactionExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	conn, err := e.activeConn()
	if err != nil {
		return 0, err
	}
	res, err := conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *sqlConnTransactionExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlConnTransactionExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	conn, err := e.activeConn()
	if err != nil {
		return nil, nil, err
	}
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsForDialectContext(ctx, rows, e.scanDialect)
}

func (e *sqlConnTransactionExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(context.Background(), query)
}

func (e *sqlConnTransactionExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	conn, err := e.activeConn()
	if err != nil {
		return err
	}
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRowsForDialect(rows, e.scanDialect, consumer)
}

func (e *sqlConnTransactionExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlConnTransactionExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	conn, err := e.activeConn()
	if err != nil {
		return nil, err
	}
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsForDialectContext(ctx, rows, e.scanDialect)
}

func (e *sqlConnTransactionExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return e.QueryMultiContext(context.Background(), query)
}

func (e *sqlConnTransactionExecer) finish(sqlText string, commit bool) error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	if e.conn == nil || e.done || e.state == sqlTransactionStateFinished || e.state == sqlTransactionStateFinishing {
		e.mu.Unlock()
		return nil
	}
	if e.state == sqlTransactionStateUnknown && (commit || e.rollbackAttempted) {
		e.mu.Unlock()
		return nil
	}
	conn := e.conn
	e.state = sqlTransactionStateFinishing
	if !commit {
		e.rollbackAttempted = true
	}
	e.mu.Unlock()
	if strings.TrimSpace(sqlText) == "" {
		e.mu.Lock()
		e.state = sqlTransactionStateFinished
		e.done = true
		e.mu.Unlock()
		return nil
	}
	_, err := conn.ExecContext(context.Background(), sqlText)
	e.mu.Lock()
	if err == nil {
		e.state = sqlTransactionStateFinished
		e.done = true
	} else {
		e.state = sqlTransactionStateUnknown
		e.done = false
	}
	e.mu.Unlock()
	if err != nil {
		return MarkWriteOutcomeUnknown(err)
	}
	return err
}

func (e *sqlConnTransactionExecer) Commit() error {
	return e.finish(e.commitSQL, true)
}

func (e *sqlConnTransactionExecer) Rollback() error {
	return e.finish(e.rollbackSQL, false)
}

func (e *sqlConnTransactionExecer) Close() error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	if e.conn == nil {
		e.mu.Unlock()
		return nil
	}
	shouldRollback := !e.done && strings.TrimSpace(e.rollbackSQL) != "" &&
		(e.state == sqlTransactionStateOpen || (e.state == sqlTransactionStateUnknown && !e.rollbackAttempted))
	shouldDiscard := !e.done && !shouldRollback
	e.mu.Unlock()

	if shouldRollback {
		if err := e.Rollback(); err != nil {
			if discardErr := e.Discard(); discardErr != nil {
				return errors.Join(err, discardErr)
			}
			return err
		}
	}
	if shouldDiscard {
		return e.Discard()
	}

	e.mu.Lock()
	if e.conn == nil {
		e.mu.Unlock()
		return nil
	}
	conn := e.conn
	e.conn = nil
	e.done = true
	e.state = sqlTransactionStateFinished
	e.mu.Unlock()

	return conn.Close()
}

func (e *sqlConnTransactionExecer) Discard() error {
	if e == nil {
		return nil
	}
	e.mu.Lock()
	conn := e.conn
	e.conn = nil
	e.done = true
	e.state = sqlTransactionStateFinished
	e.mu.Unlock()
	return discardSQLConn(&conn)
}
