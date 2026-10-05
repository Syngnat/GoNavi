//go:build gonavi_opensearch_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "opensearch"
	agentDatabaseFactory = func() db.Database {
		return &db.OpenSearchDB{}
	}
}
