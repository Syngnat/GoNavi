package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func resolveDDLDBType(config connection.ConnectionConfig) string {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	if dbType == "doris" {
		return "diros"
	}
	if dbType == "mssql" || dbType == "sql_server" || dbType == "sql-server" {
		return "sqlserver"
	}
	if dbType == "postgresql" {
		return "postgres"
	}
	if dbType == "gauss_db" || dbType == "gauss-db" {
		return "gaussdb"
	}
	if dbType == "goldendb" || dbType == "greatdb" || dbType == "gdb" {
		return "mysql"
	}
	if dbType == "kingbase8" || dbType == "kingbasees" || dbType == "kingbasev8" {
		return "kingbase"
	}
	if dbType == "milvusdb" || dbType == "milvus-db" {
		return "milvus"
	}
	if dbType == "intersystems" || dbType == "intersystemsiris" || dbType == "inter-systems" || dbType == "inter-systems-iris" {
		return "iris"
	}
	if dbType == "cache" || dbType == "caché" || dbType == "intersystems cache" || dbType == "intersystems caché" || dbType == "intersystems-cache" || dbType == "intersystems-caché" || dbType == "intersystemscache" || dbType == "intersystemscaché" || dbType == "inter-systems-cache" || dbType == "inter-systems-caché" || dbType == "intersystems-cache-database" || dbType == "cache-db" || dbType == "cachedb" {
		return "iris"
	}
	if dbType == "oceanbase" && isOceanBaseOracleProtocol(config) {
		return "oracle"
	}
	if dialect, ok := registryDDLDialect(dbType); ok {
		return dialect
	}
	if dbType != "custom" {
		return dbType
	}

	driver := strings.ToLower(strings.TrimSpace(config.Driver))
	switch driver {
	case "postgresql", "postgres", "pg", "pq", "pgx":
		return "postgres"
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "goldendb", "greatdb", "gdb":
		return "mysql"
	case "dm", "dameng", "dm8":
		return "dameng"
	case "sqlite3", "sqlite":
		return "sqlite"
	case "sphinxql":
		return "sphinx"
	case "mssql", "sqlserver", "sql_server", "sql-server":
		return "sqlserver"
	case "diros", "doris":
		return "diros"
	case "starrocks":
		return "starrocks"
	case "kingbase", "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "highgo":
		return "highgo"
	case "vastbase":
		return "vastbase"
	case "iris", "intersystems", "intersystemsiris", "inter-systems", "inter-systems-iris":
		return "iris"
	case "cache", "caché", "intersystems cache", "intersystems caché", "intersystems-cache", "intersystems-caché", "intersystemscache", "intersystemscaché", "inter-systems-cache", "inter-systems-caché", "intersystems-cache-database", "cache-db", "cachedb":
		return "iris"
	case "oceanbase":
		return "oceanbase"
	case "milvus", "milvusdb", "milvus-db":
		return "milvus"
	}

	switch {
	case strings.Contains(driver, "opengauss"), strings.Contains(driver, "open_gauss"), strings.Contains(driver, "open-gauss"):
		return "opengauss"
	case strings.Contains(driver, "gaussdb"), strings.Contains(driver, "gauss_db"), strings.Contains(driver, "gauss-db"):
		return "gaussdb"
	case strings.Contains(driver, "goldendb"), strings.Contains(driver, "greatdb"):
		return "mysql"
	case strings.Contains(driver, "postgres"):
		return "postgres"
	case strings.Contains(driver, "kingbase"):
		return "kingbase"
	case strings.Contains(driver, "highgo"):
		return "highgo"
	case strings.Contains(driver, "vastbase"):
		return "vastbase"
	case strings.Contains(driver, "iris"), strings.Contains(driver, "intersystems"):
		return "iris"
	case strings.Contains(driver, "sqlite"):
		return "sqlite"
	case strings.Contains(driver, "sphinx"):
		return "sphinx"
	case strings.Contains(driver, "sqlserver"), strings.Contains(driver, "sql_server"), strings.Contains(driver, "sql-server"), strings.Contains(driver, "mssql"):
		return "sqlserver"
	case strings.Contains(driver, "diros"), strings.Contains(driver, "doris"):
		return "diros"
	case strings.Contains(driver, "starrocks"):
		return "starrocks"
	case strings.Contains(driver, "oceanbase"):
		return "oceanbase"
	default:
		return driver
	}
}

func normalizeSchemaAndTableByType(dbType string, dbName string, tableName string) (string, string) {
	rawTable := strings.TrimSpace(tableName)
	rawDB := strings.TrimSpace(dbName)
	if rawTable == "" {
		return rawDB, rawTable
	}

	// 未借用方言的描述表类型只写表名（对象名整体是一个标识符，可能含点或路径），见 registryUsesBareTableNames。
	if registryUsesBareTableNames(dbType) {
		return "", rawTable
	}

	// Elasticsearch / RocketMQ / MQTT / RabbitMQ / Kafka / Trino 与 flatObjectNames 的描述表类型：对象名可能含多个点或路径，不能按点分割
	if registryUsesFlatObjectNames(dbType) || dbType == "elasticsearch" || dbType == "rocketmq" || dbType == "mqtt" || dbType == "kafka" || dbType == "rabbitmq" || dbType == "trino" {
		return rawDB, rawTable
	}

	if dbType == "kingbase" {
		// DDL target parts are logical identifier values.  The metadata
		// adapters may need to preserve a quoted final segment for their own
		// second-pass parsing, but feeding that delimiter into the generic
		// quoter would encode it as part of the identifier.
		schema, table := db.SplitKingbaseQualifiedName(rawTable)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "public", table
		}
	}

	if dbType == "postgres" || dbType == "highgo" || dbType == "vastbase" || dbType == "opengauss" || dbType == "gaussdb" {
		// Keep DDL construction separate from metadata argument handling:
		// quoteSqlIdentifierPath/quoteTableIdentByType adds the dialect
		// delimiter itself, so the parts must not retain an input delimiter.
		schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "public", table
		}
	}

	if dbType == "iris" {
		schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType)
		if schema != "" && table != "" {
			return schema, table
		}
		if table != "" {
			return "", table
		}
	}

	if dbType == "duckdb" {
		return rawDB, rawTable
	}

	if dbType == "sqlite" {
		return normalizeSQLiteSchemaAndTable(rawDB, rawTable)
	}

	// Use the quote-aware splitter for ordinary SQL dialects. A table name
	// such as `Sales.Data` is one identifier; strings.SplitN would incorrectly
	// turn the dot inside its delimiters into a schema separator. Preserve the
	// final delimiter for dialects whose driver parses this argument again.
	if shouldPreserveQuotedTableSegment(dbType) {
		if schema, table := db.SplitSQLQualifiedNamePreserveTableQuoteForDialect(rawTable, dbType); table != "" {
			if schema != "" {
				return schema, table
			}
			return rawDB, table
		}
	} else if schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType); table != "" {
		if schema != "" {
			return schema, table
		}
		return rawDB, table
	}

	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return "public", rawTable
	default:
		return rawDB, rawTable
	}
}

func resolveCreateStatementTargets(config connection.ConnectionConfig, dbType string, dbName string, tableName string) (string, string, string, string) {
	if dbType == "sqlserver" {
		metadataDB := strings.TrimSpace(dbName)
		if metadataDB == "" {
			metadataDB = strings.TrimSpace(config.Database)
		}
		rawTable := strings.TrimSpace(tableName)
		schema, table := db.SplitSQLQualifiedNameForDialect(rawTable, dbType)
		if table == "" {
			table = rawTable
		}
		if schema == "" {
			schema = "dbo"
		}
		return metadataDB, rawTable, schema, table
	}

	// Metadata adapters and DDL rendering intentionally use different forms:
	// adapters that parse the table argument a second time need the delimiter
	// preserved around a dotted final identifier, while the DDL quoter must see
	// the logical value so it can add exactly one delimiter itself.
	ddlSchemaName, ddlTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	metadataSchemaName, metadataTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	// Kingbase's fallback builder and metadata adapters use the explicit
	// public schema contract for an unqualified table. Keep the generic
	// PostgreSQL-family metadata path search_path-aware, but do not pass an
	// empty schema to this legacy-compatible Kingbase fallback.
	if dbType == "kingbase" && strings.TrimSpace(metadataSchemaName) == "" && strings.TrimSpace(ddlSchemaName) != "" {
		metadataSchemaName = ddlSchemaName
	}
	if strings.TrimSpace(metadataTableName) == "" {
		metadataSchemaName, metadataTableName = ddlSchemaName, ddlTableName
	}
	return metadataSchemaName, metadataTableName, ddlSchemaName, ddlTableName
}

func quoteTableIdentByType(dbType string, schema string, table string) string {
	s := strings.TrimSpace(schema)
	t := strings.TrimSpace(table)
	if dbType == "trino" {
		catalog, namespace := splitTrinoNamespace(s)
		switch {
		case catalog == "" && namespace == "":
			return quoteIdentByType(dbType, t)
		case namespace == "":
			return fmt.Sprintf("%s.%s", quoteIdentByType(dbType, catalog), quoteIdentByType(dbType, t))
		default:
			return fmt.Sprintf("%s.%s.%s", quoteIdentByType(dbType, catalog), quoteIdentByType(dbType, namespace), quoteIdentByType(dbType, t))
		}
	}
	if s == "" {
		return quoteIdentByType(dbType, t)
	}
	return fmt.Sprintf("%s.%s", quoteIdentByType(dbType, s), quoteIdentByType(dbType, t))
}

func splitTrinoNamespace(raw string) (string, string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}
	parts := strings.SplitN(text, ".", 2)
	if len(parts) == 1 {
		return strings.TrimSpace(parts[0]), ""
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func buildRunConfigForDDL(config connection.ConnectionConfig, dbType string, dbName string) connection.ConnectionConfig {
	runConfig := normalizeRunConfig(config, dbName)
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		// custom 连接的 dbName 语义依赖 driver，尽量在常见驱动上对齐内置类型行为。
		switch dbType {
		case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "dameng", "sqlserver", "clickhouse":
			if strings.TrimSpace(dbName) != "" {
				runConfig.Database = strings.TrimSpace(dbName)
			}
		}
	}
	return runConfig
}
