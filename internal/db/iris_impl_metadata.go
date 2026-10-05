//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (i *IrisDB) GetDatabases() ([]string, error) {
	namespace := strings.TrimSpace(i.namespace)
	if namespace != "" {
		return []string{namespace}, nil
	}
	data, _, err := i.Query(`SELECT DISTINCT TABLE_CATALOG FROM INFORMATION_SCHEMA.TABLES`)
	if err != nil {
		return nil, err
	}
	var namespaces []string
	seen := map[string]struct{}{}
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "TABLE_CATALOG", "table_catalog", "TABLECATALOG", "tablecatalog"))
		if name == "" {
			continue
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		namespaces = append(namespaces, name)
	}
	sort.Strings(namespaces)
	return namespaces, nil
}

func (i *IrisDB) GetTables(dbName string) ([]string, error) {
	data, _, err := i.Query(`SELECT * FROM INFORMATION_SCHEMA.TABLES`)
	if err != nil {
		return nil, err
	}
	var tables []string
	seen := map[string]struct{}{}
	for _, row := range data {
		tableType := strings.ToUpper(strings.TrimSpace(rowString(row, "TABLE_TYPE", "table_type", "TABLETYPE", "tabletype")))
		if tableType != "" && tableType != "TABLE" && tableType != "BASE TABLE" {
			continue
		}
		schema := strings.TrimSpace(rowString(row, "TABLE_SCHEMA", "table_schema", "SCHEMA_NAME", "schema_name", "TABLESCHEMA", "tableschema", "SCHEMANAME", "schemaname"))
		table := strings.TrimSpace(rowString(row, "TABLE_NAME", "table_name", "TABLENAME", "tablename"))
		if table == "" || isIRISSystemSchema(schema) {
			continue
		}
		name := table
		if schema != "" {
			name = schema + "." + table
		}
		if _, ok := seen[name]; ok {
			continue
		}
		seen[name] = struct{}{}
		tables = append(tables, name)
	}
	sort.Strings(tables)
	return tables, nil
}

func (i *IrisDB) GetCreateStatement(dbName, tableName string) (string, error) {
	ref, err := parseIRISTableRef(dbName, tableName)
	if err != nil {
		return "", err
	}
	columns, err := i.GetColumns(dbName, tableName)
	if err != nil {
		return "", err
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("未找到表字段：%s", tableName)
	}
	indexes, idxErr := i.GetIndexes(dbName, tableName)
	if idxErr != nil {
		indexes = nil
	}
	return buildIRISCreateTableDDL(ref, columns, indexes), nil
}

func (i *IrisDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	ref, err := parseIRISTableRef(dbName, tableName)
	if err != nil {
		return nil, err
	}
	data, _, err := i.Query(buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.COLUMNS", ref))
	if err != nil {
		return nil, err
	}
	indexes, _ := i.GetIndexes(dbName, tableName)
	keyByColumn := irisColumnKeyMap(indexes)

	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"))
		if name == "" {
			continue
		}
		key := keyByColumn[name]
		if primary, ok := irisBoolFromRow(row, "PRIMARY_KEY", "primary_key", "PRIMARYKEY", "primarykey"); ok && primary {
			key = "PRI"
		} else if key == "" {
			if unique, ok := irisBoolFromRow(row, "UNIQUE_COLUMN", "unique_column", "UNIQUECOLUMN", "uniquecolumn", "IS_UNIQUE", "is_unique", "ISUNIQUE", "isunique", "UNIQUE", "unique"); ok && unique {
				key = "UNI"
			}
		}
		col := connection.ColumnDefinition{
			Name:     name,
			Type:     buildIRISColumnType(row),
			Nullable: normalizeIRISNullable(rowString(row, "IS_NULLABLE", "is_nullable", "ISNULLABLE", "isnullable")),
			Key:      key,
			Extra:    "",
			Comment:  rowString(row, "DESCRIPTION", "description", "COMMENT", "comment"),
		}
		if rawDefault, ok := rowValue(row, "COLUMN_DEFAULT", "column_default", "COLUMNDEFAULT", "columndefault"); ok && rawDefault != nil {
			def := strings.TrimSpace(fmt.Sprintf("%v", rawDefault))
			if def != "" {
				col.Default = &def
			}
		}
		columns = append(columns, col)
	}
	sort.SliceStable(columns, func(a, b int) bool {
		return rowOrdinal(data, columns[a].Name) < rowOrdinal(data, columns[b].Name)
	})
	return columns, nil
}

func (i *IrisDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	data, _, err := i.Query(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS`)
	if err != nil {
		return nil, err
	}
	cols := make([]connection.ColumnDefinitionWithTable, 0, len(data))
	for _, row := range data {
		schema := strings.TrimSpace(rowString(row, "TABLE_SCHEMA", "table_schema", "TABLESCHEMA", "tableschema"))
		table := strings.TrimSpace(rowString(row, "TABLE_NAME", "table_name", "TABLENAME", "tablename"))
		name := strings.TrimSpace(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"))
		if table == "" || name == "" || isIRISSystemSchema(schema) {
			continue
		}
		tableName := table
		if schema != "" {
			tableName = schema + "." + table
		}
		cols = append(cols, connection.ColumnDefinitionWithTable{
			TableName: tableName,
			Name:      name,
			Type:      buildIRISColumnType(row),
			Comment:   rowString(row, "DESCRIPTION", "description", "COMMENT", "comment"),
		})
	}
	sort.SliceStable(cols, func(a, b int) bool {
		if cols[a].TableName == cols[b].TableName {
			return cols[a].Name < cols[b].Name
		}
		return cols[a].TableName < cols[b].TableName
	})
	return cols, nil
}

func (i *IrisDB) GetIndexes(dbName, tableName string) ([]connection.IndexDefinition, error) {
	ref, err := parseIRISTableRef(dbName, tableName)
	if err != nil {
		return nil, err
	}
	data, _, err := i.Query(buildIRISInfoSchemaWhereQuery("INFORMATION_SCHEMA.INDEXES", ref))
	if err != nil {
		return nil, err
	}
	indexes := make([]connection.IndexDefinition, 0, len(data))
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "INDEX_NAME", "index_name", "INDEXNAME", "indexname", "KEY_NAME", "key_name", "KEYNAME", "keyname", "CONSTRAINT_NAME", "constraint_name", "CONSTRAINTNAME", "constraintname"))
		column := strings.TrimSpace(rowString(row, "COLUMN_NAME", "column_name", "COLUMNNAME", "columnname"))
		primary, hasPrimaryFlag := irisBoolFromRow(row, "PRIMARY_KEY", "primary_key", "PRIMARYKEY", "primarykey")
		if name == "" && hasPrimaryFlag && primary {
			name = "PRIMARY"
		}
		if name == "" || column == "" {
			continue
		}
		indexType := normalizeIRISIndexType(rowString(row, "INDEX_TYPE", "index_type", "INDEXTYPE", "indextype", "TYPE", "type"))
		if hasPrimaryFlag && primary {
			indexType = "PRIMARY"
		}
		nonUnique := parseIRISNonUnique(row)
		indexes = append(indexes, connection.IndexDefinition{
			Name:       name,
			ColumnName: column,
			NonUnique:  nonUnique,
			SeqInIndex: parseIRISInt(rowValueAny(row, "ORDINAL_POSITION", "ordinal_position", "ORDINALPOSITION", "ordinalposition", "SEQ_IN_INDEX", "seq_in_index", "SEQININDEX", "seqinindex", "KEY_SEQ", "key_seq", "KEYSEQ", "keyseq")),
			IndexType:  indexType,
		})
	}
	sort.SliceStable(indexes, func(a, b int) bool {
		if indexes[a].Name == indexes[b].Name {
			return indexes[a].SeqInIndex < indexes[b].SeqInIndex
		}
		return indexes[a].Name < indexes[b].Name
	})
	return indexes, nil
}

func (i *IrisDB) GetForeignKeys(dbName, tableName string) ([]connection.ForeignKeyDefinition, error) {
	return []connection.ForeignKeyDefinition{}, nil
}

func (i *IrisDB) GetTriggers(dbName, tableName string) ([]connection.TriggerDefinition, error) {
	return []connection.TriggerDefinition{}, nil
}

func (i *IrisDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	return i.ApplyChangesContext(context.Background(), tableName, changes)
}

func (i *IrisDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) (err error) {
	if i.conn == nil {
		return fmt.Errorf("连接未打开")
	}
	tx, err := i.conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	transactionCommitted := false
	defer func() { rollbackUnfinishedWriteTransaction(tx, transactionCommitted, &err) }()

	for _, keys := range changes.Deletes {
		query, args, ok := buildIRISDeleteSQL(tableName, keys)
		if !ok {
			continue
		}
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("删除失败：%w", err))
		}
		if err := requireSingleRowAffected(res, rowMutationActionDelete); err != nil {
			return err
		}
	}

	for _, update := range changes.Updates {
		query, args, ok, err := buildIRISUpdateSQL(tableName, update)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("更新失败：%w", err))
		}
		if err := requireSingleRowAffected(res, rowMutationActionUpdate); err != nil {
			return err
		}
	}

	for _, row := range changes.Inserts {
		query, args, ok := buildIRISInsertSQL(tableName, row)
		if !ok {
			continue
		}
		res, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return markWriteOutcomeUnknownIfAmbiguous(ctx, fmt.Errorf("插入失败：%w", err))
		}
		if affected, err := res.RowsAffected(); err == nil && affected == 0 {
			return fmt.Errorf("插入未生效：未影响任何行")
		}
	}

	if err := commitWriteTransaction(tx); err != nil {
		return err
	}
	transactionCommitted = true
	return nil
}
