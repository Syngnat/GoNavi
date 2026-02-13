//go:build gonavi_mysql_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "mysql"
	agentDatabaseFactory = func() db.Database {
		return &db.MySQLDB{}
	}
}
