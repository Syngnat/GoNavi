package db

import (
	"database/sql"
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func (o *OracleDB) GetDatabases() ([]string, error) {
	// Oracle treats Users/Schemas as "Databases" in this context
	data, _, err := o.Query("SELECT username FROM all_users ORDER BY username")
	if err != nil {
		return nil, err
	}
	var dbs []string
	for _, row := range data {
		if val, ok := row["USERNAME"]; ok {
			dbs = append(dbs, fmt.Sprintf("%v", val))
		}
	}
	return dbs, nil
}

func (o *OracleDB) GetTables(dbName string) ([]string, error) {
	// dbName is Schema/Owner
	// 始终返回 OWNER.TABLE_NAME，避免下游 SQL 缺少 schema 前缀导致 ORA-00942（refs issue #445）
	// 列别名用双引号包裹强制大写，避免不同驱动版本返回不一致 case 导致 row map 取值失败
	var query string
	if dbName != "" {
		query = fmt.Sprintf(`SELECT owner AS "OWNER", table_name AS "TABLE_NAME" FROM all_tables WHERE owner = '%s' ORDER BY table_name`, escapeOracleMetadataLiteral(dbName))
	} else {
		query = `SELECT USER AS "OWNER", table_name AS "TABLE_NAME" FROM user_tables ORDER BY table_name`
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var tables []string
	for _, row := range data {
		owner, okOwner := row["OWNER"]
		name, okName := row["TABLE_NAME"]
		if okOwner && okName && name != nil {
			tables = append(tables, fmt.Sprintf("%v.%v", owner, name))
			continue
		}
		if okName && name != nil {
			tables = append(tables, fmt.Sprintf("%v", name))
		}
	}
	return tables, nil
}

func (o *OracleDB) GetCreateStatement(dbName, tableName string) (string, error) {
	// Oracle provides DBMS_METADATA.GET_DDL
	// Note: LONG type might be tricky, but basic string scan should work for smaller DDLs
	var firstErr error
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		metadataTableName := escapeOracleMetadataLiteralExact(candidate.table)
		metadataSchemaName := escapeOracleMetadataLiteralExact(candidate.schema)
		query := fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s', '%s') as ddl FROM DUAL",
			metadataTableName, metadataSchemaName)

		if candidate.schema == "" {
			query = fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('TABLE', '%s') as ddl FROM DUAL", metadataTableName)
		}

		data, _, err := o.queryUnbounded(query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}

		if len(data) > 0 {
			if val, ok := data[0]["DDL"]; ok {
				ddl := strings.TrimSpace(fmt.Sprintf("%v", val))
				if ddl != "" {
					return o.appendOracleCommentDDL(ddl, candidate.schema, candidate.table), nil
				}
			}
		}
	}
	if firstErr != nil {
		return "", firstErr
	}
	return "", oracleRuntimeError("db.backend.error.create_table_statement_not_found", nil)
}

func (o *OracleDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	for _, candidate := range o.oracleMetadataNameCandidates(dbName, tableName) {
		data, _, err := o.Query(o.buildOracleColumnsQueryFor(candidate.schema, candidate.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		o.rememberOracleMetadataNamePair(dbName, tableName, candidate)
		return o.assembleOracleColumns(candidate.schema, candidate.table, data), nil
	}
	for _, target := range o.lookupOracleSynonymTargets(dbName, tableName) {
		data, _, err := o.Query(o.buildOracleColumnsQueryFor(target.schema, target.table))
		if err != nil {
			return nil, err
		}
		if len(data) == 0 {
			continue
		}
		return o.assembleOracleColumns(target.schema, target.table, data), nil
	}
	if columns, err := o.inferOracleColumnsFromSelect(dbName, tableName); err == nil && len(columns) > 0 {
		return columns, nil
	}
	return []connection.ColumnDefinition{}, nil
}

// buildOracleColumnsQueryFor 在 identity 视图可用时选用带 identity 标记的变体，
// 使每张表只需一次往返；否则退回基础查询，再由 assembleOracleColumns 补一次
// identity 查询（旧版本 Oracle 与受限账号的行为与改动前一致）。
func (o *OracleDB) buildOracleColumnsQueryFor(schema, table string) string {
	if o.oracleIdentityViewAvailable(schema) {
		return buildOracleColumnsQueryWithIdentity(schema, table)
	}
	return buildOracleColumnsQuery(schema, table)
}

// assembleOracleColumns 解析列定义，并补齐 identity 标记。
//
// 合并查询已经在结果里带出 IDENTITY_COLUMN，直接复用解析结果即可；基础查询没有
// 该列，才需要单独查一次。判定依据是「结果里是否存在该投影」，而不是能力探测的
// 缓存值 —— 后者可能在负结果未缓存时与实际查询路径不一致。
func (o *OracleDB) assembleOracleColumns(schema, table string, data []map[string]interface{}) []connection.ColumnDefinition {
	columns := parseOracleColumns(data)
	if len(data) > 0 {
		if _, ok := data[0]["IDENTITY_COLUMN"]; ok {
			return applyOracleIdentityColumns(columns, oracleIdentityRowsFromColumnsData(data))
		}
	}
	return o.applyOracleIdentityMetadata(schema, table, columns)
}

func (o *OracleDB) inferOracleColumnsFromSelect(dbName string, tableName string) ([]connection.ColumnDefinition, error) {
	if o.conn == nil {
		return nil, fmt.Errorf("连接未打开")
	}

	var firstErr error
	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		query := "SELECT * FROM " + quoteOracleTableRef(candidate.schema, candidate.table) + " WHERE 1 = 0"
		rows, err := o.conn.QueryContext(metadataContextFor(o), query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		columns, parseErr := oracleColumnsFromSQLRows(rows)
		closeErr := rows.Close()
		if parseErr != nil {
			if firstErr == nil {
				firstErr = parseErr
			}
			continue
		}
		if closeErr != nil {
			if firstErr == nil {
				firstErr = closeErr
			}
			continue
		}
		if len(columns) > 0 {
			return columns, nil
		}
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return nil, fmt.Errorf("未获取到字段定义")
}

func oracleColumnsFromSQLRows(rows *sql.Rows) ([]connection.ColumnDefinition, error) {
	names, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	colTypes, err := rows.ColumnTypes()
	if err != nil || len(colTypes) != len(names) {
		colTypes = nil
	}

	columns := make([]connection.ColumnDefinition, 0, len(names))
	for idx, name := range names {
		col := connection.ColumnDefinition{
			Name:     strings.TrimSpace(name),
			Nullable: "",
			Key:      "",
			Extra:    "",
			Comment:  "",
		}
		if colTypes != nil && idx < len(colTypes) && colTypes[idx] != nil {
			col.Type = formatOracleSQLColumnType(colTypes[idx])
			if nullable, ok := colTypes[idx].Nullable(); ok {
				if nullable {
					col.Nullable = "YES"
				} else {
					col.Nullable = "NO"
				}
			}
		}
		columns = append(columns, col)
	}
	return columns, nil
}

// oracleDriverUnknownScale 是 go-ora 用来表示"变精度 / scale 未知"的哨兵值。
// 驱动的 ParameterInfo.Scale 是 uint8，Oracle 的 -127（变精度 NUMBER）在驱动内
// 被折成 0xFF，经 ColumnTypePrecisionScale 转成 int64 后就是 255。
const oracleDriverUnknownScale = 255

func formatOracleSQLColumnType(colType *sql.ColumnType) string {
	if colType == nil {
		return ""
	}
	typeName := strings.TrimSpace(colType.DatabaseTypeName())
	if typeName == "" {
		return ""
	}
	upperType := strings.ToUpper(typeName)
	if length, ok := colType.Length(); ok && length > 0 && strings.Contains(upperType, "CHAR") {
		return fmt.Sprintf("%s(%d)", typeName, length)
	}
	if precision, scale, ok := colType.DecimalSize(); ok && precision > 0 && (strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC")) {
		// 这条路径的 scale 来自驱动，字段类型是 uint8，拿不到 Oracle 的负 scale
		// （真正的负 scale 只出现在读 DATA_SCALE 的字典路径，见
		// formatOracleColumnType）。go-ora 用 0xFF=255 表示"变精度/未知 scale"，
		// 原样拼出来会得到 NUMBER(38,255) 这种非法类型：精度上限是 38，而下游
		// 折算层只认负号，不会拦这个值，最终建表报 Too big scale。
		if scale > 0 && scale != oracleDriverUnknownScale {
			return fmt.Sprintf("%s(%d,%d)", typeName, precision, scale)
		}
		return fmt.Sprintf("%s(%d)", typeName, precision)
	}
	return typeName
}

func oracleRowValue(row map[string]interface{}, names ...string) interface{} {
	for _, name := range names {
		if value, ok := row[name]; ok {
			return value
		}
		for key, value := range row {
			if strings.EqualFold(key, name) {
				return value
			}
		}
	}
	return nil
}

func oracleRowString(row map[string]interface{}, names ...string) string {
	value := oracleRowValue(row, names...)
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}

func oracleRowInt(row map[string]interface{}, names ...string) (int, bool) {
	raw := oracleRowString(row, names...)
	if raw == "" {
		return 0, false
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func isOracleLengthQualifiedType(upperType string) bool {
	switch strings.TrimSpace(upperType) {
	case "CHAR", "NCHAR", "VARCHAR", "VARCHAR2", "NVARCHAR", "NVARCHAR2", "RAW", "BINARY", "VARBINARY":
		return true
	default:
		return strings.Contains(upperType, "CHARACTER")
	}
}

func formatOracleColumnType(row map[string]interface{}) string {
	dataType := oracleRowString(row, "DATA_TYPE")
	if dataType == "" || strings.Contains(dataType, "(") {
		return dataType
	}

	upperType := strings.ToUpper(dataType)
	if isOracleLengthQualifiedType(upperType) {
		if charLength, ok := oracleRowInt(row, "CHAR_LENGTH", "CHAR_COL_DECL_LENGTH"); ok && charLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, charLength)
		}
		if dataLength, ok := oracleRowInt(row, "DATA_LENGTH"); ok && dataLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, dataLength)
		}
	}

	if strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC") {
		precision, hasPrecision := oracleRowInt(row, "DATA_PRECISION", "NUMERIC_PRECISION")
		if hasPrecision && precision > 0 {
			scale, hasScale := oracleRowInt(row, "DATA_SCALE", "NUMERIC_SCALE")
			// 负 scale 必须保留：Oracle 的 NUMBER(10,-2) 表示向左舍入到百位，
			// 丢掉负号会当成 NUMBER(10) 从而改变精度语义。跨方言迁移时由
			// 归一层把负 scale 折算成目标库合法的写法。
			if hasScale && scale != 0 {
				return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
			}
			return fmt.Sprintf("%s(%d)", dataType, precision)
		}
	}

	return dataType
}

func (o *OracleDB) GetAllColumns(dbName string) ([]connection.ColumnDefinitionWithTable, error) {
	query := fmt.Sprintf(`SELECT c.table_name, c.column_name, c.data_type, cc.comments AS comment
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		WHERE c.owner = '%s'`, strings.ReplaceAll(strings.ToUpper(dbName), "'", "''"))

	data, _, err := o.Query(query)
	if err != nil {
		return nil, err
	}

	var cols []connection.ColumnDefinitionWithTable
	for _, row := range data {
		col := connection.ColumnDefinitionWithTable{
			TableName: fmt.Sprintf("%v", row["TABLE_NAME"]),
			Name:      fmt.Sprintf("%v", row["COLUMN_NAME"]),
			Type:      fmt.Sprintf("%v", row["DATA_TYPE"]),
			Comment:   normalizeOracleMetadataComment(fmt.Sprintf("%v", row["COMMENT"])),
		}
		cols = append(cols, col)
	}
	return cols, nil
}
