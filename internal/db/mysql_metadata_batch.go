package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// mysqlBatchSchemaLiteral 生成 information_schema 查询里的库名字面量。
func mysqlBatchSchemaLiteral(dbName string) (string, error) {
	schema := strings.TrimSpace(dbName)
	if schema == "" {
		return "", localizedDatabaseRuntimeError("db.backend.error.database_name_required", nil)
	}
	return strings.ReplaceAll(schema, "'", "''"), nil
}

// GetColumnsBatch 一次取回整库的列定义。
//
// 动机：整库结构对比在千表规模上是每表一次 SHOW FULL COLUMNS，往返数千次；
// 一条 information_schema.COLUMNS 查询即可拿全库，把往返从千级压到个位。
// 返回的 map 只包含真正存在的表——调用方用「不在 map 里」判断目标表缺失，
// 因此不会为缺表再补一次存在性查询。
func (m *MySQLDB) GetColumnsBatch(dbName string, tableNames []string) (map[string][]connection.ColumnDefinition, error) {
	schema, err := mysqlBatchSchemaLiteral(dbName)
	if err != nil {
		return nil, err
	}
	query := fmt.Sprintf(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT, COLLATION_NAME
		FROM information_schema.COLUMNS
		WHERE TABLE_SCHEMA = '%s'
		ORDER BY TABLE_NAME, ORDINAL_POSITION`, schema)
	rows, _, queryErr := m.Query(query)
	if queryErr != nil {
		return nil, queryErr
	}
	// 契约要求以调用方传入的表名为键（原样），所以按大小写不敏感匹配后回写原名。
	wanted := mysqlBatchNameIndex(tableNames)
	result := make(map[string][]connection.ColumnDefinition, len(tableNames))
	for _, row := range rows {
		table := mysqlBatchText(row, "TABLE_NAME")
		if table == "" {
			continue
		}
		name, ok := mysqlBatchWantedName(wanted, table)
		if !ok {
			continue
		}
		result[name] = append(result[name], buildMySQLBatchColumnDefinition(row))
	}
	return result, nil
}

// GetIndexesBatch 一次取回整库的索引定义（索引列按 SEQ_IN_INDEX 顺序）。
//
// 与列定义同理：结构对比要为每张表判断索引缺失，逐表 SHOW INDEX 是第二大类
// 往返；information_schema.STATISTICS 一条查询覆盖整库。
func (m *MySQLDB) GetIndexesBatch(dbName string, tableNames []string) (map[string][]connection.IndexDefinition, error) {
	schema, err := mysqlBatchSchemaLiteral(dbName)
	if err != nil {
		return nil, err
	}
	query := fmt.Sprintf(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE, SUB_PART
		FROM information_schema.STATISTICS
		WHERE TABLE_SCHEMA = '%s'
		ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, schema)
	rows, _, queryErr := m.Query(query)
	if queryErr != nil {
		return nil, queryErr
	}
	wanted := mysqlBatchNameIndex(tableNames)
	result := make(map[string][]connection.IndexDefinition, len(tableNames))
	for _, row := range rows {
		table := mysqlBatchText(row, "TABLE_NAME")
		if table == "" {
			continue
		}
		name, ok := mysqlBatchWantedName(wanted, table)
		if !ok {
			continue
		}
		result[name] = append(result[name], connection.IndexDefinition{
			Name:       mysqlBatchText(row, "INDEX_NAME"),
			ColumnName: mysqlBatchText(row, "COLUMN_NAME"),
			NonUnique:  mysqlBatchInt(row, "NON_UNIQUE"),
			SeqInIndex: mysqlBatchInt(row, "SEQ_IN_INDEX"),
			IndexType:  mysqlBatchText(row, "INDEX_TYPE"),
			SubPart:    mysqlBatchInt(row, "SUB_PART"),
		})
	}
	return result, nil
}

// mysqlBatchNameIndex 建立「小写表名 -> 调用方原始表名」的索引。
func mysqlBatchNameIndex(tableNames []string) map[string]string {
	index := make(map[string]string, len(tableNames))
	for _, name := range tableNames {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			continue
		}
		index[strings.ToLower(trimmed)] = trimmed
	}
	return index
}

// mysqlBatchWantedName 把查询回来的表名映射回调用方传入的原名。
func mysqlBatchWantedName(index map[string]string, table string) (string, bool) {
	if len(index) == 0 {
		return table, true
	}
	name, ok := index[strings.ToLower(strings.TrimSpace(table))]
	return name, ok
}

// buildMySQLBatchColumnDefinition 把 information_schema.COLUMNS 的一行转成列定义。
//
// 字段语义必须与 SHOW FULL COLUMNS 版本一致：可空性是 YES/NO，默认值为 NULL
// 时表示「无默认」，排序规则决定字符集。任何一处偏差都会让对比报出假的列差异。
func buildMySQLBatchColumnDefinition(row map[string]interface{}) connection.ColumnDefinition {
	col := connection.ColumnDefinition{
		Name:     mysqlBatchText(row, "COLUMN_NAME"),
		Type:     mysqlBatchText(row, "COLUMN_TYPE"),
		Nullable: mysqlBatchText(row, "IS_NULLABLE"),
		Key:      mysqlBatchText(row, "COLUMN_KEY"),
		Extra:    mysqlBatchText(row, "EXTRA"),
		Comment:  mysqlBatchText(row, "COLUMN_COMMENT"),
	}
	if value, ok := row["COLUMN_DEFAULT"]; ok && value != nil {
		defaultValue := fmt.Sprintf("%v", value)
		col.Default = &defaultValue
		col.HasDefault = true
	}
	if collation := mysqlBatchText(row, "COLLATION_NAME"); collation != "" {
		col.Collation = collation
		if separator := strings.IndexByte(collation, '_'); separator > 0 {
			col.Charset = collation[:separator]
		}
	}
	return col
}

func mysqlBatchText(row map[string]interface{}, key string) string {
	value, ok := row[key]
	if !ok || value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func mysqlBatchInt(row map[string]interface{}, key string) int {
	value, ok := row[key]
	if !ok || value == nil {
		return 0
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case int32:
		return int(typed)
	case float64:
		return int(typed)
	case []byte:
		var parsed int
		if _, err := fmt.Sscanf(string(typed), "%d", &parsed); err == nil {
			return parsed
		}
	case string:
		var parsed int
		if _, err := fmt.Sscanf(typed, "%d", &parsed); err == nil {
			return parsed
		}
	}
	return 0
}
