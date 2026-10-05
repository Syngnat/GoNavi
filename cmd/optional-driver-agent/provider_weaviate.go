//go:build gonavi_weaviate_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "weaviate"
	agentDatabaseFactory = func() db.Database {
		return &db.WeaviateDB{}
	}
}
