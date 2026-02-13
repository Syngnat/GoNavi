//go:build gonavi_duckdb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "duckdb"
	agentDatabaseFactory = func() db.Database {
		return &db.DuckDB{}
	}
}
