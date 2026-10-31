package app

import (
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/logger"
)

func getColumnsWithMetadataFallback(
	dbInst db.Database,
	config connection.ConnectionConfig,
	schemaName string,
	tableName string,
	text func(string, map[string]any) string,
) ([]connection.ColumnDefinition, error) {
	columns, err := dbInst.GetColumns(schemaName, tableName)
	if err != nil {
		return nil, err
	}
	if len(columns) > 0 || resolveDDLDBType(config) != "oracle" {
		return columns, nil
	}

	if inferred, inferErr := inferOracleColumnsFromDictionary(dbInst, schemaName, tableName, text); inferErr == nil && len(inferred) > 0 {
		return inferred, nil
	}
	if inferred, inferErr := inferOracleColumnsFromEmptySelect(dbInst, schemaName, tableName, text); inferErr == nil && len(inferred) > 0 {
		return inferred, nil
	}
	return columns, nil
}

func (a *App) DBGetColumns(config connection.ConnectionConfig, dbName string, tableName string) connection.QueryResult {
	runConfig := normalizeMetadataRunConfig(config, dbName)
	text := a.appText

	// 元数据通道：列定义是逐表补全里最重的一类查询，必须与用户查询分开连接池。
	dbInst, err := a.getMetadataDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetColumns 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	// 列定义缓存：key 里必须显式带上 schema/表名——Oracle 与 OceanBase Oracle 模式下
	// normalizeMetadataRunConfig 刻意让同 owner 的元数据请求共用一个连接池，runConfig
	// 本身不含 owner，只按表名缓存会让 S1.T 与 S2.T 互相串味。
	columnsMetaKey := a.buildMetadataCacheKey(runConfig, dbName, metadataColumnCacheKind(schemaName, pureTableName))
	rawColumns, err := a.metadataCacheFetch(columnsMetaKey, func() (interface{}, error) {
		fetched, fetchErr := getColumnsWithMetadataFallback(dbInst, config, schemaName, pureTableName, text)
		if fetchErr != nil {
			return nil, fetchErr
		}
		return append([]connection.ColumnDefinition(nil), fetched...), nil
	})
	var columns []connection.ColumnDefinition
	if rawColumns != nil {
		columns, _ = rawColumns.([]connection.ColumnDefinition)
	}
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateMetadataDatabase(runConfig, err) {
			a.metadataCacheDelete(columnsMetaKey)
			retryInst, retryErr := a.getMetadataDatabaseForcePing(runConfig)
			if retryErr != nil {
				logger.Error(retryErr, "DBGetColumns 重建连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
				return connection.QueryResult{Success: false, Message: retryErr.Error()}
			}
			columns, err = getColumnsWithMetadataFallback(retryInst, config, schemaName, pureTableName, text)
		}
	}
	if err != nil {
		logger.Error(err, "DBGetColumns 获取列定义失败：%s 表=%s.%s schema=%s pureTable=%s", formatConnSummary(runConfig), dbName, tableName, schemaName, pureTableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if len(columns) == 0 {
		// 列定义返回空几乎总是「schema 推断不对或代理会话异常」，而不是表真的没有列。
		// 一旦把空结果写进 45s 的元数据缓存，用户看到的就是「刚才表头还有类型和注释，
		// 现在又没了，过一会儿自己又回来」——这类间歇问题无法复现，只能靠日志定位。
		// 因此空结果不留缓存，并留下可检索的告警，便于对照当时使用的 schema。
		a.metadataCacheDelete(columnsMetaKey)
		logger.Warnf("DBGetColumns 返回空列定义，已跳过缓存：%s 表=%s.%s schema=%q pureTable=%s", formatConnSummary(runConfig), dbName, tableName, schemaName, pureTableName)
	}
	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(columns)}
}

func inferOracleColumnsFromDictionary(dbInst db.Database, schemaName string, tableName string, text func(string, map[string]any) string) ([]connection.ColumnDefinition, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	var lastErr error
	for _, candidate := range appOracleMetadataNamePairs(schemaName, tableName) {
		data, _, err := dbInst.Query(buildAppOracleColumnsQuery(candidate.schema, candidate.table))
		if err != nil {
			lastErr = err
			continue
		}
		columns := parseAppOracleColumns(data)
		if len(columns) > 0 {
			return columns, nil
		}
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("%s", text("db.backend.error.column_definitions_missing", nil))
}

type appOracleMetadataNamePair struct {
	schema string
	table  string
}

func appOracleMetadataNamePairs(schemaName string, tableName string) []appOracleMetadataNamePair {
	rawSchema := strings.TrimSpace(schemaName)
	rawTable := strings.TrimSpace(tableName)
	if rawTable == "" {
		return nil
	}

	upperSchema := strings.ToUpper(rawSchema)
	upperTable := strings.ToUpper(rawTable)
	pairs := make([]appOracleMetadataNamePair, 0, 4)
	seen := map[string]struct{}{}
	add := func(schema string, table string) {
		key := schema + "\x00" + table
		if _, exists := seen[key]; exists {
			return
		}
		seen[key] = struct{}{}
		pairs = append(pairs, appOracleMetadataNamePair{schema: schema, table: table})
	}

	add(rawSchema, rawTable)
	add(upperSchema, upperTable)
	add(rawSchema, upperTable)
	add(upperSchema, rawTable)
	return pairs
}

func buildAppOracleColumnsQuery(schema string, table string) string {
	metadataTableName := escapeAppOracleMetadataLiteral(table)
	metadataSchemaName := escapeAppOracleMetadataLiteral(schema)
	if strings.TrimSpace(schema) == "" {
		return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.char_used AS "CHAR_USED", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		cc.comments AS "COMMENT"
	FROM user_tab_columns c
	LEFT JOIN user_col_comments cc
	  ON cc.table_name = c.table_name AND cc.column_name = c.column_name
	LEFT JOIN (
		SELECT cols.table_name, cols.column_name
		FROM user_constraints cons
		JOIN user_cons_columns cols
		  ON cons.constraint_name = cols.constraint_name
		WHERE cons.constraint_type = 'P'
	) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name
	WHERE c.table_name = '%s'
	ORDER BY c.column_id`, metadataTableName)
	}

	return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.char_used AS "CHAR_USED", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
		CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS "COLUMN_KEY",
		cc.comments AS "COMMENT"
	FROM all_tab_columns c
	LEFT JOIN all_col_comments cc
	  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
	LEFT JOIN (
		SELECT cols.owner, cols.table_name, cols.column_name
		FROM all_constraints cons
		JOIN all_cons_columns cols
		  ON cons.owner = cols.owner AND cons.constraint_name = cols.constraint_name
		WHERE cons.constraint_type = 'P'
	) pk ON c.owner = pk.owner AND c.table_name = pk.table_name AND c.column_name = pk.column_name
	WHERE c.owner = '%s' AND c.table_name = '%s'
	ORDER BY c.column_id`, metadataSchemaName, metadataTableName)
}

func parseAppOracleColumns(data []map[string]interface{}) []connection.ColumnDefinition {
	columns := make([]connection.ColumnDefinition, 0, len(data))
	for _, row := range data {
		name := appOracleRowString(row, "COLUMN_NAME", "column_name")
		if strings.TrimSpace(name) == "" {
			continue
		}

		defaultValue := appOracleRowString(row, "DATA_DEFAULT", "COLUMN_DEFAULT", "data_default", "column_default")
		col := connection.ColumnDefinition{
			Name:     name,
			Type:     formatAppOracleColumnType(row),
			Nullable: normalizeAppOracleNullable(appOracleRowString(row, "NULLABLE", "nullable")),
			Key:      appOracleRowString(row, "COLUMN_KEY", "column_key", "KEY", "key"),
			Extra:    appOracleAutoIncrementExtra(defaultValue),
			Comment:  appOracleRowString(row, "COMMENT", "COMMENTS", "comment", "comments"),
		}
		if defaultValue != "" {
			col.Default = &defaultValue
		}
		columns = append(columns, col)
	}
	return columns
}

func formatAppOracleColumnType(row map[string]interface{}) string {
	return db.FormatOracleColumnType(row)
}

func normalizeAppOracleNullable(nullable string) string {
	switch strings.ToUpper(strings.TrimSpace(nullable)) {
	case "N", "NO":
		return "NO"
	case "Y", "YES":
		return "YES"
	default:
		return strings.TrimSpace(nullable)
	}
}

func appOracleAutoIncrementExtra(defaultValue string) string {
	if strings.Contains(strings.ToUpper(strings.TrimSpace(defaultValue)), "NEXTVAL") {
		return "auto_increment"
	}
	return ""
}

func appOracleRowValue(row map[string]interface{}, names ...string) interface{} {
	for _, name := range names {
		if value, ok := row[name]; ok {
			return value
		}
	}
	for key, value := range row {
		for _, name := range names {
			if strings.EqualFold(key, name) {
				return value
			}
		}
	}
	return nil
}

func appOracleRowString(row map[string]interface{}, names ...string) string {
	return appOracleValueString(appOracleRowValue(row, names...))
}

func appOracleValueString(value interface{}) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case []byte:
		return strings.TrimSpace(string(typed))
	case string:
		return strings.TrimSpace(typed)
	default:
		text := strings.TrimSpace(fmt.Sprintf("%v", typed))
		if strings.EqualFold(text, "<nil>") {
			return ""
		}
		return text
	}
}

func escapeAppOracleMetadataLiteral(text string) string {
	return strings.ReplaceAll(strings.TrimSpace(text), "'", "''")
}

func inferOracleColumnsFromEmptySelect(dbInst db.Database, schemaName string, tableName string, text func(string, map[string]any) string) ([]connection.ColumnDefinition, error) {
	if text == nil {
		text = defaultDBBackendText
	}
	table := strings.TrimSpace(tableName)
	if table == "" {
		return nil, fmt.Errorf("%s", text("db.backend.error.table_name_required", nil))
	}

	query := "SELECT * FROM " + quoteOracleMetadataTableRef(schemaName, table) + " WHERE 1 = 0"
	_, fields, err := dbInst.Query(query)
	if err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, fmt.Errorf("%s", text("db.backend.error.column_definitions_missing", nil))
	}

	columns := make([]connection.ColumnDefinition, 0, len(fields))
	for _, field := range fields {
		name := strings.TrimSpace(field)
		if name == "" {
			continue
		}
		columns = append(columns, connection.ColumnDefinition{
			Name:     name,
			Nullable: "",
			Key:      "",
			Extra:    "",
			Comment:  "",
		})
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("%s", text("db.backend.error.column_definitions_missing", nil))
	}
	return columns, nil
}

func quoteOracleMetadataIdentifier(ident string) string {
	return `"` + strings.ReplaceAll(strings.TrimSpace(ident), `"`, `""`) + `"`
}

func quoteOracleMetadataTableRef(schemaName string, tableName string) string {
	tableRef := quoteOracleMetadataIdentifier(tableName)
	if strings.TrimSpace(schemaName) != "" {
		return quoteOracleMetadataIdentifier(schemaName) + "." + tableRef
	}
	return tableRef
}

func (a *App) DBGetAllColumns(config connection.ConnectionConfig, dbName string) connection.QueryResult {
	scope := config.MetadataScope
	runConfig := normalizeMetadataRunConfig(config, dbName)

	// 全库列查询一次扫全部表，是元数据里最重的单次查询，走元数据通道。
	dbInst, err := a.getMetadataDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	// 全库列缓存。PartialMetadataError（部分表读失败但其余表可用）必须把已取到的列
	// 与错误一起透传：调用方要用它渲染降级结果。fetch 返回 error 时 metadataCacheFetch
	// 只透传值、不写缓存，所以不完整结果不会被固定 45s，下次请求还有机会补齐。
	allColumnsMetaKey := a.buildScopedMetadataCacheKey(runConfig, dbName, metadataCacheKindAllColumns, scope)
	rawCols, err := a.metadataCacheFetch(allColumnsMetaKey, func() (interface{}, error) {
		fetched, fetchErr := db.DiscoverColumns(db.MetadataContext(dbInst), dbInst, runConfig, dbName, scope)
		if fetchErr != nil {
			return append([]connection.ColumnDefinitionWithTable(nil), fetched...), fetchErr
		}
		return append([]connection.ColumnDefinitionWithTable(nil), fetched...), nil
	})
	var cols []connection.ColumnDefinitionWithTable
	if rawCols != nil {
		cols, _ = rawCols.([]connection.ColumnDefinitionWithTable)
	}
	if err != nil {
		var partialErr *db.PartialMetadataError
		if errors.As(err, &partialErr) {
			return connection.QueryResult{
				Success:  true,
				Message:  partialErr.Error(),
				Data:     ensureNonNilSlice(cols),
				Partial:  true,
				Warnings: partialErr.Warnings(),
			}
		}
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	return connection.QueryResult{Success: true, Data: ensureNonNilSlice(cols)}
}
