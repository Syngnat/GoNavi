//go:build gonavi_hive_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "hive"
	agentDatabaseFactory = func() db.Database { return &db.HiveDB{} }
}
