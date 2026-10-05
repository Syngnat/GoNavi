//go:build gonavi_kafka_driver

package main

import "GoNavi-Wails/internal/db"

func init() {
	agentDriverType = "kafka"
	agentDatabaseFactory = func() db.Database {
		return &db.KafkaDB{}
	}
}
