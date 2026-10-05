package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// ServerVersionQuery returns the read-only SQL used to discover a live server
// version for AI SQL generation and connection health. ok is false when the
// source type has no version probe.
func ServerVersionQuery(config connection.ConnectionConfig) (string, bool) {
	typeName := strings.ToLower(strings.TrimSpace(config.Type))
	if typeName == "custom" {
		typeName = strings.ToLower(strings.TrimSpace(config.Driver))
	}
	switch typeName {
	case "mysql", "goldendb", "mariadb", "oceanbase", "diros", "starrocks", "sphinx",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb",
		"clickhouse", "trino":
		return "SELECT VERSION() AS version", true
	case "sqlserver":
		return "SELECT @@VERSION AS version", true
	case "sqlite":
		return "SELECT sqlite_version() AS version", true
	case "oracle", "dameng":
		return "SELECT banner AS version FROM v$version WHERE ROWNUM = 1", true
	case "tdengine":
		return "SELECT SERVER_VERSION() AS version", true
	default:
		if spec, ok := DataSourceSpec(typeName); ok && spec.VersionQuery != "" {
			return spec.VersionQuery, true
		}
		return "", false
	}
}

// FirstQueryRowValue returns the first cell of the first result row.
// Named version/banner columns are preferred so multi-column banners stay stable.
func FirstQueryRowValue(rows []map[string]interface{}) string {
	if len(rows) == 0 {
		return ""
	}
	row := rows[0]
	for _, key := range []string{"version", "Version", "VERSION", "banner", "Banner"} {
		if value, ok := row[key]; ok {
			if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
				return text
			}
		}
	}
	for _, value := range row {
		if text := strings.TrimSpace(fmt.Sprint(value)); text != "" {
			return text
		}
	}
	return ""
}

// SanitizeServerVersion trims a version banner and drops values that look like
// secrets or connection strings before they are sent to an AI prompt.
func SanitizeServerVersion(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r", " "), "\n", " "))
	lowerValue := strings.ToLower(value)
	for _, secretMarker := range []string{"password", "passwd", "secret", "token", "api key", "apikey", "jdbc:", "://"} {
		if strings.Contains(lowerValue, secretMarker) {
			return ""
		}
	}
	if len(value) > 256 {
		value = value[:256]
	}
	return value
}
