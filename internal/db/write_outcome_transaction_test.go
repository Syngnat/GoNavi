package db

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

const writeOutcomeTransactionDriverName = "gonavi_write_outcome_transaction"

var (
	registerWriteOutcomeTransactionDriverOnce sync.Once
	writeOutcomeTransactionDriverMu           sync.Mutex
	writeOutcomeTransactionDriverSeq          int
	writeOutcomeTransactionDriverStates       = map[string]*writeOutcomeTransactionState{}
)

type writeOutcomeTransactionState struct {
	mu          sync.Mutex
	execErr     error
	commitErr   error
	rollbackErr error
	commits     int
	rollbacks   int
	closes      int
}

type writeOutcomeTransactionDriver struct{}

func (writeOutcomeTransactionDriver) Open(name string) (driver.Conn, error) {
	writeOutcomeTransactionDriverMu.Lock()
	state := writeOutcomeTransactionDriverStates[name]
	writeOutcomeTransactionDriverMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("write outcome transaction state not found: %s", name)
	}
	return &writeOutcomeTransactionConn{state: state}, nil
}

type writeOutcomeTransactionConn struct {
	state *writeOutcomeTransactionState
}

func (*writeOutcomeTransactionConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (conn *writeOutcomeTransactionConn) Close() error {
	conn.state.mu.Lock()
	defer conn.state.mu.Unlock()
	conn.state.closes++
	return nil
}

func (conn *writeOutcomeTransactionConn) Begin() (driver.Tx, error) {
	return &writeOutcomeTransactionTx{state: conn.state}, nil
}

func (conn *writeOutcomeTransactionConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return &writeOutcomeTransactionTx{state: conn.state}, nil
}

func (conn *writeOutcomeTransactionConn) ExecContext(context.Context, string, []driver.NamedValue) (driver.Result, error) {
	conn.state.mu.Lock()
	defer conn.state.mu.Unlock()
	if conn.state.execErr != nil {
		return nil, conn.state.execErr
	}
	return driver.RowsAffected(1), nil
}

type writeOutcomeTransactionTx struct {
	state *writeOutcomeTransactionState
}

func (tx *writeOutcomeTransactionTx) Commit() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	tx.state.commits++
	return tx.state.commitErr
}

func (tx *writeOutcomeTransactionTx) Rollback() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	tx.state.rollbacks++
	return tx.state.rollbackErr
}

func openWriteOutcomeTransactionDB(t *testing.T, state *writeOutcomeTransactionState) *sql.DB {
	t.Helper()
	registerWriteOutcomeTransactionDriverOnce.Do(func() {
		sql.Register(writeOutcomeTransactionDriverName, writeOutcomeTransactionDriver{})
	})
	writeOutcomeTransactionDriverMu.Lock()
	writeOutcomeTransactionDriverSeq++
	dsn := fmt.Sprintf("write-outcome-%d", writeOutcomeTransactionDriverSeq)
	writeOutcomeTransactionDriverStates[dsn] = state
	writeOutcomeTransactionDriverMu.Unlock()

	database, err := sql.Open(writeOutcomeTransactionDriverName, dsn)
	if err != nil {
		t.Fatalf("open write outcome transaction database: %v", err)
	}
	t.Cleanup(func() {
		_ = database.Close()
		writeOutcomeTransactionDriverMu.Lock()
		delete(writeOutcomeTransactionDriverStates, dsn)
		writeOutcomeTransactionDriverMu.Unlock()
	})
	return database
}

func TestPostgresApplyChangesMarksCommitFailureOutcomeUnknown(t *testing.T) {
	commitErr := errors.New("commit response lost")
	state := &writeOutcomeTransactionState{commitErr: commitErr}
	database := openWriteOutcomeTransactionDB(t, state)

	err := (&PostgresDB{conn: database}).ApplyChangesContext(context.Background(), "public.users", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
		t.Fatalf("commit error must preserve its cause and mark the outcome unknown, got %v", err)
	}
}

func TestLegacyTransactionApplyChangesMarksCommitFailureOutcomeUnknown(t *testing.T) {
	for name, apply := range map[string]func(*sql.DB) error{
		"custom": func(database *sql.DB) error {
			return (&CustomDB{conn: database, driver: "mysql"}).ApplyChanges("users", connection.ChangeSet{
				Deletes: []map[string]interface{}{{"id": int64(1)}},
			})
		},
	} {
		t.Run(name, func(t *testing.T) {
			commitErr := errors.New("commit response lost")
			state := &writeOutcomeTransactionState{commitErr: commitErr}
			database := openWriteOutcomeTransactionDB(t, state)
			err := apply(database)
			if !IsWriteOutcomeUnknown(err) || !errors.Is(err, commitErr) {
				t.Fatalf("commit error must be outcome unknown, got %v", err)
			}
			state.mu.Lock()
			closes := state.closes
			state.mu.Unlock()
			if closes != 1 {
				t.Fatalf("ambiguous commit must discard its physical connection, closes=%d", closes)
			}
		})
	}
}

func TestPostgresApplyChangesMarksRollbackFailureOutcomeUnknown(t *testing.T) {
	execErr := errors.New("known statement rejection")
	rollbackErr := errors.New("rollback response lost")
	state := &writeOutcomeTransactionState{execErr: execErr, rollbackErr: rollbackErr}
	database := openWriteOutcomeTransactionDB(t, state)

	err := (&PostgresDB{conn: database}).ApplyChangesContext(context.Background(), "public.users", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, rollbackErr) {
		t.Fatalf("rollback failure must preserve its cause and mark the outcome unknown, got %v", err)
	}
}

func TestMySQLApplyChangesMarksAmbiguousDMLResponseOutcomeUnknown(t *testing.T) {
	for name, testCase := range map[string]struct {
		writeErr error
		changes  connection.ChangeSet
	}{
		"delete transport":    {writeErr: io.ErrUnexpectedEOF, changes: connection.ChangeSet{Deletes: []map[string]interface{}{{"id": int64(1)}}}},
		"insert transport":    {writeErr: io.ErrUnexpectedEOF, changes: connection.ChangeSet{Inserts: []map[string]interface{}{{"id": int64(1)}}}},
		"delete cancellation": {writeErr: context.Canceled, changes: connection.ChangeSet{Deletes: []map[string]interface{}{{"id": int64(1)}}}},
	} {
		t.Run(name, func(t *testing.T) {
			state := &writeOutcomeTransactionState{execErr: testCase.writeErr}
			database := openWriteOutcomeTransactionDB(t, state)

			err := (&MySQLDB{conn: database}).ApplyChangesContext(context.Background(), "users", testCase.changes)
			if !IsWriteOutcomeUnknown(err) || !errors.Is(err, testCase.writeErr) {
				t.Fatalf("ambiguous DML response must mark the outcome unknown for non-transactional tables, got %v", err)
			}
		})
	}
}

func TestMySQLApplyChangesKeepsSemanticDMLRejectionKnown(t *testing.T) {
	state := &writeOutcomeTransactionState{execErr: errors.New("constraint rejected")}
	database := openWriteOutcomeTransactionDB(t, state)

	err := (&MySQLDB{conn: database}).ApplyChangesContext(context.Background(), "users", connection.ChangeSet{
		Deletes: []map[string]interface{}{{"id": int64(1)}},
	})
	if err == nil || IsWriteOutcomeUnknown(err) {
		t.Fatalf("semantic DML rejection must remain a known error, got %v", err)
	}
}

func TestOptionalDriverAgentApplyChangesMarksLostRPCResponseOutcomeUnknown(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(bytes.NewReader(nil)),
		driver: "dameng",
	}
	database := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	err := database.ApplyChangesContext(context.Background(), "public.users", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": int64(1)}},
	})
	if !IsWriteOutcomeUnknown(err) || !errors.Is(err, io.EOF) {
		t.Fatalf("lost RPC response after dispatch must mark the outcome unknown, got %v", err)
	}
}

func TestOptionalDriverAgentApplyChangesKeepsRemoteRejectionKnown(t *testing.T) {
	var stdin optionalAgentTestWriteCloser
	client := &optionalDriverAgentClient{
		stdin:  &stdin,
		reader: bufio.NewReader(strings.NewReader(`{"id":1,"success":false,"error":"constraint rejected"}` + "\n")),
		driver: "dameng",
	}
	database := &OptionalDriverAgentDB{driverType: "dameng", client: client}

	err := database.ApplyChangesContext(context.Background(), "public.users", connection.ChangeSet{
		Inserts: []map[string]interface{}{{"id": int64(1)}},
	})
	if err == nil || IsWriteOutcomeUnknown(err) {
		t.Fatalf("explicit remote rejection must remain a known row error, got %v", err)
	}
}

var _ driver.ConnBeginTx = (*writeOutcomeTransactionConn)(nil)
var _ driver.ExecerContext = (*writeOutcomeTransactionConn)(nil)
