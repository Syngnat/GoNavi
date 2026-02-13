//go:build gonavi_tdengine_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "tdengine"
	agentDatabaseFactory = func() db.Database {
		return &db.TDengineDB{}
	}
}
