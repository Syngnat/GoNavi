//go:build gonavi_mongodb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "mongodb"
	agentDatabaseFactory = func() db.Database {
		return &db.MongoDB{}
	}
}
