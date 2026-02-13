//go:build gonavi_sqlite_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "sqlite"
	agentDatabaseFactory = func() db.Database {
		return &db.SQLiteDB{}
	}
}
