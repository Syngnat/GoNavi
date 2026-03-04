//go:build gonavi_mongodb_driver_v1

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "mongodb"
	agentDatabaseFactory = func() db.Database {
		return &db.MongoDBV1{}
	}
}
