package app

import (
	"context"
	"errors"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

// tableInfoQueryTimeout 表信息是单行字典查询，超时只需覆盖建连 + 查询本身。
const tableInfoQueryTimeout = 30 * time.Second

// DBGetTableInfo 返回右侧对象信息面板所需的表级聚合元数据
// （引擎/注释/编码/行格式/行数/数据与索引大小/自增/创建与更新时间）。
// 驱动方言不支持时返回 Success=true 且 Data 为空，前端据此降级展示。
func (a *App) DBGetTableInfo(config connection.ConnectionConfig, dbName string, schemaName string, tableName string) connection.QueryResult {
	config.MetadataScope = nil
	runConfig := normalizeMetadataRunConfig(config, dbName)
	dbInst, err := a.getMetadataDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetTableInfo 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	ctx, cancel := context.WithTimeout(context.Background(), tableInfoQueryTimeout)
	defer cancel()

	details, err := db.GetTableInfo(ctx, dbInst, runConfig.Type, dbName, schemaName, tableName)
	if err != nil {
		if errors.Is(err, db.ErrTableInfoUnsupported) {
			return connection.QueryResult{Success: true, Data: nil, Message: err.Error()}
		}
		logger.Error(err, "DBGetTableInfo 查询表信息失败：%s 表=%s", formatConnSummary(runConfig), tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: details}
}
