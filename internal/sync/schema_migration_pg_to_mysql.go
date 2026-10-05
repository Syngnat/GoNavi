package sync

import (
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func buildPGLikeToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(targetType, plan.TargetSchema, plan.TargetTable)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if config.AutoAddColumns {
			addSQL, addWarnings := buildPGLikeToMySQLAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建已有索引/约束")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标表不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标表已存在，执行时不会自动建表")
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标表不存在，将自动建表后导入"
		createSQL, postSQL, warnings, unsupported, idxCreate, idxSkip, err := buildPGLikeToMySQLCreateTablePlan(config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildPGLikeToMySQLAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
	targetSet := make(map[string]struct{}, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		targetSet[key] = struct{}{}
	}
	var sqlList []string
	var warnings []string
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, ok := targetSet[key]; ok {
			continue
		}
		colType, mapWarnings := mapPGLikeColumnToMySQL(col)
		warnings = append(warnings, mapWarnings...)
		if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
			warnings = append(warnings, warning)
		}
		if col.Extra != "" && strings.Contains(strings.ToLower(col.Extra), "auto_increment") {
			warnings = append(warnings, fmt.Sprintf("字段 %s 为自增列，补齐到已有目标表时不会自动补建 AUTO_INCREMENT 属性", col.Name))
		}
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildPGLikeToMySQLCreateTablePlan(config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		def, colWarnings := buildPGLikeToMySQLColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("mysql", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType("mysql", col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "primary") {
			continue
		}
		if len(idx.Columns) == 0 {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 缺少列定义，已跳过", name))
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
		if hasIndexPrefix(idx.Columns) {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 使用前缀长度，当前暂不支持迁移", name))
			continue
		}
		if kind != "" && kind != "btree" {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 类型=%s，当前暂不支持自动迁移", name, idx.IndexType))
			continue
		}
		quotedCols := make([]string, 0, len(idx.Columns))
		for _, col := range idx.Columns {
			quotedCols = append(quotedCols, quoteIdentByType("mysql", col.Name))
		}
		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		postSQL = append(postSQL, fmt.Sprintf("%s %s ON %s (%s)", prefix, quoteIdentByType("mysql", name), quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(quotedCols, ", ")))
		created++
	}
	return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), created, skipped, nil
}

func buildPGLikeToMySQLColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	col.Type = adaptCockroachColumnType(col.Type)
	targetType, warnings := mapPGLikeColumnToMySQL(col)
	parts := []string{targetType}
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") && canUseMySQLAutoIncrement(targetType) {
		parts = append(parts, "AUTO_INCREMENT")
	}
	if adapted, adaptWarning := adaptCockroachDefault(col, false); adaptWarning != "" {
		warnings = append(warnings, adaptWarning)
	} else if defaultSQL, ok, warningText := mapPGLikeDefaultToMySQL(adapted, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapPGLikeColumnToMySQL(col connection.ColumnDefinition) (string, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "text", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 text", col.Name)}
	}
	switch {
	case raw == "boolean" || strings.HasPrefix(raw, "bool"):
		return "tinyint(1)", warnings
	case raw == "smallint":
		return "smallint", warnings
	case raw == "integer" || raw == "int4":
		return "int", warnings
	case raw == "bigint" || raw == "int8":
		return "bigint", warnings
	case strings.HasPrefix(raw, "numeric") || strings.HasPrefix(raw, "decimal"):
		return replaceTypeBase(raw, []string{"numeric", "decimal"}, "decimal"), warnings
	case raw == "real" || raw == "float4":
		return "float", warnings
	case raw == "double precision" || raw == "float8":
		return "double", warnings
	case strings.HasPrefix(raw, "character varying"):
		return strings.Replace(raw, "character varying", "varchar", 1), warnings
	case strings.HasPrefix(raw, "character("):
		return strings.Replace(raw, "character", "char", 1), warnings
	case raw == "character":
		return "char(1)", warnings
	case raw == "text":
		return "text", warnings
	case raw == "json" || raw == "jsonb":
		return "json", warnings
	case raw == "bytea":
		return "longblob", warnings
	case raw == "date":
		return "date", warnings
	// timestamp 必须先于 time 判断：两者前缀相同，先判 time 会把 timestamp 列建成 MySQL 的 TIME。
	case strings.HasPrefix(raw, "timestamp"):
		return "datetime" + pgTemporalPrecisionSuffix(raw), warnings
	case strings.HasPrefix(raw, "time"):
		return "time" + pgTemporalPrecisionSuffix(raw), warnings
	case strings.HasPrefix(raw, "uuid"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 uuid 已映射为 varchar(36)", col.Name))
		return "varchar(36)", warnings
	case strings.Contains(raw, "without time zone") || strings.Contains(raw, "with time zone"):
		return "datetime", warnings
	case strings.HasPrefix(raw, "json"):
		return "json", warnings
	case strings.HasSuffix(raw, "[]") || strings.HasPrefix(raw, "array"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 json", col.Name, col.Type))
		return "json", warnings
	case raw == "user-defined":
		warnings = append(warnings, fmt.Sprintf("字段 %s 为用户自定义类型，已降级为 text", col.Name))
		return "text", warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 text", col.Name, col.Type))
		return "text", warnings
	}
}

// pgTemporalPrecisionSuffix 取 timestamp(n) / time(n) 的小数秒精度（MySQL 最多 6 位）。
func pgTemporalPrecisionSuffix(raw string) string {
	open := strings.Index(raw, "(")
	end := strings.Index(raw, ")")
	if open < 0 || end <= open+1 {
		return ""
	}
	precision, err := strconv.Atoi(strings.TrimSpace(raw[open+1 : end]))
	if err != nil || precision <= 0 {
		return ""
	}
	if precision > 6 {
		precision = 6
	}
	return "(" + strconv.Itoa(precision) + ")"
}

func canUseMySQLAutoIncrement(targetType string) bool {
	text := strings.ToLower(strings.TrimSpace(targetType))
	switch {
	case strings.HasPrefix(text, "tinyint"), strings.HasPrefix(text, "smallint"), strings.HasPrefix(text, "mediumint"), strings.HasPrefix(text, "int"), strings.HasPrefix(text, "bigint"):
		return true
	default:
		return false
	}
}

func mapPGLikeDefaultToMySQL(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" || strings.EqualFold(raw, "null") {
		return "", false, ""
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "nextval(") {
		return "", false, ""
	}
	if strings.Contains(lower, "current_timestamp") || strings.Contains(lower, "now()") {
		return "CURRENT_TIMESTAMP", true, ""
	}
	if targetType == "tinyint(1)" {
		switch lower {
		case "true", "1":
			return "1", true, ""
		case "false", "0":
			return "0", true, ""
		}
	}
	if numericPattern.MatchString(raw) && !isStringLikeTargetType(targetType) {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.Contains(lower, "current_timestamp") && !strings.Contains(lower, "now()") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	return "'" + strings.ReplaceAll(raw, "'", "''") + "'", true, ""
}

func isPGLikeTarget(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb":
		return true
	default:
		return false
	}
}
