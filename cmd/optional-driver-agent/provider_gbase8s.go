//go:build gonavi_gbase8s_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "gbase8s"
	agentDatabaseFactory = func() db.Database {
		return &db.GBase8sDB{}
	}
}
