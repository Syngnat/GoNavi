//go:build gonavi_full_drivers || gonavi_trino_driver

package db

import (
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"testing"
)

var (
	trinoCloseTestDriverOnce sync.Once
	errTrinoCloseTest        = errors.New("trino close test error")
)

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
