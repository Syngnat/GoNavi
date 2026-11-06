package db

import (
	"database/sql"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestSQLPoolStatsSnapshotIncludesRegisteredPools(t *testing.T) {
	pool, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("open sqlite pool failed: %v", err)
	}
	defer pool.Close()
	configureSQLConnectionPool(pool, "sqlite", connection.ConnectionConfig{})

	snapshot := SQLPoolStatsSnapshot()
	if snapshot.Pools < 1 {
		t.Fatalf("pools = %d, want at least 1", snapshot.Pools)
	}
	if snapshot.MaxOpen < 1 {
		t.Fatalf("maxOpen = %d, want at least 1", snapshot.MaxOpen)
	}
}
