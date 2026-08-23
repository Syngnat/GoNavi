package sync

import (
	"GoNavi-Wails/internal/connection"
	"strings"
)

func normalizeMigrationDBType(dbType string) string {
	normalized := strings.ToLower(strings.TrimSpace(dbType))
	switch normalized {
	case "doris":
		return "diros"
	case "goldendb", "greatdb", "gdb":
		return "mysql"
	case "postgresql":
		return "postgres"
	case "mssql", "sql_server", "sql-server":
		return "sqlserver"
	case "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "intersystems", "intersystemsiris", "inter-systems", "inter-systems-iris":
		return "iris"
	case "dm", "dm8":
		return "dameng"
	case "sqlite3":
		return "sqlite"
	default:
		return normalized
	}
}

func resolveMigrationDBType(config connection.ConnectionConfig) string {
	dbType := normalizeMigrationDBType(config.Type)
	if dbType != "custom" {
		return dbType
	}

	driver := strings.ToLower(strings.TrimSpace(config.Driver))
	switch driver {
	case "postgresql", "postgres", "pg", "pq", "pgx":
		return "postgres"
	case "mssql", "sqlserver", "sql_server", "sql-server":
		return "sqlserver"
	case "opengauss", "open_gauss", "open-gauss":
		return "opengauss"
	case "gaussdb", "gauss_db", "gauss-db":
		return "gaussdb"
	case "intersystems", "intersystemsiris", "inter-systems", "inter-systems-iris", "iris":
		return "iris"
	case "dm", "dameng", "dm8":
		return "dameng"
	case "sqlite3", "sqlite":
		return "sqlite"
	case "sphinxql":
		return "sphinx"
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
	case "oceanbase":
		return "oceanbase"
	case "mysql", "mysql2":
		return "mysql"
	case "mariadb":
		return "mariadb"
	}

	switch {
	case strings.Contains(driver, "opengauss"), strings.Contains(driver, "open_gauss"), strings.Contains(driver, "open-gauss"):
		return "opengauss"
	case strings.Contains(driver, "gaussdb"), strings.Contains(driver, "gauss_db"), strings.Contains(driver, "gauss-db"):
		return "gaussdb"
	case strings.Contains(driver, "postgres"):
		return "postgres"
	case strings.Contains(driver, "kingbase"):
		return "kingbase"
	case strings.Contains(driver, "highgo"):
		return "highgo"
	case strings.Contains(driver, "vastbase"):
		return "vastbase"
	case strings.Contains(driver, "sqlite"):
		return "sqlite"
	case strings.Contains(driver, "sphinx"):
		return "sphinx"
	case strings.Contains(driver, "diros"), strings.Contains(driver, "doris"):
		return "diros"
	case strings.Contains(driver, "starrocks"):
		return "starrocks"
	case strings.Contains(driver, "maria"):
		return "mariadb"
	case strings.Contains(driver, "oceanbase"):
		return "oceanbase"
	case strings.Contains(driver, "mysql"):
		return "mysql"
	case strings.Contains(driver, "dameng"), strings.Contains(driver, "dm"):
		return "dameng"
	default:
		return normalizeMigrationDBType(driver)
	}
}

func isMySQLCoreType(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks":
		return true
	default:
		return false
	}
}

func isMySQLRowStoreType(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb", "oceanbase":
		return true
	default:
		return false
	}
}

func isMySQLLikeSourceType(dbType string) bool {
	if isMySQLCoreType(dbType) {
		return true
	}
	return normalizeMigrationDBType(dbType) == "sphinx"
}

func isMySQLLikeWritableTargetType(dbType string) bool {
	return isMySQLCoreType(dbType)
}
