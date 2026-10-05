//go:build gonavi_full_drivers || gonavi_oceanbase_driver

package db

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (o *OceanBaseDB) activeDatabase() Database {
	if o.oracle != nil {
		return o.oracle
	}
	return &o.MySQLDB
}

func (o *OceanBaseDB) bindMetadataContext(ctx context.Context) {
	BindMetadataContext(o.activeDatabase(), ctx)
}

func (o *OceanBaseDB) clearMetadataContext() {
	ClearMetadataContext(o.activeDatabase())
}

func (o *OceanBaseDB) Close() error {
	if o.oracle != nil {
		err := o.oracle.Close()
		o.oracle = nil
		return err
	}
	return o.MySQLDB.Close()
}

func (o *OceanBaseDB) Ping() error {
	return o.activeDatabase().Ping()
}

func (o *OceanBaseDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if q, ok := o.activeDatabase().(interface {
		QueryContext(context.Context, string) ([]map[string]interface{}, []string, error)
	}); ok {
		return q.QueryContext(ctx, query)
	}
	return o.activeDatabase().Query(query)
}

func (o *OceanBaseDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return o.activeDatabase().Query(query)
}

func (o *OceanBaseDB) ExecContext(ctx context.Context, query string) (int64, error) {
	if e, ok := o.activeDatabase().(interface {
		ExecContext(context.Context, string) (int64, error)
	}); ok {
		return e.ExecContext(ctx, query)
	}
	return o.activeDatabase().Exec(query)
}

func (o *OceanBaseDB) Exec(query string) (int64, error) {
	return o.activeDatabase().Exec(query)
}

func (o *OceanBaseDB) QueryMulti(query string) ([]connection.ResultSetData, error) {
	if q, ok := o.activeDatabase().(MultiResultQuerier); ok {
		return q.QueryMulti(query)
	}
	data, columns, err := o.Query(query)
	if err != nil {
		return nil, err
	}
	return []connection.ResultSetData{{Rows: data, Columns: columns}}, nil
}

func (o *OceanBaseDB) QueryMultiContext(ctx context.Context, query string) ([]connection.ResultSetData, error) {
	if q, ok := o.activeDatabase().(MultiResultQuerierContext); ok {
		return q.QueryMultiContext(ctx, query)
	}
	data, columns, err := o.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	return []connection.ResultSetData{{Rows: data, Columns: columns}}, nil
}

func (o *OceanBaseDB) ExecBatchContext(ctx context.Context, query string) (int64, error) {
	if e, ok := o.activeDatabase().(BatchWriteExecer); ok {
		return e.ExecBatchContext(ctx, query)
	}
	return o.ExecContext(ctx, query)
}

func (o *OceanBaseDB) OpenSessionExecer(ctx context.Context) (StatementExecer, error) {
	if p, ok := o.activeDatabase().(SessionExecerProvider); ok {
		return p.OpenSessionExecer(ctx)
	}
	return nil, fmt.Errorf("当前 OceanBase %s 协议不支持独立导入会话", o.protocol)
}

func (o *OceanBaseDB) GetDatabases() ([]string, error) {
	return o.activeDatabase().GetDatabases()
}

func (o *OceanBaseDB) GetTables(dbName string) ([]string, error) {
	return o.activeDatabase().GetTables(dbName)
}

func (o *OceanBaseDB) GetCreateStatement(dbName, tableName string) (string, error) {
	if o.protocol == oceanBaseProtocolOracle && o.oracle != nil {
		ddl, err := o.oracle.GetCreateStatement(dbName, tableName)
		if err == nil && strings.TrimSpace(ddl) != "" {
			return ddl, nil
		}
		showDDL, showErr := o.getOceanBaseOracleShowCreateStatement(dbName, tableName)
		if showErr == nil {
			return showDDL, nil
		}
		if err != nil {
			return "", localizedDatabaseRuntimeError("db.backend.error.oceanbase_oracle_show_create_table_fallback_failed", map[string]any{
				"metadataDetail": err.Error(),
				"showDetail":     showErr.Error(),
			})
		}
		return "", showErr
	}
	return o.activeDatabase().GetCreateStatement(dbName, tableName)
}

func (o *OceanBaseDB) getOceanBaseOracleShowCreateStatement(dbName string, tableName string) (string, error) {
	var firstErr error
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		query := buildOceanBaseOracleShowCreateTableQuery(candidate.schema, candidate.table)
		data, _, err := o.oracle.Query(query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if ddl := extractOceanBaseOracleCreateStatement(data); ddl != "" {
			return o.oracle.appendOracleCommentDDL(ddl, candidate.schema, candidate.table), nil
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", localizedDatabaseRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func buildOceanBaseOracleShowCreateTableQuery(schema string, table string) string {
	return "SHOW CREATE TABLE " + quoteOracleTableRef(schema, table)
}

func extractOceanBaseOracleCreateStatement(data []map[string]interface{}) string {
	for _, row := range data {
		for _, key := range []string{"Create Table", "CREATE TABLE", "CREATE_TABLE", "DDL", "ddl"} {
			if val, ok := row[key]; ok {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text
				}
			}
		}
		for _, val := range row {
			text := strings.TrimSpace(fmt.Sprintf("%v", val))
			lower := strings.ToLower(text)
			if strings.HasPrefix(lower, "create table") ||
				strings.HasPrefix(lower, "create view") ||
				strings.HasPrefix(lower, "create or replace view") {
				return text
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text
				}
			}
		}
	}
	return ""
}

func (o *OceanBaseDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return o.activeDatabase().GetColumns(dbName, tableName)
}

func (o *OceanBaseDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	return o.activeDatabase().GetAllColumns(dbName)
}

func (o *OceanBaseDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return o.activeDatabase().GetIndexes(dbName, tableName)
}

func (o *OceanBaseDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return o.activeDatabase().GetForeignKeys(dbName, tableName)
}

func (o *OceanBaseDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return o.activeDatabase().GetTriggers(dbName, tableName)
}

func (o *OceanBaseDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return o.ApplyChangesContext(context.Background(), tableName, changes)
}
