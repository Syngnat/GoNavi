package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func buildMySQLToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
			addSQL, addWarnings := buildMySQLToPGLikeAddColumnSQL(targetType, plan.TargetQueryTable, sourceCols, targetCols)
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
		createSQL, postSQL, warnings, unsupported, unmigrated, idxCreate, idxSkip, err := buildMySQLToPGLikeCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
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

func buildMySQLToPGLikeAddColumnSQL(targetType string, targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType, _, mapWarnings := mapMySQLColumnToKingbase(col)
		warnings = append(warnings, mapWarnings...)
		if warning := relaxedNotNullAddColumnWarning(col); warning != "" {
			warnings = append(warnings, warning)
		}
		if col.Extra != "" && strings.Contains(strings.ToLower(col.Extra), "auto_increment") {
			warnings = append(warnings, fmt.Sprintf("字段 %s 为自增列，补齐到已有目标表时不会自动补建 identity/sequence", col.Name))
		}
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			quoteIdentByType(targetType, col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildMySQLToPGLikeCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	byteLengthWidener := newByteLengthWidener(resolveMigrationDBType(config.SourceConfig), targetType)
	for _, col := range sourceCols {
		col = byteLengthWidener.Adapt(col)
		def, colWarnings := buildMySQLToPGLikeColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	warnings = append(warnings, byteLengthWidener.Warnings()...)
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

func buildMySQLToPGLikeColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, useIdentity, warnings := mapMySQLColumnToKingbase(col)
	parts := []string{targetType}
	if useIdentity {
		parts = append(parts, "GENERATED BY DEFAULT AS IDENTITY")
	}
	if !useIdentity {
		if defaultSQL, ok, warningText := mapMySQLDefaultToKingbase(col, targetType); warningText != "" {
			warnings = append(warnings, warningText)
		} else if ok {
			parts = append(parts, "DEFAULT "+defaultSQL)
		}
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}
