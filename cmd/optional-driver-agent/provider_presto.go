//go:build gonavi_presto_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "presto"
	agentDatabaseFactory = func() db.Database {
		return &db.PrestoDB{}
	}
}
