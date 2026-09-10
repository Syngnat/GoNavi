package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strconv"
	"strings"
)

func buildTDengineToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
	plan.Warnings = append(plan.Warnings, tdengineSemanticWarnings(sourceCols)...)

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "TDengine 源端当前不自动补齐已有目标表字段，请先确认目标表结构")
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
		createSQL, warnings, unsupported := buildTDengineToMySQLCreateTableSQL(plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildTDengineToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
	plan.Warnings = append(plan.Warnings, tdengineSemanticWarnings(sourceCols)...)

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		missing := diffMissingColumnNames(sourceCols, targetCols)
		if len(missing) > 0 {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "TDengine 源端当前不自动补齐已有目标表字段，请先确认目标表结构")
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
		createSQL, warnings, unsupported := buildTDengineToPGLikeCreateTableSQL(targetType, plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildTDengineToMySQLCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string, []string) {
	columnDefs := make([]string, 0, len(sourceCols))
	warnings := make([]string, 0)
	unsupported := []string{"TDengine 的索引/外键/触发器/超级表/TTL 等时序语义当前不会自动迁移"}
	for _, col := range sourceCols {
		def, colWarnings := buildTDengineToMySQLColumnDefinition(col)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("mysql", col.Name), def))
		warnings = append(warnings, colWarnings...)
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildTDengineToPGLikeCreateTableSQL(targetType string, targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string, []string) {
	columnDefs := make([]string, 0, len(sourceCols))
	warnings := make([]string, 0)
	unsupported := []string{"TDengine 的索引/外键/触发器/超级表/TTL 等时序语义当前不会自动迁移"}
	for _, col := range sourceCols {
		def, colWarnings := buildTDengineToPGLikeColumnDefinition(col)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		warnings = append(warnings, colWarnings...)
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildTDengineToMySQLColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapTDengineColumnToMySQL(col)
	parts := []string{targetType}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	} else {
		parts = append(parts, "NULL")
	}
	return strings.Join(parts, " "), warnings
}

func buildTDengineToPGLikeColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapTDengineColumnToPGLike(col)
	parts := []string{targetType}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	} else {
		parts = append(parts, "NULL")
	}
	return strings.Join(parts, " "), warnings
}

func tdengineSemanticWarnings(sourceCols []connection.ColumnDefinition) []string {
	warnings := []string{"TDengine 到关系型目标库当前仅迁移列与数据；超级表、TAG 关联、保留策略等时序语义会降级或丢失"}
	for _, col := range sourceCols {
		if isTDengineTagColumn(col) {
			warnings = append(warnings, fmt.Sprintf("字段 %s 为 TDengine TAG 列，迁移到关系型目标后将降级为普通字段", col.Name))
		}
	}
	return dedupeStrings(warnings)
}

func isTDengineTagColumn(col connection.ColumnDefinition) bool {
	return strings.EqualFold(strings.TrimSpace(col.Key), "TAG") || strings.Contains(strings.ToUpper(strings.TrimSpace(col.Extra)), "TAG")
}

func parseTDengineType(raw string) (string, int) {
	cleaned := strings.TrimSpace(strings.ToUpper(raw))
	if cleaned == "" {
		return "", 0
	}
	base := cleaned
	length := 0
	if idx := strings.Index(base, "("); idx >= 0 {
		end := strings.Index(base[idx+1:], ")")
		if end >= 0 {
			lengthText := strings.TrimSpace(base[idx+1 : idx+1+end])
			if v, err := strconv.Atoi(lengthText); err == nil {
				length = v
			}
		}
		base = strings.TrimSpace(base[:idx])
	}
	return base, length
}

func mapTDengineColumnToMySQL(col connection.ColumnDefinition) (string, []string) {
	base, length := parseTDengineType(col.Type)
	warnings := make([]string, 0)
	if isTDengineTagColumn(col) {
		warnings = append(warnings, fmt.Sprintf("字段 %s 为 TDengine TAG 列，已按普通列映射", col.Name))
	}
	switch base {
	case "BOOL", "BOOLEAN":
		return "tinyint(1)", warnings
	case "TINYINT":
		return "tinyint", warnings
	case "UTINYINT":
		return "tinyint unsigned", warnings
	case "SMALLINT":
		return "smallint", warnings
	case "USMALLINT":
		return "smallint unsigned", warnings
	case "INT", "INTEGER":
		return "int", warnings
	case "UINT":
		return "int unsigned", warnings
	case "BIGINT":
		return "bigint", warnings
	case "UBIGINT":
		return "bigint unsigned", warnings
	case "FLOAT":
		return "float", warnings
	case "DOUBLE":
		return "double", warnings
	case "DECIMAL", "NUMERIC":
		if length > 0 {
			return strings.ToLower(strings.TrimSpace(col.Type)), warnings
		}
		return "decimal(38,10)", warnings
	case "TIMESTAMP":
		return "datetime", warnings
	case "DATE":
		return "date", warnings
	case "JSON":
		return "json", warnings
	case "BINARY", "NCHAR", "VARCHAR", "VARBINARY":
		if length > 0 && length <= 65535 {
			return fmt.Sprintf("varchar(%d)", length), warnings
		}
		return "text", warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 MySQL 映射，已降级为 text", col.Name, col.Type))
		return "text", warnings
	}
}

func mapTDengineColumnToPGLike(col connection.ColumnDefinition) (string, []string) {
	base, length := parseTDengineType(col.Type)
	warnings := make([]string, 0)
	if isTDengineTagColumn(col) {
		warnings = append(warnings, fmt.Sprintf("字段 %s 为 TDengine TAG 列，已按普通列映射", col.Name))
	}
	switch base {
	case "BOOL", "BOOLEAN":
		return "boolean", warnings
	case "TINYINT", "UTINYINT", "SMALLINT":
		return "smallint", warnings
	case "USMALLINT", "INT", "INTEGER":
		return "integer", warnings
	case "UINT", "BIGINT":
		return "bigint", warnings
	case "UBIGINT":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 UBIGINT 已映射为 numeric(20,0) 以避免无符号溢出", col.Name))
		return "numeric(20,0)", warnings
	case "FLOAT":
		return "real", warnings
	case "DOUBLE":
		return "double precision", warnings
	case "DECIMAL", "NUMERIC":
		if length > 0 {
			return strings.ToLower(strings.TrimSpace(col.Type)), warnings
		}
		return "numeric(38,10)", warnings
	case "TIMESTAMP":
		return "timestamp", warnings
	case "DATE":
		return "date", warnings
	case "JSON":
		return "jsonb", warnings
	case "BINARY", "NCHAR", "VARCHAR", "VARBINARY":
		if length > 0 {
			return fmt.Sprintf("varchar(%d)", length), warnings
		}
		return "text", warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 PG-like 映射，已降级为 text", col.Name, col.Type))
		return "text", warnings
	}
}
