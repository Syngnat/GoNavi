package sync

import (
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/datasource"
)

// cockroachTypeAnnotationPattern 匹配 CockroachDB 默认值里的类型注解（'a':::STRING、now():::TIMESTAMPTZ）。
var cockroachTypeAnnotationPattern = regexp.MustCompile(`:::[A-Za-z][A-Za-z0-9_ ]*(\[\])?`)

// isCockroachFamilyEndpoint 报告连接是否为 CockroachDB 内核（CockroachDB、KWDB）：
// 它们与 PostgreSQL 共用同步方言，但默认值里有 unique_rowid() 与 ::: 类型注解。
func isCockroachFamilyEndpoint(config connection.ConnectionConfig) bool {
	canonical, ok := datasource.Canonical(strings.TrimSpace(config.Type))
	return ok && (canonical == "cockroachdb" || canonical == "kwdb")
}

// adaptCockroachDefault 把 CockroachDB 专有的默认值改写成目标库能执行的形式：目标不是 CockroachDB 内核时
// 去掉 ::: 类型注解；unique_rowid() 在 PostgreSQL 系没有对应函数，去掉默认值并返回提示（已迁移的行保留原值）。
func adaptCockroachDefault(col connection.ColumnDefinition, cockroachTarget bool) (connection.ColumnDefinition, string) {
	if cockroachTarget || col.Default == nil {
		return col, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if !strings.Contains(raw, ":::") && !strings.HasPrefix(strings.ToLower(raw), "unique_rowid(") {
		return col, ""
	}
	adapted := cockroachTypeAnnotationPattern.ReplaceAllString(raw, "")
	if strings.HasPrefix(strings.ToLower(adapted), "unique_rowid(") {
		col.Default = nil
		return col, fmt.Sprintf("字段 %s 的默认值 unique_rowid() 是 CockroachDB 专有函数，目标库没有对应实现，已跳过（已迁移的行保留原值）", col.Name)
	}
	col.Default = &adapted
	return col, ""
}

// cockroachStringTypePattern 匹配 CockroachDB 内核特有的类型名：STRING / STRING(n) / BYTES / VARBYTES，可带数组后缀。
var cockroachStringTypePattern = regexp.MustCompile(`(?i)^\s*(string|bytes|varbytes)\s*(\(\s*\d+\s*\))?\s*(\[\])?\s*$`)

// adaptCockroachColumnType 把 CockroachDB 内核（CockroachDB、KWDB）特有的类型名换成 PostgreSQL 的写法：
// STRING → text、STRING(n) → varchar(n)、BYTES / VARBYTES → bytea；其他类型原样返回。
func adaptCockroachColumnType(columnType string) string {
	match := cockroachStringTypePattern.FindStringSubmatch(columnType)
	if match == nil {
		return columnType
	}
	base := "bytea"
	if strings.EqualFold(match[1], "string") {
		base = "text"
		if match[2] != "" {
			base = "varchar" + strings.ReplaceAll(match[2], " ", "")
		}
	}
	return base + match[3]
}

// isExtensionInternalTrigger 报告触发器是否调用扩展内部函数（TimescaleDB 的 _timescaledb_* schema）。
func isExtensionInternalTrigger(statement string) bool {
	return strings.Contains(strings.ToLower(statement), "_timescaledb_")
}
