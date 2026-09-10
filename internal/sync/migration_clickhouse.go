package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"regexp"
	"strings"
)

func buildMySQLToClickHousePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(config.SourceConfig.Type, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(config.TargetConfig.Type, plan.TargetSchema, plan.TargetTable)
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
			addSQL, addWarnings := buildMySQLToClickHouseAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		plan.Warnings = append(plan.Warnings, "ClickHouse 目标端建议优先使用仅插入或全量覆盖；更新/删除语义与传统关系型存在差异")
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
		createSQL, warnings, unsupported := buildMySQLToClickHouseCreateTableSQL(plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildPGLikeToClickHousePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
			addSQL, addWarnings := buildPGLikeToClickHouseAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		plan.Warnings = append(plan.Warnings, "ClickHouse 目标端建议优先使用仅插入或全量覆盖；更新/删除语义与传统关系型存在差异")
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
		createSQL, warnings, unsupported := buildPGLikeToClickHouseCreateTableSQL(plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildClickHouseToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(config.SourceConfig.Type, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedTargetNameForQuery(config.TargetConfig.Type, plan.TargetSchema, plan.TargetTable)
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
			addSQL, addWarnings := buildClickHouseToMySQLAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		plan.Warnings = append(plan.Warnings, "ClickHouse 源端索引/约束元数据有限，反向迁移将以字段和数据为主")
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
		createSQL, warnings := buildClickHouseToMySQLCreateTableSQL(plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildClickHouseToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
			addSQL, addWarnings := buildClickHouseToPGLikeAddColumnSQL(targetType, plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		}
		plan.Warnings = append(plan.Warnings, "ClickHouse 源端索引/约束元数据有限，反向迁移将以字段和数据为主")
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
		createSQL, warnings, unsupported := buildClickHouseToPGLikeCreateTableSQL(targetType, plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildClickHouseToClickHousePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
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
			addSQL, addWarnings := buildClickHouseToClickHouseAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
		} else {
			plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
		}
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标表已存在，当前仅执行数据导入；不会自动重建 ClickHouse ORDER BY/PARTITION/TTL 等表级语义")
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
		createSQL, warnings, unsupported := buildClickHouseToClickHouseCreateTableSQL(plan.TargetQueryTable, sourceCols)
		plan.CreateTableSQL = createSQL
		plan.Warnings = append(plan.Warnings, warnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildClickHouseToClickHouseAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType := sanitizeClickHouseColumnType(col.Type)
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteQualifiedIdentByType("clickhouse", targetQueryTable),
			quoteIdentByType("clickhouse", col.Name),
			colType,
		))
		if strings.TrimSpace(col.Type) != colType {
			warnings = append(warnings, fmt.Sprintf("字段 %s 类型为空或包含不安全字符，已降级为 %s", col.Name, colType))
		}
	}
	return sqlList, dedupeStrings(warnings)
}

func buildPGLikeToClickHouseAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType, mapWarnings := mapPGLikeColumnToClickHouse(col)
		warnings = append(warnings, mapWarnings...)
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteQualifiedIdentByType("clickhouse", targetQueryTable),
			quoteIdentByType("clickhouse", col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildMySQLToClickHouseAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType, mapWarnings := mapMySQLColumnToClickHouse(col)
		warnings = append(warnings, mapWarnings...)
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteQualifiedIdentByType("clickhouse", targetQueryTable),
			quoteIdentByType("clickhouse", col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildClickHouseToPGLikeAddColumnSQL(targetType string, targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType, mapWarnings := mapClickHouseColumnToPGLike(col)
		warnings = append(warnings, mapWarnings...)
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			quoteIdentByType(targetType, col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildClickHouseToMySQLAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType, mapWarnings := mapClickHouseColumnToMySQL(col)
		warnings = append(warnings, mapWarnings...)
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildPGLikeToClickHouseCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string, []string) {
	columnDefs := make([]string, 0, len(sourceCols))
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	orderByCols := make([]string, 0)
	for _, col := range sourceCols {
		def, colWarnings := buildPGLikeToClickHouseColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("clickhouse", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			orderByCols = append(orderByCols, quoteIdentByType("clickhouse", col.Name))
		}
	}
	orderExpr := "tuple()"
	if len(orderByCols) > 0 {
		orderExpr = "(" + strings.Join(orderByCols, ", ") + ")"
	} else {
		warnings = append(warnings, "源表未识别到主键，ClickHouse 将使用 ORDER BY tuple() 建表，后续查询性能可能受影响")
	}
	warnings = append(warnings, "ClickHouse 不保留关系型外键/唯一约束语义，将仅迁移字段与数据")
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n) ENGINE = MergeTree() ORDER BY %s", quoteQualifiedIdentByType("clickhouse", targetQueryTable), strings.Join(columnDefs, ",\n  "), orderExpr)
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildMySQLToClickHouseCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string, []string) {
	columnDefs := make([]string, 0, len(sourceCols))
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	orderByCols := make([]string, 0)
	for _, col := range sourceCols {
		def, colWarnings := buildMySQLToClickHouseColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("clickhouse", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			orderByCols = append(orderByCols, quoteIdentByType("clickhouse", col.Name))
		}
	}
	orderExpr := "tuple()"
	if len(orderByCols) > 0 {
		orderExpr = "(" + strings.Join(orderByCols, ", ") + ")"
	} else {
		warnings = append(warnings, "源表未识别到主键，ClickHouse 将使用 ORDER BY tuple() 建表，后续查询性能可能受影响")
	}
	warnings = append(warnings, "ClickHouse 不保留关系型外键/唯一约束语义，将仅迁移字段与数据")
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n) ENGINE = MergeTree() ORDER BY %s", quoteQualifiedIdentByType("clickhouse", targetQueryTable), strings.Join(columnDefs, ",\n  "), orderExpr)
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildClickHouseToPGLikeCreateTableSQL(targetType string, targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string, []string) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := []string{"ClickHouse ORDER BY/PARTITION/TTL/Projection/物化视图 语义当前不会自动迁移到 PG-like"}
	pkCols := make([]string, 0)
	for _, col := range sourceCols {
		def, colWarnings := buildClickHouseToPGLikeColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	} else {
		warnings = append(warnings, "ClickHouse 源端未返回主键信息，目标 PG-like 表将不自动创建主键")
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildClickHouseToMySQLCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	pkCols := make([]string, 0)
	for _, col := range sourceCols {
		def, colWarnings := buildClickHouseToMySQLColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("mysql", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType("mysql", col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	} else {
		warnings = append(warnings, "ClickHouse 源端未返回主键信息，目标 MySQL 表将不自动创建主键")
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	return createSQL, dedupeStrings(warnings)
}

func buildClickHouseToClickHouseCreateTableSQL(targetQueryTable string, sourceCols []connection.ColumnDefinition) (string, []string, []string) {
	columnDefs := make([]string, 0, len(sourceCols))
	warnings := make([]string, 0)
	unsupported := []string{"ClickHouse 同库迁移当前按列元数据重建基础 MergeTree 表；PARTITION BY/TTL/Projection/物化视图/表设置不会自动迁移"}
	orderByCols := make([]string, 0)
	for _, col := range sourceCols {
		def, colWarnings := buildClickHouseToClickHouseColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType("clickhouse", col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" || col.Key == "MUL" {
			orderByCols = append(orderByCols, quoteIdentByType("clickhouse", col.Name))
		}
	}
	orderExpr := "tuple()"
	if len(orderByCols) > 0 {
		orderExpr = "(" + strings.Join(orderByCols, ", ") + ")"
	} else {
		warnings = append(warnings, "源表未返回排序键，ClickHouse 将使用 ORDER BY tuple() 建表")
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n) ENGINE = MergeTree() ORDER BY %s", quoteQualifiedIdentByType("clickhouse", targetQueryTable), strings.Join(columnDefs, ",\n  "), orderExpr)
	return createSQL, dedupeStrings(warnings), dedupeStrings(unsupported)
}

func buildClickHouseToClickHouseColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType := sanitizeClickHouseColumnType(col.Type)
	parts := []string{targetType}
	warnings := make([]string, 0)
	if strings.TrimSpace(col.Type) != targetType {
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型为空或包含不安全字符，已降级为 %s", col.Name, targetType))
	}
	extra := strings.ToUpper(strings.TrimSpace(col.Extra))
	if extra == "MATERIALIZED" || extra == "ALIAS" {
		warnings = append(warnings, fmt.Sprintf("字段 %s 为 %s 表达式列，当前仅迁移字段类型，不内联表达式", col.Name, extra))
	} else if col.Default != nil {
		rawDefault := strings.TrimSpace(*col.Default)
		if rawDefault != "" && !strings.ContainsAny(rawDefault, ";\n\r") {
			parts = append(parts, "DEFAULT "+rawDefault)
		} else if rawDefault != "" {
			warnings = append(warnings, fmt.Sprintf("字段 %s 的默认值包含不安全字符，当前未自动迁移", col.Name))
		}
	}
	if comment := strings.TrimSpace(col.Comment); comment != "" {
		parts = append(parts, "COMMENT '"+escapeMySQLStringLiteral(comment)+"'")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func sanitizeClickHouseColumnType(t string) string {
	tt := strings.TrimSpace(t)
	if tt == "" {
		return "String"
	}
	if strings.ContainsAny(tt, "`;\n\r") {
		return "String"
	}
	return tt
}

func buildPGLikeToClickHouseColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapPGLikeColumnToClickHouse(col)
	parts := []string{targetType}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func buildMySQLToClickHouseColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapMySQLColumnToClickHouse(col)
	parts := []string{targetType}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") && !strings.HasPrefix(strings.ToLower(targetType), "nullable(") {
		return strings.Join(parts, " "), dedupeStrings(warnings)
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func buildClickHouseToPGLikeColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapClickHouseColumnToPGLike(col)
	parts := []string{targetType}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func buildClickHouseToMySQLColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, warnings := mapClickHouseColumnToMySQL(col)
	parts := []string{targetType}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapPGLikeColumnToClickHouse(col connection.ColumnDefinition) (string, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "String", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 String", col.Name)}
	}
	baseType := "String"
	switch {
	case raw == "boolean" || strings.HasPrefix(raw, "bool"):
		baseType = "UInt8"
	case raw == "smallint":
		baseType = "Int16"
	case raw == "integer" || raw == "int4":
		baseType = "Int32"
	case raw == "bigint" || raw == "int8":
		baseType = "Int64"
	case strings.HasPrefix(raw, "numeric"), strings.HasPrefix(raw, "decimal"):
		baseType = replaceTypeBase(raw, []string{"numeric", "decimal"}, "Decimal")
	case raw == "real" || raw == "float4":
		baseType = "Float32"
	case raw == "double precision" || raw == "float8":
		baseType = "Float64"
	case raw == "date":
		baseType = "Date"
	case strings.HasPrefix(raw, "timestamp") || strings.Contains(raw, "without time zone") || strings.Contains(raw, "with time zone"):
		baseType = "DateTime"
	case strings.HasPrefix(raw, "time"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 String", col.Name, col.Type))
		baseType = "String"
	case strings.HasPrefix(raw, "character varying"), strings.HasPrefix(raw, "varchar("), strings.HasPrefix(raw, "character("), strings.HasPrefix(raw, "char("), raw == "character", raw == "text", raw == "uuid":
		baseType = "String"
	case raw == "json" || raw == "jsonb" || raw == "bytea":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 String", col.Name, col.Type))
		baseType = "String"
	case strings.HasSuffix(raw, "[]") || strings.HasPrefix(raw, "array"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 String", col.Name, col.Type))
		baseType = "String"
	case raw == "user-defined":
		warnings = append(warnings, fmt.Sprintf("字段 %s 为用户自定义类型，已降级为 String", col.Name))
		baseType = "String"
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 String", col.Name, col.Type))
		baseType = "String"
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "YES") && !strings.HasPrefix(strings.ToLower(baseType), "nullable(") {
		baseType = fmt.Sprintf("Nullable(%s)", baseType)
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "identity") || strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
		warnings = append(warnings, fmt.Sprintf("字段 %s 的 identity/自增语义在 ClickHouse 中不保留", col.Name))
	}
	return baseType, dedupeStrings(warnings)
}

func mapMySQLColumnToClickHouse(col connection.ColumnDefinition) (string, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "String", []string{fmt.Sprintf("字段 %s 类型为空，已降级为 String", col.Name)}
	}
	unsigned := strings.Contains(raw, "unsigned")
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	baseType := "String"
	switch {
	case strings.HasPrefix(clean, "tinyint(1)"):
		baseType = "UInt8"
	case strings.HasPrefix(clean, "tinyint"):
		if unsigned {
			baseType = "UInt8"
		} else {
			baseType = "Int8"
		}
	case strings.HasPrefix(clean, "smallint"):
		if unsigned {
			baseType = "UInt16"
		} else {
			baseType = "Int16"
		}
	case strings.HasPrefix(clean, "mediumint"), strings.HasPrefix(clean, "int"), strings.HasPrefix(clean, "integer"):
		if unsigned {
			baseType = "UInt32"
		} else {
			baseType = "Int32"
		}
	case strings.HasPrefix(clean, "bigint"):
		if unsigned {
			baseType = "UInt64"
		} else {
			baseType = "Int64"
		}
	case strings.HasPrefix(clean, "decimal"), strings.HasPrefix(clean, "numeric"):
		baseType = replaceTypeBase(strings.Title(clean), []string{"Decimal", "Numeric"}, "Decimal")
	case strings.HasPrefix(clean, "float"):
		baseType = "Float32"
	case strings.HasPrefix(clean, "double"):
		baseType = "Float64"
	case strings.HasPrefix(clean, "date"):
		baseType = "Date"
	case strings.HasPrefix(clean, "datetime"), strings.HasPrefix(clean, "timestamp"):
		baseType = "DateTime"
	case strings.HasPrefix(clean, "time"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 time 已降级为 String", col.Name))
		baseType = "String"
	case strings.HasPrefix(clean, "json"), strings.HasPrefix(clean, "enum"), strings.HasPrefix(clean, "set"), strings.HasPrefix(clean, "char"), strings.HasPrefix(clean, "varchar"), strings.Contains(clean, "text"):
		baseType = "String"
	case strings.Contains(clean, "blob"), strings.Contains(clean, "binary"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 二进制类型已降级为 String", col.Name))
		baseType = "String"
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 String", col.Name, col.Type))
		baseType = "String"
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "YES") && !strings.HasPrefix(strings.ToLower(baseType), "nullable(") {
		baseType = fmt.Sprintf("Nullable(%s)", baseType)
	}
	if strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
		warnings = append(warnings, fmt.Sprintf("字段 %s 的 AUTO_INCREMENT 在 ClickHouse 中不保留自增语义", col.Name))
	}
	return baseType, dedupeStrings(warnings)
}

var clickHouseDecimalPattern = regexp.MustCompile(`^(decimal|numeric)\((\d+)\s*,\s*(\d+)\)$`)
var clickHouseStringArgsPattern = regexp.MustCompile(`^fixedstring\((\d+)\)$`)

func mapClickHouseColumnToPGLike(col connection.ColumnDefinition) (string, []string) {
	raw := strings.TrimSpace(col.Type)
	lower := strings.ToLower(raw)
	warnings := make([]string, 0)
	if strings.HasPrefix(lower, "nullable(") && strings.HasSuffix(lower, ")") {
		raw = strings.TrimSpace(raw[len("Nullable(") : len(raw)-1])
		lower = strings.ToLower(raw)
	}
	for {
		if strings.HasPrefix(lower, "lowcardinality(") && strings.HasSuffix(lower, ")") {
			raw = strings.TrimSpace(raw[len("LowCardinality(") : len(raw)-1])
			lower = strings.ToLower(raw)
			continue
		}
		break
	}
	switch {
	case lower == "bool" || lower == "boolean":
		return "boolean", warnings
	case lower == "int8":
		return "smallint", warnings
	case lower == "uint8":
		return "smallint", warnings
	case lower == "int16":
		return "smallint", warnings
	case lower == "uint16":
		return "integer", warnings
	case lower == "int32":
		return "integer", warnings
	case lower == "uint32":
		return "bigint", warnings
	case lower == "int64":
		return "bigint", warnings
	case lower == "uint64":
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已映射为 numeric(20,0) 以避免无符号溢出", col.Name, col.Type))
		return "numeric(20,0)", warnings
	case lower == "float32":
		return "real", warnings
	case lower == "float64":
		return "double precision", warnings
	case lower == "date":
		return "date", warnings
	case strings.HasPrefix(lower, "datetime"):
		return "timestamp", warnings
	case lower == "string":
		return "text", warnings
	case lower == "uuid":
		return "uuid", warnings
	case lower == "json", strings.HasPrefix(lower, "map("), strings.HasPrefix(lower, "array("), strings.HasPrefix(lower, "tuple("), strings.HasPrefix(lower, "nested("):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 jsonb", col.Name, col.Type))
		return "jsonb", warnings
	case strings.HasPrefix(lower, "enum8("), strings.HasPrefix(lower, "enum16("):
		warnings = append(warnings, fmt.Sprintf("字段 %s 枚举类型 %s 已降级为 varchar(255)", col.Name, col.Type))
		return "varchar(255)", warnings
	case clickHouseDecimalPattern.MatchString(lower):
		parts := clickHouseDecimalPattern.FindStringSubmatch(lower)
		return fmt.Sprintf("numeric(%s,%s)", parts[2], parts[3]), warnings
	case clickHouseStringArgsPattern.MatchString(lower):
		parts := clickHouseStringArgsPattern.FindStringSubmatch(lower)
		return fmt.Sprintf("varchar(%s)", parts[1]), warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门 PG-like 映射，已降级为 text", col.Name, col.Type))
		return "text", warnings
	}
}

func mapClickHouseColumnToMySQL(col connection.ColumnDefinition) (string, []string) {
	raw := strings.TrimSpace(col.Type)
	lower := strings.ToLower(raw)
	warnings := make([]string, 0)
	nullable := false
	if strings.HasPrefix(lower, "nullable(") && strings.HasSuffix(lower, ")") {
		nullable = true
		raw = strings.TrimSpace(raw[len("Nullable(") : len(raw)-1])
		lower = strings.ToLower(raw)
	}
	for {
		if strings.HasPrefix(lower, "lowcardinality(") && strings.HasSuffix(lower, ")") {
			raw = strings.TrimSpace(raw[len("LowCardinality(") : len(raw)-1])
			lower = strings.ToLower(raw)
			continue
		}
		break
	}
	_ = nullable
	switch {
	case lower == "bool" || lower == "boolean" || lower == "uint8":
		return "tinyint(1)", warnings
	case lower == "int8":
		return "tinyint", warnings
	case lower == "uint16":
		return "smallint unsigned", warnings
	case lower == "int16":
		return "smallint", warnings
	case lower == "uint32":
		return "int unsigned", warnings
	case lower == "int32":
		return "int", warnings
	case lower == "uint64":
		return "bigint unsigned", warnings
	case lower == "int64":
		return "bigint", warnings
	case lower == "float32":
		return "float", warnings
	case lower == "float64":
		return "double", warnings
	case lower == "date":
		return "date", warnings
	case strings.HasPrefix(lower, "datetime"):
		return "datetime", warnings
	case lower == "string":
		return "text", warnings
	case lower == "uuid":
		return "char(36)", warnings
	case lower == "json", strings.HasPrefix(lower, "map("), strings.HasPrefix(lower, "array("), strings.HasPrefix(lower, "tuple("), strings.HasPrefix(lower, "nested("):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 json", col.Name, col.Type))
		return "json", warnings
	case clickHouseDecimalPattern.MatchString(lower):
		parts := clickHouseDecimalPattern.FindStringSubmatch(lower)
		return fmt.Sprintf("decimal(%s,%s)", parts[2], parts[3]), warnings
	case clickHouseStringArgsPattern.MatchString(lower):
		parts := clickHouseStringArgsPattern.FindStringSubmatch(lower)
		return fmt.Sprintf("varchar(%s)", parts[1]), warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 text", col.Name, col.Type))
		return "text", warnings
	}
}
