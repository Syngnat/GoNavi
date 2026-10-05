//go:build gonavi_timescaledb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "timescaledb"
	agentDatabaseFactory = func() db.Database {
		return &db.TimescaleDB{}
	}
}
