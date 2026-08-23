package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"sync"
	"testing"
)

const transactionExecerDriverName = "gonavi_transaction_execer"

var (
	transactionExecerRegisterOnce sync.Once
	transactionExecerDriverMu     sync.Mutex
	transactionExecerDriverSeq    int
	transactionExecerStates       = map[string]*transactionExecerState{}
)

type transactionExecerState struct {
	mu          sync.Mutex
	commitErr   error
	rollbackErr error
	commits     int
	rollbacks   int
	opens       int
	closes      int
}

type transactionExecerDriver struct{}

func (transactionExecerDriver) Open(name string) (driver.Conn, error) {
	transactionExecerDriverMu.Lock()
	state := transactionExecerStates[name]
	transactionExecerDriverMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("transaction execer state not found: %s", name)
	}
	state.mu.Lock()
	state.opens++
	state.mu.Unlock()
	return &transactionExecerConn{state: state}, nil
}

type transactionExecerConn struct {
	state  *transactionExecerState
	closed bool
}

func (*transactionExecerConn) Prepare(string) (driver.Stmt, error) { return nil, driver.ErrSkip }

func (conn *transactionExecerConn) Close() error {
	if conn.closed {
		return nil
	}
	conn.closed = true
	conn.state.mu.Lock()
	conn.state.closes++
	conn.state.mu.Unlock()
	return nil
}

func (conn *transactionExecerConn) Begin() (driver.Tx, error) {
	return &transactionExecerTx{state: conn.state}, nil
}

func (conn *transactionExecerConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &transactionExecerTx{state: conn.state}, nil
}

func (conn *transactionExecerConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	conn.state.mu.Lock()
	defer conn.state.mu.Unlock()
	switch query {
	case "COMMIT":
		conn.state.commits++
		return nil, conn.state.commitErr
	case "ROLLBACK":
		conn.state.rollbacks++
		return nil, conn.state.rollbackErr
	default:
		return driver.RowsAffected(1), nil
	}
}

func (conn *transactionExecerConn) Raw(func(any) error) error { return nil }

type transactionExecerTx struct {
	state *transactionExecerState
}

func (tx *transactionExecerTx) Commit() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	tx.state.commits++
	return tx.state.commitErr
}

func (tx *transactionExecerTx) Rollback() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	tx.state.rollbacks++
	return tx.state.rollbackErr
}

var _ driver.ConnBeginTx = (*transactionExecerConn)(nil)
var _ driver.ExecerContext = (*transactionExecerConn)(nil)

func openTransactionExecerDB(t *testing.T, state *transactionExecerState) *sql.DB {
	t.Helper()
	transactionExecerRegisterOnce.Do(func() {
		sql.Register(transactionExecerDriverName, transactionExecerDriver{})
	})
	transactionExecerDriverMu.Lock()
	transactionExecerDriverSeq++
	dsn := fmt.Sprintf("transaction-execer-%d", transactionExecerDriverSeq)
	transactionExecerStates[dsn] = state
	transactionExecerDriverMu.Unlock()

	database, err := sql.Open(transactionExecerDriverName, dsn)
	if err != nil {
		t.Fatalf("open transaction execer database: %v", err)
	}
	t.Cleanup(func() {
		_ = database.Close()
		transactionExecerDriverMu.Lock()
		delete(transactionExecerStates, dsn)
		transactionExecerDriverMu.Unlock()
	})
	return database
}

func assertTransactionExecerDiscardedConnection(t *testing.T, database *sql.DB, state *transactionExecerState) {
	t.Helper()
	conn, err := database.Conn(context.Background())
	if err != nil {
		t.Fatalf("open replacement connection after discard: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("close replacement connection: %v", err)
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.opens != 2 {
		t.Fatalf("discarded transaction connection must not return to the pool, opens=%d", state.opens)
	}
}

func TestSQLConnTransactionExecerCommitFailureAllowsRollbackAndMarksUnknown(t *testing.T) {
	commitErr := errors.New("commit response lost")
	state := &transactionExecerState{commitErr: commitErr}
	database := openTransactionExecerDB(t, state)
	conn, err := database.Conn(context.Background())
	if err != nil {
		t.Fatalf("open pinned connection: %v", err)
	}
	execer := NewSQLConnTransactionExecer(conn, "COMMIT", "ROLLBACK")

	if err := execer.Commit(); !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("commit failure must be marked unknown and preserve its cause, got %v", err)
	}
	if err := execer.Rollback(); err != nil {
		t.Fatalf("rollback after commit failure should still run: %v", err)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if state.rollbacks != 1 {
		t.Fatalf("expected one compensating rollback, got %d", state.rollbacks)
	}
}

func TestSQLConnTransactionExecerCloseAfterCommitFailureCompensates(t *testing.T) {
	state := &transactionExecerState{commitErr: errors.New("commit rejected")}
	database := openTransactionExecerDB(t, state)
	conn, err := database.Conn(context.Background())
	if err != nil {
		t.Fatalf("open pinned connection: %v", err)
	}
	execer := NewSQLConnTransactionExecer(conn, "COMMIT", "ROLLBACK")
	if err := execer.Commit(); err == nil {
		t.Fatal("expected commit failure")
	}
	if err := execer.Close(); err != nil {
		t.Fatalf("close should succeed after compensating rollback: %v", err)
	}

	state.mu.Lock()
	defer state.mu.Unlock()
	if state.rollbacks != 1 {
		t.Fatalf("close-after-failure must execute rollback once, got %d", state.rollbacks)
	}
}

func TestSQLConnTransactionExecerDiscardAfterCompensationFailure(t *testing.T) {
	state := &transactionExecerState{
		commitErr:   errors.New("commit response lost"),
		rollbackErr: errors.New("rollback response lost"),
	}
	database := openTransactionExecerDB(t, state)
	database.SetMaxOpenConns(1)
	conn, err := database.Conn(context.Background())
	if err != nil {
		t.Fatalf("open pinned connection: %v", err)
	}
	execer := NewSQLConnTransactionExecer(conn, "COMMIT", "ROLLBACK")
	if err := execer.Commit(); !IsWriteOutcomeUnknown(err) {
		t.Fatalf("expected unknown commit failure, got %v", err)
	}
	if err := execer.Close(); !IsWriteOutcomeUnknown(err) {
		t.Fatalf("failed compensation must remain unknown, got %v", err)
	}
	assertTransactionExecerDiscardedConnection(t, database, state)
}

func TestSQLTxStatementExecerCommitFailureMarksUnknown(t *testing.T) {
	commitErr := errors.New("commit response lost")
	state := &transactionExecerState{commitErr: commitErr}
	database := openTransactionExecerDB(t, state)
	tx, err := database.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	execer := NewSQLTxStatementExecer(tx)
	if err := execer.Commit(); !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("sql.Tx commit failure must be marked unknown and preserve its cause, got %v", err)
	}
}

func TestSQLTxStatementExecerWithConnDiscardsAfterCommitFailure(t *testing.T) {
	state := &transactionExecerState{
		commitErr:   errors.New("commit response lost"),
		rollbackErr: errors.New("rollback response lost"),
	}
	database := openTransactionExecerDB(t, state)
	database.SetMaxOpenConns(1)
	conn, err := database.Conn(context.Background())
	if err != nil {
		t.Fatalf("open pinned connection: %v", err)
	}
	tx, err := conn.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatalf("begin transaction: %v", err)
	}
	execer := NewSQLTxStatementExecerWithConn(tx, conn)
	if err := execer.Commit(); !IsWriteOutcomeUnknown(err) {
		t.Fatalf("expected unknown commit failure, got %v", err)
	}
	if err := execer.Close(); !IsWriteOutcomeUnknown(err) {
		t.Fatalf("failed compensation must remain unknown, got %v", err)
	}
	assertTransactionExecerDiscardedConnection(t, database, state)
}
