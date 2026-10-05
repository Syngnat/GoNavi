//go:build gonavi_gbase8a_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "gbase8a"
	agentDatabaseFactory = func() db.Database {
		return &db.GBase8aDB{}
	}
}
