//go:build gonavi_kwdb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "kwdb"
	agentDatabaseFactory = func() db.Database {
		return &db.KWDB{}
	}
}
