package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

func normalizeRunConfig(config connection.ConnectionConfig, dbName string) connection.ConnectionConfig {
	runConfig := config
	name := strings.TrimSpace(dbName)
	if name == "" {
		return runConfig
	}

	switch strings.ToLower(strings.TrimSpace(config.Type)) {
	case "mysql", "mariadb", "diros", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "sqlserver", "mongodb", "tdengine", "clickhouse":
		// 这些类型的 dbName 表示"数据库"，需要写入连接配置以选择目标库。
		runConfig.Database = name
	case "dameng":
		// 达梦使用 schema 参数，沿用现有行为：dbName 表示 schema。
		runConfig.Database = name
	default:
		// oracle: dbName 表示 schema/owner，不能覆盖 config.Database（服务名）
		// sqlite: 无需设置 Database
		// custom: 语义不明确，避免污染缓存 key
	}

	return runConfig
}

func normalizeSchemaAndTable(config connection.ConnectionConfig, dbName string, tableName string) (string, string) {
	rawTable := strings.TrimSpace(tableName)
	rawDB := strings.TrimSpace(dbName)
	if rawTable == "" {
		return rawDB, rawTable
	}

	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "sqlserver" {
		// SQL Server 的 DB 接口约定：第一个参数是数据库名，schema 由 tableName(如 dbo.users) 自行解析。
		// 不能把 schema(dbo) 传到第一个参数，否则会拼出 dbo.sys.columns 等无效对象名。
		targetDB := rawDB
		if targetDB == "" {
			targetDB = strings.TrimSpace(config.Database)
		}
		return targetDB, rawTable
	}

	if parts := strings.SplitN(rawTable, ".", 2); len(parts) == 2 {
		schema := strings.TrimSpace(parts[0])
		table := strings.TrimSpace(parts[1])
		if schema != "" && table != "" {
			return schema, table
		}
	}

	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase":
		// PG/金仓/瀚高/海量：dbName 在 UI 里是"数据库"，schema 需从 tableName 或使用默认 public。
		return "public", rawTable
	default:
		// MySQL：dbName 表示数据库；Oracle/达梦：dbName 表示 schema/owner。
		return rawDB, rawTable
	}
}
