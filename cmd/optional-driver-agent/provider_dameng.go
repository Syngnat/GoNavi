//go:build gonavi_dameng_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "dameng"
	agentDatabaseFactory = func() db.Database {
		return &db.DamengDB{}
	}
}
