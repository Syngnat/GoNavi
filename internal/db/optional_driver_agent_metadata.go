package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (d *OptionalDriverAgentDB) GetDatabases() ([]string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var dbs []string
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method: optionalAgentMethodGetDatabases,
	}, &dbs, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return dbs, nil
}

func (d *OptionalDriverAgentDB) GetTables(dbName string) ([]string, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var tables []string
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method: optionalAgentMethodGetTables,
		DBName: dbName,
	}, &tables, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		// 代理在失败时可能带回部分结果（PartialData），与进程内驱动一样一并返回。
		return tables, err
	}
	return tables, nil
}

func (d *OptionalDriverAgentDB) TableExists(dbName, tableName string) (bool, error) {
	client, err := d.requireClient()
	if err != nil {
		return false, err
	}
	var exists bool
	err = client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method:    optionalAgentMethodTableExists,
		DBName:    dbName,
		TableName: tableName,
	}, &exists, nil, nil, nil, optionalAgentControlCallTimeout)
	if err == nil {
		return exists, nil
	}
	if !isOptionalAgentTableExistsUnsupported(err) {
		return false, err
	}

	tables, fallbackErr := d.GetTables(dbName)
	if fallbackErr != nil {
		return false, fallbackErr
	}
	target := strings.TrimSpace(tableName)
	for _, table := range tables {
		if strings.TrimSpace(table) == target {
			return true, nil
		}
	}
	return false, nil
}

func isOptionalAgentTableExistsUnsupported(err error) bool {
	if err == nil {
		return false
	}
	text := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(text, "不支持的方法") || strings.Contains(text, "unsupported method")
}

func (d *OptionalDriverAgentDB) GetTableRowCounts(_ string, tables []string) (map[string]int64, error) {
	if normalizeRuntimeDriverType(d.driverType) != "sqlite" {
		return map[string]int64{}, nil
	}
	return getSQLiteTableRowCounts(d.Query, tables)
}

func (d *OptionalDriverAgentDB) GetTableStorageStats(_ string, tables []string) (map[string]TableStorageStats, error) {
	if normalizeRuntimeDriverType(d.driverType) != "sqlite" {
		return map[string]TableStorageStats{}, nil
	}
	return getSQLiteTableStorageStats(d.Query, tables)
}

func (d *OptionalDriverAgentDB) GetCreateStatement(dbName, tableName string) (string, error) {
	client, err := d.requireClient()
	if err != nil {
		return "", err
	}
	var sqlText string
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method:    optionalAgentMethodGetCreateStmt,
		DBName:    dbName,
		TableName: tableName,
	}, &sqlText, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return "", err
	}
	return sqlText, nil
}

func (d *OptionalDriverAgentDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	return d.GetColumnsContext(metadataContextFor(d), dbName, tableName)
}

func (d *OptionalDriverAgentDB) GetColumnsContext(ctx context.Context, dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var columns []connection.ColumnDefinition
	if err := client.callWithContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodGetColumns,
		DBName:    dbName,
		TableName: tableName,
	}, &columns, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return columns, nil
}

func (d *OptionalDriverAgentDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var columns []connection.ColumnDefinitionWithTable
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method: optionalAgentMethodGetAllColumns,
		DBName: dbName,
	}, &columns, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return columns, nil
}

func (d *OptionalDriverAgentDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var indexes []connection.IndexDefinition
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method:    optionalAgentMethodGetIndexes,
		DBName:    dbName,
		TableName: tableName,
	}, &indexes, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return indexes, nil
}

func (d *OptionalDriverAgentDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var keys []connection.ForeignKeyDefinition
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method:    optionalAgentMethodGetForeignKeys,
		DBName:    dbName,
		TableName: tableName,
	}, &keys, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return keys, nil
}

func (d *OptionalDriverAgentDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	client, err := d.requireClient()
	if err != nil {
		return nil, err
	}
	var triggers []connection.TriggerDefinition
	if err := client.callWithContext(metadataContextFor(d), optionalAgentRequest{
		Method:    optionalAgentMethodGetTriggers,
		DBName:    dbName,
		TableName: tableName,
	}, &triggers, nil, nil, nil, optionalAgentControlCallTimeout); err != nil {
		return nil, err
	}
	return triggers, nil
}

func (d *OptionalDriverAgentDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return d.ApplyChangesContext(context.Background(), tableName, changes)
}

func (d *OptionalDriverAgentDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	client, err := d.requireClient()
	if err != nil {
		return err
	}
	if strings.EqualFold(d.driverType, "kingbase") {
		if normalized := normalizeKingbaseAgentTableName(tableName); normalized != "" {
			tableName = normalized
		}
		if normalized, normErr := d.normalizeKingbaseAgentChangeSet(tableName, changes); normErr == nil {
			changes = normalized
		} else {
			logger.Warnf("Kingbase ApplyChanges 字段名规范化失败：%v", normErr)
		}
	}
	err = client.callContext(ctx, optionalAgentRequest{
		Method:    optionalAgentMethodApplyChanges,
		TableName: tableName,
		Changes:   &changes,
	}, nil, nil, nil, nil)
	if err != nil && ctx.Err() != nil {
		return MarkWriteOutcomeUnknown(err)
	}
	return err
}

func (d *OptionalDriverAgentDB) requireClient() (*optionalDriverAgentClient, error) {
	if d.client == nil {
		return nil, fmt.Errorf("连接未打开")
	}
	return d.client, nil
}

func (d *OptionalDriverAgentDB) normalizeKingbaseAgentChangeSet(tableName string, changes connection.ChangeSet) (connection.ChangeSet, error) {
	columns, err := d.GetColumns("", tableName)
	if err != nil {
		return changes, err
	}
	if len(columns) == 0 {
		return changes, nil
	}
	names := make([]string, 0, len(columns))
	for _, col := range columns {
		name := strings.TrimSpace(col.Name)
		if name == "" {
			continue
		}
		names = append(names, name)
	}
	return normalizeKingbaseAgentChangeSetByColumns(changes, names)
}

func timeoutMsFromContext(ctx context.Context) int64 {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 0
	}
	remaining := time.Until(deadline).Milliseconds()
	if remaining <= 0 {
		return 1
	}
	return remaining
}
