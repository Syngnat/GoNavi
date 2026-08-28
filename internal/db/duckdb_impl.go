//go:build gonavi_full_drivers || gonavi_duckdb_driver

package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/utils"
)

type DuckDB struct {
	conn        *sql.DB
	pingTimeout time.Duration
}

func duckDBRuntimeError(key string, params map[string]any) error {
	return errors.New(localizedDriverRuntimeText(key, params))
}

func duckDBWrapRuntimeError(prefixKey string, err error) error {
	return fmt.Errorf("%s%w", localizedDriverRuntimeText(prefixKey, nil), err)
}

func duckDBConnectionNotOpenError() error {
	return duckDBRuntimeError("db.backend.error.connection_not_open", nil)
}

func duckDBTableNameRequiredError() error {
	return duckDBRuntimeError("db.backend.error.table_name_required", nil)
}

func duckDBCreateTableStatementNotFoundError() error {
	return duckDBRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func duckDBDeleteFailedError(err error) error {
	return duckDBRuntimeError("db.backend.error.row_delete_failed", map[string]any{"detail": err.Error()})
}

func duckDBUpdateKeyConditionsRequiredError() error {
	return duckDBRuntimeError("db.backend.error.row_update_key_conditions_required", nil)
}

func duckDBUpdateFailedError(err error) error {
	return duckDBRuntimeError("db.backend.error.row_update_failed", map[string]any{"detail": err.Error()})
}

func (d *DuckDB) Connect(config connection.ConnectionConfig) error {
	if supported, reason := duckDBBuildSupportStatus(); !supported {
		return duckDBRuntimeError("db.backend.error.duckdb_driver_unavailable", map[string]any{"detail": reason})
	}

	dsn := strings.TrimSpace(config.Host)
	if dsn == "" {
		dsn = strings.TrimSpace(config.Database)
	}
	if dsn == "" {
		dsn = ":memory:"
	}

	db, err := sql.Open("duckdb", dsn)
	if err != nil {
		return duckDBWrapRuntimeError("db.backend.error.connection_open_failed_prefix", err)
	}
	configureSQLConnectionPool(db, "duckdb")
	d.conn = db
	d.pingTimeout = getConnectTimeout(config)

	if err := d.Ping(); err != nil {
		_ = db.Close()
		d.conn = nil
		return duckDBWrapRuntimeError("db.backend.error.connection_verify_failed_prefix", err)
	}
	return nil
}

func (d *DuckDB) Close() error {
	if d.conn != nil {
		return d.conn.Close()
	}
	return nil
}

func (d *DuckDB) Ping() error {
	if d.conn == nil {
		return duckDBConnectionNotOpenError()
	}
	timeout := d.pingTimeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := utils.ContextWithTimeout(timeout)
	defer cancel()
	return d.conn.PingContext(ctx)
}

func (d *DuckDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, duckDBConnectionNotOpenError()
	}
	rows, err := d.conn.QueryContext(ctx, query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (d *DuckDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if d.conn == nil {
		return nil, nil, duckDBConnectionNotOpenError()
	}
	rows, err := d.conn.QueryContext(metadataContextFor(d), query)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	return scanRows(rows)
}

func (d *DuckDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if d.conn == nil {
		return 0, duckDBConnectionNotOpenError()
	}
	res, err := d.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DuckDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if d.conn == nil {
		return nil, duckDBConnectionNotOpenError()
	}
	conn, err := d.conn.Conn(ctx)
	if err != nil {
		return nil, err
	}
	return NewSQLConnStatementExecer(conn), nil
}

func (d *DuckDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if d.conn == nil {
		return 0, duckDBConnectionNotOpenError()
	}
	res, err := d.conn.ExecContext(ctx, query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DuckDB) Exec(query string) (int64, error) {
	if d.conn == nil {
		return 0, duckDBConnectionNotOpenError()
	}
	res, err := d.conn.Exec(query)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (d *DuckDB) GetDatabases() ([]string, error) {
	data, _, err := d.Query("PRAGMA database_list")
	if err != nil {
		return nil, err
	}

	seen := map[string]struct{}{}
	var names []string
	for _, row := range data {
		name := strings.TrimSpace(duckDBRowString(row, "name", "database_name", "database"))
		if name == "" {
			continue
		}
		if _, exists := seen[name]; exists {
			continue
		}
		seen[name] = struct{}{}
		names = append(names, name)
	}
	if len(names) == 0 {
		return []string{"main"}, nil
	}
	return names, nil
}

func (d *DuckDB) GetTables(dbName string) ([]string, error) {
	path := normalizeDuckDBObjectPath(dbName, "")
	query := `
SELECT table_catalog, table_schema, table_name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_catalog, table_schema, table_name`
	if path.Catalog != "" {
		query = fmt.Sprintf(`
SELECT table_catalog, table_schema, table_name
FROM information_schema.tables
WHERE table_type = 'BASE TABLE'
  AND table_schema NOT IN ('information_schema', 'pg_catalog')
  AND table_catalog = '%s'
ORDER BY table_catalog, table_schema, table_name`, escapeDuckDBLiteral(path.Catalog))
	}

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	seen := map[string]struct{}{}
	var tables []string
	for _, row := range data {
		catalog := strings.TrimSpace(duckDBRowString(row, "table_catalog", "database_name"))
		schema := strings.TrimSpace(duckDBRowString(row, "table_schema"))
		name := strings.TrimSpace(duckDBRowString(row, "table_name"))
		if name == "" {
			continue
		}
		qualified := name
		if schema != "" {
			qualified = schema + "." + name
		}
		if catalog != "" && !strings.EqualFold(catalog, "memory") && !strings.EqualFold(catalog, "main") {
			qualified = catalog + "." + qualified
		}
		if _, exists := seen[qualified]; exists {
			continue
		}
		seen[qualified] = struct{}{}
		tables = append(tables, qualified)
	}
	return tables, nil
}

func (d *DuckDB) GetCreateStatement(dbName, tableName string) (string, error) {
	path := normalizeDuckDBObjectPath(dbName, tableName)
	if path.Object == "" {
		return "", duckDBTableNameRequiredError()
	}

	for _, query := range buildDuckDBCreateStatementQueryCandidates(path) {
		data, _, err := d.Query(query)
		if err != nil || len(data) == 0 {
			continue
		}

		createSQL := strings.TrimSpace(duckDBRowString(data[0], "sql", "create_table", "Create Table", "create_statement"))
		if createSQL != "" {
			return createSQL, nil
		}
		for _, value := range data[0] {
			text := strings.TrimSpace(fmt.Sprintf("%v", value))
			if text != "" && text != "<nil>" {
				return text, nil
			}
		}
	}

	return "", duckDBCreateTableStatementNotFoundError()
}

func (d *DuckDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	path := normalizeDuckDBObjectPath(dbName, tableName)
	if path.Object == "" {
		return nil, duckDBTableNameRequiredError()
	}

	query := fmt.Sprintf(`
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '%s' AND table_schema = '%s'
ORDER BY ordinal_position`, escapeDuckDBLiteral(path.Object), escapeDuckDBLiteral(path.Schema))
	if path.Catalog != "" {
		query = fmt.Sprintf(`
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = '%s' AND table_schema = '%s' AND table_catalog = '%s'
ORDER BY ordinal_position`, escapeDuckDBLiteral(path.Object), escapeDuckDBLiteral(path.Schema), escapeDuckDBLiteral(path.Catalog))
	}

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}
	constraintQuery := buildDuckDBConstraintMetadataQuery(path, true)
	constraintRows, _, constraintErr := d.Query(constraintQuery)
	if constraintErr != nil {
		return nil, constraintErr
	}

	return buildDuckDBColumnDefinitions(data, constraintRows), nil
}

func (d *DuckDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	path := normalizeDuckDBObjectPath(dbName, "")
	query := `
SELECT table_catalog, table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_catalog, table_schema, table_name, ordinal_position`
	if path.Catalog != "" {
		query = fmt.Sprintf(`
SELECT table_catalog, table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
  AND table_catalog = '%s'
ORDER BY table_catalog, table_schema, table_name, ordinal_position`, escapeDuckDBLiteral(path.Catalog))
	}

	data, _, err := d.Query(query)
	if err != nil {
		return nil, err
	}

	columns := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		catalog := strings.TrimSpace(duckDBRowString(row, "table_catalog", "database_name"))
		schema := strings.TrimSpace(duckDBRowString(row, "table_schema"))
		tableName := strings.TrimSpace(duckDBRowString(row, "table_name"))
		if tableName == "" {
			continue
		}
		if schema != "" {
			tableName = schema + "." + tableName
		}
		if catalog != "" && !strings.EqualFold(catalog, "memory") && !strings.EqualFold(catalog, "main") {
			tableName = catalog + "." + tableName
		}

		columns = append(columns, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      duckDBRowString(row, "column_name"),
			Type:      duckDBRowString(row, "data_type"),
		})
	}
	return columns, nil
}

func (d *DuckDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	path := normalizeDuckDBObjectPath(dbName, tableName)
	if path.Object == "" {
		return nil, duckDBTableNameRequiredError()
	}

	constraintQuery := buildDuckDBConstraintMetadataQuery(path, true)
	constraintRows, _, err := d.Query(constraintQuery)
	if err != nil {
		return nil, err
	}
	indexQuery := buildDuckDBIndexMetadataQuery(path, true)
	indexRows, _, indexErr := d.Query(indexQuery)
	if indexErr != nil {
		return nil, indexErr
	}

	return buildDuckDBIndexDefinitions(constraintRows, indexRows), nil
}

func (d *DuckDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (d *DuckDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (d *DuckDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	if d.conn == nil {
		return duckDBConnectionNotOpenError()
	}

	conn, tx, err := beginPinnedWriteTransaction(d.conn)
	if err != nil {
		return err
	}
	defer func() {
		if conn != nil {
			_ = conn.Close()
		}
	}()
	defer tx.Rollback()

	quoteIdent := func(name string) string {
		n := strings.TrimSpace(name)
		n = strings.Trim(n, "\"")
		n = strings.ReplaceAll(n, "\"", "\"\"")
		if n == "" {
			return "\"\""
		}
		return `"` + n + `"`
	}

	path := normalizeDuckDBObjectPath("", tableName)
	schema := path.Schema
	table := path.Object

	qualifiedTable := quoteIdent(table)
	if schema != "" {
		qualifiedTable = fmt.Sprintf("%s.%s", quoteIdent(schema), quoteIdent(table))
	}

	isDuckDBRowIDLocator := strings.EqualFold(strings.TrimSpace(changes.LocatorStrategy), "duckdb-rowid")
	buildWhere := func(keys map[string]interface{}) ([]string, []interface{}) {
		var wheres []string
		var args []interface{}
		for k, v := range keys {
			if isDuckDBRowIDLocator && strings.EqualFold(strings.TrimSpace(k), "rowid") {
				wheres = append(wheres, "rowid = ?")
				args = append(args, v)
				continue
			}
			wheres = append(wheres, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}
		return wheres, args
	}

	for _, pk := range changes.Deletes {
		wheres, args := buildWhere(pk)
		if len(wheres) == 0 {
			continue
		}
		query := fmt.Sprintf("DELETE FROM %s WHERE %s", qualifiedTable, strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return duckDBDeleteFailedError(err)
		}
	}

	for _, update := range changes.Updates {
		var sets []string
		var args []interface{}
		for k, v := range update.Values {
			sets = append(sets, fmt.Sprintf("%s = ?", quoteIdent(k)))
			args = append(args, v)
		}
		if len(sets) == 0 {
			continue
		}

		wheres, whereArgs := buildWhere(update.Keys)
		args = append(args, whereArgs...)
		if len(wheres) == 0 {
			return duckDBUpdateKeyConditionsRequiredError()
		}

		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", qualifiedTable, strings.Join(sets, ", "), strings.Join(wheres, " AND "))
		if _, err := tx.Exec(query, args...); err != nil {
			return duckDBUpdateFailedError(err)
		}
	}

	if err := execParameterizedInsertBatches(parameterizedInsertConfig{
		Table:       qualifiedTable,
		Rows:        changes.Inserts,
		QuoteColumn: quoteIdent,
		Placeholder: func(int) string { return "?" },
		Exec: func(query string, args ...interface{}) (sql.Result, error) {
			return tx.Exec(query, args...)
		},
		MaxArgs: sqliteBatchInsertArgs,
	}); err != nil {
		return err
	}

	return commitPinnedWriteTransaction(&conn, tx)
}
