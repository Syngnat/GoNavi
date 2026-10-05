//go:build gonavi_questdb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "questdb"
	agentDatabaseFactory = func() db.Database {
		return &db.QuestDB{}
	}
}
