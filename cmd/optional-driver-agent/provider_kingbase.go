//go:build gonavi_kingbase_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "kingbase"
	agentDatabaseFactory = func() db.Database {
		return &db.KingbaseDB{}
	}
}
