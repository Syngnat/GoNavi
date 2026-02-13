//go:build gonavi_mariadb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "mariadb"
	agentDatabaseFactory = func() db.Database {
		return &db.MariaDB{}
	}
}
