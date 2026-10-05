//go:build gonavi_full_drivers || gonavi_firebird_driver

package db

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (f *FirebirdDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return f.ApplyChangesContext(context.Background(), tableName, changes)
}

// ApplyChangesContext 在一个事务里依次执行删除、修改、新增（? 参数绑定）；修改与删除必须恰好命中一行，否则整体回滚。
// 主键值为 NULL 时用 IS NULL 匹配。
func (f *FirebirdDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if f.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	table := firebirdQuoteIdent(f.relationName(tableName))
	tx, err := f.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, committed, &err) }()

	exec := func(query string, args []interface{}, action rowMutationAction, expectOne bool) error {
		result, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, err)
		}
		if expectOne {
			return requireSingleRowAffected(result, action)
		}
		return nil
	}
	for _, keys := range changes.Deletes {
		where, args := firebirdWhere(keys)
		if where == "" {
			continue
		}
		if err := exec("DELETE FROM "+table+" WHERE "+where, args, rowMutationActionDelete, true); err != nil {
			return err
		}
	}
	for _, update := range changes.Updates {
		if len(update.Values) == 0 {
			continue
		}
		where, whereArgs := firebirdWhere(update.Keys)
		if where == "" {
			return localizedDatabaseRuntimeError("db.backend.error.grid_update_requires_key", nil)
		}
		columns := firebirdSortedKeys(update.Values)
		sets := make([]string, len(columns))
		args := make([]interface{}, 0, len(columns)+len(whereArgs))
		for i, column := range columns {
			sets[i] = firebirdQuoteIdent(column) + " = ?"
			args = append(args, firebirdWriteValue(update.Values[column]))
		}
		query := "UPDATE " + table + " SET " + strings.Join(sets, ", ") + " WHERE " + where
		if err := exec(query, append(args, whereArgs...), rowMutationActionUpdate, true); err != nil {
			return err
		}
	}
	for _, row := range changes.Inserts {
		if len(row) == 0 {
			continue
		}
		columns := firebirdSortedKeys(row)
		names := make([]string, len(columns))
		args := make([]interface{}, len(columns))
		for i, column := range columns {
			names[i] = firebirdQuoteIdent(column)
			args[i] = firebirdWriteValue(row[column])
		}
		query := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(names, ", "), strings.TrimSuffix(strings.Repeat("?, ", len(columns)), ", "))
		if err := exec(query, args, "", false); err != nil {
			return err
		}
	}
	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	committed = true
	return nil
}

// firebirdWhere 生成定位条件；NULL 值用 IS NULL（参数绑定的 = NULL 永远不成立）。
func firebirdWhere(keys map[string]interface{}) (string, []interface{}) {
	columns := firebirdSortedKeys(keys)
	parts := make([]string, 0, len(columns))
	args := make([]interface{}, 0, len(columns))
	for _, column := range columns {
		value := keys[column]
		if value == nil {
			parts = append(parts, firebirdQuoteIdent(column)+" IS NULL")
			continue
		}
		parts = append(parts, firebirdQuoteIdent(column)+" = ?")
		args = append(args, firebirdWriteValue(value))
	}
	return strings.Join(parts, " AND "), args
}

func firebirdSortedKeys(values map[string]interface{}) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// firebirdWriteValue 把网格传来的 JSON 值转成可绑定的参数：对象与数组序列化成 JSON 文本。
func firebirdWriteValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case map[string]interface{}, []interface{}:
		if data, err := json.Marshal(typed); err == nil {
			return string(data)
		}
	}
	return value
}
