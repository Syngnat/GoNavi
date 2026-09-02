//go:build gonavi_full_drivers || gonavi_duckdb_driver

package db

import "testing"

func TestDuckDBGetDatabasesPropagatesQueryFailure(t *testing.T) {
	db := &DuckDB{}

	databases, err := db.GetDatabases()
	if err == nil {
		t.Fatalf("GetDatabases unexpectedly succeeded with databases %v", databases)
	}
	if databases != nil {
		t.Fatalf("databases = %v, want nil on query failure", databases)
	}
}
