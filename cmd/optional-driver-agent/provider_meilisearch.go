//go:build gonavi_meilisearch_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "meilisearch"
	agentDatabaseFactory = func() db.Database {
		return &db.MeilisearchDB{}
	}
}
