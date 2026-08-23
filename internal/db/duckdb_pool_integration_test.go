//go:build gonavi_duckdb_driver

package db

import (
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestDuckDBConnectConfiguresBoundedPool(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "pool.duckdb")
	client := &DuckDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "duckdb", Host: dbPath}); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	if got := client.conn.Stats().MaxOpenConnections; got != duckDBSQLMaxOpenConns {
		t.Fatalf("expected max open connections %d, got %d", duckDBSQLMaxOpenConns, got)
	}
	if _, _, err := client.Query("SELECT 1"); err != nil {
		t.Fatalf("query failed: %v", err)
	}
	stats := client.conn.Stats()
	if stats.OpenConnections > duckDBSQLMaxOpenConns || stats.Idle > duckDBSQLMaxIdleConns {
		t.Fatalf("DuckDB connection pool exceeded its bounds: %+v", stats)
	}
}
