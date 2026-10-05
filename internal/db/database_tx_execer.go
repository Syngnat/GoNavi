package db

import (
	"context"
	"database/sql"
	"errors"
	"sync"

	"GoNavi-Wails/internal/connection"
)

type sqlTxStatementExecer struct {
	mu                sync.Mutex
	tx                *sql.Tx
	conn              *sql.Conn
	done              bool
	state             sqlTransactionState
	rollbackAttempted bool
	lastFinishErr     error
}

func NewSQLTxStatementExecer(tx *sql.Tx) TransactionExecer {
	return &sqlTxStatementExecer{tx: tx}
}

// NewSQLTxStatementExecerWithConn keeps the pinned *sql.Conn alongside a
// database/sql transaction so a failed finalization can evict the physical
// connection instead of returning an unresolved transaction to the pool.
func NewSQLTxStatementExecerWithConn(tx *sql.Tx, conn *sql.Conn) TransactionExecer {
	return &sqlTxStatementExecer{tx: tx, conn: conn}
}

func (e *sqlTxStatementExecer) activeTx() (*sql.Tx, error) {
	if e == nil || e.tx == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_not_open", nil)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.done || e.state != sqlTransactionStateOpen {
		return nil, localizedDatabaseRuntimeError("db.backend.error.transaction_already_finished", nil)
	}
	return e.tx, nil
}

func (e *sqlTxStatementExecer) ExecContext(ctx context.Context, query string) (int64, error) {
	tx, err := e.activeTx()
	if err != nil {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (e *sqlTxStatementExecer) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *sqlTxStatementExecer) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	tx, err := e.activeTx()
	if err != nil {
		return nil, nil, err
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRowsContext(ctx, rows)
}

func (e *sqlTxStatementExecer) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(context.Background(), query)
}

func (e *sqlTxStatementExecer) StreamQueryContext(ctx context.Context, query string, consumer QueryStreamConsumer) error {
	tx, err := e.activeTx()
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()
	return streamRows(rows, consumer)
}

func (e *sqlTxStatementExecer) StreamQuery(query string, consumer QueryStreamConsumer) error {
	return e.StreamQueryContext(context.Background(), query, consumer)
}

func (e *sqlTxStatementExecer) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	tx, err := e.activeTx()
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMultiRowsContext(ctx, rows)
}

func (e *sqlTxStatementExecer) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return e.QueryMultiContext(context.Background(), query)
}

func (e *sqlTxStatementExecer) finish(action func(*sql.Tx) error, commit bool) error {
	if e == nil || e.tx == nil {
		return nil
	}
	e.mu.Lock()
	if e.done || e.state == sqlTransactionStateFinished || e.state == sqlTransactionStateFinishing {
		e.mu.Unlock()
		return nil
	}
	if e.state == sqlTransactionStateUnknown && (commit || e.rollbackAttempted) {
		e.mu.Unlock()
		return nil
	}
	tx := e.tx
	e.state = sqlTransactionStateFinishing
	if !commit {
		e.rollbackAttempted = true
	}
	e.mu.Unlock()
	err := action(tx)
	e.mu.Lock()
	if err == nil {
		e.done = true
		e.state = sqlTransactionStateFinished
		e.lastFinishErr = nil
	} else {
		e.done = false
		e.state = sqlTransactionStateUnknown
		e.lastFinishErr = MarkWriteOutcomeUnknown(err)
	}
	e.mu.Unlock()
	if err != nil {
		return MarkWriteOutcomeUnknown(err)
	}
	return nil
}

func (e *sqlTxStatementExecer) Commit() error {
	return e.finish(func(tx *sql.Tx) error {
		return tx.Commit()
	}, true)
}

func (e *sqlTxStatementExecer) Rollback() error {
	return e.finish(func(tx *sql.Tx) error {
		return tx.Rollback()
	}, false)
}

func (e *sqlTxStatementExecer) Close() error {
	if e == nil || e.tx == nil {
		return nil
	}
	e.mu.Lock()
	if e.state == sqlTransactionStateUnknown && e.rollbackAttempted && e.lastFinishErr != nil {
		err := e.lastFinishErr
		e.mu.Unlock()
		if discardErr := e.Discard(); discardErr != nil {
			return errors.Join(err, discardErr)
		}
		return err
	}
	e.mu.Unlock()
	if err := e.Rollback(); err != nil {
		if discardErr := e.Discard(); discardErr != nil {
			return errors.Join(err, discardErr)
		}
		return err
	}
	e.mu.Lock()
	conn := e.conn
	e.conn = nil
	e.mu.Unlock()
	if conn != nil {
		return conn.Close()
	}
	return nil
}

func (e *sqlTxStatementExecer) Discard() error {
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
