//go:build gonavi_sphinx_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "sphinx"
	agentDatabaseFactory = func() db.Database {
		return &db.SphinxDB{}
	}
}
