//go:build gonavi_sqlserver_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "sqlserver"
	agentDatabaseFactory = func() db.Database {
		return &db.SqlServerDB{}
	}
}
