//go:build gonavi_typesense_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "typesense"
	agentDatabaseFactory = func() db.Database {
		return &db.TypesenseDB{}
	}
}
