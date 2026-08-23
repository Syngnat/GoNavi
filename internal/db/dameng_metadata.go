package db

import (
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// escapeDamengMetadataLiteral normalizes a schema/table value and escapes it
// for use as a SQL string literal in Dameng metadata queries.
func escapeDamengMetadataLiteral(value string) string {
	return strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(value)), "'", "''")
}

var damengDatabaseQueries = []string{
	// 优先使用达梦原生系统表（SYSDBA 保留：作为默认管理员 schema，大多数用户在此创建业务表）
	"SELECT DISTINCT OBJECT_NAME AS DATABASE_NAME FROM SYS.SYSOBJECTS WHERE TYPE$ = 'SCH' AND OBJECT_NAME NOT IN ('SYS','SYSAUDITOR','SYSSSO','CTISYS','__RECYCLE_USER__') ORDER BY OBJECT_NAME",
	"SELECT SCHEMA_NAME AS DATABASE_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME NOT IN ('SYS','SYSAUDITOR','SYSSSO','CTISYS','INFORMATION_SCHEMA') ORDER BY SCHEMA_NAME",
	// Oracle 兼容层
	"SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS DATABASE_NAME FROM DUAL",
	"SELECT SYS_CONTEXT('USERENV', 'CURRENT_USER') AS DATABASE_NAME FROM DUAL",
	"SELECT USERNAME AS DATABASE_NAME FROM USER_USERS",
	"SELECT USERNAME AS DATABASE_NAME FROM ALL_USERS ORDER BY USERNAME",
	"SELECT USERNAME AS DATABASE_NAME FROM DBA_USERS ORDER BY USERNAME",
	"SELECT USERNAME AS DATABASE_NAME FROM SYS.DBA_USERS ORDER BY USERNAME",
	"SELECT DISTINCT OWNER AS DATABASE_NAME FROM ALL_OBJECTS ORDER BY OWNER",
	"SELECT DISTINCT OWNER AS DATABASE_NAME FROM ALL_TABLES ORDER BY OWNER",
	// 最终兜底：获取当前连接用户作为 schema 名称
	"SELECT USER AS DATABASE_NAME FROM DUAL",
}

type damengQueryFunc func(query string) ([]map[string]interface{}, []string, error)

func collectDamengDatabaseNames(query damengQueryFunc) ([]string, error) {
	seen := make(map[string]struct{})
	dbs := make([]string, 0, 64)
	var lastErr error

	for idx, q := range damengDatabaseQueries {
		data, _, err := query(q)
		if err != nil {
			logger.Warnf("达梦 GetDatabases 查询[%d]失败：%v（SQL: %.80s…）", idx, err, q)
			lastErr = err
			continue
		}
		newCount := 0
		for _, row := range data {
			name := getDamengRowString(row,
				"DATABASE_NAME",
				"USERNAME",
				"OWNER",
				"SCHEMA_NAME",
				"CURRENT_SCHEMA",
				"CURRENT_USER",
			)
			if name == "" {
				for _, v := range row {
					text := strings.TrimSpace(fmt.Sprintf("%v", v))
					if text == "" || strings.EqualFold(text, "<nil>") {
						continue
					}
					name = text
					break
				}
			}
			if name == "" {
				continue
			}
			key := strings.ToUpper(name)
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			dbs = append(dbs, name)
			newCount++
		}
		logger.Infof("达梦 GetDatabases 查询[%d]成功：返回 %d 行，新增 %d 条（SQL: %.80s…）", idx, len(data), newCount, q)
	}

	logger.Infof("达梦 GetDatabases 最终结果：共 %d 条数据库/schema", len(dbs))
	if len(dbs) == 0 && lastErr != nil {
		logger.Warnf("达梦 GetDatabases 所有查询均失败，返回最后错误：%v", lastErr)
		return nil, lastErr
	}

	sort.Slice(dbs, func(i, j int) bool {
		return strings.ToUpper(dbs[i]) < strings.ToUpper(dbs[j])
	})
	return dbs, nil
}

func getDamengRowString(row map[string]interface{}, keys ...string) string {
	if len(row) == 0 {
		return ""
	}
	for _, key := range keys {
		for k, v := range row {
			if !strings.EqualFold(strings.TrimSpace(k), strings.TrimSpace(key)) {
				continue
			}
			text := strings.TrimSpace(fmt.Sprintf("%v", v))
			if text == "" || strings.EqualFold(text, "<nil>") {
				return ""
			}
			return text
		}
	}
	return ""
}

func buildDamengColumnsQuery(dbName, tableName string) string {
	upperTableName := escapeDamengMetadataLiteral(tableName)
	upperDBName := escapeDamengMetadataLiteral(dbName)

	// 注意：达梦中 COMMENT 为保留字，不能使用 AS comment 作为列别名（Error -2007 语法分析出错）。
	if upperDBName == "" {
		return fmt.Sprintf(`SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.data_precision, c.data_scale, c.nullable, c.data_default, cc.comments AS col_comment,
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
		FROM user_tab_columns c
		LEFT JOIN user_col_comments cc
		  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
		LEFT JOIN (
			SELECT cols.table_name, cols.column_name
			FROM user_constraints cons
			JOIN user_cons_columns cols USING (constraint_name)
			WHERE cons.constraint_type = 'P'
			  AND cons.table_name = '%s'
			  AND cols.table_name = '%s'
		) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.table_name = '%s'
		ORDER BY c.column_id`, upperTableName, upperTableName, upperTableName)
	}

	return fmt.Sprintf(`SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.data_precision, c.data_scale, c.nullable, c.data_default, cc.comments AS col_comment,
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
		FROM all_tab_columns c
		LEFT JOIN all_col_comments cc
		  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
		LEFT JOIN (
			SELECT cols.owner, cols.table_name, cols.column_name
			FROM all_constraints cons
			JOIN all_cons_columns cols
			  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
			WHERE cons.constraint_type = 'P'
			  AND cons.owner = '%s'
			  AND cons.table_name = '%s'
			  AND cols.owner = '%s'
			  AND cols.table_name = '%s'
		) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
		WHERE c.owner = '%s' AND c.table_name = '%s'
		ORDER BY c.column_id`, upperDBName, upperTableName, upperDBName, upperTableName, upperDBName, upperTableName)
}

// buildDamengColumnCommentsQuery uses Dameng's native comment dictionary as a
// fallback. Some DM8 deployments expose column metadata through the Oracle-
// compatible ALL_COL_COMMENTS/USER_COL_COMMENTS views but return empty comment
// values when those views are joined with the column dictionary.
func buildDamengColumnCommentsQuery(dbName, tableName string) string {
	upperTableName := escapeDamengMetadataLiteral(tableName)
	upperDBName := escapeDamengMetadataLiteral(dbName)

	schemaPredicate := "SCHNAME = USER"
	if upperDBName != "" {
		schemaPredicate = fmt.Sprintf("SCHNAME = '%s'", upperDBName)
	}

	return fmt.Sprintf(`SELECT COLNAME AS column_name, COMMENT$ AS col_comment
		FROM SYS.SYSCOLUMNCOMMENTS
		WHERE %s AND TVNAME = '%s' AND COMMENT$ IS NOT NULL
		ORDER BY COLNAME`, schemaPredicate, upperTableName)
}

func buildDamengTableCommentQuery(dbName, tableName string) string {
	upperTableName := escapeDamengMetadataLiteral(tableName)
	upperDBName := escapeDamengMetadataLiteral(dbName)
	if upperDBName == "" {
		return fmt.Sprintf(`SELECT comments AS "TABLE_COMMENT"
			FROM user_tab_comments
			WHERE table_name = '%s' AND comments IS NOT NULL`, upperTableName)
	}
	return fmt.Sprintf(`SELECT comments AS "TABLE_COMMENT"
		FROM all_tab_comments
		WHERE owner = '%s' AND table_name = '%s' AND comments IS NOT NULL`, upperDBName, upperTableName)
}

func appendDamengTableCommentDDL(ddl, dbName, tableName, comment string) string {
	baseDDL := strings.TrimSpace(ddl)
	comment = strings.TrimSpace(comment)
	if baseDDL == "" || comment == "" || strings.Contains(strings.ToUpper(baseDDL), "COMMENT ON TABLE ") {
		return baseDDL
	}

	quoteIdentifier := func(value string) string {
		value = strings.ToUpper(strings.TrimSpace(value))
		return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	}
	tableRef := quoteIdentifier(tableName)
	if strings.TrimSpace(dbName) != "" {
		tableRef = quoteIdentifier(dbName) + "." + tableRef
	}

	baseDDL = strings.TrimRight(baseDDL, " \t\r\n")
	if !strings.HasSuffix(baseDDL, ";") && !strings.HasSuffix(baseDDL, "/") {
		baseDDL += ";"
	}
	escapedComment := strings.ReplaceAll(comment, "'", "''")
	return fmt.Sprintf("%s\n\nCOMMENT ON TABLE %s IS '%s';", baseDDL, tableRef, escapedComment)
}

// buildDamengAutoIncrementColumnsQuery reads the stable system-table flag that
// records both IDENTITY and AUTO_INCREMENT columns. It intentionally remains a
// separate query so restricted accounts can still load base column metadata.
func buildDamengAutoIncrementColumnsQuery(dbName, tableName string) string {
	upperDBName := escapeDamengMetadataLiteral(dbName)
	upperTableName := escapeDamengMetadataLiteral(tableName)

	schemaPredicate := "s.NAME = USER"
	if upperDBName != "" {
		schemaPredicate = fmt.Sprintf("s.NAME = '%s'", upperDBName)
	}

	return fmt.Sprintf(`SELECT sc.NAME AS column_name
		FROM SYS.SYSCOLUMNS sc
		JOIN SYS.SYSOBJECTS t ON sc.ID = t.ID
		JOIN SYS.SYSOBJECTS s ON t.SCHID = s.ID
		WHERE %s
		  AND t.NAME = '%s'
		  AND (sc.INFO2 & 0x01) = 0x01
		ORDER BY sc.COLID`, schemaPredicate, upperTableName)
}

func applyDamengAutoIncrementColumns(columns []connection.ColumnDefinition, data []map[string]interface{}) []connection.ColumnDefinition {
	autoIncrementColumns := make(map[string]struct{}, len(data))
	for _, row := range data {
		name := strings.ToUpper(strings.TrimSpace(getDamengRowString(row, "COLUMN_NAME")))
		if name != "" {
			autoIncrementColumns[name] = struct{}{}
		}
	}

	for i := range columns {
		if _, ok := autoIncrementColumns[strings.ToUpper(strings.TrimSpace(columns[i].Name))]; ok {
			columns[i].Extra = "auto_increment"
		}
	}

	return columns
}

func buildDamengIndexesQuery(dbName, tableName string) string {
	upperDBName := escapeDamengMetadataLiteral(dbName)
	upperTableName := escapeDamengMetadataLiteral(tableName)

	if upperDBName == "" {
		return fmt.Sprintf(`SELECT c.index_name, c.column_name, i.uniqueness, c.column_position, i.index_type
			FROM user_ind_columns c
			JOIN user_indexes i ON i.index_name = c.index_name
			WHERE c.table_name = '%s'
			  AND c.column_name IS NOT NULL
			ORDER BY c.index_name, c.column_position`, upperTableName)
	}

	return fmt.Sprintf(`SELECT c.index_name, c.column_name, i.uniqueness, c.column_position, i.index_type
		FROM all_ind_columns c
		JOIN all_indexes i ON i.owner = c.index_owner AND i.index_name = c.index_name
		WHERE c.table_owner = '%s'
		  AND c.table_name = '%s'
		  AND c.column_name IS NOT NULL
		ORDER BY c.index_name, c.column_position`, upperDBName, upperTableName)
}

func buildDamengIndexDefinitions(data []map[string]interface{}) []connection.IndexDefinition {
	indexes := make([]connection.IndexDefinition, 0, len(data))
	for _, row := range data {
		name := getDamengRowString(row, "INDEX_NAME")
		columnName := getDamengRowString(row, "COLUMN_NAME")
		if name == "" || columnName == "" {
			continue
		}

		nonUnique := 1
		if strings.EqualFold(getDamengRowString(row, "UNIQUENESS"), "UNIQUE") {
			nonUnique = 0
		}

		seqInIndex, _ := getDamengRowInt(row, "COLUMN_POSITION")
		indexType := getDamengRowString(row, "INDEX_TYPE")
		if indexType == "" {
			indexType = "BTREE"
		}

		indexes = append(indexes, connection.IndexDefinition{
			Name:       name,
			ColumnName: columnName,
			NonUnique:  nonUnique,
			SeqInIndex: seqInIndex,
			IndexType:  indexType,
		})
	}
	return indexes
}

func buildDamengForeignKeysQuery(dbName, tableName string) string {
	upperDBName := escapeDamengMetadataLiteral(dbName)
	upperTableName := escapeDamengMetadataLiteral(tableName)
	if upperDBName == "" {
		return fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM (
			SELECT constraint_name, table_name, column_name, position
			FROM user_cons_columns
			WHERE table_name = '%s'
		) a
		JOIN user_constraints c ON a.constraint_name = c.constraint_name
		JOIN user_constraints c_pk ON c.r_constraint_name = c_pk.constraint_name
		JOIN user_cons_columns b ON c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND c.table_name = '%s'`, upperTableName, upperTableName)
	}
	return fmt.Sprintf(`SELECT a.constraint_name, a.column_name, c_pk.table_name r_table_name, b.column_name r_column_name
		FROM (
			SELECT owner, constraint_name, table_name, column_name, position
			FROM all_cons_columns
			WHERE owner = '%s' AND table_name = '%s'
		) a
		JOIN all_constraints c ON a.owner = c.owner AND a.constraint_name = c.constraint_name
		JOIN all_constraints c_pk ON c.r_owner = c_pk.owner AND c.r_constraint_name = c_pk.constraint_name
		JOIN all_cons_columns b ON c_pk.owner = b.owner AND c_pk.constraint_name = b.constraint_name AND a.position = b.position
		WHERE c.constraint_type = 'R' AND c.owner = '%s' AND c.table_name = '%s'`,
		upperDBName, upperTableName, upperDBName, upperTableName)
}

func getDamengRowInt(row map[string]interface{}, keys ...string) (int, bool) {
	for _, key := range keys {
		raw := getDamengRowString(row, key)
		if raw == "" {
			continue
		}
		var parsed int
		if _, err := fmt.Sscanf(raw, "%d", &parsed); err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func normalizeDamengNullable(value string) string {
	switch strings.ToUpper(strings.TrimSpace(value)) {
	case "N", "NO", "FALSE", "0", "NOT NULL":
		return "NO"
	case "Y", "YES", "TRUE", "1", "NULL", "NULLABLE":
		return "YES"
	default:
		return strings.TrimSpace(value)
	}
}

func isDamengLengthQualifiedType(upperType string) bool {
	switch strings.TrimSpace(upperType) {
	case "CHAR", "NCHAR", "VARCHAR", "VARCHAR2", "NVARCHAR", "NVARCHAR2", "RAW", "BINARY", "VARBINARY":
		return true
	default:
		return strings.Contains(upperType, "CHARACTER")
	}
}

func formatDamengColumnType(row map[string]interface{}) string {
	dataType := getDamengRowString(row, "DATA_TYPE")
	if dataType == "" || strings.Contains(dataType, "(") {
		return dataType
	}

	upperType := strings.ToUpper(dataType)
	if isDamengLengthQualifiedType(upperType) {
		if charLength, ok := getDamengRowInt(row, "CHAR_LENGTH", "CHAR_COL_DECL_LENGTH"); ok && charLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, charLength)
		}
		if dataLength, ok := getDamengRowInt(row, "DATA_LENGTH"); ok && dataLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, dataLength)
		}
	}

	if strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC") {
		precision, hasPrecision := getDamengRowInt(row, "DATA_PRECISION", "NUMERIC_PRECISION")
		if hasPrecision && precision > 0 {
			scale, hasScale := getDamengRowInt(row, "DATA_SCALE", "NUMERIC_SCALE")
			if hasScale && scale > 0 {
				return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
			}
			return fmt.Sprintf("%s(%d)", dataType, precision)
		}
	}

	return dataType
}

func buildDamengColumnDefinitions(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     getDamengRowString(row, "COLUMN_NAME"),
			Type:     formatDamengColumnType(row),
			Nullable: normalizeDamengNullable(getDamengRowString(row, "NULLABLE")),
			Key:      getDamengRowString(row, "COLUMN_KEY"),
			// col_comment：避免达梦保留字 comment 别名；兼容旧别名与原生 comments 列名
			Comment: getDamengRowString(row, "COL_COMMENT", "COMMENT", "COMMENTS"),
		}

		defaultValue := getDamengRowString(row, "DATA_DEFAULT")
		if defaultValue != "" {
			def := defaultValue
			col.Default = &def
		}

		columns = append(columns, col)
	}

	return columns
}

func hasDamengColumnComments(columns []connection.ColumnDefinition) bool {
	for _, column := range columns {
		if strings.TrimSpace(column.Comment) != "" {
			return true
		}
	}
	return false
}

func applyDamengColumnComments(columns []connection.ColumnDefinition, data []map[string]interface{}) []connection.ColumnDefinition {
	commentsByColumn := make(map[string]string, len(data))
	for _, row := range data {
		columnName := strings.ToUpper(strings.TrimSpace(getDamengRowString(row, "COLUMN_NAME", "COLNAME")))
		if columnName == "" {
			continue
		}
		commentsByColumn[columnName] = getDamengRowString(row, "COL_COMMENT", "COMMENT$", "COMMENT", "COMMENTS")
	}

	for i := range columns {
		if comment, ok := commentsByColumn[strings.ToUpper(strings.TrimSpace(columns[i].Name))]; ok {
			columns[i].Comment = comment
		}
	}
	return columns
}
