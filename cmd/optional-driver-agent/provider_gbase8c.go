//go:build gonavi_gbase8c_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "gbase8c"
	agentDatabaseFactory = func() db.Database {
		return &db.GBase8cDB{}
	}
}
