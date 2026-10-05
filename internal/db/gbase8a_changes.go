//go:build gonavi_full_drivers || gonavi_gbase8a_driver

package db

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"

	"github.com/go-sql-driver/mysql"
)

// GBase 8a 的事务里，同一张表执行过 UPDATE / DELETE 之后不能再有任何写入，INSERT 之后也不能再 UPDATE / DELETE
// （服务端报 1015 Can't lock table），只有多条 INSERT 可以连续执行。网格提交因此把同类改动合成一条语句：
// 多行删除合成一条 DELETE，多行修改合成一条带 CASE 的 UPDATE；新增、修改、删除混在一起时无法在一个事务里完成，
// 提示分开提交，而不是拆成多个事务牺牲原子性。

const (
	gbase8aErrCantLockTable = 1015
	// gbase8aMaxPlaceholders 留出余量的预处理语句占位符上限（MySQL 协议最多 65535 个）。
	gbase8aMaxPlaceholders = 60000
)

func (g *GBase8aDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return g.ApplyChangesContext(context.Background(), tableName, changes)
}

func (g *GBase8aDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	kinds := 0
	for _, count := range []int{len(changes.Inserts), len(changes.Updates), len(changes.Deletes)} {
		if count > 0 {
			kinds++
		}
	}
	switch {
	case kinds == 0:
		return nil
	case kinds > 1:
		return localizedDatabaseRuntimeError("db.backend.error.gbase8a_mixed_changes", nil)
	case len(changes.Inserts) > 0:
		return g.MySQLDB.ApplyChangesContext(ctx, tableName, changes)
	}
	if g.conn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	columnTypeMap := g.loadColumnTypeMapContext(ctx, tableName)
	var (
		query    string
		args     []interface{}
		expected int
	)
	if len(changes.Deletes) > 0 {
		query, args = buildGBase8aDelete(tableName, changes.Deletes, columnTypeMap)
		expected = len(changes.Deletes)
	} else {
		if query, args, err = buildGBase8aUpdate(tableName, changes.Updates, columnTypeMap); err != nil {
			return err
		}
		expected = len(changes.Updates)
	}
	tx, err := g.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, committed, &err) }()
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return markWriteOutcomeUnknownIfAmbiguous(ctx, gbase8aWriteError(err))
	}
	if affected, affectedErr := result.RowsAffected(); affectedErr == nil && affected != int64(expected) {
		return localizedDatabaseRuntimeError("db.backend.error.gbase8a_rows_mismatch", map[string]any{"expected": expected, "actual": affected})
	}
	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	committed = true
	return nil
}

// gbase8aRowCondition 生成一行的主键条件（列按名称排序，参数与占位符一一对应）。
func gbase8aRowCondition(keys map[string]interface{}, columnTypeMap map[string]string) (string, []interface{}) {
	names := make([]string, 0, len(keys))
	for name := range keys {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	args := make([]interface{}, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("`%s` = ?", escapeMySQLBacktickIdent(name)))
		args = append(args, normalizeMySQLValueForWrite(name, keys[name], columnTypeMap))
	}
	return "(" + strings.Join(parts, " AND ") + ")", args
}

func buildGBase8aDelete(tableName string, rows []map[string]interface{}, columnTypeMap map[string]string) (string, []interface{}) {
	conditions := make([]string, 0, len(rows))
	var args []interface{}
	for _, row := range rows {
		condition, conditionArgs := gbase8aRowCondition(row, columnTypeMap)
		conditions = append(conditions, condition)
		args = append(args, conditionArgs...)
	}
	return fmt.Sprintf("DELETE FROM `%s` WHERE %s", escapeMySQLBacktickIdent(tableName), strings.Join(conditions, " OR ")), args
}

// buildGBase8aUpdate 把多行修改合成一条 UPDATE：每个被修改的列写成 CASE WHEN 行条件 THEN 新值 … ELSE 原值 END。
func buildGBase8aUpdate(tableName string, updates []connection.UpdateRow, columnTypeMap map[string]string) (string, []interface{}, error) {
	conditions := make([]string, len(updates))
	conditionArgs := make([][]interface{}, len(updates))
	columnSet := map[string]struct{}{}
	for i, update := range updates {
		if len(update.Keys) == 0 {
			return "", nil, localizedDatabaseRuntimeError("db.backend.error.gbase8a_update_requires_key", nil)
		}
		conditions[i], conditionArgs[i] = gbase8aRowCondition(update.Keys, columnTypeMap)
		for column := range update.Values {
			columnSet[column] = struct{}{}
		}
	}
	columns := make([]string, 0, len(columnSet))
	for column := range columnSet {
		columns = append(columns, column)
	}
	sort.Strings(columns)
	var args []interface{}
	sets := make([]string, 0, len(columns))
	for _, column := range columns {
		quoted := fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(column))
		var cases strings.Builder
		for i, update := range updates {
			value, ok := update.Values[column]
			if !ok {
				continue
			}
			cases.WriteString(" WHEN " + conditions[i] + " THEN ?")
			args = append(args, conditionArgs[i]...)
			args = append(args, normalizeMySQLValueForWrite(column, value, columnTypeMap))
		}
		sets = append(sets, fmt.Sprintf("%s = CASE%s ELSE %s END", quoted, cases.String(), quoted))
	}
	for i := range updates {
		args = append(args, conditionArgs[i]...)
	}
	if len(args) > gbase8aMaxPlaceholders {
		return "", nil, localizedDatabaseRuntimeError("db.backend.error.gbase8a_update_too_large", map[string]any{"rows": len(updates)})
	}
	query := fmt.Sprintf("UPDATE `%s` SET %s WHERE %s", escapeMySQLBacktickIdent(tableName), strings.Join(sets, ", "), strings.Join(conditions, " OR "))
	return query, args, nil
}

// gbase8aWriteError 给事务内的 1015 Can't lock table 补充原因说明。
func gbase8aWriteError(err error) error {
	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) && mysqlErr.Number == gbase8aErrCantLockTable {
		return localizedDatabaseRuntimeError("db.backend.error.gbase8a_table_locked_in_transaction", map[string]any{"detail": err.Error()})
	}
	return err
}

// gbase8aTransaction 是托管事务句柄：沿用通用实现，只给语句错误补充 GBase 8a 的事务限制说明。
type gbase8aTransaction struct {
	*sqlTxStatementExecer
}

func (t gbase8aTransaction) ExecContext(ctx context.Context, query string) (int64, error) {
	affected, err := t.sqlTxStatementExecer.ExecContext(ctx, query)
	return affected, gbase8aWriteError(err)
}

func (t gbase8aTransaction) Exec(query string) (int64, error) {
	return t.ExecContext(context.Background(), query)
}

func (t gbase8aTransaction) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	rows, columns, err := t.sqlTxStatementExecer.QueryContext(ctx, query)
	return rows, columns, gbase8aWriteError(err)
}

func (t gbase8aTransaction) Query(query string) ([]map[string]interface{}, []string, error) {
	return t.QueryContext(context.Background(), query)
}

func (t gbase8aTransaction) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	results, err := t.sqlTxStatementExecer.QueryMultiContext(ctx, query)
	return results, gbase8aWriteError(err)
}

func (t gbase8aTransaction) QueryMulti(query string) ([]connection.ResultSetData, error) {
	return t.QueryMultiContext(context.Background(), query)
}
