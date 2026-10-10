//go:build gonavi_full_drivers || gonavi_iris_driver || gonavi_cache_driver

package db

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (i *IrisDB) GetDatabases() ([]string, error) {
	namespace := strings.TrimSpace(i.namespace)
	// 侧边栏「未返回可见数据库或结构」可能源于本层返回 0 项，也可能源于前端显示范围
	// 过滤。把本层实际解析到的命名空间与结果数写进日志（agent 的 stderr 会汇入
	// gonavi.log），用户回传日志即可区分两者。
	if i.namespaceExplicit && namespace != "" {
		logger.Infof("%s 库列表：命名空间=%q（连接配置显式指定），返回 1 项", i.productName(), namespace)
		return []string{namespace}, nil
	}
	// 连接配置留空：此时的 namespace 只是本地兜底的 defaultIRISNamespace（USER），
	// 服务端从未确认过它。直接回它会显示一个可能并不存在的库，展开才发第一个真实查询，
	// 失败即红点。改为向服务端枚举真实命名空间。
	//
	// 旧实现在这里查 INFORMATION_SCHEMA.TABLES 的 TABLE_CATALOG，实测 IRIS 2026.1 与
	// Caché 2018.1 都只回一行 NULL，永远列不出命名空间，属于走不到的空路径。
	namespaces, err := i.listNamespaces()
	if err != nil {
		logger.Warnf("%s 库列表：枚举命名空间失败（多为权限不足），回退到连接命名空间 %q：%v",
			i.productName(), namespace, err)
	} else if len(namespaces) > 0 {
		logger.Infof("%s 库列表：枚举到 %d 个命名空间 %v", i.productName(), len(namespaces), namespaces)
		return namespaces, nil
	} else {
		logger.Warnf("%s 库列表：枚举结果为空，回退到连接命名空间 %q", i.productName(), namespace)
	}
	if namespace == "" {
		return nil, nil
	}
	return []string{namespace}, nil
}

// listNamespaces 用 %SYS.Namespace_List() 枚举服务端真实存在的命名空间。
//
// 这条 SQL 对受限账号可能永久不返回：受限账号（非 %SYS 权限）在普通命名空间下访问
// %SYS.Namespace_List() 时服务端既不回包也不报错。底层驱动在每次网络读上挂了
// irisDriverQueryReadTimeout（issue #1430/#1427），到期后这里会拿到读超时错误，
// 调用方据此回退到连接命名空间而不是无限等待。
//
// 注意列名是 Nsp/Status/Remote 而不是 Name，按 Name 查会报 SQLCODE -29。
// 与 schema 层一致，滤掉 % 开头的系统命名空间（%SYS），避免显示用户点不开的项。
func (i *IrisDB) listNamespaces() ([]string, error) {
	data, _, err := i.Query(`SELECT Nsp FROM %SYS.Namespace_List()`)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	namespaces := make([]string, 0, len(data))
	for _, row := range data {
		name := strings.TrimSpace(rowString(row, "Nsp", "nsp", "Name", "name"))
		if name == "" || strings.HasPrefix(name, "%") {
			continue
		}
		key := strings.ToUpper(name)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		namespaces = append(namespaces, name)
	}
	sort.Strings(namespaces)
	return namespaces, nil
}

// GetTables 列当前命名空间的用户表。
//
// 服务端先过滤再返回：不再 SELECT * 拉全量再客户端过滤。原因是 IRIS/Caché 把大量
// 系统投影（%SQL_Diag.* / %Studio.* / %UnitTest_* / %SYS_Monitor_* / %WebStress_*）
// 也暴露成 INFORMATION_SCHEMA.TABLES 的行，行数远超真实用户表；驱动又是流式
// fetchMoreData，行数一多长链路下往返非常慢，侧栏直接转圈（issue #1430/#1427）。
//
// 用 SUBSTRING(TABLE_SCHEMA,1,1) <> '%' 而不是 LIKE '\%'：Caché 2018.1 对模式以 %
// 开头的 LIKE 会卡死（哪怕加 ESCAPE），SUBSTRING/LEFT 这种函数形式能立即返回（实测
// 1s vs >30s 超时）。
func (i *IrisDB) GetTables(dbName string) ([]string, error) {
	data, _, err := i.Query(`SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES WHERE SUBSTRING(TABLE_SCHEMA,1,1) <> '%' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'`)
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

// GetAllColumns 列当前命名空间所有用户表的列。
// 与 GetTables 同理：用 SUBSTRING 而不是 LIKE '\%'（Caché 2018.1 上对以 % 开头的
// LIKE 模式会挂起，SUBSTRING 等价写法立即返回）。 issue #1430。
func (i *IrisDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	data, _, err := i.Query(`SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DESCRIPTION FROM INFORMATION_SCHEMA.COLUMNS WHERE SUBSTRING(TABLE_SCHEMA,1,1) <> '%' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA'`)
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
