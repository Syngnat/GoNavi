//go:build gonavi_cockroachdb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "cockroachdb"
	agentDatabaseFactory = func() db.Database {
		return &db.CockroachDB{}
	}
}
