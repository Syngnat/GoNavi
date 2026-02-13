//go:build gonavi_vastbase_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "vastbase"
	agentDatabaseFactory = func() db.Database {
		return &db.VastbaseDB{}
	}
}
