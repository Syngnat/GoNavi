//go:build gonavi_pulsar_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "pulsar"
	agentDatabaseFactory = func() db.Database {
		return &db.PulsarDB{}
	}
}
