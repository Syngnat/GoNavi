package db

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

// GenerateChangePreview 将 ChangeSet 转为可读 SQL 语句（不执行）。
// quoteIdent 用于引用列名/表名（MySQL: backtick, PostgreSQL: double quote）。
func GenerateChangePreview(tableName string, changes connection.ChangeSet, quoteIdent func(string) string) (deletes, updates, inserts []string) {
	return GenerateChangePreviewWithTableQuoter(tableName, changes, quoteIdent, quoteIdent)
}

// GenerateChangePreviewWithTableQuoter allows qualified table names to be quoted
// segment by segment while keeping column quoting unchanged.
func GenerateChangePreviewWithTableQuoter(
	tableName string,
	changes connection.ChangeSet,
	quoteIdent func(string) string,
	quoteTable func(string) string,
) (deletes, updates, inserts []string) {
	return generateChangePreview(tableName, changes, quoteIdent, quoteTable, formatLiteral)
}

// GenerateChangePreviewWithDialect 按目标方言格式化值字面量，同时保留现有标识符引用钩子。
func GenerateChangePreviewWithDialect(
	tableName string,
	changes connection.ChangeSet,
	dbType string,
	quoteIdent func(string) string,
	quoteTable func(string) string,
) (deletes, updates, inserts []string) {
	return generateChangePreview(tableName, changes, quoteIdent, quoteTable, func(v interface{}) string {
		return formatLiteralForDialect(dbType, v)
	})
}

func generateChangePreview(
	tableName string,
	changes connection.ChangeSet,
	quoteIdent func(string) string,
	quoteTable func(string) string,
	format func(interface{}) string,
) (deletes, updates, inserts []string) {
	if quoteTable == nil {
		quoteTable = quoteIdent
	}

	// Deletes
	for _, pk := range changes.Deletes {
		var conds []string
		for _, k := range sortedKeys(pk) {
			v := pk[k]
			conds = append(conds, fmt.Sprintf("%s = %s", quoteIdent(k), format(v)))
		}
		if len(conds) > 0 {
			deletes = append(deletes, fmt.Sprintf("DELETE FROM %s WHERE %s;", quoteTable(tableName), strings.Join(conds, " AND ")))
		}
	}

	// Updates
	for _, row := range changes.Updates {
		var sets []string
		for _, k := range sortedKeys(row.Values) {
			v := row.Values[k]
			sets = append(sets, fmt.Sprintf("%s = %s", quoteIdent(k), format(v)))
		}
		if len(sets) == 0 {
			continue
		}
		var conds []string
		for _, k := range sortedKeys(row.Keys) {
			v := row.Keys[k]
			conds = append(conds, fmt.Sprintf("%s = %s", quoteIdent(k), format(v)))
		}
		if len(conds) == 0 {
			continue
		}
		updates = append(updates, fmt.Sprintf("UPDATE %s SET %s WHERE %s;", quoteTable(tableName), strings.Join(sets, ", "), strings.Join(conds, " AND ")))
	}

	// Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var vals []string
		for _, k := range sortedKeys(row) {
			v := row[k]
			if v == nil {
				continue
			}
			cols = append(cols, quoteIdent(k))
			vals = append(vals, format(v))
		}
		if len(cols) == 0 {
			continue
		}
		inserts = append(inserts, fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s);", quoteTable(tableName), strings.Join(cols, ", "), strings.Join(vals, ", ")))
	}

	return deletes, updates, inserts
}

// sortedKeys 返回 map 的键排序切片，保证输出确定性。
func sortedKeys(m map[string]interface{}) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// formatLiteral 将 Go 值转为 SQL 字面量字符串。
func formatLiteral(v interface{}) string {
	return formatLiteralWithEscaper(v, func(value string) string {
		escaped := strings.ReplaceAll(value, "\\", "\\\\")
		return strings.ReplaceAll(escaped, "'", "\\'")
	}, func(value string) string {
		return strings.ReplaceAll(value, "'", "\\'")
	})
}

func formatLiteralForDialect(dbType string, v interface{}) string {
	normalizedType := strings.ToLower(strings.TrimSpace(dbType))
	switch normalizedType {
	case "postgresql":
		normalizedType = "postgres"
	case "mssql", "sql_server", "sql-server":
		normalizedType = "sqlserver"
	}
	if temporal, ok := v.(time.Time); ok {
		return formatPreviewTemporalLiteral(normalizedType, temporal)
	}
	return formatLiteralWithEscaper(v, func(value string) string {
		if dialectEscapesBackslashInPreviewLiteral(normalizedType) {
			value = strings.ReplaceAll(value, "\\", "\\\\")
		}
		return strings.ReplaceAll(value, "'", "''")
	}, func(value string) string {
		if dialectEscapesBackslashInPreviewLiteral(normalizedType) {
			value = strings.ReplaceAll(value, "\\", "\\\\")
		}
		return strings.ReplaceAll(value, "'", "''")
	})
}

func formatPreviewTemporalLiteral(dbType string, value time.Time) string {
	switch dbType {
	case "postgres":
		return fmt.Sprintf("TIMESTAMP '%s'", formatPreviewTimestamp(value, 6))
	case "oracle":
		text, precision := formatPreviewTimestampWithPrecision(value, 9)
		if precision == 0 {
			return fmt.Sprintf("TO_TIMESTAMP('%s', 'YYYY-MM-DD HH24:MI:SS')", text)
		}
		return fmt.Sprintf("TO_TIMESTAMP('%s', 'YYYY-MM-DD HH24:MI:SS.FF%d')", text, precision)
	case "sqlserver":
		return fmt.Sprintf("CONVERT(datetime2(7), '%s', 126)", strings.Replace(formatPreviewTimestamp(value, 7), " ", "T", 1))
	default:
		return fmt.Sprintf("'%s'", formatPreviewTimestamp(value, 6))
	}
}

// formatPreviewTimestamp 将小数秒限制在目标方言可表达的精度内，并保留原始本地时间值。
func formatPreviewTimestamp(value time.Time, maxPrecision int) string {
	text, _ := formatPreviewTimestampWithPrecision(value, maxPrecision)
	return text
}

func formatPreviewTimestampWithPrecision(value time.Time, maxPrecision int) (string, int) {
	text := value.Format("2006-01-02 15:04:05")
	if value.Nanosecond() == 0 || maxPrecision <= 0 {
		return text, 0
	}

	fraction := strings.TrimRight(fmt.Sprintf("%09d", value.Nanosecond()), "0")
	if len(fraction) > maxPrecision {
		fraction = fraction[:maxPrecision]
	}
	fraction = strings.TrimRight(fraction, "0")
	if fraction == "" {
		return text, 0
	}
	return text + "." + fraction, len(fraction)
}

func formatLiteralWithEscaper(v interface{}, escapeString func(string) string, escapeDefault func(string) string) string {
	if v == nil {
		return "NULL"
	}
	switch t := v.(type) {
	case string:
		return fmt.Sprintf("'%s'", escapeString(t))
	case float64:
		return formatNumber(t)
	case float32:
		return formatNumber(float64(t))
	case int:
		return fmt.Sprintf("%d", t)
	case int64:
		return fmt.Sprintf("%d", t)
	case int32:
		return fmt.Sprintf("%d", t)
	case int16:
		return fmt.Sprintf("%d", t)
	case int8:
		return fmt.Sprintf("%d", t)
	case uint64:
		return fmt.Sprintf("%d", t)
	case uint32:
		return fmt.Sprintf("%d", t)
	case uint16:
		return fmt.Sprintf("%d", t)
	case uint8:
		return fmt.Sprintf("%d", t)
	case uint:
		return fmt.Sprintf("%d", t)
	case time.Time:
		return fmt.Sprintf("'%s'", t.Format("2006-01-02 15:04:05"))
	case bool:
		if t {
			return "TRUE"
		}
		return "FALSE"
	case []byte:
		return fmt.Sprintf("'%s'", escapeString(string(t)))
	default:
		return fmt.Sprintf("'%s'", escapeDefault(fmt.Sprintf("%v", t)))
	}
}

// dialectEscapesBackslashInPreviewLiteral reports dialects whose default string
// literal parser treats backslash as an escape character.
func dialectEscapesBackslashInPreviewLiteral(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "tidb", "oceanbase", "diros", "doris", "starrocks", "sphinx", "clickhouse", "tdengine", "taos":
		return true
	default:
		return false
	}
}

func formatNumber(f float64) string {
	if f == float64(int64(f)) {
		return fmt.Sprintf("%d", int64(f))
	}
	return fmt.Sprintf("%v", f)
}
