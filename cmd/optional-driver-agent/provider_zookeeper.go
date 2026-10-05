//go:build gonavi_zookeeper_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "zookeeper"
	agentDatabaseFactory = func() db.Database {
		return &db.ZooKeeperDB{}
	}
}
