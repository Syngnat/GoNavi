package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (o *OracleDB) loadColumnTypeMap(tableName string) (map[string]string, error) {
	result := map[string]string{}
	schema, table := splitOracleQualifiedTableName(tableName)
	if table == "" {
		return result, nil
	}

	columns, err := o.GetColumns(schema, table)
	if err != nil {
		return nil, oracleRuntimeError("db.backend.error.oracle_column_metadata_load_failed", map[string]any{
			"table":  tableName,
			"detail": err.Error(),
		})
	}

	for _, col := range columns {
		name := strings.ToLower(strings.TrimSpace(col.Name))
		if name == "" {
			continue
		}
		result[name] = strings.TrimSpace(col.Type)
	}
	return result, nil
}

func normalizeOracleValueForWrite(columnName string, value interface{}, columnTypeMap map[string]string) interface{} {
	columnType := columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]
	if !isOracleTemporalColumnType(columnType) {
		return value
	}
	if value == nil {
		return nil
	}
	text, ok := value.(string)
	if !ok {
		return value
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return nil
	}
	if parsed, ok := parseOracleTemporalString(raw); ok {
		return parsed
	}
	return value
}

func isOracleTemporalColumnType(columnType string) bool {
	typ := strings.ToUpper(strings.TrimSpace(columnType))
	return strings.Contains(typ, "DATE") || strings.Contains(typ, "TIMESTAMP")
}

func parseOracleTemporalString(raw string) (time.Time, bool) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return time.Time{}, false
	}
	text = strings.ReplaceAll(text, "+ ", "+")
	text = strings.ReplaceAll(text, "- ", "-")

	candidates := []string{text}
	if len(text) >= 19 && text[10] == ' ' && (strings.HasSuffix(text, "Z") || hasTimezoneOffset(text)) {
		candidates = append(candidates, strings.Replace(text, " ", "T", 1))
	}

	layoutsWithZone := []string{
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700",
		"2006-01-02 15:04:05 -0700",
		time.RFC3339Nano,
		time.RFC3339,
	}
	for _, candidate := range candidates {
		for _, layout := range layoutsWithZone {
			if parsed, err := time.Parse(layout, candidate); err == nil {
				return parsed, true
			}
		}
	}

	layoutsWithoutZone := []string{
		"2006-01-02T15:04:05.999999999",
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05.999999999",
		"2006-01-02 15:04:05",
		"2006-01-02",
	}
	for _, layout := range layoutsWithoutZone {
		if parsed, err := time.ParseInLocation(layout, text, time.Local); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func (o *OracleDB) ApplyChanges(tableName string, changes connection.ChangeSet) (err error) {
	return o.ApplyChangesContext(context.Background(), tableName, changes)
}

func (o *OracleDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if o.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	columnTypeMap, err := o.loadColumnTypeMap(tableName)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	conn, err := o.conn.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if conn == nil {
			return
		}
		if closeErr := conn.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()

	transactionFinished := false
	defer func() {
		if transactionFinished {
			return
		}
		rollbackCtx, cancelRollback := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelRollback()
		if _, rollbackErr := conn.ExecContext(rollbackCtx, "ROLLBACK"); rollbackErr != nil {
			logger.Warnf("Oracle 表格编辑事务回滚失败：table=%s err=%v", tableName, rollbackErr)
			unknownErr := fmt.Errorf("Oracle 事务回滚失败：%w", rollbackErr)
			if err != nil {
				unknownErr = errors.Join(err, unknownErr)
			}
			if discardErr := discardSQLConn(&conn); discardErr != nil {
				unknownErr = errors.Join(unknownErr, fmt.Errorf("Oracle 事务连接丢弃失败：%w", discardErr))
			}
			err = MarkWriteOutcomeUnknown(unknownErr)
		}
	}()

	if err := o.execOracleChanges(ctx, conn, tableName, changes, columnTypeMap); err != nil {
		return err
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return MarkWriteOutcomeUnknown(fmt.Errorf("事务提交失败：%w", err))
	}
	transactionFinished = true
	return nil
}

// oracleChangeExecer 是执行网格改动语句的连接或事务（*sql.Conn / *sql.Tx）。
type oracleChangeExecer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// execOracleChanges 按删除、更新、插入的顺序执行网格改动（:n 占位符，ROWID 定位时按 ROWID 匹配），不负责提交。
func (o *OracleDB) execOracleChanges(ctx context.Context, conn oracleChangeExecer, tableName string, changes connection.ChangeSet, columnTypeMap map[string]string) error {
	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	schema := ""
	table := strings.TrimSpace(tableName)
	if parts := strings.SplitN(table, ".", 2); len(parts) == 2 {
		schema = strings.TrimSpace(parts[0])
		table = strings.TrimSpace(parts[1])
	}

	qualifiedTable := ""
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))
	} else {
		qualifiedTable = quoteIdent(table)
	}

	isOracleRowIDLocator := strings.EqualFold(strings.TrimSpace(changes.LocatorStrategy), "oracle-rowid")
	buildWhere := func(keys map[string]interface{}, startIndex int) ([]string, []interface{}, int) {
		var wheres []string
		var args []interface{}
		idx := startIndex
		for k, v := range keys {
			idx++
			if isOracleRowIDLocator && strings.EqualFold(strings.TrimSpace(k), "ROWID") {
				wheres = append(wheres, fmt.Sprintf("ROWID = :%d", idx))
				args = append(args, v)
				continue
			}
			wheres = append(wheres, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, normalizeOracleValueForWrite(k, v, columnTypeMap))
		}
		return wheres, args, idx
	}

	// 1. Deletes
	for _, pk := range changes.Deletes {
		wheres, args, _ := buildWhere(pk, 0)
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		res, err := conn.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = :%d", quoteIdent(k), idx))
			args = append(args, normalizeOracleValueForWrite(k, v, columnTypeMap))
		}

		if len(sets) == 0 {
			continue
		}

		wheres, whereArgs, _ := buildWhere(update.Keys, idx)
		args = append(args, whereArgs...)

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := conn.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	// 3. Inserts
	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}
		idx := 0

		for k, v := range row {
			idx++
			cols = append(cols, quoteIdent(k))
			placeholders = append(placeholders, fmt.Sprintf(":%d", idx))
			args = append(args, normalizeOracleValueForWrite(k, v, columnTypeMap))
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		res, err := conn.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("插入失败：%v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}
	return nil
}
