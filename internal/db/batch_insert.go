package db

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
)

const (
	defaultBatchInsertRows   = 1000
	defaultBatchInsertArgs   = 60000
	sqlServerBatchInsertArgs = 2000
	sqliteBatchInsertArgs    = 900
)

type preparedInsertRow struct {
	columns []string
	values  []interface{}
}

type parameterizedInsertConfig struct {
	Table           string
	Rows            []map[string]interface{}
	QuoteColumn     func(string) string
	Placeholder     func(int) string
	Value           func(string, interface{}) (interface{}, bool)
	Arg             func(int, string, interface{}) interface{}
	Exec            func(string, ...interface{}) (sql.Result, error)
	MaxRows         int
	MaxArgs         int
	EmptyInsertSQL  func(string) string
	RequireAffected bool
}

func execParameterizedInsertBatches(config parameterizedInsertConfig) error {
	if len(config.Rows) == 0 {
		return nil
	}
	if strings.TrimSpace(config.Table) == "" {
		return localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	if config.QuoteColumn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_quote_column_required", nil)
	}
	if config.Placeholder == nil {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_placeholder_required", nil)
	}
	if config.Exec == nil {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_exec_required", nil)
	}
	if config.Value == nil {
		config.Value = func(_ string, value interface{}) (interface{}, bool) { return value, false }
	}
	if config.Arg == nil {
		config.Arg = func(_ int, _ string, value interface{}) interface{} { return value }
	}

	groups, order := groupPreparedInsertRows(config.Rows, config.Value)
	for _, key := range order {
		rows := groups[key]
		if len(rows) == 0 {
			continue
		}
		columnCount := len(rows[0].columns)
		if columnCount == 0 {
			if config.EmptyInsertSQL == nil {
				continue
			}
			for range rows {
				res, err := config.Exec(config.EmptyInsertSQL(config.Table))
				if err != nil {
					return localizedDatabaseRuntimeError("db.backend.error.batch_insert_failed", map[string]any{"detail": err.Error()})
				}
				if config.RequireAffected {
					if err := requireInsertAffected(res); err != nil {
						return err
					}
				}
			}
			continue
		}

		batchSize := batchInsertRowLimit(columnCount, config.MaxRows, config.MaxArgs)
		for start := 0; start < len(rows); start += batchSize {
			end := start + batchSize
			if end > len(rows) {
				end = len(rows)
			}
			if err := execParameterizedInsertBatch(config, rows[start:end]); err != nil {
				return err
			}
		}
	}
	return nil
}

func groupPreparedInsertRows(rows []map[string]interface{}, valueFunc func(string, interface{}) (interface{}, bool)) (map[string][]preparedInsertRow, []string) {
	groups := make(map[string][]preparedInsertRow)
	order := make([]string, 0)
	for _, row := range rows {
		prepared := prepareInsertRow(row, valueFunc)
		key := strings.Join(prepared.columns, "\x00")
		if _, ok := groups[key]; !ok {
			order = append(order, key)
		}
		groups[key] = append(groups[key], prepared)
	}
	return groups, order
}

func prepareInsertRow(row map[string]interface{}, valueFunc func(string, interface{}) (interface{}, bool)) preparedInsertRow {
	columns := make([]string, 0, len(row))
	valuesByColumn := make(map[string]interface{}, len(row))
	for key, value := range row {
		column := strings.TrimSpace(key)
		if column == "" {
			continue
		}
		nextValue, omit := valueFunc(column, value)
		if omit {
			continue
		}
		columns = append(columns, column)
		valuesByColumn[column] = nextValue
	}
	sort.Strings(columns)

	values := make([]interface{}, 0, len(columns))
	for _, column := range columns {
		values = append(values, valuesByColumn[column])
	}
	return preparedInsertRow{columns: columns, values: values}
}

func execParameterizedInsertBatch(config parameterizedInsertConfig, rows []preparedInsertRow) error {
	if len(rows) == 0 || len(rows[0].columns) == 0 {
		return nil
	}

	quotedColumns := make([]string, 0, len(rows[0].columns))
	for _, column := range rows[0].columns {
		quotedColumns = append(quotedColumns, config.QuoteColumn(column))
	}

	argIndex := 0
	valueGroups := make([]string, 0, len(rows))
	args := make([]interface{}, 0, len(rows)*len(rows[0].columns))
	for _, row := range rows {
		placeholders := make([]string, 0, len(row.columns))
		for idx, column := range row.columns {
			argIndex++
			placeholders = append(placeholders, config.Placeholder(argIndex))
			args = append(args, config.Arg(argIndex, column, row.values[idx]))
		}
		valueGroups = append(valueGroups, "("+strings.Join(placeholders, ", ")+")")
	}

	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES %s",
		config.Table,
		strings.Join(quotedColumns, ", "),
		strings.Join(valueGroups, ", "),
	)
	res, err := config.Exec(query, args...)
	if err != nil {
		if len(rows) > 1 && isPreparedStatementPlaceholderLimitError(err) {
			middle := len(rows) / 2
			if err := execParameterizedInsertBatch(config, rows[:middle]); err != nil {
				return err
			}
			return execParameterizedInsertBatch(config, rows[middle:])
		}
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_failed", map[string]any{"detail": err.Error()})
	}
	if config.RequireAffected {
		if err := requireInsertAffected(res); err != nil {
			return err
		}
	}
	return nil
}

func isPreparedStatementPlaceholderLimitError(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "prepared statement contains too many placeholders")
}

func requireInsertAffected(result sql.Result) error {
	if result == nil {
		return nil
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_no_rows_affected", nil)
	}
	return nil
}

func batchInsertRowLimit(columnCount, maxRows, maxArgs int) int {
	if maxRows <= 0 {
		maxRows = defaultBatchInsertRows
	}
	if maxArgs <= 0 {
		maxArgs = defaultBatchInsertArgs
	}
	if columnCount <= 0 {
		return 1
	}
	limitByArgs := maxArgs / columnCount
	if limitByArgs < 1 {
		return 1
	}
	if limitByArgs < maxRows {
		return limitByArgs
	}
	return maxRows
}

type literalInsertConfig struct {
	Table           string
	Rows            []map[string]interface{}
	QuoteColumn     func(string) string
	Literal         func(interface{}) string
	Exec            func(string) (sql.Result, error)
	RowSeparator    string
	MaxRows         int
	RequireAffected bool
}

func execLiteralInsertBatches(config literalInsertConfig) error {
	if len(config.Rows) == 0 {
		return nil
	}
	if strings.TrimSpace(config.Table) == "" {
		return localizedDatabaseRuntimeError("db.backend.error.table_name_required", nil)
	}
	if config.QuoteColumn == nil {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_quote_column_required", nil)
	}
	if config.Literal == nil {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_literal_required", nil)
	}
	if config.Exec == nil {
		return localizedDatabaseRuntimeError("db.backend.error.batch_insert_exec_required", nil)
	}
	if config.RowSeparator == "" {
		config.RowSeparator = ", "
	}
	if config.MaxRows <= 0 {
		config.MaxRows = defaultBatchInsertRows
	}

	groups, order := groupPreparedInsertRows(config.Rows, func(_ string, value interface{}) (interface{}, bool) { return value, false })
	for _, key := range order {
		rows := groups[key]
		if len(rows) == 0 || len(rows[0].columns) == 0 {
			continue
		}
		for start := 0; start < len(rows); start += config.MaxRows {
			end := start + config.MaxRows
			if end > len(rows) {
				end = len(rows)
			}
			if err := execLiteralInsertBatch(config, rows[start:end]); err != nil {
				return err
			}
		}
	}
	return nil
}

func execLiteralInsertBatch(config literalInsertConfig, rows []preparedInsertRow) error {
	if len(rows) == 0 || len(rows[0].columns) == 0 {
		return nil
	}

	quotedColumns := make([]string, 0, len(rows[0].columns))
	for _, column := range rows[0].columns {
		quotedColumns = append(quotedColumns, config.QuoteColumn(column))
	}

	valueGroups := make([]string, 0, len(rows))
	for _, row := range rows {
		values := make([]string, 0, len(row.values))
		for _, value := range row.values {
			values = append(values, config.Literal(value))
		}
		valueGroups = append(valueGroups, "("+strings.Join(values, ", ")+")")
	}

	query := fmt.Sprintf("INSERT INTO %s (%s) VALUES %s",
		config.Table,
		strings.Join(quotedColumns, ", "),
		strings.Join(valueGroups, config.RowSeparator),
	)
	res, err := config.Exec(query)
	if err != nil {
		resultErr := localizedDatabaseRuntimeError("db.backend.error.batch_insert_failed_with_sql", map[string]any{
			"detail": err.Error(),
			"sql":    query,
		})
		if IsAmbiguousWriteResponse(err) {
			return MarkWriteOutcomeUnknown(resultErr)
		}
		return resultErr
	}
	if config.RequireAffected {
		if err := requireInsertAffected(res); err != nil {
			return err
		}
	}
	return nil
}
