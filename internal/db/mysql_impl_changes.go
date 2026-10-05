package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (m *MySQLDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return m.ApplyChangesContext(context.Background(), tableName, changes)
}

func (m *MySQLDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if m.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	if m.navicatTunnel {
		return errors.New("Navicat HTTP 隧道不支持跨请求事务，无法保证数据网格批量修改的原子性")
	}

	columnTypeMap := m.loadColumnTypeMapContext(ctx, tableName)

	tx, err := m.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

	// 1. Deletes
	for _, pk := range changes.Deletes {
		var wheres []string
		var args []interface{}
		for k, v := range pk {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLValueForWrite(k, v, columnTypeMap))
		}
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM `%s` WHERE %s", tableName, strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("删除失败：%w", err))
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	// 2. Updates
	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}

		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLValueForWrite(k, v, columnTypeMap))
		}

		if len(sets) == 0 {
			continue
		}

		var wheres []string
		for k, v := range update.Keys {
			wheres = append(wheres, fmt.Sprintf("`%s` = ?", k))
			args = append(args, normalizeMySQLValueForWrite(k, v, columnTypeMap))
		}

		if len(wheres) == 0 {
			return fmt.Errorf("更新操作需要主键条件")
		}

		query := fmt.Sprintf("UPDATE `%s` SET %s WHERE %s", tableName, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("更新失败：%w", err))
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	if err := m.applyInsertChangesContext(ctx, tx, tableName, changes.Inserts, columnTypeMap); err != nil {
		return err
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}

func (m *MySQLDB) applyInsertChangesContext(ctx context.Context, tx *sql.Tx, tableName string, rows []map[string]interface{}, columnTypeMap map[string]string) error {
	var unknownWriteErr error
	err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table: fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(tableName)),
		Rows:  rows,
		QuoteColumn: func(column string) string {
			return fmt.Sprintf("`%s`", escapeMySQLBacktickIdent(column))
		},
		Placeholder: func(int) string { return "?" },
		Value: func(column string, value interface{}) (interface{}, bool) {
			return normalizeMySQLValueForInsert(column, value, columnTypeMap)
		},
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			result, err := tx.ExecContext(ctx, query, args...)
			err = markWriteOutcomeUnknownIfAmbiguous(ctx, err)
			if IsWriteOutcomeUnknown(err) {
				unknownWriteErr = err
			}
			return result, err
		},
		MaxRows:         defaultMySQLInsertBatchSize,
		MaxArgs:         maxMySQLInsertBatchArgs,
		RequireAffected: true,
		EmptyInsertSQL: func(table string) string {
			return fmt.Sprintf("INSERT INTO %s () VALUES ()", table)
		},
	})
	if err != nil && unknownWriteErr != nil {
		return fmt.Errorf("%s: %w", err.Error(), unknownWriteErr)
	}
	return err
}

func escapeMySQLBacktickIdent(ident string) string {
	return strings.ReplaceAll(strings.TrimSpace(ident), "`", "``")
}

func normalizeMySQLComplexValue(value interface{}) interface{} {
	switch v := value.(type) {
	case map[string]interface{}, []interface{}:
		if data, err := json.Marshal(v); err == nil {
			return string(data)
		}
		return fmt.Sprintf("%v", value)
	default:
		return value
	}
}

func normalizeMySQLDateTimeValue(value interface{}) interface{} {
	text, ok := value.(string)
	if !ok {
		return value
	}
	raw := strings.TrimSpace(text)
	if raw == "" {
		return value
	}

	cleaned := strings.ReplaceAll(raw, "+ ", "+")
	cleaned = strings.ReplaceAll(cleaned, "- ", "-")

	if len(cleaned) >= 19 && cleaned[10] == 'T' {
		if strings.HasSuffix(cleaned, "Z") || hasTimezoneOffset(cleaned) {
			if t, err := time.Parse(time.RFC3339Nano, cleaned); err == nil {
				return formatMySQLDateTime(t)
			}
			if t, err := time.Parse(time.RFC3339, cleaned); err == nil {
				return formatMySQLDateTime(t)
			}
		}
		return strings.Replace(cleaned, "T", " ", 1)
	}

	if strings.Contains(cleaned, " ") && (strings.HasSuffix(cleaned, "Z") || hasTimezoneOffset(cleaned)) {
		candidate := strings.Replace(cleaned, " ", "T", 1)
		if t, err := time.Parse(time.RFC3339Nano, candidate); err == nil {
			return formatMySQLDateTime(t)
		}
		if t, err := time.Parse(time.RFC3339, candidate); err == nil {
			return formatMySQLDateTime(t)
		}
	}

	return value
}

func (m *MySQLDB) loadColumnTypeMapContext(ctx context.Context, tableName string) map[string]string {
	result := map[string]string{}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return result
	}

	data, _, err := m.QueryContext(ctx, buildMySQLShowFullColumnsQuery("", table))
	if err != nil {
		logger.Warnf("加载列元数据失败（不影响提交）：表=%s err=%v", table, err)
		return result
	}

	for _, row := range data {
		col := buildMySQLColumnDefinition(row)
		name := strings.ToLower(strings.TrimSpace(col.Name))
		if name == "" {
			continue
		}
		result[name] = strings.TrimSpace(col.Type)
	}
	return result
}
