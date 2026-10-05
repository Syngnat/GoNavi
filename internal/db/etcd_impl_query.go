//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"context"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// etcdColumns 是网格的固定列；v2 API 的 createdIndex / modifiedIndex 映射到两个修订号列，版本与租约为空。
var etcdColumns = []string{etcdColumnKey, etcdColumnValue, etcdColumnCreateRevision, etcdColumnModRevision, etcdColumnVersion, etcdColumnLease, etcdColumnTTL}

func etcdRowMap(row etcdKeyValue, columns []string) map[string]interface{} {
	values := map[string]interface{}{
		etcdColumnKey:            row.key,
		etcdColumnValue:          normalizeQueryValueWithDBType(row.value, ""),
		etcdColumnCreateRevision: row.createRevision,
		etcdColumnModRevision:    row.modRevision,
		etcdColumnVersion:        row.version,
		etcdColumnLease:          formatEtcdLease(row.lease),
		etcdColumnTTL:            nil,
	}
	if row.ttl > 0 || (row.lease != 0 && row.ttl < 0) {
		values[etcdColumnTTL] = row.ttl
	}
	if row.value == nil {
		values[etcdColumnValue] = ""
	}
	result := make(map[string]interface{}, len(columns))
	for _, column := range columns {
		result[column] = values[column]
	}
	return result
}

func (e *EtcdDB) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	if e.v3 == nil && e.v2 == nil {
		return nil, nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	selection, isSelect, err := parseEtcdSelect(query, e.delimiter)
	if err != nil {
		return nil, nil, err
	}
	if isSelect {
		return e.runSelect(ctx, selection)
	}
	command, err := parseEtcdCommand(query)
	if err != nil {
		return nil, nil, err
	}
	if e.v2 != nil {
		return e.v2Command(ctx, command)
	}
	return e.v3Command(ctx, command)
}

func (e *EtcdDB) Query(query string) ([]map[string]interface{}, []string, error) {
	return e.QueryContext(metadataContextFor(e), query)
}

func (e *EtcdDB) runSelect(ctx context.Context, selection etcdSelect) ([]map[string]interface{}, []string, error) {
	var (
		rows  []etcdKeyValue
		total int64
		err   error
	)
	if e.v2 != nil {
		rows, total, err = e.v2.selectRows(ctx, selection, e.delimiter)
	} else {
		rows, total, err = e.v3Select(ctx, selection)
	}
	if err != nil {
		return nil, nil, err
	}
	if selection.count {
		return []map[string]interface{}{{"total": total}}, []string{"total"}, nil
	}
	if e.v3 != nil {
		e.v3TTLs(ctx, rows)
	}
	columns := etcdColumns
	if len(selection.columns) > 0 {
		columns = selection.columns
	}
	result := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		result = append(result, etcdRowMap(row, columns))
	}
	return result, columns, nil
}

// ExecContext 执行写命令；影响行数取删除的键数、写入的键数（1）或命令本身报告的数量。
func (e *EtcdDB) ExecContext(ctx context.Context, query string) (int64, error) {
	rows, _, err := e.QueryContext(ctx, query)
	if err != nil {
		return 0, err
	}
	if len(rows) == 1 {
		if deleted, ok := rows[0]["deleted"].(int64); ok {
			return deleted, nil
		}
	}
	return int64(len(rows)), nil
}

func (e *EtcdDB) Exec(query string) (int64, error) {
	return e.ExecContext(context.Background(), query)
}

func (e *EtcdDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	types := map[string]string{
		etcdColumnKey: "bytes", etcdColumnValue: "bytes", etcdColumnCreateRevision: "int64", etcdColumnModRevision: "int64",
		etcdColumnVersion: "int64", etcdColumnLease: "lease (hex)", etcdColumnTTL: "int64",
	}
	if e.v2 != nil {
		types[etcdColumnCreateRevision], types[etcdColumnModRevision] = "createdIndex", "modifiedIndex"
	}
	columns := make([]connection.ColumnDefinition, 0, len(etcdColumns))
	for _, name := range etcdColumns {
		column := connection.ColumnDefinition{Name: name, Type: types[name], Nullable: "YES"}
		if name == etcdColumnKey {
			column.Key, column.Nullable = "PRI", "NO"
		}
		columns = append(columns, column)
	}
	return columns, nil
}

func (e *EtcdDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	tables, err := e.GetTables(dbName)
	if err != nil {
		return nil, err
	}
	columns, _ := e.GetColumns(dbName, "")
	result := make([]connection.ColumnDefinitionWithTable, 0, len(tables)*len(columns))
	for _, table := range tables {
		for _, column := range columns {
			result = append(result, connection.ColumnDefinitionWithTable{TableName: table, Name: column.Name, Type: column.Type})
		}
	}
	return result, nil
}

// GetCreateStatement 返回重建该前缀的 etcdctl 命令（每个键一条以分号结尾的 put），最多列出 500 个键。
func (e *EtcdDB) GetCreateStatement(dbName, tableName string) (string, error) {
	ctx, cancel := e.requestContext()
	defer cancel()
	selection := etcdSelect{
		kvSelect:  kvSelect{table: tableName, limit: etcdDDLScriptLimit},
		keyRanges: etcdTableRanges(tableName, e.delimiter),
	}
	var (
		rows []etcdKeyValue
		err  error
	)
	if e.v2 != nil {
		rows, _, err = e.v2.selectRows(ctx, selection, e.delimiter)
	} else {
		rows, _, err = e.v3Select(ctx, selection)
	}
	if err != nil {
		return "", err
	}
	var builder strings.Builder
	for _, row := range rows {
		builder.WriteString("put " + quoteShellArgument(row.key) + " " + quoteShellArgument(string(row.value)))
		if row.lease != 0 {
			builder.WriteString(" --lease=" + formatEtcdLease(row.lease).(string))
		}
		builder.WriteString(";\n")
	}
	return builder.String(), nil
}

func (e *EtcdDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (e *EtcdDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (e *EtcdDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (e *EtcdDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return e.ApplyChangesContext(context.Background(), tableName, changes)
}

func (e *EtcdDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	switch {
	case e.v3 != nil:
		return e.v3ApplyChanges(ctx, changes)
	case e.v2 != nil:
		return e.v2.applyChanges(ctx, changes)
	}
	return localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
}
