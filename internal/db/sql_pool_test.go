package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync/atomic"
	"testing"
)

const poolRecordingDriverName = "gonavi_pool_recording"

var (
	poolRecordingOpenCount  atomic.Int64
	poolRecordingCloseCount atomic.Int64
)

func init() {
	sql.Register(poolRecordingDriverName, poolRecordingDriver{})
}

type poolRecordingDriver struct{}

func (poolRecordingDriver) Open(name string) (driver.Conn, error) {
	poolRecordingOpenCount.Add(1)
	return poolRecordingConn{}, nil
}

type poolRecordingConn struct{}

func (poolRecordingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not implemented")
}

func (poolRecordingConn) Close() error {
	poolRecordingCloseCount.Add(1)
	return nil
}

func (poolRecordingConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not implemented")
}

func (poolRecordingConn) Ping(ctx context.Context) error {
	return nil
}

func resetPoolRecordingDriverCounters() {
	poolRecordingOpenCount.Store(0)
	poolRecordingCloseCount.Store(0)
}

func openConfiguredPoolForTest(t *testing.T, dbType string) *sql.DB {
	t.Helper()
	resetPoolRecordingDriverCounters()
	dbConn, err := sql.Open(poolRecordingDriverName, t.Name())
	if err != nil {
		t.Fatalf("sql.Open failed: %v", err)
	}
	configureSQLConnectionPool(dbConn, dbType)
	t.Cleanup(func() {
		_ = dbConn.Close()
	})
	return dbConn
}

func TestConfigureSQLConnectionPoolKeepsOneIdleSQLServerConnection(t *testing.T) {
	dbConn := openConfiguredPoolForTest(t, "sqlserver")

	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("first ping failed: %v", err)
	}
	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("second ping failed: %v", err)
	}

	if got := poolRecordingOpenCount.Load(); got != 1 {
		t.Fatalf("expected SQL Server pool to reuse one idle connection, opened %d connections", got)
	}
	if got := poolRecordingCloseCount.Load(); got != 0 {
		t.Fatalf("expected SQL Server idle connection to remain cached before DB close, closed %d connections", got)
	}
}

func TestConfigureSQLConnectionPoolKeepsOneIdleKingbaseConnection(t *testing.T) {
	dbConn := openConfiguredPoolForTest(t, "kingbase")

	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("first ping failed: %v", err)
	}
	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("second ping failed: %v", err)
	}

	if got := poolRecordingOpenCount.Load(); got != 1 {
		t.Fatalf("expected Kingbase pool to reuse one idle connection, opened %d connections", got)
	}
	if got := poolRecordingCloseCount.Load(); got != 0 {
		t.Fatalf("expected Kingbase idle connection to remain cached before DB close, closed %d connections", got)
	}
}

func TestSQLServerConnectionPoolIdleWindowOutlastsDefaultPingBoundary(t *testing.T) {
	sqlServerIdleTime := resolveSQLConnectionPoolMaxIdleTime("sqlserver")
	if sqlServerIdleTime <= defaultSQLConnMaxIdleTime {
		t.Fatalf("expected SQL Server idle connection window to exceed %s, got %s", defaultSQLConnMaxIdleTime, sqlServerIdleTime)
	}
	if sqlServerIdleTime != defaultSQLConnMaxLifetime {
		t.Fatalf("expected SQL Server idle connection window to match lifetime %s, got %s", defaultSQLConnMaxLifetime, sqlServerIdleTime)
	}
	if got := resolveSQLConnectionPoolMaxIdleTime("oracle"); got != defaultSQLConnMaxIdleTime {
		t.Fatalf("expected Oracle idle connection window to remain %s, got %s", defaultSQLConnMaxIdleTime, got)
	}
}

func TestConfigureSQLConnectionPoolDefaultDoesNotKeepIdleConnections(t *testing.T) {
	dbConn := openConfiguredPoolForTest(t, "mysql")

	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("first ping failed: %v", err)
	}
	if err := dbConn.PingContext(context.Background()); err != nil {
		t.Fatalf("second ping failed: %v", err)
	}

	if got := poolRecordingOpenCount.Load(); got != 2 {
		t.Fatalf("expected default pool to reopen without idle cache, opened %d connections", got)
	}
	if got := poolRecordingCloseCount.Load(); got != 2 {
		t.Fatalf("expected default pool to close each returned connection, closed %d connections", got)
	}
}
