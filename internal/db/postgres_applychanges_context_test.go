package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

const postgresApplyChangesContextDriverName = "postgres_apply_changes_context"

var (
	registerPostgresApplyChangesContextDriverOnce sync.Once
	postgresApplyChangesContextExecStarted        = make(chan struct{}, 1)
)

type postgresApplyChangesContextDriver struct{}

type postgresApplyChangesContextConn struct{}

type postgresApplyChangesContextTx struct{}

func (postgresApplyChangesContextDriver) Open(string) (driver.Conn, error) {
	return postgresApplyChangesContextConn{}, nil
}

func (postgresApplyChangesContextConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (postgresApplyChangesContextConn) Close() error { return nil }

func (postgresApplyChangesContextConn) Begin() (driver.Tx, error) {
	return nil, errors.New("legacy Begin must not be used")
}

func (postgresApplyChangesContextConn) BeginTx(context.Context, driver.TxOptions) (driver.Tx, error) {
	return postgresApplyChangesContextTx{}, nil
}

func (postgresApplyChangesContextConn) ExecContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	select {
	case postgresApplyChangesContextExecStarted <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, ctx.Err()
}

func (postgresApplyChangesContextTx) Commit() error   { return nil }
func (postgresApplyChangesContextTx) Rollback() error { return nil }

func TestPostgresApplyChangesContextCancelsInFlightStatement(t *testing.T) {
	registerPostgresApplyChangesContextDriverOnce.Do(func() {
		sql.Register(postgresApplyChangesContextDriverName, postgresApplyChangesContextDriver{})
	})

	conn, err := sql.Open(postgresApplyChangesContextDriverName, "")
	if err != nil {
		t.Fatalf("open context-aware test database: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- (&PostgresDB{conn: conn}).ApplyChangesContext(ctx, "public.orders", connection.ChangeSet{
			Deletes: []map[string]interface{}{{"id": 42}},
		})
	}()

	select {
	case <-postgresApplyChangesContextExecStarted:
		cancel()
	case <-time.After(time.Second):
		cancel()
		t.Fatal("ApplyChangesContext did not reach the context-aware SQL execution path")
	}

	select {
	case err := <-errCh:
		if err == nil || !strings.Contains(err.Error(), context.Canceled.Error()) {
			t.Fatalf("ApplyChangesContext error = %v, want context cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("ApplyChangesContext did not return after cancellation")
	}
}
