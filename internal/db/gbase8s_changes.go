//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (g *GBase8sDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return g.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 在一个事务里依次执行删除、修改、新增（参数绑定）；修改与删除必须恰好命中一行，否则整体回滚。
func (g *GBase8sDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if g.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	table := gbase8sQuoteIdent(strings.Trim(strings.TrimSpace(tableName), `"`))
	booleans := g.booleanColumns(strings.Trim(strings.TrimSpace(tableName), `"`))
	writeValue := func(column string, value interface{}) interface{} {
		if booleans[strings.ToLower(column)] {
			return gbase8sBooleanValue(value)
		}
		return gbase8sWriteValue(value)
	}
	tx, err := g.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, committed, &err) }()

	exec := func(query string, args []interface{}, expectOne bool) error {
		result, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, err)
		}
		if expectOne {
			if affected, affectedErr := result.RowsAffected(); affectedErr == nil && affected != 1 {
				return localizedDatabaseRuntimeError("db.backend.error.gbase8s_rows_mismatch", map[string]any{"actual": affected})
			}
		}
		return nil
	}
	for _, keys := range changes.Deletes {
		where, args := gbase8sWhere(keys)
		if where == "" {
			continue
		}
		if err := exec("DELETE FROM "+table+" WHERE "+where, args, true); err != nil {
			return err
		}
	}
	for _, update := range changes.Updates {
		if len(update.Values) == 0 {
			continue
		}
		where, whereArgs := gbase8sWhere(update.Keys)
		if where == "" {
			return localizedDatabaseRuntimeError("db.backend.error.gbase8s_update_requires_key", nil)
		}
		columns := gbase8sSortedKeys(update.Values)
		sets := make([]string, len(columns))
		args := make([]interface{}, 0, len(columns)+len(whereArgs))
		for i, column := range columns {
			sets[i] = gbase8sQuoteIdent(column) + " = ?"
			args = append(args, writeValue(column, update.Values[column]))
		}
		if err := exec("UPDATE "+table+" SET "+strings.Join(sets, ", ")+" WHERE "+where, append(args, whereArgs...), true); err != nil {
			return err
		}
	}
	for _, row := range changes.Inserts {
		if len(row) == 0 {
			continue
		}
		columns := gbase8sSortedKeys(row)
		names := make([]string, len(columns))
		args := make([]interface{}, len(columns))
		for i, column := range columns {
			names[i] = gbase8sQuoteIdent(column)
			args[i] = writeValue(column, row[column])
		}
		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(names, ", "), strings.TrimSuffix(strings.Repeat("?, ", len(columns)), ", "))
		if err := exec(query, args, false); err != nil {
			return err
		}
	}
	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	committed = true
	return nil
}

// gbase8sWhere 生成主键条件；NULL 值用 IS NULL（参数绑定的 = NULL 永远不成立）。
func gbase8sWhere(keys map[string]interface{}) (string, []interface{}) {
	columns := gbase8sSortedKeys(keys)
	parts := make([]string, 0, len(columns))
	args := make([]interface{}, 0, len(columns))
	for _, column := range columns {
		value := keys[column]
		if value == nil {
			parts = append(parts, gbase8sQuoteIdent(column)+" IS NULL")
			continue
		}
		parts = append(parts, gbase8sQuoteIdent(column)+" = ?")
		args = append(args, gbase8sWriteValue(value))
	}
	return strings.Join(parts, " AND "), args
}

func gbase8sSortedKeys(values map[string]interface{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// gbase8sWriteValue 把网格传来的 JSON 值转成可绑定的参数：对象与数组序列化成 JSON 文本。
func gbase8sWriteValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}, []interface{}:
		if data, err := json.Marshal(typed); err == nil {
			return string(data)
		}
	}
	return value
}

// booleanColumns 返回表里 BOOLEAN 列（小写列名）；读不到列信息时返回空集合，值原样绑定。
func (g *GBase8sDB) booleanColumns(tableName string) map[string]bool {
	result := map[string]bool{}
	columns, err := g.GetColumns("", tableName)
	if err != nil {
		return result
	}
	for _, column := range columns {
		if strings.EqualFold(strings.TrimSpace(column.Type), "BOOLEAN") {
			result[strings.ToLower(strings.TrimSpace(column.Name))] = true
		}
	}
	return result
}

// gbase8sBooleanValue 把布尔值写成 GBase 8s 认识的 't' / 'f'：BOOLEAN 列不接受 true / false / 1 / 0 文本
// （导入的 CSV、网格编辑传来的都是文本），识别不了的值原样绑定，由服务端报错。
func gbase8sBooleanValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case nil:
		return nil
	case bool:
		if typed {
			return "t"
		}
		return "f"
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "t", "1", "yes", "y":
			return "t"
		case "false", "f", "0", "no", "n":
			return "f"
		case "":
			return nil
		}
	case int, int64, int32, float64:
		if fmt.Sprint(typed) == "0" {
			return "f"
		}
		return "t"
	}
	return value
}
