package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

type readOnlyTestQuerier interface {
	QueryReadOnlyContext(context.Context, string) ([]map[string]interface{}, []string, error)
}

type readOnlyDriverState struct {
	mu                                                 sync.Mutex
	options                                            driver.TxOptions
	begins, queries, rollbacks, commits, closes        int
	active                                             bool
	rollbackDone                                       chan struct{}
	beginErr, queryErr, scanErr, rollbackErr, closeErr error
	cancelQuery                                        bool
	cancelScan                                         context.CancelFunc
}
type readOnlyConnector struct{ state *readOnlyDriverState }

func (c readOnlyConnector) Connect(context.Context) (driver.Conn, error) {
	return &readOnlyConn{state: c.state}, nil
}
func (c readOnlyConnector) Driver() driver.Driver { return readOnlyDriver{} }

type readOnlyDriver struct{}

func (readOnlyDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use connector") }

type readOnlyConn struct {
	state  *readOnlyDriverState
	active bool
}

func (*readOnlyConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (*readOnlyConn) Close() error              { return nil }
func (*readOnlyConn) Begin() (driver.Tx, error) { return nil, errors.New("unexpected legacy begin") }
func (c *readOnlyConn) BeginTx(_ context.Context, options driver.TxOptions) (driver.Tx, error) {
	s := c.state
	s.mu.Lock()
	defer s.mu.Unlock()
	s.begins++
	s.options = options
	if s.beginErr != nil {
		return nil, s.beginErr
	}
	s.active = true
	c.active = true
	return &readOnlyTx{state: s, conn: c}, nil
}
func (c *readOnlyConn) QueryContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	s := c.state
	s.mu.Lock()
	defer s.mu.Unlock()
	s.queries++
	if !c.active {
		return nil, errors.New("query outside transaction")
	}
	if s.cancelQuery {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if s.queryErr != nil {
		return nil, s.queryErr
	}
	return &readOnlyRows{state: s}, nil
}

type readOnlyTx struct {
	state *readOnlyDriverState
	conn  *readOnlyConn
}

func (tx *readOnlyTx) Commit() error {
	tx.state.mu.Lock()
	defer tx.state.mu.Unlock()
	tx.state.commits++
	return errors.New("unexpected commit")
}
func (tx *readOnlyTx) Rollback() error {
	s := tx.state
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rollbacks++
	s.active = false
	tx.conn.active = false
	if s.rollbackDone != nil {
		close(s.rollbackDone)
	}
	return s.rollbackErr
}

type readOnlyRows struct {
	state *readOnlyDriverState
	index int
}

func (*readOnlyRows) Columns() []string { return []string{"value"} }
func (r *readOnlyRows) Close() error    { r.state.closes++; return r.state.closeErr }
func (r *readOnlyRows) Next(values []driver.Value) error {
	if r.state.scanErr != nil {
		return r.state.scanErr
	}
	if r.index == 5 {
		return io.EOF
	}
	if r.state.cancelScan != nil {
		r.state.cancelScan()
		return context.Canceled
	}
	r.index++
	values[0] = int64(r.index)
	return nil
}
func openReadOnlyTestDB(t *testing.T, s *readOnlyDriverState) *sql.DB {
	t.Helper()
	conn := sql.OpenDB(readOnlyConnector{state: s})
	t.Cleanup(func() {
		if err := conn.Close(); err != nil {
			t.Error(err)
		}
	})
	return conn
}
func TestPostgresReadOnlyQueryTransaction(t *testing.T) {
	state := &readOnlyDriverState{}
	database := &PostgresDB{conn: openReadOnlyTestDB(t, state)}
	querier, ok := interface{}(database).(readOnlyTestQuerier)
	if !ok {
		t.Fatal("PostgresDB must implement QueryReadOnlyContext")
	}
	rows, fields, err := querier.QueryReadOnlyContext(context.Background(), "SELECT value")
	if err != nil || len(rows) != 5 || len(fields) != 1 {
		t.Fatalf("query rows=%v fields=%v err=%v", rows, fields, err)
	}
	if !state.options.ReadOnly || state.begins != 1 || state.queries != 1 || state.rollbacks != 1 || state.commits != 0 || state.closes != 1 {
		t.Fatalf("transaction state = %+v", state)
	}
}

func TestMySQLReadOnlyQueryTransaction(t *testing.T) {
	state := &readOnlyDriverState{}
	database := &MySQLDB{conn: openReadOnlyTestDB(t, state)}
	querier, ok := interface{}(database).(readOnlyTestQuerier)
	if !ok {
		t.Fatal("MySQLDB must implement QueryReadOnlyContext")
	}
	if _, _, err := querier.QueryReadOnlyContext(context.Background(), "SELECT value"); err != nil {
		t.Fatal(err)
	}
	if !state.options.ReadOnly || state.rollbacks != 1 || state.queries != 1 {
		t.Fatalf("state=%+v", state)
	}
}
func TestPostgresReadOnlyQueryErrors(t *testing.T) {
	primary := errors.New("primary failure")
	cleanup := errors.New("rollback failure")
	for _, tc := range []struct {
		name     string
		state    *readOnlyDriverState
		want     error
		rollback bool
	}{
		{name: "begin unsupported", state: &readOnlyDriverState{beginErr: primary}, want: primary},
		{name: "query", state: &readOnlyDriverState{queryErr: primary}, want: primary, rollback: true},
		{name: "scan", state: &readOnlyDriverState{scanErr: primary}, want: primary, rollback: true},
		{name: "rows close", state: &readOnlyDriverState{closeErr: primary}, want: primary, rollback: true},
		{name: "rollback", state: &readOnlyDriverState{rollbackErr: cleanup}, want: cleanup, rollback: true},
		{name: "query and rollback", state: &readOnlyDriverState{queryErr: primary, rollbackErr: cleanup}, want: primary, rollback: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := tc.state
			database := &PostgresDB{conn: openReadOnlyTestDB(t, state)}
			rows, fields, err := database.QueryReadOnlyContext(context.Background(), "SELECT value")
			if !errors.Is(err, tc.want) || rows != nil || fields != nil {
				t.Fatalf("rows=%v fields=%v err=%v", rows, fields, err)
			}
			if tc.state.rollbackErr != nil && !errors.Is(err, cleanup) {
				t.Fatalf("lost rollback error: %v", err)
			}
			if tc.rollback && state.rollbacks != 1 {
				t.Fatalf("rollback count=%d", state.rollbacks)
			}
			if state.commits != 0 {
				t.Fatal("read-only query committed")
			}
		})
	}
}
func TestPostgresReadOnlyQueryBudget(t *testing.T) {
	state := &readOnlyDriverState{}
	database := &PostgresDB{conn: openReadOnlyTestDB(t, state)}
	budget := NewRowBudget(2)
	rows, _, err := database.QueryReadOnlyContext(ContextWithRowBudget(context.Background(), budget), "SELECT value")
	if err != nil || len(rows) != 2 || !budget.Truncated() || state.closes != 1 || state.rollbacks != 1 {
		t.Fatalf("rows=%v err=%v budget=%v state=%+v", rows, err, budget.Truncated(), state)
	}
}
func TestPostgresReadOnlyQueryCancellation(t *testing.T) {
	for _, name := range []string{"before begin", "during query", "during scan"} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
			defer cancel()
			state := &readOnlyDriverState{rollbackDone: make(chan struct{})}
			if name == "before begin" {
				cancel()
			}
			if name == "during query" {
				state.cancelQuery = true
			}
			if name == "during scan" {
				state.cancelScan = cancel
			}
			database := &PostgresDB{conn: openReadOnlyTestDB(t, state)}
			rows, fields, err := database.QueryReadOnlyContext(ctx, "SELECT value")
			if !errors.Is(err, ctx.Err()) || rows != nil || fields != nil {
				t.Fatalf("rows=%v fields=%v err=%v context=%v", rows, fields, err, ctx.Err())
			}
			if name == "before begin" && state.begins != 0 {
				t.Fatal("canceled request began transaction")
			}
			if name != "before begin" {
				select {
				case <-state.rollbackDone:
				case <-time.After(time.Second):
					t.Fatal("canceled transaction was not rolled back")
				}
				state.mu.Lock()
				rollbacks := state.rollbacks
				state.mu.Unlock()
				if rollbacks != 1 {
					t.Fatalf("rollbacks=%d", rollbacks)
				}
			}
		})
	}
}
func TestPostgresReadOnlyQueryRequiresConnection(t *testing.T) {
	if _, _, err := (&PostgresDB{}).QueryReadOnlyContext(context.Background(), "SELECT 1"); err == nil {
		t.Fatal("missing connection accepted")
	}
}
