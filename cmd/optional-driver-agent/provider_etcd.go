//go:build gonavi_etcd_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "etcd"
	agentDatabaseFactory = func() db.Database {
		return &db.EtcdDB{}
	}
}
