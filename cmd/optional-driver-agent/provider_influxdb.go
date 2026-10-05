//go:build gonavi_influxdb_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "influxdb"
	agentDatabaseFactory = func() db.Database {
		return &db.InfluxDB{}
	}
}
