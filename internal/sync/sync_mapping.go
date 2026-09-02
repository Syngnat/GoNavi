package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"fmt"
	"strings"
)

// SyncObjectRef identifies one tabular object without overloading a connection's
// Database field (Oracle, for example, stores the service name there).
type SyncObjectRef struct {
	Catalog  string `json:"catalog,omitempty"`
	Database string `json:"database,omitempty"`
	Schema   string `json:"schema,omitempty"`
	Name     string `json:"name"`
}

// SyncObjectMapping is orthogonal to the legacy Tables field. When Mappings is
// empty the engine preserves the legacy identity table/column behavior.
type SyncObjectMapping struct {
	ID         string              `json:"id,omitempty"`
	Source     SyncObjectRef       `json:"source"`
	Target     SyncObjectRef       `json:"target"`
	KeyColumns []string            `json:"keyColumns,omitempty"`
	Filter     string              `json:"filter,omitempty"`
	Columns    []SyncColumnMapping `json:"columns,omitempty"`
}

// SyncColumnMapping maps and optionally transforms one source field. A mapping
// with an empty Source must provide Default and acts as a generated field.
type SyncColumnMapping struct {
	Source     string               `json:"source,omitempty"`
	Target     string               `json:"target,omitempty"`
	Drop       bool                 `json:"drop,omitempty"`
	Default    *SyncDefaultValue    `json:"default,omitempty"`
	Transforms []SyncValueTransform `json:"transforms,omitempty"`
}

// SyncDefaultValue stores a durable, typed literal. When defaults to missing
// and null. Supported When values are missing, null and empty.
type SyncDefaultValue struct {
	When      []string `json:"when,omitempty"`
	ValueType string   `json:"valueType,omitempty"`
	Value     string   `json:"value,omitempty"`
}

// SyncValueTransform is deliberately declarative. Arbitrary SQL or executable
// expressions are not accepted by CompileProjection.
type SyncValueTransform struct {
	Type string            `json:"type"`
	Args map[string]string `json:"args,omitempty"`
}

func hasExplicitSyncMappings(config SyncConfig) bool {
	return len(config.Mappings) > 0
}

func normalizeMappedSyncTables(config SyncConfig) SyncConfig {
	if len(config.Mappings) == 0 || len(config.Tables) > 0 {
		return config
	}
	config.Tables = make([]string, 0, len(config.Mappings))
	for _, mapping := range config.Mappings {
		config.Tables = append(config.Tables, syncObjectRefIdentifier(mapping.Source))
	}
	return config
}

func validateSyncMappings(config SyncConfig) error {
	if len(config.Mappings) == 0 {
		return nil
	}
	if hasSourceQuery(config) {
		return validateSourceQueryMappings(config)
	}
	if isRedisToMongoKeyspacePair(config) || isMongoToRedisKeyspacePair(config) {
		return fmt.Errorf("Redis 与 MongoDB 键空间迁移尚未接入对象和字段映射")
	}
	if classifyMigrationDataModel(resolveMigrationDBType(config.SourceConfig)) == MigrationDataModelDocument ||
		classifyMigrationDataModel(resolveMigrationDBType(config.SourceConfig)) == MigrationDataModelKeyValue ||
		classifyMigrationDataModel(resolveMigrationDBType(config.TargetConfig)) == MigrationDataModelDocument ||
		classifyMigrationDataModel(resolveMigrationDBType(config.TargetConfig)) == MigrationDataModelKeyValue {
		return fmt.Errorf("当前映射执行底座仅支持表格式数据源和目标端")
	}
	content := strings.ToLower(strings.TrimSpace(config.Content))
	if content == "both" {
		return fmt.Errorf("对象和字段映射当前仅支持仅结构同步或仅数据同步")
	}
	if content == "schema" {
		if config.CreateIndexes || normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
			return fmt.Errorf("仅结构对象映射要求目标表已存在，且不支持自动建表或创建索引")
		}
	} else if config.AutoAddColumns || config.CreateIndexes || normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
		return fmt.Errorf("对象和字段映射当前要求目标表已存在，且不支持自动补字段、建表或创建索引")
	}

	seenIDs := make(map[string]struct{}, len(config.Mappings))
	seenSources := make(map[string]struct{}, len(config.Mappings))
	for index, mapping := range config.Mappings {
		source := strings.TrimSpace(syncObjectRefIdentifier(mapping.Source))
		target := strings.TrimSpace(syncObjectRefIdentifier(mapping.Target))
		if source == "" {
			return fmt.Errorf("第 %d 个对象映射缺少源对象名称", index+1)
		}
		if target == "" {
			return fmt.Errorf("对象映射 %s 缺少目标对象名称", source)
		}
		if strings.TrimSpace(mapping.Source.Catalog) != "" || strings.TrimSpace(mapping.Source.Database) != "" ||
			strings.TrimSpace(mapping.Target.Catalog) != "" || strings.TrimSpace(mapping.Target.Database) != "" {
			return fmt.Errorf("对象映射 %s 尚不支持逐对象 catalog/database 覆盖，请在连接配置中选择数据库", source)
		}
		if strings.TrimSpace(mapping.Filter) != "" {
			return fmt.Errorf("对象映射 %s 的源过滤条件尚未接入执行引擎，已拒绝执行", source)
		}
		if id := strings.TrimSpace(mapping.ID); id != "" {
			key := strings.ToLower(id)
			if _, exists := seenIDs[key]; exists {
				return fmt.Errorf("对象映射 ID 重复：%s", id)
			}
			seenIDs[key] = struct{}{}
		}
		sourceKey := strings.ToLower(source)
		if _, exists := seenSources[sourceKey]; exists {
			return fmt.Errorf("源对象被重复映射：%s", source)
		}
		seenSources[sourceKey] = struct{}{}
		projection, err := CompileProjection(mapping)
		if err != nil {
			return err
		}
		seenKeys := make(map[string]struct{}, len(mapping.KeyColumns))
		for _, keyColumn := range mapping.KeyColumns {
			keyColumn = strings.TrimSpace(keyColumn)
			if keyColumn == "" {
				return fmt.Errorf("对象映射 %s 的 keyColumns 不能包含空字段", source)
			}
			key := strings.ToLower(keyColumn)
			if _, duplicate := seenKeys[key]; duplicate {
				return fmt.Errorf("对象映射 %s 的 keyColumns 字段重复：%s", source, keyColumn)
			}
			seenKeys[key] = struct{}{}
			if targetColumn, ok := projection.TargetColumn(keyColumn); !ok || strings.TrimSpace(targetColumn) == "" {
				return fmt.Errorf("对象映射 %s 的稳定 key %s 未唯一映射到目标字段", source, keyColumn)
			}
		}
	}

	for _, tableName := range config.Tables {
		if _, err := explicitSyncMappingForTable(config, tableName); err != nil {
			return err
		}
	}
	return nil
}

func validateSourceQueryMappings(config SyncConfig) error {
	if len(config.Mappings) != 1 {
		return fmt.Errorf("SQL 结果同步要求恰好一个对象映射")
	}
	mapping := config.Mappings[0]
	source := strings.TrimSpace(syncObjectRefIdentifier(mapping.Source))
	target := strings.TrimSpace(syncObjectRefIdentifier(mapping.Target))
	if source == "" {
		return fmt.Errorf("SQL 结果映射缺少合成源对象名称")
	}
	if target == "" {
		return fmt.Errorf("SQL 结果映射 %s 缺少目标对象名称", source)
	}
	if strings.TrimSpace(mapping.Filter) != "" {
		return fmt.Errorf("SQL 结果映射 %s 不支持额外源过滤条件", source)
	}
	if strings.TrimSpace(mapping.Source.Catalog) != "" || strings.TrimSpace(mapping.Source.Database) != "" ||
		strings.TrimSpace(mapping.Target.Catalog) != "" || strings.TrimSpace(mapping.Target.Database) != "" {
		return fmt.Errorf("SQL 结果映射 %s 尚不支持逐对象 catalog/database 覆盖", source)
	}
	content := strings.ToLower(strings.TrimSpace(config.Content))
	if content != "" && content != "data" {
		return fmt.Errorf("SQL 结果对象映射仅支持数据同步")
	}
	if config.AutoAddColumns || config.CreateIndexes || normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
		return fmt.Errorf("SQL 结果对象映射要求目标表已存在，且不支持自动补字段、建表或创建索引")
	}
	projection, err := CompileProjection(mapping)
	if err != nil {
		return err
	}
	seenKeys := make(map[string]struct{}, len(mapping.KeyColumns))
	for _, sourceKey := range mapping.KeyColumns {
		sourceKey = strings.TrimSpace(sourceKey)
		if sourceKey == "" {
			return fmt.Errorf("SQL 结果映射 %s 的 keyColumns 不能包含空字段", source)
		}
		key := strings.ToLower(sourceKey)
		if _, duplicate := seenKeys[key]; duplicate {
			return fmt.Errorf("SQL 结果映射 %s 的 keyColumns 字段重复：%s", source, sourceKey)
		}
		seenKeys[key] = struct{}{}
		if targetKey, ok := projection.TargetColumn(sourceKey); !ok || strings.TrimSpace(targetKey) == "" {
			return fmt.Errorf("SQL 结果映射 %s 的稳定 key %s 未唯一映射到目标字段", source, sourceKey)
		}
	}
	return nil
}

func sourceQueryMapping(config SyncConfig) (SyncObjectMapping, bool, error) {
	if len(config.Mappings) == 0 {
		return SyncObjectMapping{}, false, nil
	}
	if err := validateSourceQueryMappings(config); err != nil {
		return SyncObjectMapping{}, false, err
	}
	return config.Mappings[0], true, nil
}

func explicitSyncMappingForTable(config SyncConfig, tableName string) (SyncObjectMapping, error) {
	if len(config.Mappings) == 0 {
		return SyncObjectMapping{}, fmt.Errorf("同步配置未提供显式对象映射")
	}
	raw := strings.TrimSpace(tableName)
	last := lastSyncTableIdentifier(raw)
	matches := make([]SyncObjectMapping, 0, 1)
	for _, mapping := range config.Mappings {
		identifier := strings.TrimSpace(syncObjectRefIdentifier(mapping.Source))
		if strings.EqualFold(identifier, raw) ||
			(mapping.Source.Schema != "" && !strings.Contains(raw, ".") && strings.EqualFold(mapping.Source.Name, last)) ||
			(mapping.Source.Schema == "" && strings.EqualFold(mapping.Source.Name, last)) {
			matches = append(matches, mapping)
		}
	}
	if len(matches) == 0 {
		return SyncObjectMapping{}, fmt.Errorf("表 %s 缺少对象映射", tableName)
	}
	if len(matches) > 1 {
		return SyncObjectMapping{}, fmt.Errorf("表 %s 匹配到多个对象映射", tableName)
	}
	return matches[0], nil
}

func syncObjectRefIdentifier(ref SyncObjectRef) string {
	name := strings.TrimSpace(ref.Name)
	if name == "" {
		return ""
	}
	schema := strings.TrimSpace(ref.Schema)
	if schema == "" {
		return name
	}
	return schema + "." + name
}

func projectionForSyncTable(config SyncConfig, tableName string) (*CompiledProjection, error) {
	if !hasExplicitSyncMappings(config) {
		return CompileProjection(SyncObjectMapping{})
	}
	mapping, err := explicitSyncMappingForTable(config, tableName)
	if err != nil {
		return nil, err
	}
	return CompileProjection(mapping)
}

func projectSyncRows(projection *CompiledProjection, rows []map[string]interface{}) ([]map[string]interface{}, error) {
	if projection == nil {
		return nil, fmt.Errorf("字段投影尚未编译")
	}
	projected := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		mapped, err := projection.Project(row)
		if err != nil {
			return nil, err
		}
		projected = append(projected, mapped)
	}
	return projected, nil
}

func explicitSyncKeyColumnsForTable(config SyncConfig, tableName string, sourceColumns []connection.ColumnDefinition) ([]string, bool, error) {
	if !hasExplicitSyncMappings(config) {
		return nil, false, nil
	}
	mapping, err := explicitSyncMappingForTable(config, tableName)
	if err != nil {
		return nil, false, err
	}
	if len(mapping.KeyColumns) == 0 {
		return nil, false, nil
	}
	projection, err := CompileProjection(mapping)
	if err != nil {
		return nil, false, err
	}
	available := make(map[string]string, len(sourceColumns))
	for _, column := range sourceColumns {
		name := strings.TrimSpace(column.Name)
		if name != "" {
			available[strings.ToLower(name)] = name
		}
	}
	keys := make([]string, 0, len(mapping.KeyColumns))
	seen := make(map[string]struct{}, len(mapping.KeyColumns))
	for _, configured := range mapping.KeyColumns {
		key := strings.ToLower(strings.TrimSpace(configured))
		canonical, exists := available[key]
		if !exists {
			return nil, false, fmt.Errorf("对象映射 %s 的稳定 key 字段 %s 不存在", syncObjectRefIdentifier(mapping.Source), configured)
		}
		if _, duplicate := seen[key]; duplicate {
			return nil, false, fmt.Errorf("对象映射稳定 key 字段重复：%s", configured)
		}
		seen[key] = struct{}{}
		if targetColumn, ok := projection.TargetColumn(canonical); !ok || strings.TrimSpace(targetColumn) == "" {
			return nil, false, fmt.Errorf("对象映射稳定 key %s 未唯一映射到目标字段", canonical)
		}
		keys = append(keys, canonical)
	}
	return keys, true, nil
}

func syncKeyColumnsForTable(config SyncConfig, tableName string, sourceColumns []connection.ColumnDefinition) ([]string, error) {
	if keys, explicit, err := explicitSyncKeyColumnsForTable(config, tableName, sourceColumns); err != nil {
		return nil, err
	} else if explicit {
		return keys, nil
	}
	return physicalPrimaryKeyColumns(sourceColumns), nil
}

// physicalPrimaryKeyColumns returns only database-declared primary-key columns.
// Explicit mapping keys are resolved by syncKeyColumnsForTable before this
// legacy-table fallback is used.
func physicalPrimaryKeyColumns(sourceColumns []connection.ColumnDefinition) []string {
	keys := make([]string, 0, 2)
	for _, column := range sourceColumns {
		if strings.EqualFold(strings.TrimSpace(column.Key), "PRI") || strings.EqualFold(strings.TrimSpace(column.Key), "PK") {
			keys = append(keys, strings.TrimSpace(column.Name))
		}
	}
	return keys
}

func buildMappedExistingTargetPlan(config SyncConfig, tableName string, sourceDB db.Database, targetDB db.Database) (SchemaMigrationPlan, []connection.ColumnDefinition, []connection.ColumnDefinition, error) {
	mapping, err := explicitSyncMappingForTable(config, tableName)
	if err != nil {
		return SchemaMigrationPlan{}, nil, nil, err
	}
	projection, err := CompileProjection(mapping)
	if err != nil {
		return SchemaMigrationPlan{}, nil, nil, err
	}

	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	sourceSchema, sourceTable := normalizeSyncSourceSchemaAndTable(config, tableName)
	if value := strings.TrimSpace(mapping.Source.Schema); value != "" {
		sourceSchema = value
	}
	if value := strings.TrimSpace(mapping.Source.Name); value != "" {
		sourceTable = value
	}
	targetSchema, targetTable := normalizeSyncTargetSchemaAndTable(config, tableName)
	if value := strings.TrimSpace(mapping.Target.Schema); value != "" {
		targetSchema = value
	}
	if value := strings.TrimSpace(mapping.Target.Name); value != "" {
		targetTable = value
	}

	plan := SchemaMigrationPlan{
		SourceSchema:     sourceSchema,
		SourceTable:      sourceTable,
		TargetSchema:     targetSchema,
		TargetTable:      targetTable,
		SourceQueryTable: qualifiedNameForQuery(sourceType, sourceSchema, sourceTable, syncObjectRefIdentifier(SyncObjectRef{Schema: sourceSchema, Name: sourceTable})),
		TargetQueryTable: qualifiedNameForQuery(targetType, targetSchema, targetTable, syncObjectRefIdentifier(SyncObjectRef{Schema: targetSchema, Name: targetTable})),
		PlannedAction:    "使用对象和字段映射导入已有目标表",
	}

	sourceCols, sourceExists, err := inspectTableColumns(sourceDB, sourceSchema, sourceTable)
	if err != nil {
		return plan, nil, nil, syncWrapDetailError("data_sync.backend.error.source_table_columns_failed", err)
	}
	if !sourceExists {
		return plan, nil, nil, syncTextError("data_sync.backend.error.source_table_missing_or_no_columns", map[string]any{"table": tableName})
	}
	if err := projection.ValidateSourceColumns(sourceCols); err != nil {
		return plan, sourceCols, nil, err
	}

	targetCols, targetExists, err := inspectTableColumns(targetDB, targetSchema, targetTable)
	if err != nil {
		return plan, sourceCols, nil, syncWrapDetailError("data_sync.backend.error.target_table_columns_failed", err)
	}
	plan.TargetTableExists = targetExists
	if !targetExists {
		plan.PlannedAction = "映射目标表不存在，需先创建目标表"
		plan.Warnings = append(plan.Warnings, "对象和字段映射当前仅支持写入已有目标表")
		return plan, sourceCols, targetCols, nil
	}

	missing := projection.MissingTargetColumns(targetCols, sourceCols)
	if len(missing) == 0 {
		plan.PlannedAction = "表结构已一致"
		return plan, sourceCols, targetCols, nil
	}
	if !strings.EqualFold(strings.TrimSpace(config.Content), "schema") {
		return plan, sourceCols, targetCols, fmt.Errorf("映射目标表缺少字段 %d 个：%s", len(missing), strings.Join(missing, ", "))
	}
	plan.Warnings = append(plan.Warnings, fmt.Sprintf("目标表缺失字段 %d 个：%s", len(missing), strings.Join(missing, ", ")))
	if !config.AutoAddColumns {
		plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，未开启自动补齐", len(missing))
		return plan, sourceCols, targetCols, nil
	}
	if !supportsAutoAddColumnsForPair(sourceType, targetType) {
		plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，当前库对暂不支持自动补齐", len(missing))
		return plan, sourceCols, targetCols, nil
	}

	for _, missingTarget := range missing {
		var sourceColumn *connection.ColumnDefinition
		for index := range sourceCols {
			targetColumn, mapped := projection.TargetColumn(sourceCols[index].Name)
			if mapped && strings.EqualFold(strings.TrimSpace(targetColumn), strings.TrimSpace(missingTarget)) {
				column := sourceCols[index]
				column.Name = missingTarget
				sourceColumn = &column
				break
			}
		}
		if sourceColumn == nil {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 没有可推断的源列类型，未生成自动补齐 SQL", missingTarget))
			continue
		}
		addSQL, addErr := buildAddColumnSQLForPair(sourceType, targetType, plan.TargetQueryTable, *sourceColumn)
		if addErr != nil {
			plan.Warnings = append(plan.Warnings, fmt.Sprintf("字段 %s 自动补齐 SQL 生成失败：%v", missingTarget, addErr))
			continue
		}
		plan.PreDataSQL = append(plan.PreDataSQL, addSQL)
	}
	if len(plan.PreDataSQL) > 0 {
		plan.PlannedAction = fmt.Sprintf("补齐缺失字段(%d)", len(plan.PreDataSQL))
	} else {
		plan.PlannedAction = fmt.Sprintf("目标表缺失字段(%d)，但未生成可执行补齐 SQL", len(missing))
	}
	return plan, sourceCols, targetCols, nil
}
