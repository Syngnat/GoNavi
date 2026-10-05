//go:build gonavi_yashandb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "yashandb"
	agentDatabaseFactory = func() db.Database {
		return &db.YashanDB{}
	}
}
