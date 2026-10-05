package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func buildMySQLToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
		if len(missing) == 0 {
			plan.PlannedAction = "表结构已一致"
		} else if config.AutoAddColumns {
			targetSet := make(map[string]struct{}, len(targetCols))
			for _, col := range targetCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				targetSet[key] = struct{}{}
			}
			for _, col := range sourceCols {
				key := strings.ToLower(strings.TrimSpace(col.Name))
				if key == "" {
					continue
				}
				if _, ok := targetSet[key]; ok {
					continue
				}
				addSQL, addWarnings, err := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, col)
				if err != nil {
					plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", col.Name, err))
					continue
				}
				plan.Warnings = append(plan.Warnings, addWarnings...)
				plan.PreDataSQL = append(plan.PreDataSQL, addSQL)
				if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
					plan.Warnings = append(plan.Warnings, warning)
				}
			}
			if len(plan.PreDataSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(plan.PreDataSQL))
			} else {
				plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，但未生成可执行补齐 SQL", len(missing))
			}
		} else {
			plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
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
		createSQL, postSQL, warnings, unsupported, unmigrated, idxCreate, idxSkip, err := buildMySQLToMySQLCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildMySQLToMySQLCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	for _, col := range sourceCols {
		def, colWarnings := buildMySQLToMySQLColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if strings.EqualFold(col.Key, "PRI") || strings.EqualFold(col.Key, "PK") {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan(targetType, targetQueryTable,
		stripPrimaryKeyImplicitIndexes(indexes, sourceCols))
	return createSQL, postSQL, dedupeStrings(warnings), unsupported, unmigrated, created, skipped, nil
}

func buildMySQLToMySQLColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType := sanitizeMySQLColumnType(col.Type)
	parts := []string{targetType}
	warnings := make([]string, 0)
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	} else {
		parts = append(parts, "NULL")
	}
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")
	if isAutoIncrement {
		if canUseMySQLAutoIncrement(targetType) {
			parts = append(parts, "AUTO_INCREMENT")
		} else {
			warnings = append(warnings, fmt.Sprintf("字段 %s 的类型 %s 不适合保留 AUTO_INCREMENT，已跳过", col.Name, targetType))
		}
	} else if defaultSQL, ok, warningText := mapMySQLDefaultToMySQL(col, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	extra := strings.ToLower(strings.TrimSpace(col.Extra))
	if strings.Contains(extra, "on update current_timestamp") {
		parts = append(parts, "ON UPDATE CURRENT_TIMESTAMP")
	}
	if comment := strings.TrimSpace(col.Comment); comment != "" {
		parts = append(parts, "COMMENT '"+escapeMySQLStringLiteral(comment)+"'")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapMySQLDefaultToMySQL(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" {
		if isMySQLStringLikeTargetType(targetType) {
			return "''", true, ""
		}
		return "", false, fmt.Sprintf("字段 %s 的空字符串默认值未保留", col.Name)
	}
	lower := strings.ToLower(raw)
	if lower == "null" {
		return "", false, ""
	}
	if strings.ContainsAny(raw, ";\n\r") {
		return "", false, fmt.Sprintf("字段 %s 的默认值包含不安全字符，当前未自动迁移", col.Name)
	}
	switch {
	case strings.HasPrefix(lower, "current_timestamp"):
		return "CURRENT_TIMESTAMP", true, ""
	case lower == "current_date":
		return "CURRENT_DATE", true, ""
	case lower == "current_time":
		return "CURRENT_TIME", true, ""
	}
	if numericPattern.MatchString(raw) && !isMySQLStringLikeTargetType(targetType) {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.HasPrefix(lower, "current_timestamp") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	return "'" + escapeMySQLStringLiteral(raw) + "'", true, ""
}

func isMySQLStringLikeTargetType(targetType string) bool {
	text := strings.ToLower(strings.TrimSpace(targetType))
	return strings.Contains(text, "char") ||
		strings.Contains(text, "text") ||
		strings.Contains(text, "json") ||
		strings.Contains(text, "blob") ||
		strings.Contains(text, "binary") ||
		strings.Contains(text, "enum") ||
		strings.Contains(text, "set")
}

// escapeMySQLStringLiteral 转义内联进 MySQL/ClickHouse DDL 的字符串字面量
// （列注释、DEFAULT 值）。这两个方言的字面量都以反斜杠转义，必须先翻倍反斜杠再翻倍单引号：
// 否则以反斜杠结尾的注释会让 COMMENT '...\' 吞掉闭合引号并生成语法错误的 DDL，
// 含 \n \t 的注释也会被静默改写。
func escapeMySQLStringLiteral(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	return strings.ReplaceAll(escaped, "'", "''")
}
