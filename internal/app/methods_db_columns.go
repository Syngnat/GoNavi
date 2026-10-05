package app

import (
	"errors"
	"fmt"
	"strconv"
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

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		logger.Error(err, "DBGetColumns 获取连接失败：%s 表=%s.%s", formatConnSummary(runConfig), dbName, tableName)
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	schemaName, pureTableName := normalizeMetadataSchemaAndTable(config, dbName, tableName)
	columns, err := getColumnsWithMetadataFallback(dbInst, config, schemaName, pureTableName, text)
	if err != nil && shouldRefreshCachedConnection(err) {
		if a.invalidateCachedDatabase(runConfig, err) {
			retryInst, retryErr := a.getDatabaseForcePing(runConfig)
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
		return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
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

	return fmt.Sprintf(`SELECT c.column_name AS "COLUMN_NAME", c.data_type AS "DATA_TYPE", c.data_length AS "DATA_LENGTH", c.char_length AS "CHAR_LENGTH", c.data_precision AS "DATA_PRECISION", c.data_scale AS "DATA_SCALE", c.nullable AS "NULLABLE", c.data_default AS "DATA_DEFAULT",
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
	dataType := appOracleRowString(row, "DATA_TYPE", "TYPE_NAME", "data_type", "type_name")
	if dataType == "" || strings.Contains(dataType, "(") {
		return dataType
	}

	upperType := strings.ToUpper(dataType)
	if isAppOracleLengthQualifiedType(upperType) {
		if charLength, ok := appOracleRowInt(row, "CHAR_LENGTH", "CHAR_COL_DECL_LENGTH", "char_length", "char_col_decl_length"); ok && charLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, charLength)
		}
		if dataLength, ok := appOracleRowInt(row, "DATA_LENGTH", "data_length"); ok && dataLength > 0 {
			return fmt.Sprintf("%s(%d)", dataType, dataLength)
		}
	}

	if strings.Contains(upperType, "NUMBER") || strings.Contains(upperType, "DECIMAL") || strings.Contains(upperType, "NUMERIC") {
		precision, hasPrecision := appOracleRowInt(row, "DATA_PRECISION", "NUMERIC_PRECISION", "data_precision", "numeric_precision")
		if hasPrecision && precision > 0 {
			scale, hasScale := appOracleRowInt(row, "DATA_SCALE", "NUMERIC_SCALE", "data_scale", "numeric_scale")
			// 负 scale 必须保留，理由与 internal/db 的 formatOracleColumnType 相同：
			// Oracle 的 NUMBER(10,-2) 表示向左舍入到百位，丢掉负号会显示成
			// NUMBER(10) 而改变精度语义。这两条路径都可能被 DBGetColumns 走到
			// （db 层返回空列表时才走本兜底），保持一致才不会让同一列显示出两种类型。
			if hasScale && scale != 0 {
				return fmt.Sprintf("%s(%d,%d)", dataType, precision, scale)
			}
			return fmt.Sprintf("%s(%d)", dataType, precision)
		}
	}

	return dataType
}

func isAppOracleLengthQualifiedType(upperType string) bool {
	switch strings.TrimSpace(upperType) {
	case "CHAR", "NCHAR", "VARCHAR", "VARCHAR2", "NVARCHAR", "NVARCHAR2", "RAW", "BINARY", "VARBINARY":
		return true
	default:
		return strings.Contains(upperType, "CHARACTER")
	}
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

func appOracleRowInt(row map[string]interface{}, names ...string) (int, bool) {
	value := appOracleRowValue(row, names...)
	switch typed := value.(type) {
	case int:
		return typed, true
	case int8:
		return int(typed), true
	case int16:
		return int(typed), true
	case int32:
		return int(typed), true
	case int64:
		return int(typed), true
	case uint:
		return int(typed), true
	case uint8:
		return int(typed), true
	case uint16:
		return int(typed), true
	case uint32:
		return int(typed), true
	case uint64:
		return int(typed), true
	case float32:
		return int(typed), true
	case float64:
		return int(typed), true
	case []byte:
		parsed, err := strconv.Atoi(strings.TrimSpace(string(typed)))
		return parsed, err == nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
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
	runConfig := normalizeMetadataRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	cols, err := dbInst.GetAllColumns(dbName)
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
