//go:build gonavi_firebird_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "firebird"
	agentDatabaseFactory = func() db.Database {
		return &db.FirebirdDB{}
	}
}
