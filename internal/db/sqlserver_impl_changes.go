//go:build gonavi_full_drivers || gonavi_sqlserver_driver

package db

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (s *SqlServerDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return s.ApplyChangesContext(context.Background(), tableName, changes)
}

func (s *SqlServerDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if s.conn == nil {
		return fmt.Errorf("连接未打开")
	}

	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

	quoteIdent := quoteSQLServerChangeIdentifier

	schema, table := splitSQLServerTableName(tableName)

	qualifiedTable := fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		idx := 0
		for k, v := range pk {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = @p%d", quoteIdent(k), idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("删除失败：%v", err)
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		idx := 0

		for k, v := range update.Values {
			idx++
			sets = append(sets, fmt.Sprintf("%s = @p%d", quoteIdent(k), idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			idx++
			wheres = append(wheres, fmt.Sprintf("%s = @p%d", quoteIdent(k), idx))
			args = append(args, sql.Named(fmt.Sprintf("p%d", idx), v))
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return fmt.Errorf("更新失败：%v", err)
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table:       qualifiedTable,
		Rows:        changes.Inserts,
		QuoteColumn: quoteIdent,
		Placeholder: func(idx int) string {
			return fmt.Sprintf("@p%d", idx)
		},
		Arg: func(idx int, _ string, value interface{}) interface{} {
			return sql.Named(fmt.Sprintf("p%d", idx), value)
		},
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			return tx.ExecContext(ctx, query, args...)
		},
		MaxArgs: sqlServerBatchInsertArgs,
	}); err != nil {
		return err
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}
