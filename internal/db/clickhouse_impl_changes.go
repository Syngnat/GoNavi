//go:build gonavi_full_drivers || gonavi_clickhouse_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
)

func (c *ClickHouseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return c.ApplyChangesContext(context.Background(), tableName, changes)
}

func (c *ClickHouseDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if c.conn == nil && c.legacyHTTP == nil {
		return fmt.Errorf("连接未打开")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	database, table, err := c.resolveDatabaseAndTable(c.database, tableName)
	if err != nil {
		return err
	}
	qualifiedTable := fmt.Sprintf("%s.%s", quoteClickHouseIdentifier(database), quoteClickHouseIdentifier(table))
	return applyClickHouseChangesContext(ctx, qualifiedTable, changes, c.ExecContext)
}

func applyClickHouseChangesContext(
	ctx context.Context,
	qualifiedTable string,
	changes connection.ChangeSet,
	exec func(context.Context, string) (int64, error),
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if exec == nil {
		return fmt.Errorf("连接未打开")
	}
	writeApplied := false

	for _, pk := range changes.Deletes {
		whereExpr := buildClickHouseWhereClause(pk)
		if whereExpr == "" {
			continue
		}
		query := fmt.Sprintf("ALTER TABLE %s DELETE WHERE %s", qualifiedTable, whereExpr)
		if err := clickHouseWritePreflightError(ctx, writeApplied); err != nil {
			return err
		}
		if _, err := exec(ctx, query); err != nil {
			resultErr := localizedDatabaseRuntimeError("db.backend.error.clickhouse_delete_failed_with_sql", map[string]any{
				"detail": err.Error(),
				"sql":    query,
			})
			return classifyClickHouseWriteError(ctx, preserveClickHouseWriteCause(resultErr, err), writeApplied)
		}
		writeApplied = true
	}

	for _, update := range changes.Updates {
		setExpr := buildClickHouseAssignments(update.Values)
		whereExpr := buildClickHouseWhereClause(update.Keys)
		if setExpr == "" || whereExpr == "" {
			continue
		}
		query := fmt.Sprintf("ALTER TABLE %s UPDATE %s WHERE %s", qualifiedTable, setExpr, whereExpr)
		if err := clickHouseWritePreflightError(ctx, writeApplied); err != nil {
			return err
		}
		if _, err := exec(ctx, query); err != nil {
			resultErr := localizedDatabaseRuntimeError("db.backend.error.clickhouse_update_failed_with_sql", map[string]any{
				"detail": err.Error(),
				"sql":    query,
			})
			return classifyClickHouseWriteError(ctx, preserveClickHouseWriteCause(resultErr, err), writeApplied)
		}
		writeApplied = true
	}

	if err := execClickHouseInsertBatchesContext(ctx, exec, qualifiedTable, changes.Inserts, &writeApplied); err != nil {
		return err
	}
	return nil
}

func execClickHouseInsertBatches(exec func(string) (int64, error), qualifiedTable string, rows []map[string]interface{}) error {
	if exec == nil {
		return fmt.Errorf("连接未打开")
	}
	writeApplied := false
	return execClickHouseInsertBatchesContext(context.Background(), func(_ context.Context, query string) (int64, error) {
		return exec(query)
	}, qualifiedTable, rows, &writeApplied)
}

func execClickHouseInsertBatchesContext(
	ctx context.Context,
	exec func(context.Context, string) (int64, error),
	qualifiedTable string,
	rows []map[string]interface{},
	writeApplied *bool,
) error {
	if exec == nil {
		return fmt.Errorf("连接未打开")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if writeApplied == nil {
		writeApplied = new(bool)
	}

	var preflightErr error
	var execCause error
	err := execLiteralInsertBatches(literalInsertConfig{
		Table:       qualifiedTable,
		Rows:        rows,
		QuoteColumn: quoteClickHouseIdentifier,
		Literal:     clickHouseLiteral,
		Exec: func(query string) (sql.Result, error) {
			if err := clickHouseWritePreflightError(ctx, *writeApplied); err != nil {
				preflightErr = err
				return nil, errClickHouseWritePreflightStopped
			}
			affected, err := exec(ctx, query)
			if err != nil {
				execCause = err
				return nil, err
			}
			*writeApplied = true
			return driver.RowsAffected(affected), nil
		},
	})
	if preflightErr != nil {
		return preflightErr
	}
	if err == nil {
		return nil
	}
	if execCause != nil {
		err = preserveClickHouseWriteCause(err, execCause)
	}
	return classifyClickHouseWriteError(ctx, err, *writeApplied)
}

func clickHouseWritePreflightError(ctx context.Context, writeApplied bool) error {
	if ctx == nil {
		return nil
	}
	if err := ctx.Err(); err != nil {
		if writeApplied {
			return MarkWriteOutcomeUnknown(err)
		}
		return err
	}
	return nil
}

func classifyClickHouseWriteError(ctx context.Context, err error, writeApplied bool) error {
	if err == nil || IsWriteOutcomeUnknown(err) {
		return err
	}
	if writeApplied || IsAmbiguousWriteResponse(err) || (ctx != nil && ctx.Err() != nil) {
		return MarkWriteOutcomeUnknown(err)
	}
	return err
}

func buildClickHouseInsertSQL(qualifiedTable string, row map[string]interface{}) (string, error) {
	if len(row) == 0 {
		return "", nil
	}
	cols := make([]string, 0, len(row))
	for k := range row {
		if strings.TrimSpace(k) == "" {
			continue
		}
		cols = append(cols, k)
	}
	if len(cols) == 0 {
		return "", nil
	}
	sort.Strings(cols)
	quotedCols := make([]string, 0, len(cols))
	values := make([]string, 0, len(cols))
	for _, col := range cols {
		quotedCols = append(quotedCols, quoteClickHouseIdentifier(col))
		values = append(values, clickHouseLiteral(row[col]))
	}
	return fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", qualifiedTable, strings.Join(quotedCols, ", "), strings.Join(values, ", ")), nil
}

func buildClickHouseAssignments(values map[string]interface{}) string {
	if len(values) == 0 {
		return ""
	}
	cols := make([]string, 0, len(values))
	for k := range values {
		if strings.TrimSpace(k) == "" {
			continue
		}
		cols = append(cols, k)
	}
	sort.Strings(cols)
	parts := make([]string, 0, len(cols))
	for _, col := range cols {
		parts = append(parts, fmt.Sprintf("%s = %s", quoteClickHouseIdentifier(col), clickHouseLiteral(values[col])))
	}
	return strings.Join(parts, ", ")
}

func buildClickHouseWhereClause(keys map[string]interface{}) string {
	if len(keys) == 0 {
		return ""
	}
	cols := make([]string, 0, len(keys))
	for k := range keys {
		if strings.TrimSpace(k) == "" {
			continue
		}
		cols = append(cols, k)
	}
	sort.Strings(cols)
	parts := make([]string, 0, len(cols))
	for _, col := range cols {
		parts = append(parts, fmt.Sprintf("%s = %s", quoteClickHouseIdentifier(col), clickHouseLiteral(keys[col])))
	}
	return strings.Join(parts, " AND ")
}

func clickHouseLiteral(value interface{}) string {
	switch val := value.(type) {
	case nil:
		return "NULL"
	case bool:
		if val {
			return "1"
		}
		return "0"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		return fmt.Sprintf("%v", val)
	case time.Time:
		return fmt.Sprintf("'%s'", val.Format("2006-01-02 15:04:05"))
	case []byte:
		return fmt.Sprintf("'%s'", strings.ReplaceAll(string(val), "'", "''"))
	default:
		return fmt.Sprintf("'%s'", strings.ReplaceAll(fmt.Sprintf("%v", val), "'", "''"))
	}
}
