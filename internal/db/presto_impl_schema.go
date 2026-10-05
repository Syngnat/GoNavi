//go:build gonavi_full_drivers || gonavi_presto_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// Presto 元数据：库是 catalog.schema（SHOW CATALOGS + SHOW SCHEMAS FROM），表来自 SHOW TABLES（含视图），
// 列来自各 catalog 的 information_schema.columns（PrestoDB 带 comment / extra_info，PrestoSQL 视版本而定，
// 按存在的列读取），取不到时回退 SHOW COLUMNS。元数据查询走固定会话，不受编辑器里 USE 的影响。

func quotePrestoIdent(name string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(name), `"`, `""`) + `"`
}

func prestoStringLiteral(value string) string {
	return "'" + strings.ReplaceAll(strings.TrimSpace(value), "'", "''") + "'"
}

func quotePrestoTable(catalog, schema, table string) string {
	return quotePrestoIdent(catalog) + "." + quotePrestoIdent(schema) + "." + quotePrestoIdent(table)
}

// namespace 解析库名 catalog.schema；为空时用连接配置的默认命名空间。
func (p *PrestoDB) namespace(dbName string) (string, string, error) {
	catalog, schema := prestoNamespace(dbName, nil)
	if catalog == "" && schema == "" {
		catalog, schema = p.catalog, p.schema
	}
	if catalog == "" || schema == "" {
		return "", "", localizedDatabaseRuntimeError("db.backend.error.presto_namespace_required", map[string]any{"name": dbName})
	}
	return catalog, schema, nil
}

// resolveTable 解析表所在的 catalog.schema。导航树传 catalog.schema 与原始表名；编辑器按 SQL 里的引用取列信息时，
// 库名可能只有一段（catalog 或 schema），表名带着 schema. 或 catalog.schema. 前缀，这时从表名里拆出命名空间：
// 两段表名的第一段与库名相同说明库名其实是 schema，catalog 用连接的默认 catalog。
func (p *PrestoDB) resolveTable(dbName, tableName string) (string, string, string, error) {
	table := strings.TrimSpace(tableName)
	if catalog, schema := prestoNamespace(dbName, nil); schema == "" {
		switch parts := strings.Split(table, "."); len(parts) {
		case 3:
			return parts[0], parts[1], parts[2], nil
		case 2:
			if catalog == "" || strings.EqualFold(catalog, parts[0]) {
				catalog = p.catalog
			}
			if catalog != "" {
				return catalog, parts[0], parts[1], nil
			}
		}
	}
	catalog, schema, err := p.namespace(dbName)
	return catalog, schema, table, err
}

func (p *PrestoDB) metadataRows(ctx context.Context, query string) ([]map[string]interface{}, error) {
	if p.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	collector := &prestoRowCollector{}
	if _, err := p.client.execute(ctx, p.metaSession, query, nil, collector); err != nil {
		return nil, err
	}
	return collector.data, nil
}

func (p *PrestoDB) metadataStrings(ctx context.Context, query string) ([]string, error) {
	if p.client == nil {
		return nil, localizedDatabaseRuntimeError("db.backend.error.connection_not_open", nil)
	}
	collector := &prestoSingleColumn{}
	if _, err := p.client.execute(ctx, p.metaSession, query, nil, collector); err != nil {
		return nil, err
	}
	return collector.values, nil
}

func (p *PrestoDB) defaultNamespace() string {
	if p.catalog == "" || p.schema == "" {
		return ""
	}
	return p.catalog + "." + p.schema
}

// GetDatabases 列出全部 catalog.schema；某个 catalog 读不到 schema 时跳过它并返回部分元数据错误。
func (p *PrestoDB) GetDatabases() ([]string, error) {
	ctx := metadataContextFor(p)
	catalogs, err := p.metadataStrings(ctx, "SHOW CATALOGS")
	if err != nil {
		if namespace := p.defaultNamespace(); namespace != "" {
			return []string{namespace}, nil
		}
		return nil, err
	}
	namespaces := make([]string, 0, len(catalogs)*2)
	seen := make(map[string]struct{}, len(catalogs)*2)
	var failures []MetadataObjectFailure
	for _, catalog := range catalogs {
		schemas, schemaErr := p.metadataStrings(ctx, "SHOW SCHEMAS FROM "+quotePrestoIdent(catalog))
		if schemaErr != nil {
			failures = append(failures, MetadataObjectFailure{ObjectName: catalog, Err: schemaErr})
			continue
		}
		for _, schema := range schemas {
			namespace := catalog + "." + schema
			if _, ok := seen[strings.ToLower(namespace)]; ok {
				continue
			}
			seen[strings.ToLower(namespace)] = struct{}{}
			namespaces = append(namespaces, namespace)
		}
	}
	if len(namespaces) == 0 {
		if namespace := p.defaultNamespace(); namespace != "" {
			namespaces = append(namespaces, namespace)
		}
	}
	sort.Strings(namespaces)
	if partial := NewPartialMetadataError(failures); partial != nil {
		return namespaces, partial
	}
	return namespaces, nil
}

func (p *PrestoDB) GetTables(dbName string) ([]string, error) {
	catalog, schema, err := p.namespace(dbName)
	if err != nil {
		return nil, err
	}
	tables, err := p.metadataStrings(metadataContextFor(p), "SHOW TABLES FROM "+quotePrestoIdent(catalog)+"."+quotePrestoIdent(schema))
	if err != nil {
		return nil, err
	}
	sort.Strings(tables)
	return tables, nil
}

// GetCreateStatement 返回 SHOW CREATE TABLE；对象是视图（或物化视图）时改用对应的 SHOW CREATE 语句。
func (p *PrestoDB) GetCreateStatement(dbName, tableName string) (string, error) {
	catalog, schema, tableName, err := p.resolveTable(dbName, tableName)
	if err != nil {
		return "", err
	}
	ctx := metadataContextFor(p)
	target := quotePrestoTable(catalog, schema, tableName)
	var firstErr error
	for _, statement := range []string{"SHOW CREATE TABLE ", "SHOW CREATE VIEW ", "SHOW CREATE MATERIALIZED VIEW "} {
		values, showErr := p.metadataStrings(ctx, statement+target)
		if showErr == nil && len(values) > 0 {
			return values[0], nil
		}
		if firstErr == nil {
			firstErr = showErr
		}
	}
	if firstErr == nil {
		firstErr = localizedDatabaseRuntimeError("db.backend.error.presto_ddl_empty", map[string]any{"name": tableName})
	}
	return "", firstErr
}

func (p *PrestoDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	catalog, schema, tableName, err := p.resolveTable(dbName, tableName)
	if err != nil {
		return nil, err
	}
	ctx := metadataContextFor(p)
	rows, err := p.metadataRows(ctx, fmt.Sprintf(
		"SELECT * FROM %s.information_schema.columns WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
		quotePrestoIdent(catalog), prestoStringLiteral(schema), prestoStringLiteral(tableName),
	))
	if err == nil && len(rows) > 0 {
		columns := make([]connection.ColumnDefinition, 0, len(rows))
		for _, row := range rows {
			columns = append(columns, prestoColumnDefinition(row))
		}
		return columns, nil
	}
	described, describeErr := p.metadataRows(ctx, "SHOW COLUMNS FROM "+quotePrestoTable(catalog, schema, tableName))
	if describeErr != nil {
		if err != nil {
			return nil, err
		}
		return nil, describeErr
	}
	columns := make([]connection.ColumnDefinition, 0, len(described))
	for _, row := range described {
		name := rowText(row, "Column", "column_name")
		if name == "" {
			continue
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     name,
			Type:     rowText(row, "Type", "data_type"),
			Nullable: "YES",
			Extra:    rowText(row, "Extra"),
			Comment:  rowText(row, "Comment"),
		})
	}
	return columns, nil
}

func prestoColumnDefinition(row map[string]interface{}) connection.ColumnDefinition {
	column := connection.ColumnDefinition{
		Name:     rowText(row, "column_name"),
		Type:     rowText(row, "data_type"),
		Nullable: strings.ToUpper(rowText(row, "is_nullable")),
		Extra:    rowText(row, "extra_info"),
		Comment:  rowText(row, "comment"),
	}
	if column.Nullable == "" {
		column.Nullable = "YES"
	}
	if value := firstMapValueOf(row, "column_default"); value != nil {
		text := strings.TrimSpace(fmt.Sprint(value))
		column.Default = &text
		column.HasDefault = true
	}
	return column
}

func (p *PrestoDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	catalog, schema, err := p.namespace(dbName)
	if err != nil {
		return nil, err
	}
	rows, err := p.metadataRows(metadataContextFor(p), fmt.Sprintf(
		"SELECT * FROM %s.information_schema.columns WHERE table_schema = %s ORDER BY table_name, ordinal_position",
		quotePrestoIdent(catalog), prestoStringLiteral(schema),
	))
	if err != nil {
		return nil, err
	}
	columns := make([]connection.ColumnDefinitionWithTable, 0, len(rows))
	for _, row := range rows {
		columns = append(columns, connection.ColumnDefinitionWithTable{
			TableName: rowText(row, "table_name"),
			Name:      rowText(row, "column_name"),
			Type:      rowText(row, "data_type"),
			Comment:   rowText(row, "comment"),
		})
	}
	return columns, nil
}

// Presto 没有索引、外键与触发器；Hive 的分区列在列的 Extra 里标为 partition key。
func (p *PrestoDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	return []connection.IndexDefinition{}, nil
}

func (p *PrestoDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (p *PrestoDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}
