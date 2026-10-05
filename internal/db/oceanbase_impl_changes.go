//go:build gonavi_full_drivers || gonavi_oceanbase_driver

package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func (o *OceanBaseDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	// Oracle 协议走 OBClient 路径时，o.oracle.conn 实际上是 mysql wire 的 *sql.DB，
	// Oracle 风格 SQL（双引号引用 + ROWID）由 OceanBase 服务端按 Oracle 解析器处理，
	// 但占位符必须是 mysql 风格的 "?"，不能用 OracleDB.ApplyChanges 的 ":1" Oracle bind 风格。
	if o.protocol == oceanBaseProtocolOracle && o.oracle != nil {
		return o.applyOracleChangesMySQLWireContext(ctx, tableName, changes)
	}
	if applier, ok := o.activeDatabase().(BatchApplierContext); ok {
		return applier.ApplyChangesContext(ctx, tableName, changes)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if applier, ok := o.activeDatabase().(BatchApplier); ok {
		return applier.ApplyChanges(tableName, changes)
	}
	return fmt.Errorf("当前 OceanBase %s 协议不支持 ApplyChanges", o.protocol)
}

func buildOceanBaseOracleTemporalBind(columnType string, value interface{}) (string, interface{}, bool) {
	if value == nil {
		return "?", nil, false
	}

	rawType := strings.ToUpper(strings.TrimSpace(columnType))
	if !isOracleTemporalColumnType(rawType) {
		return "?", value, false
	}

	var parsed time.Time
	switch typed := value.(type) {
	case time.Time:
		parsed = typed
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return "?", nil, false
		}
		var ok bool
		parsed, ok = parseOracleTemporalString(text)
		if !ok {
			return "?", value, false
		}
	default:
		return "?", value, false
	}

	if strings.Contains(rawType, "TIMESTAMP") {
		text := parsed.Format("2006-01-02 15:04:05")
		format := "YYYY-MM-DD HH24:MI:SS"
		if parsed.Nanosecond() != 0 {
			text = parsed.Format("2006-01-02 15:04:05.999999999")
			text = strings.TrimRight(strings.TrimRight(text, "0"), ".")
			format = "YYYY-MM-DD HH24:MI:SS.FF"
		}
		return fmt.Sprintf("TO_TIMESTAMP(?, '%s')", format), text, true
	}

	if parsed.Hour() == 0 && parsed.Minute() == 0 && parsed.Second() == 0 && parsed.Nanosecond() == 0 {
		return "TO_DATE(?, 'YYYY-MM-DD')", parsed.Format("2006-01-02"), true
	}
	return "TO_DATE(?, 'YYYY-MM-DD HH24:MI:SS')", parsed.Format("2006-01-02 15:04:05"), true
}

func buildOceanBaseOracleAssignment(columnName string, value interface{}, columnTypeMap map[string]string) (string, []interface{}) {
	columnType := columnTypeMap[strings.ToLower(strings.TrimSpace(columnName))]
	normalized := normalizeOracleValueForWrite(columnName, value, columnTypeMap)
	if expr, bind, ok := buildOceanBaseOracleTemporalBind(columnType, normalized); ok {
		return expr, []interface{}{bind}
	}
	return "?", []interface{}{normalized}
}

// applyOracleChangesMySQLWire 在 OceanBase Oracle 租户的 mysql wire 连接上执行
// DELETE/UPDATE/INSERT，使用 Oracle 风格双引号引用标识符 + mysql wire 风格 "?" 占位符。
func (o *OceanBaseDB) applyOracleChangesMySQLWire(tableName string, changes connection.ChangeSet) error {
	return o.applyOracleChangesMySQLWireContext(context.Background(), tableName, changes)
}

func (o *OceanBaseDB) applyOracleChangesMySQLWireContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if o.oracle == nil || o.oracle.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	columnTypeMap, err := o.oracle.loadColumnTypeMap(tableName)
	if err != nil {
		return fmt.Errorf("OceanBase Oracle 租户 %w", err)
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	tx, err := o.oracle.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

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
	buildWhere := func(keys map[string]interface{}) ([]string, []interface{}) {
		var wheres []string
		var args []interface{}
		for k, v := range keys {
			if isOracleRowIDLocator && strings.EqualFold(strings.TrimSpace(k), "ROWID") {
				wheres = append(wheres, "ROWID = ?")
				args = append(args, v)
				continue
			}
			valueExpr, valueArgs := buildOceanBaseOracleAssignment(k, v, columnTypeMap)
			wheres = append(wheres, fmt.Sprintf("%s = %s", quoteIdent(k), valueExpr))
			args = append(args, valueArgs...)
		}
		return wheres, args
	}

	for _, pk := range changes.Deletes {
		wheres, args := buildWhere(pk)
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			valueExpr, valueArgs := buildOceanBaseOracleAssignment(k, v, columnTypeMap)
			sets = append(sets, fmt.Sprintf("%s = %s", quoteIdent(k), valueExpr))
			args = append(args, valueArgs...)
		}

		if len(sets) == 0 {
			continue
		}

		wheres, whereArgs := buildWhere(update.Keys)
		args = append(args, whereArgs...)

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	for _, row := range changes.Inserts {
		var cols []string
		var placeholders []string
		var args []interface{}

		for k, v := range row {
			cols = append(cols, quoteIdent(k))
			valueExpr, valueArgs := buildOceanBaseOracleAssignment(k, v, columnTypeMap)
			placeholders = append(placeholders, valueExpr)
			args = append(args, valueArgs...)
		}

		if len(cols) == 0 {
			continue
		}

		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(cols, ", "), strings.Join(placeholders, ", "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("插入失败：%v", err)
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}
