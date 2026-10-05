//go:build gonavi_full_drivers || gonavi_tidb_driver

package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

const defaultTiDBPort = 4000

// TiDBDB 通过 MySQL 协议接入 TiDB，并按服务端版本档位开关 TiDB 特有的元数据与语法。
type TiDBDB struct {
	MySQLDB
	driverVariantState
}

var (
	_ Database              = (*TiDBDB)(nil)
	_ DriverVariantReporter = (*TiDBDB)(nil)
)

func (t *TiDBDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(&t.MySQLDB, ctx)
}

func (t *TiDBDB) clearMetadataContext() {
	ClearMetadataContext(&t.MySQLDB)
}

// Connect 复用 MySQL 连接链路（多地址、SSH、代理、SSL），再识别 TiDB 版本并确定档位。
func (t *TiDBDB) Connect(config connection.ConnectionConfig) error {
	runConfig := rewriteURIScheme(config, "mysql", "tidb")
	if runConfig.Port <= 0 {
		runConfig.Port = defaultTiDBPort
	}
	if err := t.MySQLDB.Connect(runConfig); err != nil {
		return err
	}
	version := t.queryTiDBVersion()
	if err := t.resolve("tidb", config, version); err != nil {
		_ = t.MySQLDB.Close()
		return err
	}
	return nil
}

func (t *TiDBDB) queryTiDBVersion() string {
	rows, _, err := t.MySQLDB.Query("SELECT VERSION() AS version")
	if err != nil {
		logger.Warnf("TiDB 版本识别失败：%v", err)
		return ""
	}
	return parseTiDBVersion(FirstQueryRowValue(rows))
}

// parseTiDBVersion 从 "8.0.11-TiDB-v8.5.8" 这类版本串里取出 TiDB 自身版本；
// 不是 TiDB 的服务端返回空串，交给档位默认值处理。
func parseTiDBVersion(banner string) string {
	text := strings.TrimSpace(banner)
	index := strings.Index(strings.ToLower(text), "tidb-")
	if index < 0 {
		return ""
	}
	version := strings.TrimPrefix(strings.TrimPrefix(text[index+len("tidb-"):], "v"), "V")
	if end := strings.IndexAny(version, " \t\r\n"); end >= 0 {
		version = version[:end]
	}
	return version
}

// tidbSupportsForeignKeys 报告服务端是否真正保存并执行外键（TiDB 6.6 起）。
// 更早版本会接受 FOREIGN KEY 语法但不落元数据，元数据查询返回空即可。
func (t *TiDBDB) tidbSupportsForeignKeys() bool {
	return t.atLeast("6.6")
}

// GetForeignKeys 在不支持外键的旧版本上直接返回空列表，避免把语法残留当成约束展示。
func (t *TiDBDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	if !t.tidbSupportsForeignKeys() {
		return []connection.ForeignKeyDefinition{}, nil
	}
	return t.MySQLDB.GetForeignKeys(dbName, tableName)
}

// GetTriggers TiDB 不支持触发器；直接返回空列表，避免把 SHOW TRIGGERS 的兼容行为暴露给用户。
func (t *TiDBDB) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

// GetTables 只返回普通表；序列（TABLE_TYPE=SEQUENCE）和视图走各自的对象分组。
func (t *TiDBDB) GetTables(dbName string) ([]string, error) {
	query := "SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"
	if strings.TrimSpace(dbName) != "" {
		query = fmt.Sprintf(
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = '%s' AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
			strings.ReplaceAll(dbName, "'", "''"),
		)
	}
	rows, _, err := t.MySQLDB.Query(query)
	if err != nil {
		return nil, err
	}
	tables := make([]string, 0, len(rows))
	for _, row := range rows {
		if name := strings.TrimSpace(fmt.Sprint(firstMapValue(row, "TABLE_NAME", "table_name"))); name != "" {
			tables = append(tables, name)
		}
	}
	return dedupeExactTableMetadataNames(tables), nil
}

func firstMapValue(row map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := row[key]; ok {
			return value
		}
	}
	for _, value := range row {
		return value
	}
	return nil
}
