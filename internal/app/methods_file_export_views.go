package app

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func buildExportObjectOrder(
	config connection.ConnectionConfig,
	dbName string,
	rawObjects []string,
	viewLookup map[string]string,
	includeAllViews bool,
) []string {
	tableSet := make(map[string]string, len(rawObjects))
	viewSet := make(map[string]string, len(rawObjects))

	for _, rawName := range rawObjects {
		objectName := strings.TrimSpace(rawName)
		if objectName == "" {
			continue
		}
		key := normalizeExportObjectKey(config, dbName, objectName)
		if key == "" {
			continue
		}
		if canonicalViewName, ok := viewLookup[key]; ok {
			if strings.TrimSpace(canonicalViewName) == "" {
				canonicalViewName = objectName
			}
			viewSet[key] = canonicalViewName
			delete(tableSet, key)
			continue
		}
		if _, isView := viewSet[key]; isView {
			continue
		}
		if _, exists := tableSet[key]; !exists {
			tableSet[key] = objectName
		}
	}

	if includeAllViews {
		for key, viewName := range viewLookup {
			canonicalViewName := strings.TrimSpace(viewName)
			if canonicalViewName == "" {
				continue
			}
			viewSet[key] = canonicalViewName
			delete(tableSet, key)
		}
	}

	tables := mapValuesSorted(tableSet)
	views := mapValuesSorted(viewSet)
	return append(tables, views...)
}

func filterExportObjectsBySchema(
	config connection.ConnectionConfig,
	dbName string,
	rawObjects []string,
	schemaName string,
) []string {
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeSchemaName == "" {
		return append([]string(nil), rawObjects...)
	}

	filtered := make([]string, 0, len(rawObjects))
	for _, rawName := range rawObjects {
		objectName := strings.TrimSpace(rawName)
		if objectName == "" {
			continue
		}
		objectSchemaName, _ := normalizeSchemaAndTable(config, dbName, objectName)
		if strings.EqualFold(strings.TrimSpace(objectSchemaName), safeSchemaName) {
			filtered = append(filtered, objectName)
		}
	}
	return filtered
}

func filterExportViewLookupBySchema(
	config connection.ConnectionConfig,
	dbName string,
	viewLookup map[string]string,
	schemaName string,
) map[string]string {
	safeSchemaName := strings.TrimSpace(schemaName)
	if safeSchemaName == "" {
		cloned := make(map[string]string, len(viewLookup))
		for key, value := range viewLookup {
			cloned[key] = value
		}
		return cloned
	}

	filtered := make(map[string]string, len(viewLookup))
	for key, objectName := range viewLookup {
		objectSchemaName, _ := normalizeSchemaAndTable(config, dbName, objectName)
		if strings.EqualFold(strings.TrimSpace(objectSchemaName), safeSchemaName) {
			filtered[key] = objectName
		}
	}
	return filtered
}

func mapValuesSorted(values map[string]string) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func normalizeExportObjectKey(config connection.ConnectionConfig, dbName string, objectName string) string {
	schemaName, pureName := normalizeSchemaAndTable(config, dbName, objectName)
	return normalizeExportObjectKeyByParts(schemaName, pureName)
}

func normalizeExportObjectKeyByParts(schemaName, objectName string) string {
	return strings.ToLower(strings.TrimSpace(qualifyTable(schemaName, objectName)))
}

func listViewNameLookup(dbInst db.Database, config connection.ConnectionConfig, dbName string) map[string]string {
	viewLookup, _ := listViewNameLookupWithStatus(dbInst, config, dbName)
	return viewLookup
}

func listViewNameLookupWithStatus(dbInst db.Database, config connection.ConnectionConfig, dbName string) (map[string]string, error) {
	viewLookup := make(map[string]string)
	var firstErr error
	querySucceeded := false
	queries := buildListViewQueries(config, dbName)
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForExport(dbInst, config, query)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		querySucceeded = true
		for _, row := range rows {
			tableType := strings.ToUpper(exportRowValueCI(row, "table_type", "type"))
			if tableType != "" && tableType != "VIEW" {
				continue
			}
			schemaName := exportRowValueCI(row, "schema_name", "table_schema", "owner", "schema", "db")
			if registryHidesSchema(config.Type, schemaName) {
				continue
			}
			viewName := exportRowValueCI(row, "object_name", "view_name", "table_name", "name")
			if viewName == "" {
				viewName = exportInferObjectName(row)
			}
			if strings.TrimSpace(viewName) == "" {
				continue
			}
			fullName := strings.TrimSpace(qualifyTable(schemaName, viewName))
			if fullName == "" {
				fullName = strings.TrimSpace(viewName)
			}
			key := normalizeExportObjectKey(config, dbName, fullName)
			if key == "" {
				continue
			}
			if _, exists := viewLookup[key]; !exists {
				viewLookup[key] = fullName
			}
		}
	}
	if !querySucceeded && firstErr != nil {
		return viewLookup, firstErr
	}
	return viewLookup, nil
}

func buildListViewQueries(config connection.ConnectionConfig, dbName string) []string {
	if queries, ok := registryListViewQueries(config.Type); ok {
		return queries
	}
	dbType := resolveDDLDBType(config)
	escapedDbName := escapeSQLLiteral(dbName)
	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		queries := []string{
			fmt.Sprintf(`SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name, TABLE_TYPE AS table_type FROM information_schema.tables WHERE TABLE_TYPE='VIEW' AND %s ORDER BY TABLE_NAME`, mysqlMetadataSchemaPredicate("TABLE_SCHEMA", dbName)),
		}
		if strings.TrimSpace(dbName) != "" {
			queries = append(queries, fmt.Sprintf("SHOW FULL TABLES FROM %s WHERE Table_type = 'VIEW'", quoteIdentByType("mysql", dbName)))
		} else {
			queries = append(queries, "SHOW FULL TABLES WHERE Table_type = 'VIEW'")
		}
		return queries
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		return []string{
			`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name`,
		}
	case "sqlserver":
		return []string{
			`SELECT s.name AS schema_name, v.name AS object_name FROM sys.views v JOIN sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name`,
		}
	case "oracle", "dameng":
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT VIEW_NAME AS object_name FROM user_views ORDER BY VIEW_NAME`,
			}
		}
		return []string{
			fmt.Sprintf("SELECT OWNER AS schema_name, VIEW_NAME AS object_name FROM all_views WHERE OWNER = '%s' ORDER BY VIEW_NAME", strings.ToUpper(escapedDbName)),
		}
	case "sqlite":
		return []string{
			"SELECT name AS object_name FROM sqlite_master WHERE type='view' ORDER BY name",
		}
	case "duckdb":
		return []string{
			`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name`,
		}
	case "clickhouse":
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT database AS schema_name, name AS object_name FROM system.tables WHERE engine LIKE '%View%' ORDER BY database, name`,
			}
		}
		return []string{
			fmt.Sprintf(`SELECT database AS schema_name, name AS object_name FROM system.tables WHERE engine LIKE '%%View%%' AND database='%s' ORDER BY name`, escapedDbName),
		}
	default:
		if strings.TrimSpace(dbName) == "" {
			return []string{
				`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views`,
			}
		}
		return []string{
			fmt.Sprintf(`SELECT table_schema AS schema_name, table_name AS object_name FROM information_schema.views WHERE table_schema='%s'`, escapedDbName),
		}
	}
}

func tryGetViewCreateStatement(
	exportCtx context.Context,
	dbInst db.Database,
	config connection.ConnectionConfig,
	dbName string,
	schemaName string,
	viewName string,
) (string, bool) {
	if ddl, ok := registryDriverViewCreateStatement(dbInst, config.Type, schemaName, viewName); ok {
		return ensureSQLTerminator(ddl), true
	}
	queries := buildViewCreateQueries(config, dbName, schemaName, viewName)
	for _, query := range queries {
		if strings.TrimSpace(query) == "" {
			continue
		}
		rows, _, err := queryDataForViewDDL(exportCtx, dbInst, config, query)
		if err != nil || len(rows) == 0 {
			continue
		}
		createSQL := strings.TrimSpace(extractViewCreateSQL(rows[0]))
		if createSQL == "" {
			continue
		}
		if looksLikeSelectOrWith(createSQL) {
			dbType := resolveDDLDBType(config)
			createSQL = fmt.Sprintf("CREATE VIEW %s AS %s", quoteTableIdentByType(dbType, schemaName, viewName), strings.TrimSuffix(strings.TrimSpace(createSQL), ";"))
		}
		return ensureSQLTerminator(createSQL), true
	}
	return "", false
}

type viewDDLQueryCollector struct {
	columns []string
	rows    []map[string]interface{}
}

func (c *viewDDLQueryCollector) SetColumns(columns []string) error {
	c.columns = append([]string(nil), columns...)
	return nil
}

func (c *viewDDLQueryCollector) ConsumeRow(row map[string]interface{}) error {
	c.rows = append(c.rows, row)
	return nil
}

func queryDataForViewDDL(
	exportCtx context.Context,
	dbInst db.Database,
	config connection.ConnectionConfig,
	query string,
) ([]map[string]interface{}, []string, error) {
	switch resolveDDLDBType(config) {
	case "oracle", "dameng":
		collector := &viewDDLQueryCollector{}
		if err := streamQueryDataForExportWithContext(exportCtx, dbInst, config, query, collector); err != nil {
			return nil, nil, err
		}
		return collector.rows, collector.columns, nil
	default:
		return queryDataForExportWithContext(exportCtx, dbInst, config, query)
	}
}

func buildViewCreateQueries(config connection.ConnectionConfig, dbName, schemaName, viewName string) []string {
	dbType := resolveDDLDBType(config)
	safeSchema := strings.TrimSpace(schemaName)
	safeView := strings.TrimSpace(viewName)
	if safeView == "" {
		return nil
	}
	escapedSchema := escapeSQLLiteral(safeSchema)
	escapedView := escapeSQLLiteral(safeView)
	escapedDB := escapeSQLLiteral(dbName)

	switch dbType {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "sphinx":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SHOW CREATE VIEW %s.%s", quoteIdentByType("mysql", safeSchema), quoteIdentByType("mysql", safeView)),
			}
		}
		return []string{
			fmt.Sprintf("SHOW CREATE VIEW %s", quoteIdentByType("mysql", safeView)),
		}
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		if safeSchema == "" {
			safeSchema = "public"
		}
		regClassName := fmt.Sprintf(`"%s"."%s"`, strings.ReplaceAll(safeSchema, `"`, `""`), strings.ReplaceAll(safeView, `"`, `""`))
		regClassName = strings.ReplaceAll(regClassName, "'", "''")
		return []string{
			fmt.Sprintf("SELECT pg_get_viewdef('%s'::regclass, true) AS ddl", regClassName),
		}
	case "sqlserver":
		schema := safeSchema
		if schema == "" {
			schema = "dbo"
		}
		return []string{
			fmt.Sprintf(`SELECT m.definition AS ddl
FROM sys.views v
JOIN sys.schemas s ON v.schema_id = s.schema_id
JOIN sys.sql_modules m ON v.object_id = m.object_id
WHERE s.name = '%s' AND v.name = '%s'`,
				escapeSQLLiteral(schema), escapedView),
		}
	case "oracle", "dameng":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('VIEW', '%s', '%s') AS ddl FROM DUAL", strings.ToUpper(escapedView), strings.ToUpper(escapeSQLLiteral(safeSchema))),
				fmt.Sprintf("SELECT TEXT AS ddl FROM ALL_VIEWS WHERE OWNER = '%s' AND VIEW_NAME = '%s'", strings.ToUpper(escapeSQLLiteral(safeSchema)), strings.ToUpper(escapedView)),
			}
		}
		return []string{
			fmt.Sprintf("SELECT DBMS_METADATA.GET_DDL('VIEW', '%s') AS ddl FROM DUAL", strings.ToUpper(escapedView)),
			fmt.Sprintf("SELECT TEXT AS ddl FROM USER_VIEWS WHERE VIEW_NAME = '%s'", strings.ToUpper(escapedView)),
		}
	case "sqlite":
		return []string{
			fmt.Sprintf("SELECT sql AS ddl FROM sqlite_master WHERE type='view' AND name='%s'", escapedView),
		}
	case "duckdb":
		if safeSchema == "" {
			safeSchema = "main"
			escapedSchema = "main"
		}
		return []string{
			fmt.Sprintf("SELECT sql AS ddl FROM duckdb_views() WHERE view_name = '%s' AND schema_name = '%s' LIMIT 1", escapedView, escapedSchema),
			fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedSchema),
		}
	case "clickhouse":
		if safeSchema == "" {
			safeSchema = strings.TrimSpace(dbName)
		}
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SHOW CREATE TABLE %s.%s", quoteIdentByType("clickhouse", safeSchema), quoteIdentByType("clickhouse", safeView)),
			}
		}
		return []string{
			fmt.Sprintf("SHOW CREATE TABLE %s", quoteIdentByType("clickhouse", safeView)),
		}
	default:
		if safeSchema != "" {
			return []string{
				fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedSchema),
			}
		}
		if strings.TrimSpace(dbName) != "" {
			return []string{
				fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' AND table_schema = '%s' LIMIT 1", escapedView, escapedDB),
			}
		}
		return []string{
			fmt.Sprintf("SELECT view_definition AS ddl FROM information_schema.views WHERE table_name = '%s' LIMIT 1", escapedView),
		}
	}
}

func extractViewCreateSQL(row map[string]interface{}) string {
	if row == nil {
		return ""
	}
	ddl := exportRowValueCI(row, "create view", "create_statement", "create_sql", "ddl", "sql", "view_definition", "definition")
	if ddl != "" {
		return normalizeMySQLViewCreateSQL(ddl)
	}
	for _, value := range row {
		if value == nil {
			continue
		}
		text := strings.TrimSpace(fmt.Sprintf("%v", value))
		if text == "" || text == "<nil>" {
			continue
		}
		lower := strings.ToLower(text)
		if strings.HasPrefix(lower, "create ") || strings.HasPrefix(lower, "select ") || strings.HasPrefix(lower, "with ") {
			return normalizeMySQLViewCreateSQL(text)
		}
	}
	return ""
}

func normalizeMySQLViewCreateSQL(sql string) string {
	trimmed := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(sql), ";"))
	if trimmed == "" {
		return ""
	}
	if mysqlCreateViewPrefixPattern.MatchString(trimmed) {
		return mysqlCreateViewPrefixPattern.ReplaceAllString(trimmed, "CREATE OR REPLACE VIEW ")
	}
	return trimmed
}
