//go:build gonavi_cache_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "cache"
	agentDatabaseFactory = func() db.Database {
		return &db.CacheDB{}
	}
}
