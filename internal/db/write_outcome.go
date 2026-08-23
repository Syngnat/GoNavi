package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net"
)

// WriteOutcomeUnknownError marks a write whose server-side outcome cannot be
// determined from the response. Callers must not retry or continue past it as
// though the row were known to have been rejected.
type WriteOutcomeUnknownError struct {
	cause error
}

func (err *WriteOutcomeUnknownError) Error() string {
	if err == nil || err.cause == nil {
		return "write outcome is unknown"
	}
	return err.cause.Error()
}

func (err *WriteOutcomeUnknownError) Unwrap() error {
	if err == nil {
		return nil
	}
	return err.cause
}

// MarkWriteOutcomeUnknown preserves the original error while attaching the
// no-retry contract used by import and synchronization callers.
func MarkWriteOutcomeUnknown(err error) error {
	if err == nil || IsWriteOutcomeUnknown(err) {
		return err
	}
	return &WriteOutcomeUnknownError{cause: err}
}

func IsWriteOutcomeUnknown(err error) bool {
	var unknown *WriteOutcomeUnknownError
	return errors.As(err, &unknown)
}

// IsAmbiguousWriteResponse reports transport and cancellation failures that
// can occur after an autocommit statement was dispatched but before its server
// response was observed. A database semantic error is deliberately not
// classified as ambiguous because it proves the statement was rejected.
func IsAmbiguousWriteResponse(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded) ||
		errors.Is(err, driver.ErrBadConn) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrClosedPipe) ||
		errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var networkErr net.Error
	return errors.As(err, &networkErr)
}

func markWriteOutcomeUnknownIfAmbiguous(ctx context.Context, err error) error {
	if err == nil || IsWriteOutcomeUnknown(err) {
		return err
	}
	if IsAmbiguousWriteResponse(err) || (ctx != nil && ctx.Err() != nil) {
		return MarkWriteOutcomeUnknown(err)
	}
	return err
}

// rollbackUnfinishedWriteTransaction keeps a failed rollback from being
// flattened into the preceding statement error. A rollback failure means the
// transaction's final server-side state cannot safely be inferred.
func rollbackUnfinishedWriteTransaction(tx *sql.Tx, committed bool, resultErr *error) {
	if tx == nil || committed {
		return
	}
	rollbackErr := tx.Rollback()
	if rollbackErr == nil || errors.Is(rollbackErr, sql.ErrTxDone) {
		return
	}
	rollbackErr = fmt.Errorf("事务回滚失败：%w", rollbackErr)
	if resultErr != nil && *resultErr != nil {
		rollbackErr = errors.Join(*resultErr, rollbackErr)
	}
	if resultErr != nil {
		*resultErr = MarkWriteOutcomeUnknown(rollbackErr)
	}
}

func commitWriteTransaction(tx *sql.Tx) error {
	if err := tx.Commit(); err != nil {
		return MarkWriteOutcomeUnknown(fmt.Errorf("事务提交失败：%w", err))
	}
	return nil
}

// beginPinnedWriteTransaction keeps the physical connection available until a
// commit outcome is known, so an ambiguous commit can evict that connection.
func beginPinnedWriteTransaction(database *sql.DB) (*sql.Conn, *sql.Tx, error) {
	conn, err := database.Conn(context.Background())
	if err != nil {
		return nil, nil, err
	}
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	return conn, tx, nil
}

func commitPinnedWriteTransaction(connRef **sql.Conn, tx *sql.Tx) error {
	err := commitWriteTransaction(tx)
	if !IsWriteOutcomeUnknown(err) {
		return err
	}
	if discardErr := discardSQLConn(connRef); discardErr != nil {
		return errors.Join(err, fmt.Errorf("事务连接丢弃失败：%w", discardErr))
	}
	return err
}
