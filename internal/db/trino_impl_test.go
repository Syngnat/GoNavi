//go:build gonavi_full_drivers || gonavi_trino_driver

package db

import (
	"database/sql"
	"database/sql/driver"
	"errors"
	"net/url"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

var (
	trinoCloseTestDriverOnce sync.Once
	errTrinoCloseTest        = errors.New("trino close test error")
)

type fakeTrinoExecResult struct {
	affected int64
	err      error
}

func (r fakeTrinoExecResult) LastInsertId() (int64, error) { return 0, errors.New("not implemented") }
func (r fakeTrinoExecResult) RowsAffected() (int64, error) { return r.affected, r.err }

type trinoCloseTestDriver struct{}

func (trinoCloseTestDriver) Open(string) (driver.Conn, error) {
	return trinoCloseTestConn{}, nil
}

type trinoCloseTestConn struct{}

func (trinoCloseTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (trinoCloseTestConn) Close() error {
	return errTrinoCloseTest
}

func (trinoCloseTestConn) Begin() (driver.Tx, error) {
	return nil, driver.ErrSkip
}

func TestTrinoRowsAffectedMarksErrorsAsUnknownWriteOutcome(t *testing.T) {
	rowErr := errors.New("rows affected unavailable")
	affected, err := trinoRowsAffected(fakeTrinoExecResult{err: rowErr})
	if affected != 0 {
		t.Fatalf("trinoRowsAffected() = %d, want 0 with error", affected)
	}
	if !errors.Is(err, rowErr) {
		t.Fatalf("trinoRowsAffected() error = %v, want cause %v", err, rowErr)
	}
	if !IsWriteOutcomeUnknown(err) {
		t.Fatalf("trinoRowsAffected() error = %v, want unknown write outcome", err)
	}
}

func TestTrinoRowsAffectedPreservesSuccessfulCount(t *testing.T) {
	affected, err := trinoRowsAffected(fakeTrinoExecResult{affected: 7})
	if err != nil {
		t.Fatalf("trinoRowsAffected() error = %v", err)
	}
	if affected != 7 {
		t.Fatalf("trinoRowsAffected() = %d, want 7", affected)
	}
}

func TestTrinoCloseCleansStateWhenDatabaseCloseFails(t *testing.T) {
	const driverName = "gonavi_trino_close_test"
	trinoCloseTestDriverOnce.Do(func() {
		sql.Register(driverName, trinoCloseTestDriver{})
	})

	conn, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := conn.Ping(); err != nil {
		t.Fatalf("ping test database: %v", err)
	}

	trino := &TrinoDB{
		conn:      conn,
		namespace: "catalog.schema",
	}
	if err := trino.Close(); !errors.Is(err, errTrinoCloseTest) {
		t.Fatalf("Close() error = %v, want %v", err, errTrinoCloseTest)
	}
	if trino.conn != nil {
		t.Fatal("Close() did not clear the database handle after an error")
	}
	if trino.namespace != "" {
		t.Fatalf("Close() namespace = %q, want empty", trino.namespace)
	}
}

func TestOpenTrinoSQLConnectionConfiguresPool(t *testing.T) {
	const driverName = "gonavi_trino_close_test"
	trinoCloseTestDriverOnce.Do(func() {
		sql.Register(driverName, trinoCloseTestDriver{})
	})

	conn, err := openTrinoSQLConnection(driverName, "")
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	if got := conn.Stats().MaxOpenConnections; got != defaultSQLMaxOpenConns {
		t.Fatalf("max open connections = %d, want %d", got, defaultSQLMaxOpenConns)
	}
}

func TestBuildTrinoDSNDoesNotDeriveQueryTimeoutFromConnectionTimeout(t *testing.T) {
	dsn, err := buildTrinoDSN(connection.ConnectionConfig{
		Type:     "trino",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "alice",
		Database: "hive.analytics",
		Timeout:  1,
	}, "")
	if err != nil {
		t.Fatalf("buildTrinoDSN: %v", err)
	}
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("parse Trino DSN: %v", err)
	}
	if got := parsed.Query().Get("query_timeout"); got != "" {
		t.Fatalf("connection timeout leaked into Trino query_timeout=%q", got)
	}
}
