package app

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func exportRowValueCI(row map[string]interface{}, candidates ...string) string {
	if len(row) == 0 || len(candidates) == 0 {
		return ""
	}
	for _, candidate := range candidates {
		candidate = strings.ToLower(strings.TrimSpace(candidate))
		if candidate == "" {
			continue
		}
		for key, value := range row {
			normalizedKey := strings.ToLower(strings.TrimSpace(key))
			if normalizedKey != candidate {
				continue
			}
			if value == nil {
				return ""
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text == "<nil>" {
				return ""
			}
			return text
		}
	}
	return ""
}

func exportInferObjectName(row map[string]interface{}) string {
	if len(row) == 0 {
		return ""
	}
	for key, value := range row {
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		if normalizedKey == "" {
			continue
		}
		if strings.Contains(normalizedKey, "type") {
			continue
		}
		if strings.Contains(normalizedKey, "table") || strings.Contains(normalizedKey, "view") || strings.Contains(normalizedKey, "name") || strings.Contains(normalizedKey, "ddl") || strings.Contains(normalizedKey, "sql") {
			if value == nil {
				continue
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text == "" || text == "<nil>" {
				continue
			}
			return text
		}
	}
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			continue
		}
		return text
	}
	return ""
}

func trimLeadingSQLComments(sql string) string {
	trimmed := strings.TrimSpace(sql)
	for trimmed != "" {
		switch {
		case strings.HasPrefix(trimmed, "--"):
			if newline := strings.IndexByte(trimmed, '\n'); newline >= 0 {
				trimmed = strings.TrimSpace(trimmed[newline+1:])
				continue
			}
			return ""
		case strings.HasPrefix(trimmed, "#"):
			if newline := strings.IndexByte(trimmed, '\n'); newline >= 0 {
				trimmed = strings.TrimSpace(trimmed[newline+1:])
				continue
			}
			return ""
		case strings.HasPrefix(trimmed, "/*"):
			if end := strings.Index(trimmed, "*/"); end >= 0 {
				trimmed = strings.TrimSpace(trimmed[end+2:])
				continue
			}
			return ""
		}
		break
	}
	return trimmed
}

func looksLikeSelectOrWith(sql string) bool {
	trimmed := trimLeadingSQLComments(strings.TrimSuffix(sql, ";"))
	if trimmed == "" {
		return false
	}
	lower := strings.ToLower(trimmed)
	return hasLeadingReadonlySQLKeyword(lower, "select") || hasLeadingReadonlySQLKeyword(lower, "with")
}

func hasLeadingReadonlySQLKeyword(sql string, keyword string) bool {
	if sql == keyword {
		return true
	}
	if !strings.HasPrefix(sql, keyword) {
		return false
	}
	if len(sql) <= len(keyword) {
		return true
	}
	return unicode.IsSpace(rune(sql[len(keyword)]))
}

func escapeSQLLiteral(value string) string {
	return strings.ReplaceAll(strings.TrimSpace(value), "'", "''")
}

// dialectEscapesBackslashInStringLiteral 判断方言是否把反斜杠当作字符串字面量里的转义符。
//
// 命中的方言必须在生成字面量时把反斜杠翻倍，否则还原时 \n \t \0 会被解释成控制字符
// （静默改写数据），且以反斜杠结尾的值会吞掉闭合单引号，让后续文本越出字面量。
//   - MySQL 协议系（mysql/mariadb/tidb/oceanbase/doris/starrocks）：默认 sql_mode 不含
//     NO_BACKSLASH_ESCAPES，反斜杠为转义符。
//   - ClickHouse 与 TDengine：字面量同样支持 C 风格反斜杠转义。
//
// 不命中的方言（postgres 系在 standard_conforming_strings=on 下、oracle、sqlserver、
// sqlite 等）反斜杠是普通字面字符，翻倍反而会写入两个反斜杠、损坏数据。
func dialectEscapesBackslashInStringLiteral(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "mysql", "mariadb", "tidb", "oceanbase", "diros", "doris", "starrocks",
		"clickhouse", "tdengine", "taos", "greptimedb":
		return true
	default:
		return false
	}
}

// escapeSQLStringLiteralBody 按方言转义字符串字面量的内容（不含外层单引号）。
// 反斜杠必须先于单引号处理，避免二次转义。非 MySQL 系方言（standard_conforming_strings）
// 只需翻倍单引号，反斜杠保持字面量含义。
func escapeSQLStringLiteralBody(dbType string, value string) string {
	if dialectEscapesBackslashInStringLiteral(dbType) {
		value = strings.ReplaceAll(value, "\\", "\\\\")
	}
	return strings.ReplaceAll(value, "'", "''")
}

func isMySQLHexLiteral(s string) bool {
	if len(s) < 3 || !(strings.HasPrefix(s, "0x") || strings.HasPrefix(s, "0X")) {
		return false
	}
	for i := 2; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

func formatSQLValue(dbType string, v interface{}) string {
	if v == nil {
		return "NULL"
	}

	switch val := v.(type) {
	case bool:
		if isPgLikeBooleanDBType(dbType) {
			return booleanSQLLiteral(val)
		}
		if val {
			return "1"
		}
		return "0"
	case int:
		return strconv.Itoa(val)
	case int8, int16, int32, int64:
		return fmt.Sprintf("%d", val)
	case uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", val)
	case float32:
		f := float64(val)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(f, 'f', -1, 32)
	case float64:
		if math.IsNaN(val) || math.IsInf(val, 0) {
			return "NULL"
		}
		return strconv.FormatFloat(val, 'f', -1, 64)
	case json.Number:
		literal := strings.TrimSpace(val.String())
		if !jsonNumberSQLLiteralPattern.MatchString(literal) {
			return "NULL"
		}
		// JSON numbers may exceed float64 while remaining valid database numeric
		// literals. The strict token pattern above prevents SQL injection; let the
		// target column/driver decide its actual numeric range instead of silently
		// replacing a valid value with NULL.
		return literal
	case time.Time:
		return "'" + val.Format("2006-01-02 15:04:05") + "'"
	case string:
		normalizedType := strings.ToLower(strings.TrimSpace(dbType))
		if (normalizedType == "mysql" || normalizedType == "oceanbase" || normalizedType == "diros" || normalizedType == "starrocks") && isMySQLHexLiteral(val) {
			return val
		}
		return "'" + escapeSQLStringLiteralBody(dbType, val) + "'"
	default:
		return "'" + escapeSQLStringLiteralBody(dbType, fmt.Sprintf("%v", v)) + "'"
	}
}

func dumpTableSQL(
	exportCtx context.Context,
	w *bufio.Writer,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName,
	tableName string,
	includeSchema bool,
	includeData bool,
	viewLookup map[string]string,
) error {
	return dumpTableSQLWithDatabaseContext(
		exportCtx,
		w,
		dbInst,
		config,
		dbName,
		tableName,
		includeSchema,
		includeData,
		viewLookup,
		true,
	)
}

func dumpTableSQLWithDatabaseContext(
	exportCtx context.Context,
	w *bufio.Writer,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName,
	tableName string,
	includeSchema bool,
	includeData bool,
	viewLookup map[string]string,
	includeDatabaseContext bool,
) error {
	dbType := resolveDDLDBType(config)
	metadataSchemaName, metadataTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	ddlSchemaName, ddlTableName := normalizeSchemaAndTableByType(dbType, dbName, tableName)
	objectKey := normalizeExportObjectKey(config, dbName, tableName)
	_, isView := viewLookup[objectKey]
	var createSQL string

	if includeSchema {
		if isView {
			viewDDL, ok := tryGetViewCreateStatement(exportCtx, dbInst, config, dbName, metadataSchemaName, metadataTableName)
			if ok {
				createSQL = viewDDL
			} else {
				ddl, err := dbInst.GetCreateStatement(metadataSchemaName, metadataTableName)
				if err != nil {
					return err
				}
				createSQL = ddl
			}
		} else {
			ddl, err := resolveCreateStatementWithFallback(dbInst, config, dbName, tableName)
			if err != nil {
				if viewDDL, ok := tryGetViewCreateStatement(exportCtx, dbInst, config, dbName, metadataSchemaName, metadataTableName); ok {
					createSQL = viewDDL
					isView = true
				} else {
					return err
				}
			} else {
				createSQL = ddl
			}
		}
	}

	if includeData && !includeSchema && !isView {
		if _, ok := tryGetViewCreateStatement(exportCtx, dbInst, config, dbName, metadataSchemaName, metadataTableName); ok {
			isView = true
		}
	}

	objectLabel := "Table"
	if isView {
		objectLabel = "View"
	}

	if _, err := w.WriteString("\n-- ----------------------------\n"); err != nil {
		return err
	}
	if _, err := w.WriteString(fmt.Sprintf("-- %s: %s\n", objectLabel, qualifyTable(ddlSchemaName, ddlTableName))); err != nil {
		return err
	}
	if _, err := w.WriteString("-- ----------------------------\n\n"); err != nil {
		return err
	}

	if includeSchema {
		if _, err := w.WriteString(ensureSQLTerminator(createSQL)); err != nil {
			return err
		}
		if _, err := w.WriteString("\n\n"); err != nil {
			return err
		}
	}

	if !includeData {
		return nil
	}

	if isView {
		if _, err := w.WriteString("-- View data export skipped (INSERT for views is not emitted).\n"); err != nil {
			return err
		}
		return nil
	}

	selectSQL := fmt.Sprintf("SELECT * FROM %s", quoteTableIdentByType(dbType, ddlSchemaName, ddlTableName))
	outputTableName := quoteTableIdentByType(dbType, ddlSchemaName, ddlTableName)
	if supportsMySQLDatabaseContext(config) && !includeDatabaseContext {
		outputTableName = quoteIdentByType(dbType, ddlTableName)
	}
	columnTypeMap := map[string]string{}
	if defs, colErr := dbInst.GetColumns(metadataSchemaName, metadataTableName); colErr == nil {
		columnTypeMap = buildImportColumnTypeMap(defs)
	}
	insertConsumer := &sqlInsertExportConsumer{
		w:             w,
		dbType:        dbType,
		quotedTable:   outputTableName,
		columnTypeMap: columnTypeMap,
	}
	if err := streamQueryDataForExportWithContext(exportCtx, dbInst, config, selectSQL, insertConsumer); err != nil {
		if flushErr := insertConsumer.Flush(); flushErr != nil {
			return flushErr
		}
		return err
	}
	if err := insertConsumer.Flush(); err != nil {
		return err
	}
	if insertConsumer.rowCount == 0 {
		if _, err := w.WriteString("-- (0 rows)\n"); err != nil {
			return err
		}
		return nil
	}

	return nil
}
