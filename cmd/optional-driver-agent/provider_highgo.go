//go:build gonavi_highgo_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "highgo"
	agentDatabaseFactory = func() db.Database {
		return &db.HighGoDB{}
	}
}
