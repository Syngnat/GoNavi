package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// resolveConnectionProtectionDBType returns the canonical dialect used only by
// connection-level protection checks. Keep this separate from resolveDDLDBType:
// the latter has broader DDL semantics and intentionally lives with the DDL
// builders, while protection must recognize every saved-connection alias
// before deciding whether a guard is available.
func resolveConnectionProtectionDBType(config connection.ConnectionConfig) string {
	dbType := strings.ToLower(strings.TrimSpace(config.Type))
	isCustom := dbType == "custom"
	if dbType == "custom" {
		dbType = strings.ToLower(strings.TrimSpace(config.Driver))
		config.Type = dbType
	}

	switch dbType {
	case "doris":
		return "diros"
	case "postgresql", "pg", "pq", "pgx":
		return "postgres"
	case "mssql", "sql_server", "sql-server":
		return "sqlserver"
	case "gauss_db", "gauss-db":
		return "gaussdb"
	case "open_gauss", "open-gauss":
		return "opengauss"
	case "goldendb", "greatdb", "gdb":
		return "goldendb"
	case "dm", "dm8":
		return "dameng"
	case "sqlite3":
		return "sqlite"
	case "sphinxql":
		return "sphinx"
	case "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "apache-iotdb", "apache_iotdb":
		return "iotdb"
	case "elastic":
		return "elasticsearch"
	case "milvusdb", "milvus-db":
		return "milvus"
	case "intersystems", "intersystemsiris", "inter-systems-iris", "inter-systems":
		return "iris"
	case "cache", "caché", "intersystems cache", "intersystems caché",
		"intersystems-cache", "intersystems-caché", "intersystemscache", "intersystemscaché",
		"inter-systems-cache", "inter-systems-caché", "intersystems-cache-database", "cache-db", "cachedb":
		return "iris"
	case "oceanbase":
		// isOceanBaseOracleProtocol only considers Type=oceanbase. The custom
		// branch above rewrites Type so custom OceanBase connections follow the
		// same tenant protection path.
		if isOceanBaseOracleProtocol(config) {
			return "oracle"
		}
		return "oceanbase"
	}

	// Preserve the historical custom-driver matching used by the DDL guard.
	// Saved custom drivers are not always registered under the short canonical
	// name (for example, an agent package may expose "postgres-driver").
	if isCustom {
		switch {
		case strings.Contains(dbType, "oceanbase"):
			config.Type = "oceanbase"
			if isOceanBaseOracleProtocol(config) {
				return "oracle"
			}
			return "oceanbase"
		case strings.Contains(dbType, "opengauss"), strings.Contains(dbType, "open_gauss"), strings.Contains(dbType, "open-gauss"):
			return "opengauss"
		case strings.Contains(dbType, "gaussdb"), strings.Contains(dbType, "gauss_db"), strings.Contains(dbType, "gauss-db"):
			return "gaussdb"
		case strings.Contains(dbType, "goldendb"), strings.Contains(dbType, "greatdb"):
			return "goldendb"
		case strings.Contains(dbType, "postgres"):
			return "postgres"
		case strings.Contains(dbType, "kingbase"):
			return "kingbase"
		case strings.Contains(dbType, "highgo"):
			return "highgo"
		case strings.Contains(dbType, "vastbase"):
			return "vastbase"
		case strings.Contains(dbType, "iris"), strings.Contains(dbType, "intersystems"):
			return "iris"
		case strings.Contains(dbType, "sqlite"):
			return "sqlite"
		case strings.Contains(dbType, "sphinx"):
			return "sphinx"
		case strings.Contains(dbType, "sqlserver"), strings.Contains(dbType, "sql_server"), strings.Contains(dbType, "sql-server"), strings.Contains(dbType, "mssql"):
			return "sqlserver"
		case strings.Contains(dbType, "diros"), strings.Contains(dbType, "doris"):
			return "diros"
		case strings.Contains(dbType, "starrocks"):
			return "starrocks"
		}
	}
	return dbType
}
