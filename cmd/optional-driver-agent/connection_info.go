package main

import "GoNavi-Wails/internal/db"

type agentConnectionInfo struct {
	ElasticsearchServerMajor int    `json:"elasticsearchServerMajor,omitempty"`
	ProtocolSchema           string `json:"protocolSchema,omitempty"`
	// InFlightCancel 声明本 agent 支持在途查询取消通道：主进程据此决定停止查询时
	// 是先发取消通知，还是沿用杀进程的旧路径。旧版主进程忽略该字段。
	InFlightCancel bool `json:"inFlightCancel,omitempty"`
	// DriverVariant / ServerVersion 由描述表数据源回报：实际采用的驱动版本档位与服务端自报版本。
	// 旧版主进程忽略这两个字段。
	DriverVariant string `json:"driverVariant,omitempty"`
	ServerVersion string `json:"serverVersion,omitempty"`
}

// newAgentConnectionInfo 汇总 connect 成功后回传主进程的连接级信息。
func newAgentConnectionInfo(inst db.Database) agentConnectionInfo {
	info := agentConnectionInfo{ProtocolSchema: agentProtocolSchemaV2, InFlightCancel: true}
	if versionProvider, ok := inst.(db.ElasticsearchServerVersionProvider); ok {
		info.ElasticsearchServerMajor = versionProvider.ElasticsearchServerMajor()
	}
	if reporter, ok := inst.(db.DriverVariantReporter); ok {
		info.DriverVariant, info.ServerVersion = reporter.DriverVariantInfo()
	}
	return info
}
