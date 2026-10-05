package db

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

func (o *OracleDB) appendOracleCommentDDL(baseDDL string, dbName string, tableName string) string {
	table := strings.TrimSpace(tableName)
	if strings.TrimSpace(baseDDL) == "" || table == "" {
		return baseDDL
	}

	schema := strings.TrimSpace(dbName)
	tableRef := quoteOracleDDLIdentifier(table)
	if schema != "" {
		tableRef = quoteOracleDDLIdentifier(schema) + "." + tableRef
	}
	existingDDLUpper := strings.ToUpper(baseDDL)
	commentLines := make([]string, 0, 4)

	if tableComment := strings.TrimSpace(o.fetchOracleTableComment(schema, table)); tableComment != "" {
		marker := "COMMENT ON TABLE " + strings.ToUpper(tableRef)
		if !strings.Contains(existingDDLUpper, marker) {
			commentLines = append(commentLines, fmt.Sprintf("COMMENT ON TABLE %s IS '%s';", tableRef, escapeOracleCommentLiteral(tableComment)))
		}
	}

	for _, colComment := range o.fetchOracleColumnComments(schema, table) {
		columnName := strings.TrimSpace(colComment.columnName)
		comment := strings.TrimSpace(colComment.comment)
		if columnName == "" || comment == "" {
			continue
		}
		columnRef := fmt.Sprintf("%s.%s", tableRef, quoteOracleDDLIdentifier(columnName))
		marker := "COMMENT ON COLUMN " + strings.ToUpper(columnRef)
		if strings.Contains(existingDDLUpper, marker) {
			continue
		}
		commentLines = append(commentLines, fmt.Sprintf("COMMENT ON COLUMN %s IS '%s';", columnRef, escapeOracleCommentLiteral(comment)))
	}

	if len(commentLines) == 0 {
		return baseDDL
	}
	return ensureOracleDDLStatementTerminator(baseDDL) + "\n\n" + strings.Join(commentLines, "\n")
}

func ensureOracleDDLStatementTerminator(ddl string) string {
	trimmed := strings.TrimRight(ddl, " \t\r\n")
	if trimmed == "" {
		return trimmed
	}
	if strings.HasSuffix(trimmed, ";") || strings.HasSuffix(trimmed, "/") {
		return trimmed
	}
	return trimmed + ";"
}

func (o *OracleDB) fetchOracleTableComment(schema string, table string) string {
	escapedTable := escapeOracleMetadataLiteralExact(table)
	var query string
	if strings.TrimSpace(schema) != "" {
		query = fmt.Sprintf(`SELECT comments AS "COMMENT" FROM all_tab_comments WHERE owner = '%s' AND table_name = '%s' AND comments IS NOT NULL`, escapeOracleMetadataLiteralExact(schema), escapedTable)
	} else {
		query = fmt.Sprintf(`SELECT comments AS "COMMENT" FROM user_tab_comments WHERE table_name = '%s' AND comments IS NOT NULL`, escapedTable)
	}
	data, _, err := o.Query(query)
	if err != nil || len(data) == 0 {
		return ""
	}
	return normalizeOracleMetadataComment(oracleRowString(data[0], "COMMENT", "COMMENTS"))
}

type oracleColumnComment struct {
	columnName string
	comment    string
}

func (o *OracleDB) fetchOracleColumnComments(schema string, table string) []oracleColumnComment {
	escapedTable := escapeOracleMetadataLiteralExact(table)
	var query string
	if strings.TrimSpace(schema) != "" {
		query = fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", cc.comments AS "COMMENT"
FROM all_tab_columns c
JOIN all_col_comments cc
  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
WHERE c.owner = '%s' AND c.table_name = '%s' AND cc.comments IS NOT NULL
ORDER BY c.column_id`, escapeOracleMetadataLiteralExact(schema), escapedTable)
	} else {
		query = fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", cc.comments AS "COMMENT"
FROM user_tab_columns c
JOIN user_col_comments cc
  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
WHERE c.table_name = '%s' AND cc.comments IS NOT NULL
ORDER BY c.column_id`, escapedTable)
	}

	data, _, err := o.Query(query)
	if err != nil {
		return nil
	}
	comments := make([]oracleColumnComment, 0, len(data))
	for _, row := range data {
		comments = append(comments, oracleColumnComment{
			columnName: oracleRowString(row, "COLUMN_NAME"),
			comment:    normalizeOracleMetadataComment(oracleRowString(row, "COMMENT", "COMMENTS")),
		})
	}
	return comments
}

func quoteOracleDDLIdentifier(ident string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(ident), `"`, `""`) + `"`
}

func quoteOracleTableRef(schema string, table string) string {
	tableRef := quoteOracleDDLIdentifier(table)
	if strings.TrimSpace(schema) != "" {
		return quoteOracleDDLIdentifier(schema) + "." + tableRef
	}
	return tableRef
}

func escapeOracleCommentLiteral(text string) string {
	return strings.ReplaceAll(text, "'", "''")
}

func escapeOracleMetadataLiteral(text string) string {
	return strings.ReplaceAll(strings.ToUpper(strings.TrimSpace(text)), "'", "''")
}

func escapeOracleMetadataLiteralExact(text string) string {
	return strings.ReplaceAll(strings.TrimSpace(text), "'", "''")
}

type oracleMetadataNamePair struct {
	schema string
	table  string
}

func oracleMetadataNamePairs(dbName string, tableName string) []oracleMetadataNamePair {
	rawSchema := strings.TrimSpace(dbName)
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return nil
	}

	upperSchema := strings.ToUpper(rawSchema)
	upperTable := strings.ToUpper(rawTable)
	pairs := make([]oracleMetadataNamePair, 0, 4)
	seen := map[string]struct{}{}
	add := func(schema string, table string) {
		key := schema + "\x00" + table
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		pairs = append(pairs, oracleMetadataNamePair{schema: schema, table: table})
	}

	add(rawSchema, rawTable)
	add(upperSchema, upperTable)
	add(rawSchema, upperTable)
	add(upperSchema, rawTable)
	return pairs
}

func (o *OracleDB) lookupOracleSynonymTargets(dbName string, tableName string) []oracleMetadataNamePair {
	targets := make([]oracleMetadataNamePair, 0, 4)
	seen := map[string]struct{}{}
	add := func(schema string, table string) {
		key := schema + "\x00" + table
		if strings.TrimSpace(table) == "" {
			return
		}
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		targets = append(targets, oracleMetadataNamePair{schema: schema, table: table})
	}

	for _, candidate := range oracleMetadataNamePairs(dbName, tableName) {
		data, _, err := o.Query(buildOracleSynonymLookupQuery(candidate.schema, candidate.table))
		if err != nil {
			continue
		}
		for _, row := range data {
			targetSchema := oracleRowString(row, "TABLE_OWNER", "table_owner")
			targetTable := oracleRowString(row, "TABLE_NAME", "table_name")
			for _, target := range oracleMetadataNamePairs(targetSchema, targetTable) {
				add(target.schema, target.table)
			}
			if strings.TrimSpace(targetTable) != "" {
				break
			}
		}
	}

	return targets
}

func buildOracleSynonymLookupQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT table_owner AS "TABLE_OWNER", table_name AS "TABLE_NAME"
FROM all_synonyms
WHERE synonym_name = '%s'
  AND db_link IS NULL
  AND (owner = USER OR owner = 'PUBLIC')
ORDER BY CASE WHEN owner = USER THEN 0 WHEN owner = 'PUBLIC' THEN 1 ELSE 2 END`, metadataTableName)
	}

	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	return fmt.Sprintf(`SELECT table_owner AS "TABLE_OWNER", table_name AS "TABLE_NAME"
FROM all_synonyms
WHERE synonym_name = '%s'
  AND db_link IS NULL
  AND owner IN ('%s', 'PUBLIC')
ORDER BY CASE WHEN owner = '%s' THEN 0 WHEN owner = 'PUBLIC' THEN 1 ELSE 2 END`, metadataTableName, metadataSchemaName, metadataSchemaName)
}

func parseOracleColumns(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		col := connection.ColumnDefinition{
			Name:     oracleRowString(row, "COLUMN_NAME"),
			Type:     formatOracleColumnType(row),
			Nullable: oracleRowString(row, "NULLABLE"),
			Key:      oracleRowString(row, "COLUMN_KEY"),
			Comment:  normalizeOracleMetadataComment(oracleRowString(row, "COMMENT")),
		}

		if defaultValue := oracleRowValue(row, "DATA_DEFAULT"); defaultValue != nil {
			d := fmt.Sprintf("%v", defaultValue)
			col.Default = &d
		}

		columns = append(columns, col)
	}
	return columns
}

// buildOracleIdentityColumnsQuery 读取 12c 起提供的 identity 列元数据。
//
// 刻意独立成一条查询：ALL_TAB_IDENTITY_COLS 在 11g 及更早版本不存在，合并进主
// 查询会让整个 GetColumns 在旧库上直接失败；受限账号缺少该视图权限时同理。
// 调用方应把查询错误降级为告警，保留基础列元数据。
func buildOracleIdentityColumnsQuery(schema string, table string) string {
	metadataTableName := escapeOracleMetadataLiteralExact(table)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT column_name AS "COLUMN_NAME"
FROM user_tab_identity_cols
WHERE table_name = '%s'`, metadataTableName)
	}

	metadataSchemaName := escapeOracleMetadataLiteralExact(schema)
	return fmt.Sprintf(`SELECT column_name AS "COLUMN_NAME"
FROM all_tab_identity_cols
WHERE owner = '%s'
  AND table_name = '%s'`, metadataSchemaName, metadataTableName)
}

// applyOracleIdentityColumns 给 identity 列打上 auto_increment 标记。
// 跨库自动建表只认 Extra 里的这个标记来识别自增，缺失会让目标表建成普通数字列，
// 导入后目标端不再自动生成 ID。
func applyOracleIdentityColumns(columns []connection.ColumnDefinition, data []map[string]interface{}) []connection.ColumnDefinition {
	identityColumns := make(map[string]struct{}, len(data))
	for _, row := range data {
		name := strings.ToUpper(strings.TrimSpace(oracleRowString(row, "COLUMN_NAME")))
		if name != "" {
			identityColumns[name] = struct{}{}
		}
	}
	if len(identityColumns) == 0 {
		return columns
	}

	for i := range columns {
		if _, ok := identityColumns[strings.ToUpper(strings.TrimSpace(columns[i].Name))]; ok {
			columns[i].Extra = "auto_increment"
		}
	}
	return columns
}

// applyOracleIdentityMetadata 查询并回填 identity 标记。查询失败只告警，
// 保证旧版本 Oracle 与受限账号仍能拿到基础列定义。
func (o *OracleDB) applyOracleIdentityMetadata(schema string, table string, columns []connection.ColumnDefinition) []connection.ColumnDefinition {
	if len(columns) == 0 {
		return columns
	}
	data, _, err := o.Query(buildOracleIdentityColumnsQuery(schema, table))
	if err != nil {
		logger.Warnf("Oracle GetColumns identity 元数据查询失败，已返回基础字段定义：%v", err)
		return columns
	}
	return applyOracleIdentityColumns(columns, data)
}
