package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

func buildMySQLToMongoPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTabularToMongoPlan(config, tableName, sourceDB, targetDB)
}

func buildPGLikeToMongoPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTabularToMongoPlan(config, tableName, sourceDB, targetDB)
}

func buildClickHouseToMongoPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTabularToMongoPlan(config, tableName, sourceDB, targetDB)
}

func buildTDengineToMongoPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	return buildTabularToMongoPlan(config, tableName, sourceDB, targetDB)
}

func buildTabularToMongoPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标集合导入"

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, plan.SourceSchema, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{
			"table": tableName,
		})
	}

	targetExists, err := inspectMongoCollection(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_collection_check_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		plan.Warnings = append(plan.Warnings, "MongoDB 为弱 schema 目标，字段结构以写入文档为准，不执行目标列校验")
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标集合不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标集合已存在，执行时不会自动创建")
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标集合不存在，将自动创建集合后导入"
		createCmd, err := buildMongoCreateCollectionCommand(plan.TargetTable)
		if err != nil {
			return plan, sourceCols, nil, err
		}
		plan.PreDataSQL = append(plan.PreDataSQL, createCmd)
		if config.CreateIndexes {
			indexCmds, warnings, unsupported, unmigrated, created, skipped, err := buildMongoIndexCommands(sourceDB, plan.SourceSchema, plan.SourceTable, plan.TargetTable)
			if err != nil {
				plan.Warnings = append(plan.Warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
			} else {
				plan.PostDataSQL = append(plan.PostDataSQL, indexCmds...)
				plan.Warnings = append(plan.Warnings, warnings...)
				plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
				plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
				plan.IndexesToCreate = created
				plan.IndexesSkipped = skipped
			}
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	}
}

func buildMongoToMongoPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(sourceType, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(targetType, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标集合导入"

	sourceCols, warnings, err := inferMongoCollectionColumns(sourceDB, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, err
	}
	plan.Warnings = append(plan.Warnings, warnings...)
	if len(sourceCols) == 0 {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_collection_no_migratable_fields", map[string]any{
			"collection": tableName,
		})
	}

	targetExists, err := inspectMongoCollection(targetDB, plan.TargetSchema, plan.TargetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_collection_check_failed", err)
	}
	plan.TargetTableExists = targetExists

	strategy := normalizeTargetTableStrategy(config.TargetTableStrategy)
	if targetExists {
		plan.Warnings = append(plan.Warnings, "MongoDB 为弱 schema 目标，字段结构以写入文档为准，不执行目标列校验")
		if strategy != "existing_only" {
			plan.Warnings = append(plan.Warnings, "目标集合已存在，当前仅执行数据导入；不会自动重建已有索引")
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	}

	switch strategy {
	case "existing_only":
		plan.PlannedAction = "目标集合不存在，需先手工创建"
		plan.Warnings = append(plan.Warnings, "当前策略要求目标集合已存在，执行时不会自动创建")
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	case "smart", "auto_create_if_missing":
		plan.AutoCreate = true
		plan.PlannedAction = "目标集合不存在，将自动创建集合后导入"
		createCmd, err := buildMongoCreateCollectionCommand(plan.TargetTable)
		if err != nil {
			return plan, sourceCols, nil, err
		}
		plan.PreDataSQL = append(plan.PreDataSQL, createCmd)
		if config.CreateIndexes {
			indexCmds, indexWarnings, unsupported, unmigrated, created, skipped, err := buildMongoIndexCommands(sourceDB, plan.SourceSchema, plan.SourceTable, plan.TargetTable)
			if err != nil {
				plan.Warnings = append(plan.Warnings, fmt.Sprintf("读取源集合索引失败，已跳过索引迁移：%v", err))
			} else {
				plan.PostDataSQL = append(plan.PostDataSQL, indexCmds...)
				plan.Warnings = append(plan.Warnings, indexWarnings...)
				plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
				plan.UnmigratedIndexes = append(plan.UnmigratedIndexes, unmigrated...)
				plan.IndexesToCreate = created
				plan.IndexesSkipped = skipped
			}
		}
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, nil, nil
	}
}

func buildMongoToMySQLPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(config.SourceConfig.Type, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(config.TargetConfig.Type, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, warnings, err := inferMongoCollectionColumns(sourceDB, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, err
	}
	plan.Warnings = append(plan.Warnings, warnings...)
	if len(sourceCols) == 0 {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_collection_no_migratable_fields", map[string]any{
			"collection": tableName,
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
			addSQL, addWarnings := buildMongoToMySQLAddColumnSQL(plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
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
		createSQL, postSQL, moreWarnings, unsupported, idxCreate, idxSkip, err := buildMongoToMySQLCreateTablePlan(config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, moreWarnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func inspectMongoCollection(database db.Database, dbName, collection string) (bool, error) {
	items, err := database.GetTables(dbName)
	if err != nil {
		return false, err
	}
	target := strings.TrimSpace(collection)
	for _, item := range items {
		if strings.EqualFold(strings.TrimSpace(item), target) {
			return true, nil
		}
	}
	return false, nil
}

func buildMongoCreateCollectionCommand(collection string) (string, error) {
	cmd := map[string]interface{}{"create": strings.TrimSpace(collection)}
	data, err := json.Marshal(cmd)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func buildMongoIndexCommand(targetCollection string, idx groupedIndex, text bool) (string, error) {
	keyParts := make([]string, 0, len(idx.Columns))
	for _, column := range idx.Columns {
		nameJSON, err := json.Marshal(strings.TrimSpace(column.Name))
		if err != nil {
			return "", err
		}
		value := "1"
		if text {
			value = `"text"`
		}
		keyParts = append(keyParts, fmt.Sprintf("%s:%s", nameJSON, value))
	}
	command := struct {
		CreateIndexes string `json:"createIndexes"`
		Indexes       []struct {
			Name   string          `json:"name"`
			Key    json.RawMessage `json:"key"`
			Unique bool            `json:"unique"`
		} `json:"indexes"`
	}{CreateIndexes: strings.TrimSpace(targetCollection)}
	command.Indexes = append(command.Indexes, struct {
		Name   string          `json:"name"`
		Key    json.RawMessage `json:"key"`
		Unique bool            `json:"unique"`
	}{
		Name:   strings.TrimSpace(idx.Name),
		Key:    json.RawMessage(`{` + strings.Join(keyParts, ",") + `}`),
		Unique: idx.Unique,
	})
	data, err := json.Marshal(command)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func remediationStatements(command string) []string {
	if strings.TrimSpace(command) == "" {
		return nil
	}
	return []string{command}
}

func buildMongoIndexCommands(sourceDB db.Database, dbName, tableName, targetCollection string) ([]string, []string, []string, []UnmigratedIndex, int, int, error) {
	indexes, err := sourceDB.GetIndexes(dbName, tableName)
	if err != nil {
		return nil, nil, nil, nil, 0, 0, err
	}
	grouped := groupIndexDefinitions(indexes)
	cmds := make([]string, 0, len(grouped))
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	unmigrated := make([]UnmigratedIndex, 0)
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "primary") {
			continue
		}
		if len(idx.Columns) == 0 {
			reason := fmt.Sprintf("索引 %s 缺少列定义，已跳过", name)
			skipped++
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:       name,
				Columns:    []IndexMigrationColumn{},
				Unique:     idx.Unique,
				IndexType:  idx.IndexType,
				ReasonCode: "missing_columns",
				Reason:     reason,
			})
			continue
		}
		kind := strings.ToLower(strings.TrimSpace(idx.IndexType))
		if hasIndexPrefix(idx.Columns) {
			reason := fmt.Sprintf("索引 %s 使用前缀长度，MongoDB 目标暂不支持等价迁移", name)
			remediation, _ := buildMongoIndexCommand(targetCollection, idx, false)
			skipped++
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:                  name,
				Columns:               append([]IndexMigrationColumn(nil), idx.Columns...),
				Unique:                idx.Unique,
				IndexType:             idx.IndexType,
				ReasonCode:            "prefix_index_requires_review",
				Reason:                reason,
				RemediationStatements: remediationStatements(remediation),
			})
			continue
		}
		if kind == "fulltext" {
			reason := fmt.Sprintf("索引 %s 类型=%s，MongoDB 目标暂不支持等价迁移", name, idx.IndexType)
			remediation, _ := buildMongoIndexCommand(targetCollection, idx, true)
			skipped++
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:                  name,
				Columns:               append([]IndexMigrationColumn(nil), idx.Columns...),
				Unique:                idx.Unique,
				IndexType:             idx.IndexType,
				ReasonCode:            "fulltext_requires_review",
				Reason:                reason,
				RemediationStatements: remediationStatements(remediation),
			})
			continue
		}
		if kind != "" && kind != "btree" {
			reason := fmt.Sprintf("索引 %s 类型=%s，MongoDB 目标暂不支持等价迁移", name, idx.IndexType)
			skipped++
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:       name,
				Columns:    append([]IndexMigrationColumn(nil), idx.Columns...),
				Unique:     idx.Unique,
				IndexType:  idx.IndexType,
				ReasonCode: "unsupported_index_type",
				Reason:     reason,
			})
			continue
		}
		command, err := buildMongoIndexCommand(targetCollection, idx, false)
		if err != nil {
			reason := fmt.Sprintf("索引 %s 生成 MongoDB createIndexes 命令失败：%v", name, err)
			skipped++
			unsupported = append(unsupported, reason)
			unmigrated = append(unmigrated, UnmigratedIndex{
				Name:       name,
				Columns:    append([]IndexMigrationColumn(nil), idx.Columns...),
				Unique:     idx.Unique,
				IndexType:  idx.IndexType,
				ReasonCode: "remediation_generation_failed",
				Reason:     reason,
			})
			continue
		}
		cmds = append(cmds, command)
		created++
	}
	return cmds, dedupeStrings(warnings), dedupeStrings(unsupported), unmigrated, created, skipped, nil
}

func inferMongoCollectionColumns(sourceDB db.Database, collection string) ([]connection.ColumnDefinition, []string, error) {
	query := fmt.Sprintf(`{"find":"%s","filter":{},"limit":200}`, strings.TrimSpace(collection))
	rows, _, err := sourceDB.Query(query)
	if err != nil {
		return nil, nil, syncWrapDetailError("data_sync.backend.error.mongo_read_source_samples_failed", err)
	}
	if len(rows) == 0 {
		return []connection.ColumnDefinition{{Name: "_id", Type: "varchar(64)", Nullable: "NO", Key: "PRI"}}, []string{"源集合暂无样本数据，仅按 `_id` 生成基础主键列"}, nil
	}
	fieldNames := make(map[string]struct{})
	for _, row := range rows {
		for key := range row {
			fieldNames[key] = struct{}{}
		}
	}
	orderedFields := make([]string, 0, len(fieldNames))
	for key := range fieldNames {
		orderedFields = append(orderedFields, key)
	}
	sort.Strings(orderedFields)
	if containsString(orderedFields, "_id") {
		orderedFields = moveStringToFront(orderedFields, "_id")
	}
	columns := make([]connection.ColumnDefinition, 0, len(orderedFields))
	warnings := make([]string, 0)
	for _, field := range orderedFields {
		typeName, nullable, fieldWarnings := inferMongoFieldType(rows, field)
		warnings = append(warnings, fieldWarnings...)
		col := connection.ColumnDefinition{
			Name:     field,
			Type:     typeName,
			Nullable: ternaryString(nullable, "YES", "NO"),
			Key:      "",
			Extra:    "",
		}
		if field == "_id" {
			col.Key = "PRI"
			col.Nullable = "NO"
		}
		columns = append(columns, col)
	}
	return columns, dedupeStrings(warnings), nil
}

func inferMongoFieldType(rows []map[string]interface{}, field string) (string, bool, []string) {
	nullable := false
	hasString, hasBool, hasInt, hasFloat, hasTime, hasComplex := false, false, false, false, false, false
	for _, row := range rows {
		value, ok := row[field]
		if !ok || value == nil {
			nullable = true
			continue
		}
		switch value.(type) {
		case bool:
			hasBool = true
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
			hasInt = true
		case float32, float64:
			hasFloat = true
		case time.Time:
			hasTime = true
		case map[string]interface{}, []interface{}:
			hasComplex = true
		default:
			hasString = true
		}
	}
	kinds := 0
	for _, flag := range []bool{hasString, hasBool, hasInt, hasFloat, hasTime, hasComplex} {
		if flag {
			kinds++
		}
	}
	warnings := make([]string, 0)
	if kinds > 1 {
		warnings = append(warnings, fmt.Sprintf("字段 %s 存在多种 BSON 值类型，已按兼容类型降级", field))
	}
	if field == "_id" {
		return "varchar(64)", false, warnings
	}
	switch {
	case hasComplex:
		return "json", nullable, warnings
	case hasTime:
		return "datetime", nullable, warnings
	case hasFloat:
		return "double", nullable, warnings
	case hasInt:
		return "bigint", nullable, warnings
	case hasBool:
		return "tinyint(1)", nullable, warnings
	default:
		return "varchar(255)", nullable, warnings
	}
}

func buildMongoToMySQLAddColumnSQL(targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
	targetSet := make(map[string]struct{}, len(targetCols))
	for _, col := range targetCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		targetSet[key] = struct{}{}
	}
	var sqlList []string
	for _, col := range sourceCols {
		key := strings.ToLower(strings.TrimSpace(col.Name))
		if key == "" {
			continue
		}
		if _, ok := targetSet[key]; ok {
			continue
		}
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", col.Name),
			strings.TrimSpace(col.Type),
		))
	}
	return sqlList, nil
}

func buildMongoToMySQLCreateTablePlan(config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 1)
	for _, col := range sourceCols {
		columnDef := fmt.Sprintf("%s %s", quoteIdentByType("mysql", col.Name), strings.TrimSpace(col.Type))
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			columnDef += " NOT NULL"
		}
		columnDefs = append(columnDefs, columnDef)
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType("mysql", col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	} else {
		warnings = append(warnings, "MongoDB 源集合未推断出稳定主键，目标表将不自动创建主键")
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType("mysql", targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源集合索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "_id_") || strings.EqualFold(name, "primary") {
			continue
		}
		if len(idx.Columns) == 0 {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 缺少列定义，已跳过", name))
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

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func moveStringToFront(items []string, target string) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item == target {
			continue
		}
		out = append(out, item)
	}
	return append([]string{target}, out...)
}

func buildMongoToPGLikePlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	plan := SchemaMigrationPlan{}
	targetType := strings.ToLower(strings.TrimSpace(config.TargetConfig.Type))
	plan.SourceSchema, plan.SourceTable = normalizeSyncSourceSchemaAndTable(config, tableName)
	plan.TargetSchema, plan.TargetTable = normalizeSyncTargetSchemaAndTable(config, tableName)
	plan.SourceQueryTable = qualifiedNameForQuery(config.SourceConfig.Type, plan.SourceSchema, plan.SourceTable, tableName)
	plan.TargetQueryTable = qualifiedNameForQuery(config.TargetConfig.Type, plan.TargetSchema, plan.TargetTable, tableName)
	plan.PlannedAction = "使用已有目标表导入"

	sourceCols, warnings, err := inferMongoCollectionColumns(sourceDB, plan.SourceTable)
	if err != nil {
		return plan, nil, nil, err
	}
	plan.Warnings = append(plan.Warnings, warnings...)
	if len(sourceCols) == 0 {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_collection_no_migratable_fields", map[string]any{
			"collection": tableName,
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
			addSQL, addWarnings := buildMongoToPGLikeAddColumnSQL(targetType, plan.TargetQueryTable, sourceCols, targetCols)
			plan.PreDataSQL = append(plan.PreDataSQL, addSQL...)
			plan.Warnings = append(plan.Warnings, addWarnings...)
			if len(addSQL) > 0 {
				plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)后导入", len(addSQL))
			}
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
		createSQL, postSQL, moreWarnings, unsupported, idxCreate, idxSkip, err := buildMongoToPGLikeCreateTablePlan(targetType, config, plan.TargetQueryTable, sourceCols, sourceDB, plan.SourceSchema, plan.SourceTable)
		if err != nil {
			return plan, sourceCols, targetCols, err
		}
		plan.CreateTableSQL = createSQL
		plan.PostDataSQL = append(plan.PostDataSQL, postSQL...)
		plan.Warnings = append(plan.Warnings, moreWarnings...)
		plan.UnsupportedObjects = append(plan.UnsupportedObjects, unsupported...)
		plan.IndexesToCreate = idxCreate
		plan.IndexesSkipped = idxSkip
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	default:
		return dedupeSchemaMigrationPlan(plan), sourceCols, targetCols, nil
	}
}

func buildMongoToPGLikeAddColumnSQL(targetType string, targetQueryTable string, sourceCols, targetCols []connection.ColumnDefinition) ([]string, []string) {
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
		colType, mapWarnings := mapMongoInferredColumnToPGLike(col)
		warnings = append(warnings, mapWarnings...)
		sqlList = append(sqlList, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(targetType, targetQueryTable),
			quoteIdentByType(targetType, col.Name),
			colType,
		))
	}
	return sqlList, dedupeStrings(warnings)
}

func buildMongoToPGLikeCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 1)
	for _, col := range sourceCols {
		colType, colWarnings := mapMongoInferredColumnToPGLike(col)
		warnings = append(warnings, colWarnings...)
		parts := []string{colType}
		if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
			parts = append(parts, "NOT NULL")
		}
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), strings.Join(parts, " ")))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))
	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源集合索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), 0, 0, nil
	}
	grouped := groupIndexDefinitions(indexes)
	postSQL := make([]string, 0, len(grouped))
	created := 0
	skipped := 0
	for _, idx := range grouped {
		name := strings.TrimSpace(idx.Name)
		if name == "" || strings.EqualFold(name, "_id_") || strings.EqualFold(name, "primary") {
			continue
		}
		if len(idx.Columns) == 0 {
			skipped++
			unsupported = append(unsupported, fmt.Sprintf("索引 %s 缺少列定义，已跳过", name))
			continue
		}
		quotedCols := make([]string, 0, len(idx.Columns))
		for _, col := range idx.Columns {
			quotedCols = append(quotedCols, quoteIdentByType(targetType, col.Name))
		}
		prefix := "CREATE INDEX"
		if idx.Unique {
			prefix = "CREATE UNIQUE INDEX"
		}
		postSQL = append(postSQL, fmt.Sprintf("%s %s ON %s (%s)", prefix, quoteIdentByType(targetType, name), quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(quotedCols, ", ")))
		created++
	}
	return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), created, skipped, nil
}

func mapMongoInferredColumnToPGLike(col connection.ColumnDefinition) (string, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	switch {
	case strings.HasPrefix(raw, "varchar"):
		return col.Type, warnings
	case raw == "json":
		return "jsonb", warnings
	case raw == "datetime":
		return "timestamp", warnings
	case raw == "tinyint(1)":
		return "boolean", warnings
	case raw == "double":
		return "double precision", warnings
	case raw == "bigint":
		return "bigint", warnings
	default:
		return col.Type, warnings
	}
}
