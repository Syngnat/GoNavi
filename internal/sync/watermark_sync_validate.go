package sync

import (
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func validateWatermarkSyncRequest(request WatermarkSyncRequest) (SyncConfig, string, string, int, error) {
	config := normalizeMappedSyncTables(normalizeSyncConnectionDatabases(request.Sync))
	if hasSourceQuery(config) {
		return config, "", "", 0, errors.New("watermark 增量不支持 SourceQuery")
	}
	content := strings.ToLower(strings.TrimSpace(config.Content))
	if content != "" && content != "data" {
		return config, "", "", 0, errors.New("watermark 增量仅支持数据同步")
	}
	rawMode := strings.ToLower(strings.TrimSpace(config.Mode))
	var mode string
	switch rawMode {
	case "", "insert_update":
		mode = "insert_update"
	case "insert_only":
		mode = "insert_only"
	case "full_overwrite":
		return config, "", "", 0, errors.New("watermark 增量不支持 full_overwrite")
	default:
		return config, "", "", 0, fmt.Errorf("watermark 增量不支持同步模式 %q", config.Mode)
	}
	delivery, err := normalizeWatermarkDeliverySemantics(request.DeliverySemantics)
	if err != nil {
		return config, "", "", 0, err
	}
	if mode == "insert_only" && delivery != WatermarkDeliveryAtLeastOnce {
		return config, "", "", 0, errors.New("watermark insert_only 可能在目标提交后、checkpoint 前失败并重放；必须显式选择 at_least_once")
	}
	if config.AutoAddColumns || config.CreateIndexes || normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
		return config, "", "", 0, errors.New("watermark 增量要求目标表已存在，且不支持自动建表、补字段或创建索引")
	}
	if err := validateSyncMappings(config); err != nil {
		return config, "", "", 0, err
	}
	sourceType := resolveMigrationDBType(config.SourceConfig)
	targetType := resolveMigrationDBType(config.TargetConfig)
	if classifyMigrationDataModel(sourceType) == MigrationDataModelDocument || classifyMigrationDataModel(sourceType) == MigrationDataModelKeyValue {
		return config, "", "", 0, fmt.Errorf("watermark 增量不支持 %s 源数据模型", classifyMigrationDataModel(sourceType))
	}
	if classifyMigrationDataModel(targetType) == MigrationDataModelDocument || classifyMigrationDataModel(targetType) == MigrationDataModelKeyValue {
		return config, "", "", 0, fmt.Errorf("watermark 增量不支持 %s 目标数据模型", classifyMigrationDataModel(targetType))
	}
	if !SupportsWatermarkSyncDialect(sourceType) {
		return config, "", "", 0, fmt.Errorf("watermark 增量不支持源方言 %s", sourceType)
	}
	if !SupportsWatermarkSyncDialect(targetType) {
		return config, "", "", 0, fmt.Errorf("watermark 增量不支持目标方言 %s", targetType)
	}

	tableName := strings.TrimSpace(request.Table)
	if tableName == "" {
		if len(config.Tables) != 1 {
			return config, "", "", 0, errors.New("watermark 增量每次必须且只能指定一个源表")
		}
		tableName = strings.TrimSpace(config.Tables[0])
	}
	if tableName == "" {
		return config, "", "", 0, errors.New("watermark 增量缺少源表")
	}
	if len(config.Tables) > 0 {
		matched := false
		for _, configuredTable := range config.Tables {
			if strings.EqualFold(strings.TrimSpace(configuredTable), tableName) || strings.EqualFold(lastSyncTableIdentifier(configuredTable), lastSyncTableIdentifier(tableName)) {
				matched = true
				break
			}
		}
		if !matched {
			return config, "", "", 0, fmt.Errorf("watermark 表 %s 不在同步表列表中", tableName)
		}
	}
	if options, ok := lookupWatermarkTableOptions(config, tableName); ok {
		if options.Delete {
			return config, "", "", 0, errors.New("watermark 增量不支持删除传播")
		}
		if len(options.SelectedInsertPKs) > 0 || len(options.SelectedUpdatePKs) > 0 || len(options.SelectedDeletePKs) > 0 {
			return config, "", "", 0, errors.New("watermark 增量不支持预选主键过滤")
		}
	}
	if strings.TrimSpace(request.WatermarkColumn) == "" {
		return config, "", "", 0, errors.New("watermark 增量缺少 watermark 字段")
	}
	if len(request.TieBreakerColumns) == 0 {
		return config, "", "", 0, errors.New("watermark 增量缺少稳定 tie-breaker")
	}
	batchSize := request.BatchSize
	if batchSize < 0 {
		return config, "", "", 0, errors.New("watermark 批大小不能小于 0")
	}
	if batchSize == 0 {
		batchSize = defaultWatermarkSyncBatchSize
	}
	if batchSize > maxWatermarkSyncBatchSize {
		return config, "", "", 0, fmt.Errorf("watermark 批大小不能超过 %d", maxWatermarkSyncBatchSize)
	}
	return config, tableName, mode, batchSize, nil
}

// ValidateWatermarkSyncRequest exposes the exact runtime contract for task
// preflight. It performs no database I/O.
func ValidateWatermarkSyncRequest(request WatermarkSyncRequest) error {
	_, _, _, _, err := validateWatermarkSyncRequest(request)
	return err
}

func normalizeWatermarkDeliverySemantics(value string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", WatermarkDeliveryIdempotent:
		return WatermarkDeliveryIdempotent, nil
	case WatermarkDeliveryAtLeastOnce:
		return WatermarkDeliveryAtLeastOnce, nil
	default:
		return "", fmt.Errorf("不支持的 watermark delivery semantics %q", value)
	}
}

func lookupWatermarkTableOptions(config SyncConfig, tableName string) (TableOptions, bool) {
	if config.TableOptions == nil {
		return TableOptions{}, false
	}
	candidates := []string{tableName, lastSyncTableIdentifier(tableName)}
	if hasExplicitSyncMappings(config) {
		if mapping, err := explicitSyncMappingForTable(config, tableName); err == nil {
			candidates = append(candidates, mapping.ID, syncObjectRefIdentifier(mapping.Source), mapping.Source.Name)
		}
	}
	for _, candidate := range candidates {
		if options, ok := config.TableOptions[candidate]; ok {
			return options, true
		}
	}
	return TableOptions{}, false
}

func buildWatermarkRuntimePlan(config SyncConfig, tableName, mode string, batchSize int, requestedWatermark string, requestedTies []string, sourceDB, targetDB db.Database) (watermarkRuntimePlan, error) {
	plan := watermarkRuntimePlan{
		config:     config,
		tableName:  tableName,
		mode:       mode,
		batchSize:  batchSize,
		sourceType: resolveMigrationDBType(config.SourceConfig),
		targetType: resolveMigrationDBType(config.TargetConfig),
	}

	var sourceCols, targetCols []connection.ColumnDefinition
	if hasExplicitSyncMappings(config) {
		mappedPlan, mappedSourceCols, mappedTargetCols, err := buildMappedExistingTargetPlan(config, tableName, sourceDB, targetDB)
		if err != nil {
			return plan, err
		}
		if !mappedPlan.TargetTableExists {
			return plan, fmt.Errorf("watermark 映射目标表 %s 不存在", mappedPlan.TargetQueryTable)
		}
		plan.sourceQueryTable = mappedPlan.SourceQueryTable
		plan.targetQueryTable = mappedPlan.TargetQueryTable
		plan.applyTableName = mappedPlan.TargetTable
		if shouldUseQualifiedSyncApplyTable(config.TargetConfig) {
			plan.applyTableName = mappedPlan.TargetQueryTable
		}
		sourceCols, targetCols = mappedSourceCols, mappedTargetCols
	} else {
		sourceSchema, sourceTable := normalizeSyncSourceSchemaAndTable(config, tableName)
		targetSchema, targetTable := normalizeSyncTargetSchemaAndTable(config, tableName)
		var sourceExists, targetExists bool
		var err error
		sourceCols, sourceExists, err = inspectTableColumns(sourceDB, sourceSchema, sourceTable)
		if err != nil {
			return plan, fmt.Errorf("读取 watermark 源表字段失败: %w", err)
		}
		if !sourceExists {
			return plan, fmt.Errorf("watermark 源表 %s 不存在或没有字段", tableName)
		}
		targetCols, targetExists, err = inspectTableColumns(targetDB, targetSchema, targetTable)
		if err != nil {
			return plan, fmt.Errorf("读取 watermark 目标表字段失败: %w", err)
		}
		if !targetExists {
			return plan, fmt.Errorf("watermark 目标表 %s 不存在或没有字段", targetTable)
		}
		plan.sourceQueryTable = qualifiedNameForQuery(plan.sourceType, sourceSchema, sourceTable, tableName)
		plan.targetQueryTable = qualifiedTargetNameForQuery(plan.targetType, targetSchema, targetTable)
		plan.applyTableName = targetTable
		if shouldUseQualifiedSyncApplyTable(config.TargetConfig) {
			plan.applyTableName = plan.targetQueryTable
		}
	}
	plan.sourceColumns = sourceCols
	plan.targetColumns = targetCols

	projection, err := projectionForSyncTable(config, tableName)
	if err != nil {
		return plan, err
	}
	if err := projection.ValidateSourceColumns(sourceCols); err != nil {
		return plan, err
	}
	missing := projection.MissingTargetColumns(targetCols, sourceCols)
	if len(missing) > 0 {
		return plan, fmt.Errorf("watermark 目标表缺少字段：%s", strings.Join(missing, ", "))
	}
	plan.projection = projection

	watermarkColumn, watermarkDef, ok := canonicalWatermarkColumn(sourceCols, requestedWatermark)
	if !ok {
		return plan, fmt.Errorf("watermark 源字段 %s 不存在", requestedWatermark)
	}
	if strings.EqualFold(strings.TrimSpace(watermarkDef.Nullable), "YES") {
		return plan, fmt.Errorf("watermark 字段 %s 必须为非 NULL", watermarkColumn)
	}
	stableKeys, explicitStableKeys, err := explicitSyncKeyColumnsForTable(config, tableName, sourceCols)
	if err != nil {
		return plan, err
	}
	if !explicitStableKeys {
		stableKeys, err = syncKeyColumnsForTable(config, tableName, sourceCols)
		if err != nil {
			return plan, err
		}
	}
	tieColumns, err := canonicalStableWatermarkTies(stableKeys, requestedTies)
	if err != nil {
		return plan, err
	}
	if err := validateNonNullableWatermarkKeys("源", sourceCols, tieColumns); err != nil {
		return plan, err
	}
	targetTieColumns := make([]string, 0, len(tieColumns))
	for _, tieColumn := range tieColumns {
		targetColumn, ok := projection.TargetColumn(tieColumn)
		if !ok || strings.TrimSpace(targetColumn) == "" {
			return plan, fmt.Errorf("稳定 tie-breaker %s 未唯一映射到目标字段", tieColumn)
		}
		if _, _, exists := canonicalWatermarkColumn(targetCols, targetColumn); !exists {
			return plan, fmt.Errorf("目标表缺少 tie-breaker 字段 %s", targetColumn)
		}
		targetTieColumns = append(targetTieColumns, targetColumn)
	}
	if err := validateNonNullableWatermarkKeys("目标", targetCols, targetTieColumns); err != nil {
		return plan, err
	}
	if mode == "insert_update" && !explicitStableKeys {
		if err := validateWatermarkTargetKey(targetCols, targetTieColumns); err != nil {
			return plan, err
		}
	}
	plan.watermarkColumn = watermarkColumn
	plan.tieColumns = tieColumns
	plan.targetTieColumns = targetTieColumns
	return plan, nil
}

func validateNonNullableWatermarkKeys(side string, columns []connection.ColumnDefinition, keys []string) error {
	for _, key := range keys {
		_, definition, exists := canonicalWatermarkColumn(columns, key)
		if !exists {
			return fmt.Errorf("%s表缺少稳定 key 字段 %s", side, key)
		}
		if strings.EqualFold(strings.TrimSpace(definition.Nullable), "YES") {
			return fmt.Errorf("%s表稳定 key 字段 %s 必须为非 NULL", side, key)
		}
	}
	return nil
}

func canonicalWatermarkColumn(columns []connection.ColumnDefinition, requested string) (string, connection.ColumnDefinition, bool) {
	for _, column := range columns {
		if strings.EqualFold(strings.TrimSpace(column.Name), strings.TrimSpace(requested)) {
			return strings.TrimSpace(column.Name), column, true
		}
	}
	return "", connection.ColumnDefinition{}, false
}

func canonicalStableWatermarkTies(stableKeys, requested []string) ([]string, error) {
	available := make(map[string]string, len(stableKeys))
	for _, column := range stableKeys {
		name := strings.TrimSpace(column)
		if name != "" {
			available[strings.ToLower(name)] = name
		}
	}
	if len(available) == 0 {
		return nil, errors.New("watermark 增量要求源表具有稳定主键 tie-breaker")
	}
	if len(requested) != len(available) {
		return nil, fmt.Errorf("稳定 tie-breaker 必须完整覆盖已声明稳定 key，共 %d 列", len(available))
	}
	canonical := make([]string, 0, len(requested))
	seen := make(map[string]struct{}, len(requested))
	for _, requestedColumn := range requested {
		key := strings.ToLower(strings.TrimSpace(requestedColumn))
		name, exists := available[key]
		if !exists {
			return nil, fmt.Errorf("tie-breaker %s 不是已声明稳定 key", requestedColumn)
		}
		if _, duplicate := seen[key]; duplicate {
			return nil, fmt.Errorf("tie-breaker 字段重复：%s", requestedColumn)
		}
		seen[key] = struct{}{}
		canonical = append(canonical, name)
	}
	return canonical, nil
}

func validateWatermarkTargetKey(targetColumns []connection.ColumnDefinition, targetTies []string) error {
	primaryKeys := make(map[string]struct{})
	for _, column := range targetColumns {
		if strings.EqualFold(strings.TrimSpace(column.Key), "PRI") || strings.EqualFold(strings.TrimSpace(column.Key), "PK") {
			primaryKeys[strings.ToLower(strings.TrimSpace(column.Name))] = struct{}{}
		}
	}
	if len(primaryKeys) != len(targetTies) {
		return errors.New("insert_update 要求映射后的 tie-breaker 完整覆盖目标表主键")
	}
	for _, column := range targetTies {
		if _, ok := primaryKeys[strings.ToLower(strings.TrimSpace(column))]; !ok {
			return fmt.Errorf("insert_update 的目标 tie-breaker %s 不是目标表主键", column)
		}
	}
	return nil
}
