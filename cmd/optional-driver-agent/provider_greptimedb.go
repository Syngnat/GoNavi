//go:build gonavi_greptimedb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "greptimedb"
	agentDatabaseFactory = func() db.Database {
		return &db.GreptimeDB{}
	}
}
