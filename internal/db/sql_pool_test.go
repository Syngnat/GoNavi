package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	poolRecordingDriverName = "gonavi_pool_recording"
	poolBlockingDriverName  = "gonavi_pool_blocking"
)

var (
	poolRecordingOpenCount  atomic.Int64
	poolRecordingCloseCount atomic.Int64
	poolBlockingStatesMu    sync.Mutex
	poolBlockingStates      = map[string]*poolBlockingState{}
)

func init() {
	sql.Register(poolRecordingDriverName, poolRecordingDriver{})
	sql.Register(poolBlockingDriverName, poolBlockingDriver{})
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

type poolBlockingState struct {
	release      chan struct{}
	releaseOnce  sync.Once
	started      chan struct{}
	openCount    atomic.Int64
	closeCount   atomic.Int64
	activePings  atomic.Int64
	maxPingCount atomic.Int64
}

func newPoolBlockingState(requestCount int) *poolBlockingState {
	return &poolBlockingState{
		release: make(chan struct{}),
		started: make(chan struct{}, requestCount),
	}
}

func (s *poolBlockingState) releaseAll() {
	s.releaseOnce.Do(func() {
		close(s.release)
	})
}

func (s *poolBlockingState) recordActivePing() {
	active := s.activePings.Add(1)
	for {
		current := s.maxPingCount.Load()
		if active <= current || s.maxPingCount.CompareAndSwap(current, active) {
			return
		}
	}
}

type poolBlockingDriver struct{}

func (poolBlockingDriver) Open(name string) (driver.Conn, error) {
	poolBlockingStatesMu.Lock()
	state := poolBlockingStates[name]
	poolBlockingStatesMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("blocking pool state not found: %s", name)
	}
	state.openCount.Add(1)
	return &poolBlockingConn{state: state}, nil
}

type poolBlockingConn struct {
	state *poolBlockingState
}

func (c *poolBlockingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("not implemented")
}

func (c *poolBlockingConn) Close() error {
	c.state.closeCount.Add(1)
	return nil
}

func (c *poolBlockingConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not implemented")
}

func (c *poolBlockingConn) Ping(ctx context.Context) error {
	c.state.recordActivePing()
	defer c.state.activePings.Add(-1)
	c.state.started <- struct{}{}
	select {
	case <-c.state.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
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

func openBlockingPoolForTest(t *testing.T, dbType string, requestCount int) (*sql.DB, *poolBlockingState) {
	t.Helper()
	stateKey := t.Name()
	state := newPoolBlockingState(requestCount)
	poolBlockingStatesMu.Lock()
	poolBlockingStates[stateKey] = state
	poolBlockingStatesMu.Unlock()

	dbConn, err := sql.Open(poolBlockingDriverName, stateKey)
	if err != nil {
		t.Fatalf("sql.Open failed: %v", err)
	}
	configureSQLConnectionPool(dbConn, dbType)
	t.Cleanup(func() {
		state.releaseAll()
		_ = dbConn.Close()
		poolBlockingStatesMu.Lock()
		delete(poolBlockingStates, stateKey)
		poolBlockingStatesMu.Unlock()
	})
	return dbConn, state
}

func waitForPoolCondition(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", description)
}

func TestConfigureLocalSQLConnectionPoolBoundsConcurrentRequests(t *testing.T) {
	const requestCount = 20
	tests := []struct {
		name    string
		dbType  string
		maxOpen int
		maxIdle int
	}{
		{name: "SQLite", dbType: "sqlite", maxOpen: sqliteSQLMaxOpenConns, maxIdle: sqliteSQLMaxIdleConns},
		{name: "DuckDB", dbType: "duckdb", maxOpen: duckDBSQLMaxOpenConns, maxIdle: duckDBSQLMaxIdleConns},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dbConn, state := openBlockingPoolForTest(t, tt.dbType, requestCount)
			if got := dbConn.Stats().MaxOpenConnections; got != tt.maxOpen {
				t.Fatalf("expected max open connections %d, got %d", tt.maxOpen, got)
			}

			start := make(chan struct{})
			errCh := make(chan error, requestCount)
			for i := 0; i < requestCount; i++ {
				go func() {
					<-start
					errCh <- dbConn.PingContext(context.Background())
				}()
			}
			close(start)

			for i := 0; i < tt.maxOpen; i++ {
				select {
				case <-state.started:
				case <-time.After(5 * time.Second):
					t.Fatalf("timed out waiting for %d active connections", tt.maxOpen)
				}
			}
			waitForPoolCondition(t, "excess requests to wait", func() bool {
				return dbConn.Stats().WaitCount >= int64(requestCount-tt.maxOpen)
			})

			stats := dbConn.Stats()
			if stats.OpenConnections > tt.maxOpen {
				t.Fatalf("open connections exceeded limit: limit=%d stats=%+v", tt.maxOpen, stats)
			}
			if got := state.openCount.Load(); got != int64(tt.maxOpen) {
				t.Fatalf("expected %d physical connections, opened %d", tt.maxOpen, got)
			}
			if got := state.maxPingCount.Load(); got != int64(tt.maxOpen) {
				t.Fatalf("expected at most %d concurrent pings, got %d", tt.maxOpen, got)
			}

			state.releaseAll()
			for i := 0; i < requestCount; i++ {
				select {
				case err := <-errCh:
					if err != nil {
						t.Fatalf("concurrent ping failed: %v", err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("timed out waiting for concurrent pings to finish")
				}
			}

			waitForPoolCondition(t, "idle connections to respect the limit", func() bool {
				stats := dbConn.Stats()
				return stats.InUse == 0 && stats.Idle <= tt.maxIdle && stats.OpenConnections <= tt.maxIdle
			})
			if err := dbConn.Close(); err != nil {
				t.Fatalf("close failed: %v", err)
			}
			waitForPoolCondition(t, "all physical connections to close", func() bool {
				return state.closeCount.Load() == state.openCount.Load()
			})
		})
	}
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
