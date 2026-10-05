package app

import (
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func (a *App) DBShowCreateTable(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	dbType := resolveDDLDBType(config)
	runConfig := buildRunConfigForDDL(config, dbType, dbName)
	if isOceanBaseOracleProtocol(config) {
		runConfig = normalizeMetadataRunConfig(config, dbName)
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取连接失败：%s", formatConnSummary(runConfig))
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	sqlStr, err := resolveCreateStatementWithFallbackWithText(dbInst, config, dbName, tableName, a.appText)
	if err != nil {
		logger.Error(err, "DBShowCreateTable 获取建表语句失败：%s 表=%s", formatConnSummary(runConfig), tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: sqlStr}
}

func resolveCreateStatementWithFallback(dbInst db.Database, config connection.ConnectionConfig, dbName string, tableName string) (string, error) {
	return resolveCreateStatementWithFallbackWithText(dbInst, config, dbName, tableName, defaultDBBackendText)
}

func resolveCreateStatementWithFallbackWithText(dbInst db.Database, config connection.ConnectionConfig, dbName string, tableName string, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	dbType := resolveDDLDBType(config)
	metadataSchemaName, metadataTableName, ddlSchemaName, ddlTableName := resolveCreateStatementTargets(config, dbType, dbName, tableName)
	if metadataTableName == "" || ddlTableName == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.table_name_required", nil))
	}

	sqlStr, sourceErr := dbInst.GetCreateStatement(metadataSchemaName, metadataTableName)
	if sourceErr == nil && !shouldFallbackCreateStatement(dbType, sqlStr) {
		if strings.TrimSpace(sqlStr) != "" {
			if columns, err := loadCreateStatementCommentColumns(dbInst, dbType, metadataSchemaName, metadataTableName); err == nil {
				sqlStr = appendCreateStatementColumnComments(dbType, ddlSchemaName, ddlTableName, sqlStr, columns)
			}
			sqlStr = appendCreateStatementTableComment(
				dbInst,
				dbType,
				metadataSchemaName,
				metadataTableName,
				ddlSchemaName,
				ddlTableName,
				sqlStr,
			)
			return sqlStr, nil
		}
		if isOceanBaseOracleProtocol(config) {
			if showDDL, ok := tryGetOceanBaseOracleShowCreateStatement(dbInst, metadataSchemaName, metadataTableName); ok {
				return showDDL, nil
			}
		}
		return sqlStr, nil
	}

	if isOceanBaseOracleProtocol(config) {
		if showDDL, ok := tryGetOceanBaseOracleShowCreateStatement(dbInst, metadataSchemaName, metadataTableName); ok {
			return showDDL, nil
		}
	}

	if supportsViewCreateStatementLookup(dbType) {
		if viewDDL, ok := tryGetViewCreateStatement(db.MetadataContext(dbInst), dbInst, config, dbName, ddlSchemaName, ddlTableName); ok {
			return viewDDL, nil
		}
	}

	if !supportsCreateStatementFallback(dbType) {
		if sourceErr != nil {
			return "", sourceErr
		}
		return sqlStr, nil
	}

	columns, colErr := dbInst.GetColumns(metadataSchemaName, metadataTableName)
	if colErr != nil {
		if sourceErr != nil {
			return "", sourceErr
		}
		return "", colErr
	}

	var indexes []connection.IndexDefinition
	if indexRows, idxErr := dbInst.GetIndexes(metadataSchemaName, metadataTableName); idxErr == nil {
		indexes = indexRows
	}

	fallbackDDL, buildErr := buildFallbackCreateStatementWithText(dbType, ddlSchemaName, ddlTableName, columns, indexes, text)
	if buildErr != nil {
		if sourceErr != nil {
			return "", sourceErr
		}
		return "", buildErr
	}
	fallbackDDL = appendCreateStatementTableComment(
		dbInst,
		dbType,
		metadataSchemaName,
		metadataTableName,
		ddlSchemaName,
		ddlTableName,
		fallbackDDL,
	)
	return appendRegistryCreateStatementSupplement(dbInst, config, metadataSchemaName, metadataTableName, fallbackDDL), nil
}

func tryGetOceanBaseOracleShowCreateStatement(dbInst db.Database, schemaName string, tableName string) (string, bool) {
	query := "SHOW CREATE TABLE " + quoteOracleMetadataTableRef(schemaName, tableName)
	data, _, err := dbInst.Query(query)
	if err != nil {
		return "", false
	}
	for _, row := range data {
		for _, key := range []string{"Create Table", "CREATE TABLE", "CREATE_TABLE", "DDL", "ddl"} {
			if val, ok := row[key]; ok {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text, true
				}
			}
		}
		for _, val := range row {
			text := strings.TrimSpace(fmt.Sprintf("%v", val))
			lower := strings.ToLower(text)
			if strings.HasPrefix(lower, "create table") ||
				strings.HasPrefix(lower, "create view") ||
				strings.HasPrefix(lower, "create or replace view") {
				return text, true
			}
		}
		if len(row) == 1 {
			for _, val := range row {
				text := strings.TrimSpace(fmt.Sprintf("%v", val))
				if text != "" && !strings.EqualFold(text, "<nil>") {
					return text, true
				}
			}
		}
	}
	return "", false
}

func supportsCreateStatementFallback(dbType string) bool {
	switch dbType {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "dameng":
		return true
	default:
		return false
	}
}

func supportsViewCreateStatementLookup(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "oracle", "dameng", "sqlite", "duckdb", "clickhouse":
		return true
	default:
		return false
	}
}

func shouldFallbackCreateStatement(dbType string, ddl string) bool {
	if !supportsCreateStatementFallback(dbType) {
		return false
	}

	trimmed := strings.TrimSpace(ddl)
	if trimmed == "" {
		return true
	}
	if hasCreateTableOrViewHead(trimmed) {
		return false
	}

	lower := strings.ToLower(trimmed)
	if strings.Contains(lower, "not fully supported") ||
		strings.Contains(lower, "not directly supported") ||
		strings.Contains(lower, "not supported") {
		return true
	}
	return true
}

func hasCreateTableOrViewHead(sqlText string) bool {
	lines := strings.Split(sqlText, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "--") || strings.HasPrefix(line, "/*") || strings.HasPrefix(line, "*") {
			continue
		}
		lower := strings.ToLower(line)
		return strings.HasPrefix(lower, "create table") ||
			strings.HasPrefix(lower, "create view") ||
			strings.HasPrefix(lower, "create or replace view") ||
			strings.HasPrefix(lower, "create materialized view")
	}
	return false
}

func buildFallbackCreateStatement(dbType string, schemaName string, tableName string, columns []connection.ColumnDefinition) (string, error) {
	return buildFallbackCreateStatementWithText(dbType, schemaName, tableName, columns, nil, defaultDBBackendText)
}

func loadCreateStatementCommentColumns(dbInst db.Database, dbType string, schemaName string, tableName string) ([]connection.ColumnDefinition, error) {
	if !shouldAppendColumnCommentsToCreateStatement(dbType) {
		return nil, nil
	}
	return dbInst.GetColumns(schemaName, tableName)
}

func shouldAppendColumnCommentsToCreateStatement(dbType string) bool {
	switch dbType {
	case "dameng":
		return true
	default:
		return false
	}
}

func appendCreateStatementColumnComments(dbType string, schemaName string, tableName string, ddl string, columns []connection.ColumnDefinition) string {
	if !shouldAppendColumnCommentsToCreateStatement(dbType) || strings.TrimSpace(ddl) == "" || len(columns) == 0 {
		return ddl
	}

	qualifiedTable := quoteTableIdentByType(dbType, schemaName, tableName)
	existingDDLUpper := strings.ToUpper(ddl)
	commentStatements := make([]string, 0, len(columns))
	for _, col := range columns {
		commentSQL := buildFallbackColumnCommentStatement(dbType, schemaName, tableName, qualifiedTable, col.Name, col.Comment)
		if commentSQL == "" {
			continue
		}
		if strings.Contains(existingDDLUpper, strings.ToUpper(commentSQL)) {
			continue
		}
		commentStatements = append(commentStatements, commentSQL)
	}
	if len(commentStatements) == 0 {
		return ddl
	}

	trimmedDDL := strings.TrimRight(ddl, " \t\r\n")
	if !strings.HasSuffix(trimmedDDL, ";") {
		trimmedDDL += ";"
	}
	return trimmedDDL + "\n" + strings.Join(commentStatements, "\n")
}

func appendCreateStatementTableComment(
	dbInst db.Database,
	dbType string,
	metadataSchemaName string,
	metadataTableName string,
	ddlSchemaName string,
	ddlTableName string,
	ddl string,
) string {
	if dbType != "postgres" || strings.TrimSpace(ddl) == "" {
		return ddl
	}
	provider, ok := dbInst.(db.TableCommentProvider)
	if !ok {
		return ddl
	}

	comment, err := provider.GetTableComment(metadataSchemaName, metadataTableName)
	if err != nil || comment == "" {
		return ddl
	}

	tableRef := quoteTableIdentByType(dbType, ddlSchemaName, ddlTableName)
	marker := "COMMENT ON TABLE " + strings.ToUpper(tableRef)
	if strings.Contains(strings.ToUpper(ddl), marker) {
		return ddl
	}

	trimmedDDL := strings.TrimRight(ddl, " \t\r\n")
	if !strings.HasSuffix(trimmedDDL, ";") {
		trimmedDDL += ";"
	}
	return fmt.Sprintf(
		"%s\nCOMMENT ON TABLE %s IS '%s';",
		trimmedDDL,
		tableRef,
		escapeSQLStringLiteralBody(dbType, comment),
	)
}

func buildFallbackCreateStatementWithText(dbType string, schemaName string, tableName string, columns []connection.ColumnDefinition, indexes []connection.IndexDefinition, text func(string, map[string]any) string) (string, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return "", fmt.Errorf("%s", text("db.backend.error.table_name_required", nil))
	}
	if len(columns) == 0 {
		return "", fmt.Errorf("%s", text("db.backend.error.table_columns_missing_for_ddl", nil))
	}

	qualifiedTable := quoteTableIdentByType(dbType, schemaName, table)
	columnLines := make([]string, 0, len(columns)+1)
	columnCommentLines := make([]string, 0, len(columns))
	primaryKeys := make([]string, 0, 2)

	for _, col := range columns {
		colNameRaw := strings.TrimSpace(col.Name)
		if colNameRaw == "" {
			continue
		}
		colType := strings.TrimSpace(col.Type)
		if colType == "" {
			colType = "text"
		}

		colName := quoteIdentByType(dbType, colNameRaw)
		defParts := []string{fmt.Sprintf("%s %s", colName, colType)}

		if supportsFallbackIdentityColumn(dbType, colType, col.Extra) {
			defParts = append(defParts, "IDENTITY(1,1)")
		}
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			defParts = append(defParts, "NOT NULL")
		}
		if col.Default != nil {
			defVal := strings.TrimSpace(*col.Default)
			if defVal != "" {
				defParts = append(defParts, "DEFAULT "+defVal)
			}
		}

		columnLines = append(columnLines, "  "+strings.Join(defParts, " "))
		if commentSQL := buildFallbackColumnCommentStatement(dbType, schemaName, table, qualifiedTable, colNameRaw, col.Comment); commentSQL != "" {
			columnCommentLines = append(columnCommentLines, commentSQL)
		}
		if strings.EqualFold(strings.TrimSpace(col.Key), "PRI") {
			primaryKeys = append(primaryKeys, colName)
		}
	}

	if len(columnLines) == 0 {
		return "", fmt.Errorf("%s", text("db.backend.error.table_columns_empty_for_ddl", nil))
	}
	if len(primaryKeys) > 0 {
		columnLines = append(columnLines, "  PRIMARY KEY ("+strings.Join(primaryKeys, ", ")+")")
	}
	indexStatements := buildFallbackIndexStatements(dbType, qualifiedTable, primaryKeys, indexes)

	ddl := strings.Builder{}
	ddl.WriteString("CREATE TABLE ")
	ddl.WriteString(qualifiedTable)
	ddl.WriteString(" (\n")
	ddl.WriteString(strings.Join(columnLines, ",\n"))
	ddl.WriteString("\n);")
	if len(indexStatements) > 0 {
		ddl.WriteString("\n")
		ddl.WriteString(strings.Join(indexStatements, "\n"))
	}
	if len(columnCommentLines) > 0 {
		ddl.WriteString("\n")
		ddl.WriteString(strings.Join(columnCommentLines, "\n"))
	}
	return ddl.String(), nil
}

func supportsFallbackIdentityColumn(dbType string, columnType string, extra string) bool {
	if !strings.Contains(strings.ToLower(strings.TrimSpace(extra)), "auto_increment") {
		return false
	}
	if dbType == "sqlserver" {
		return true
	}
	if dbType != "dameng" {
		return false
	}

	// 达梦只允许整数列声明 IDENTITY；NUMBER 等类型强行追加会触发
	// Error -2713（非法 IDENTITY 列类型）。GetColumns 对真实自增列会返回
	// SMALLINT、INTEGER 或 BIGINT，因此仅在这些合法类型上还原该属性。
	switch strings.ToUpper(strings.TrimSpace(columnType)) {
	case "SMALLINT", "INTEGER", "BIGINT":
		return true
	default:
		return false
	}
}

type fallbackIndexGroup struct {
	Name    string
	Unique  bool
	Columns []string
}

func buildFallbackIndexStatements(dbType string, qualifiedTable string, primaryKeys []string, indexes []connection.IndexDefinition) []string {
	grouped := groupFallbackIndexDefinitions(indexes)
	if len(grouped) == 0 {
		return nil
	}

	statements := make([]string, 0, len(grouped))
	for _, idx := range grouped {
		if strings.TrimSpace(idx.Name) == "" || len(idx.Columns) == 0 {
			continue
		}
		if sameFallbackColumnNameList(idx.Columns, primaryKeys) {
			continue
		}

		quotedColumns := make([]string, 0, len(idx.Columns))
		for _, columnName := range idx.Columns {
			columnName = strings.TrimSpace(columnName)
			if columnName == "" {
				continue
			}
			quotedColumns = append(quotedColumns, quoteIdentByType(dbType, columnName))
		}
		if len(quotedColumns) == 0 {
			continue
		}

		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		statements = append(statements, fmt.Sprintf(
			"%s %s ON %s (%s);",
			prefix,
			quoteIdentByType(dbType, idx.Name),
			qualifiedTable,
			strings.Join(quotedColumns, ", "),
		))
	}

	return statements
}

func groupFallbackIndexDefinitions(indexes []connection.IndexDefinition) []fallbackIndexGroup {
	if len(indexes) == 0 {
		return nil
	}

	groupMap := make(map[string][]connection.IndexDefinition)
	order := make([]string, 0)
	for _, idx := range indexes {
		name := strings.TrimSpace(idx.Name)
		if name == "" {
			continue
		}
		if _, ok := groupMap[name]; !ok {
			order = append(order, name)
		}
		groupMap[name] = append(groupMap[name], idx)
	}

	grouped := make([]fallbackIndexGroup, 0, len(order))
	for _, name := range order {
		rows := groupMap[name]
		sort.SliceStable(rows, func(i, j int) bool {
			return rows[i].SeqInIndex < rows[j].SeqInIndex
		})

		group := fallbackIndexGroup{Name: name, Unique: true}
		for _, row := range rows {
			if row.NonUnique != 0 {
				group.Unique = false
			}
			columnName := strings.TrimSpace(row.ColumnName)
			if columnName != "" {
				group.Columns = append(group.Columns, columnName)
			}
		}
		grouped = append(grouped, group)
	}

	return grouped
}

func sameFallbackColumnNameList(a []string, b []string) bool {
	if len(a) == 0 || len(a) != len(b) {
		return false
	}
	// 主键列名是按方言引用过的（"id"、`id`、[id]），索引列名是原样的：比较前去掉引号。
	unquote := func(name string) string { return strings.Trim(strings.TrimSpace(name), "\"`[]") }
	for i := range a {
		if !strings.EqualFold(unquote(a[i]), unquote(b[i])) {
			return false
		}
	}
	return true
}

func buildFallbackColumnCommentStatement(dbType string, schemaName string, tableName string, qualifiedTable string, columnName string, comment string) string {
	colName := strings.TrimSpace(columnName)
	commentText := strings.TrimSpace(comment)
	if colName == "" || commentText == "" {
		return ""
	}
	if dbType == "sqlserver" {
		schema := strings.TrimSpace(schemaName)
		if schema == "" {
			schema = "dbo"
		}
		return fmt.Sprintf(
			"EXEC sp_addextendedproperty @name = N'MS_Description', @value = N'%s', @level0type = N'SCHEMA', @level0name = N'%s', @level1type = N'TABLE', @level1name = N'%s', @level2type = N'COLUMN', @level2name = N'%s';",
			strings.ReplaceAll(commentText, "'", "''"),
			strings.ReplaceAll(schema, "'", "''"),
			strings.ReplaceAll(strings.TrimSpace(tableName), "'", "''"),
			strings.ReplaceAll(colName, "'", "''"),
		)
	}
	columnRef := fmt.Sprintf("%s.%s", qualifiedTable, quoteIdentByType(dbType, colName))
	return fmt.Sprintf("COMMENT ON COLUMN %s IS '%s';", columnRef, strings.ReplaceAll(commentText, "'", "''"))
}
