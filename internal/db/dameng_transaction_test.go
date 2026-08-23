//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

type damengTransactionRecordingState struct {
	mu            sync.Mutex
	beginCalls    int
	commitCalls   int
	rollbackCalls int
	execQueries   []string
	execStarted   chan struct{}
	execRelease   chan struct{}
	blockExec     bool
}

type damengTransactionConnector struct {
	state *damengTransactionRecordingState
}

func (c *damengTransactionConnector) Connect(context.Context) (driver.Conn, error) {
	return &damengTransactionConn{state: c.state}, nil
}

func (c *damengTransactionConnector) Driver() driver.Driver {
	return damengTransactionDriver{}
}

type damengTransactionDriver struct{}

func (damengTransactionDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use connector")
}

type damengTransactionConn struct {
	state *damengTransactionRecordingState
}

func (c *damengTransactionConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not supported")
}

func (c *damengTransactionConn) Close() error { return nil }

func (c *damengTransactionConn) Begin() (driver.Tx, error) {
	c.state.mu.Lock()
	c.state.beginCalls++
	c.state.mu.Unlock()
	return &damengTransactionTx{state: c.state}, nil
}

func (c *damengTransactionConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return c.Begin()
}

func (c *damengTransactionConn) ExecContext(ctx context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.state.mu.Lock()
	c.state.execQueries = append(c.state.execQueries, query)
	blockExec := c.state.blockExec
	execStarted := c.state.execStarted
	execRelease := c.state.execRelease
	c.state.mu.Unlock()
	if blockExec {
		select {
		case execStarted <- struct{}{}:
		default:
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-execRelease:
			return nil, errors.New("execution released without cancellation")
		}
	}
	return driver.RowsAffected(1), nil
}

type damengTransactionTx struct {
	state *damengTransactionRecordingState
}

func (tx *damengTransactionTx) Commit() error {
	tx.state.mu.Lock()
	tx.state.commitCalls++
	tx.state.mu.Unlock()
	return nil
}

func (tx *damengTransactionTx) Rollback() error {
	tx.state.mu.Lock()
	tx.state.rollbackCalls++
	tx.state.mu.Unlock()
	return nil
}

func (s *damengTransactionRecordingState) snapshot() (int, int, int, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.beginCalls, s.commitCalls, s.rollbackCalls, append([]string(nil), s.execQueries...)
}

func TestDamengOpenTransactionExecerUsesDriverTransaction(t *testing.T) {
	for _, tc := range []struct {
		name          string
		finish        func(TransactionExecer) error
		wantCommits   int
		wantRollbacks int
	}{
		{name: "commit", finish: func(tx TransactionExecer) error { return tx.Commit() }, wantCommits: 1},
		{name: "rollback", finish: func(tx TransactionExecer) error { return tx.Rollback() }, wantRollbacks: 1},
		{name: "close", finish: func(tx TransactionExecer) error { return tx.Close() }, wantRollbacks: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := &damengTransactionRecordingState{}
			dbConn := sql.OpenDB(&damengTransactionConnector{state: state})
			t.Cleanup(func() { _ = dbConn.Close() })

			damengDB := &DamengDB{conn: dbConn}
			openCtx, cancel := context.WithCancel(context.Background())
			tx, err := damengDB.OpenTransactionExecer(openCtx)
			if err != nil {
				cancel()
				t.Fatalf("OpenTransactionExecer returned error: %v", err)
			}
			cancel()

			stmt := "UPDATE users SET name = 'new' WHERE id = 1"
			if _, err := tx.ExecContext(context.Background(), stmt); err != nil {
				t.Fatalf("DML after open context cancellation returned error: %v", err)
			}
			if err := tc.finish(tx); err != nil {
				t.Fatalf("finish transaction returned error: %v", err)
			}
			if err := tx.Close(); err != nil {
				t.Fatalf("Close returned error: %v", err)
			}

			beginCalls, commitCalls, rollbackCalls, execQueries := state.snapshot()
			if beginCalls != 1 || commitCalls != tc.wantCommits || rollbackCalls != tc.wantRollbacks {
				t.Fatalf(
					"unexpected transaction calls: begin=%d commit=%d rollback=%d",
					beginCalls,
					commitCalls,
					rollbackCalls,
				)
			}
			if !reflect.DeepEqual(execQueries, []string{stmt}) {
				t.Fatalf("expected only DML to reach the driver, got %#v", execQueries)
			}
		})
	}
}

func TestDamengApplyChangesPreservesSchemaContainingDot(t *testing.T) {
	state := &damengTransactionRecordingState{}
	dbConn := sql.OpenDB(&damengTransactionConnector{state: state})
	t.Cleanup(func() { _ = dbConn.Close() })

	damengDB := &DamengDB{conn: dbConn}
	err := damengDB.ApplyChanges(
		`"PEM2.4_V1_1"."COM_APPROVE_INFO"`,
		connection.ChangeSet{Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"ID": 7},
			Values: map[string]interface{}{"STATUS": "0"},
		}}},
	)
	if err != nil {
		t.Fatalf("ApplyChanges returned error: %v", err)
	}

	beginCalls, commitCalls, rollbackCalls, execQueries := state.snapshot()
	if beginCalls != 1 || commitCalls != 1 || rollbackCalls != 0 {
		t.Fatalf(
			"unexpected transaction calls: begin=%d commit=%d rollback=%d",
			beginCalls,
			commitCalls,
			rollbackCalls,
		)
	}
	want := []string{`UPDATE "PEM2.4_V1_1"."COM_APPROVE_INFO" SET "STATUS" = :1 WHERE "ID" = :2`}
	if !reflect.DeepEqual(execQueries, want) {
		t.Fatalf("ApplyChanges queries = %#v, want %#v", execQueries, want)
	}
}

func TestDamengApplyChangesContextCancelsInFlightInsert(t *testing.T) {
	state := &damengTransactionRecordingState{
		execStarted: make(chan struct{}, 1),
		execRelease: make(chan struct{}),
		blockExec:   true,
	}
	dbConn := sql.OpenDB(&damengTransactionConnector{state: state})
	t.Cleanup(func() { _ = dbConn.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- (&DamengDB{conn: dbConn}).ApplyChangesContext(ctx, "APP.ORDERS", connection.ChangeSet{
			Inserts: []map[string]interface{}{{"ID": 42, "STATUS": "pending"}},
		})
	}()

	select {
	case <-state.execStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not reach the context-aware insert path")
	}

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("ApplyChangesContext error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		close(state.execRelease)
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
}

var _ BatchApplierContext = (*DamengDB)(nil)
