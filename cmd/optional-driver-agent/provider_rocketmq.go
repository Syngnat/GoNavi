//go:build gonavi_rocketmq_driver

package main

import (
	"GoNavi-Wails/internal/db"

	"github.com/apache/rocketmq-client-go/v2/rlog"
)

func init() {
	agentDriverType = "rocketmq"
	agentDatabaseFactory = func() db.Database {
		return &db.RocketMQDB{}
	}
	// RocketMQ 客户端默认把 Info 级日志写到 stderr；在代理里每一行都会变成主进程告警，
	// 并挤占附在错误信息后的 stderr 尾部，只保留 error 级别。
	rlog.SetLogLevel("error")
}
