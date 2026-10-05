//go:build gonavi_tidb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "tidb"
	agentDatabaseFactory = func() db.Database {
		return &db.TiDBDB{}
	}
}
