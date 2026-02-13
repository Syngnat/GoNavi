//go:build gonavi_diros_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "diros"
	agentDatabaseFactory = func() db.Database {
		return &db.DirosDB{}
	}
}
