package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"time"
)

const (
	WatermarkCursorVersion        = 1
	WatermarkDeliveryIdempotent   = "idempotent"
	WatermarkDeliveryAtLeastOnce  = "at_least_once"
	defaultWatermarkSyncBatchSize = 500
	maxWatermarkSyncBatchSize     = 10000
)

// WatermarkCursorValue is a JSON-safe, typed scalar used by durable cursors.
// Value is always canonical text so integers and decimals never pass through a
// lossy JSON float representation.
type WatermarkCursorValue struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

// WatermarkCursor is the durable position immediately after one committed
// source row. SourceTable and column metadata prevent accidental reuse for a
// different object or key definition.
type WatermarkCursor struct {
	Version           int                    `json:"version"`
	SourceTable       string                 `json:"sourceTable"`
	WatermarkColumn   string                 `json:"watermarkColumn"`
	TieBreakerColumns []string               `json:"tieBreakerColumns"`
	Watermark         WatermarkCursorValue   `json:"watermark"`
	TieBreakers       []WatermarkCursorValue `json:"tieBreakers"`
}

// WatermarkSyncRequest executes one table per call. Sync.Mappings may rename
// the object and project its columns; Table identifies the source-side object.
type WatermarkSyncRequest struct {
	Sync              SyncConfig       `json:"sync"`
	Table             string           `json:"table"`
	WatermarkColumn   string           `json:"watermarkColumn"`
	TieBreakerColumns []string         `json:"tieBreakerColumns"`
	Cursor            *WatermarkCursor `json:"cursor,omitempty"`
	BatchSize         int              `json:"batchSize,omitempty"`
	DeliverySemantics string           `json:"deliverySemantics,omitempty"`
}

// WatermarkCheckpoint is emitted only after a non-empty target change set has
// committed, or after a source page was confirmed as an insert_update no-op.
type WatermarkCheckpoint struct {
	Cursor          WatermarkCursor `json:"cursor"`
	UpperBound      WatermarkCursor `json:"upperBound"`
	Batch           int             `json:"batch"`
	SourceRows      int             `json:"sourceRows"`
	RowsInserted    int             `json:"rowsInserted"`
	RowsUpdated     int             `json:"rowsUpdated"`
	TotalSourceRows int             `json:"totalSourceRows"`
}

type WatermarkCheckpointFunc func(context.Context, WatermarkCheckpoint) error

type WatermarkSyncResult struct {
	Success           bool             `json:"success"`
	Message           string           `json:"message,omitempty"`
	Cancelled         bool             `json:"cancelled,omitempty"`
	OutcomeUnknown    bool             `json:"outcomeUnknown,omitempty"`
	SourceRowsRead    int              `json:"sourceRowsRead"`
	RowsInserted      int              `json:"rowsInserted"`
	RowsUpdated       int              `json:"rowsUpdated"`
	BatchesProcessed  int              `json:"batchesProcessed"`
	BatchesApplied    int              `json:"batchesApplied"`
	Checkpoints       int              `json:"checkpoints"`
	Cursor            *WatermarkCursor `json:"cursor,omitempty"`
	UpperBound        *WatermarkCursor `json:"upperBound,omitempty"`
	DeliverySemantics string           `json:"deliverySemantics"`
}

type watermarkRuntimePlan struct {
	config           SyncConfig
	tableName        string
	mode             string
	batchSize        int
	sourceType       string
	targetType       string
	sourceQueryTable string
	targetQueryTable string
	applyTableName   string
	sourceColumns    []connection.ColumnDefinition
	targetColumns    []connection.ColumnDefinition
	watermarkColumn  string
	tieColumns       []string
	targetTieColumns []string
	projection       *CompiledProjection
}

// SupportsWatermarkSyncDialect reports whether the execution engine can build
// bounded composite-keyset SQL for the dialect.
func SupportsWatermarkSyncDialect(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "mysql", "mariadb",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb",
		"sqlserver", "sqlite", "duckdb":
		return true
	default:
		return false
	}
}

// RunWatermarkSync copies one bounded incremental window. The upper tuple is
// captured before the first page, so concurrent higher-watermark writes are
// deferred to the next invocation instead of extending this run forever.
func (s *SyncEngine) RunWatermarkSync(ctx context.Context, request WatermarkSyncRequest, checkpoint WatermarkCheckpointFunc) WatermarkSyncResult {
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx := markSyncDriverContext(ctx)
	delivery, _ := normalizeWatermarkDeliverySemantics(request.DeliverySemantics)
	result := WatermarkSyncResult{Cursor: cloneWatermarkCursor(request.Cursor), DeliverySemantics: delivery}

	config, tableName, mode, batchSize, err := validateWatermarkSyncRequest(request)
	if err != nil {
		return failWatermarkSync(result, runCtx, err)
	}
	if err := runCtx.Err(); err != nil {
		return failWatermarkSync(result, runCtx, err)
	}

	sourceDB, err := newSyncDatabase(config.SourceConfig.Type)
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("初始化 watermark 源数据库失败: %w", err))
	}
	targetDB, err := newSyncDatabase(config.TargetConfig.Type)
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("初始化 watermark 目标数据库失败: %w", err))
	}
	if err := sourceDB.Connect(config.SourceConfig); err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("连接 watermark 源数据库失败: %w", err))
	}
	defer sourceDB.Close()
	if err := runCtx.Err(); err != nil {
		return failWatermarkSync(result, runCtx, err)
	}
	if err := targetDB.Connect(config.TargetConfig); err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("连接 watermark 目标数据库失败: %w", err))
	}
	defer targetDB.Close()

	plan, err := buildWatermarkRuntimePlan(config, tableName, mode, batchSize, request.WatermarkColumn, request.TieBreakerColumns, sourceDB, targetDB)
	if err != nil {
		return failWatermarkSync(result, runCtx, err)
	}
	applier, ok := targetDB.(db.BatchApplier)
	if !ok {
		return failWatermarkSync(result, runCtx, errors.New("watermark 目标驱动不支持 ApplyChanges"))
	}

	if request.Cursor != nil {
		if err := validateWatermarkCursor(*request.Cursor, plan); err != nil {
			return failWatermarkSync(result, runCtx, err)
		}
	}

	upperQuery := buildWatermarkUpperBoundQuery(plan)
	upperRows, _, err := querySyncDatabaseContext(runCtx, sourceDB, upperQuery)
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("读取 watermark 固定上界失败: %w", err))
	}
	if len(upperRows) == 0 {
		result.Success = true
		return result
	}
	upperBound, err := watermarkCursorFromRow(plan, upperRows[0])
	if err != nil {
		return failWatermarkSync(result, runCtx, fmt.Errorf("解析 watermark 固定上界失败: %w", err))
	}
	result.UpperBound = cloneWatermarkCursor(&upperBound)
	if request.Cursor != nil {
		comparison, comparable, err := compareWatermarkCursorPositions(*request.Cursor, upperBound)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("比较 watermark cursor 与固定上界失败: %w", err))
		}
		if comparable && comparison >= 0 {
			result.Success = true
			return result
		}
	}

	durableCursor := cloneWatermarkCursor(request.Cursor)
	for {
		if err := runCtx.Err(); err != nil {
			result.Cursor = cloneWatermarkCursor(durableCursor)
			return failWatermarkSync(result, runCtx, err)
		}
		pageQuery, err := buildWatermarkPageQuery(plan, durableCursor, upperBound)
		if err != nil {
			return failWatermarkSync(result, runCtx, err)
		}
		sourceRows, _, err := querySyncDatabaseContext(runCtx, sourceDB, pageQuery)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("分页读取 watermark 源表失败: %w", err))
		}
		if len(sourceRows) == 0 {
			result.Success = true
			result.Cursor = cloneWatermarkCursor(durableCursor)
			return result
		}
		result.SourceRowsRead += len(sourceRows)

		candidate, err := watermarkCursorFromRow(plan, sourceRows[len(sourceRows)-1])
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("解析 watermark 批次游标失败: %w", err))
		}
		projectedRows, err := projectSyncRows(plan.projection, sourceRows)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("watermark 字段投影失败: %w", err))
		}
		changeSet, err := buildWatermarkChangeSet(runCtx, plan, targetDB, projectedRows)
		if err != nil {
			return failWatermarkSync(result, runCtx, err)
		}

		batchInserted := len(changeSet.Inserts)
		batchUpdated := len(changeSet.Updates)
		if batchInserted > 0 || batchUpdated > 0 {
			if err := applySyncChangesContext(runCtx, applier, plan.applyTableName, changeSet); err != nil {
				result.Cursor = cloneWatermarkCursor(durableCursor)
				result.OutcomeUnknown = db.IsWriteOutcomeUnknown(err)
				return failWatermarkSync(result, runCtx, fmt.Errorf("应用 watermark 目标批次失败: %w", err))
			}
			result.RowsInserted += batchInserted
			result.RowsUpdated += batchUpdated
			result.BatchesApplied++
		}
		if err := runCtx.Err(); err != nil {
			result.Cursor = cloneWatermarkCursor(durableCursor)
			return failWatermarkSync(result, runCtx, err)
		}

		checkpointEvent := WatermarkCheckpoint{
			Cursor:          *cloneWatermarkCursor(&candidate),
			UpperBound:      *cloneWatermarkCursor(&upperBound),
			Batch:           result.BatchesProcessed + 1,
			SourceRows:      len(sourceRows),
			RowsInserted:    batchInserted,
			RowsUpdated:     batchUpdated,
			TotalSourceRows: result.SourceRowsRead,
		}
		if checkpoint != nil {
			if err := checkpoint(runCtx, checkpointEvent); err != nil {
				result.Cursor = cloneWatermarkCursor(durableCursor)
				return failWatermarkSync(result, runCtx, fmt.Errorf("持久化 watermark checkpoint 失败（目标批次可能已提交）: %w", err))
			}
			result.Checkpoints++
		}
		durableCursor = cloneWatermarkCursor(&candidate)
		result.Cursor = cloneWatermarkCursor(durableCursor)
		result.BatchesProcessed++
		comparison, comparable, err := compareWatermarkCursorPositions(candidate, upperBound)
		if err != nil {
			return failWatermarkSync(result, runCtx, fmt.Errorf("比较 watermark 批次游标与固定上界失败: %w", err))
		}
		if comparable && comparison >= 0 {
			result.Success = true
			return result
		}
		if len(sourceRows) < plan.batchSize {
			result.Success = true
			return result
		}
	}
}

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
		plan.targetQueryTable = qualifiedNameForQuery(plan.targetType, targetSchema, targetTable, tableName)
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

func watermarkPositionColumns(plan watermarkRuntimePlan) []string {
	columns := make([]string, 0, len(plan.tieColumns)+1)
	columns = append(columns, plan.watermarkColumn)
	columns = append(columns, plan.tieColumns...)
	return columns
}

func watermarkPositionValues(cursor WatermarkCursor) []WatermarkCursorValue {
	values := make([]WatermarkCursorValue, 0, len(cursor.TieBreakers)+1)
	values = append(values, cursor.Watermark)
	values = append(values, cursor.TieBreakers...)
	return values
}

func buildWatermarkUpperBoundQuery(plan watermarkRuntimePlan) string {
	columns := watermarkPositionColumns(plan)
	selectList := make([]string, 0, len(columns))
	nonNull := make([]string, 0, len(columns))
	orderBy := make([]string, 0, len(columns))
	for _, column := range columns {
		quoted := quoteIdentByType(plan.sourceType, column)
		selectList = append(selectList, quoted)
		nonNull = append(nonNull, quoted+" IS NOT NULL")
		orderBy = append(orderBy, quoted+" DESC")
	}
	if normalizeMigrationDBType(plan.sourceType) == "sqlserver" {
		return fmt.Sprintf("SELECT TOP (1) %s FROM %s WHERE %s ORDER BY %s",
			strings.Join(selectList, ", "),
			quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
			strings.Join(nonNull, " AND "),
			strings.Join(orderBy, ", "))
	}
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s ORDER BY %s LIMIT 1",
		strings.Join(selectList, ", "),
		quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
		strings.Join(nonNull, " AND "),
		strings.Join(orderBy, ", "))
}

func buildWatermarkPageQuery(plan watermarkRuntimePlan, lower *WatermarkCursor, upper WatermarkCursor) (string, error) {
	positionColumns := watermarkPositionColumns(plan)
	conditions := make([]string, 0, 3)
	for _, column := range positionColumns {
		conditions = append(conditions, quoteIdentByType(plan.sourceType, column)+" IS NOT NULL")
	}
	if lower != nil {
		predicate, err := buildWatermarkLexicographicPredicate(plan.sourceType, positionColumns, watermarkPositionValues(*lower), ">", false)
		if err != nil {
			return "", fmt.Errorf("构建 watermark 下界失败: %w", err)
		}
		conditions = append(conditions, predicate)
	}
	upperPredicate, err := buildWatermarkLexicographicPredicate(plan.sourceType, positionColumns, watermarkPositionValues(upper), "<", true)
	if err != nil {
		return "", fmt.Errorf("构建 watermark 上界失败: %w", err)
	}
	conditions = append(conditions, upperPredicate)

	selectList := buildColumnSelectListForSync(plan.sourceType, plan.sourceColumns)
	if strings.TrimSpace(selectList) == "" {
		return "", errors.New("watermark 源表没有可读取字段")
	}
	orderBy := make([]string, 0, len(positionColumns))
	for _, column := range positionColumns {
		orderBy = append(orderBy, quoteIdentByType(plan.sourceType, column)+" ASC")
	}
	if normalizeMigrationDBType(plan.sourceType) == "sqlserver" {
		return fmt.Sprintf("SELECT TOP (%d) %s FROM %s WHERE %s ORDER BY %s",
			plan.batchSize,
			selectList,
			quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
			strings.Join(conditions, " AND "),
			strings.Join(orderBy, ", ")), nil
	}
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s ORDER BY %s LIMIT %d",
		selectList,
		quoteQualifiedIdentByType(plan.sourceType, plan.sourceQueryTable),
		strings.Join(conditions, " AND "),
		strings.Join(orderBy, ", "),
		plan.batchSize), nil
}

func buildWatermarkLexicographicPredicate(dbType string, columns []string, values []WatermarkCursorValue, comparator string, inclusive bool) (string, error) {
	if len(columns) == 0 || len(columns) != len(values) {
		return "", errors.New("复合 watermark 字段和值数量不一致")
	}
	if comparator != ">" && comparator != "<" {
		return "", fmt.Errorf("不支持的 watermark 比较符 %q", comparator)
	}
	literals := make([]string, len(values))
	for index, value := range values {
		literal, err := watermarkCursorSQLLiteral(dbType, value)
		if err != nil {
			return "", err
		}
		literals[index] = literal
	}
	clauses := make([]string, 0, len(columns))
	for index := range columns {
		parts := make([]string, 0, index+1)
		for prefix := 0; prefix < index; prefix++ {
			parts = append(parts, fmt.Sprintf("%s = %s", quoteIdentByType(dbType, columns[prefix]), literals[prefix]))
		}
		operator := comparator
		if inclusive && index == len(columns)-1 {
			operator += "="
		}
		parts = append(parts, fmt.Sprintf("%s %s %s", quoteIdentByType(dbType, columns[index]), operator, literals[index]))
		clauses = append(clauses, "("+strings.Join(parts, " AND ")+")")
	}
	return "(" + strings.Join(clauses, " OR ") + ")", nil
}

func watermarkCursorFromRow(plan watermarkRuntimePlan, row map[string]interface{}) (WatermarkCursor, error) {
	_, watermarkDefinition, exists := canonicalWatermarkColumn(plan.sourceColumns, plan.watermarkColumn)
	if !exists {
		return WatermarkCursor{}, fmt.Errorf("watermark 元数据缺少字段 %s", plan.watermarkColumn)
	}
	watermarkValue, err := watermarkValueFromRow(row, plan.watermarkColumn, watermarkDefinition)
	if err != nil {
		return WatermarkCursor{}, err
	}
	cursor := WatermarkCursor{
		Version:           WatermarkCursorVersion,
		SourceTable:       plan.sourceQueryTable,
		WatermarkColumn:   plan.watermarkColumn,
		TieBreakerColumns: append([]string(nil), plan.tieColumns...),
		Watermark:         watermarkValue,
		TieBreakers:       make([]WatermarkCursorValue, 0, len(plan.tieColumns)),
	}
	for _, column := range plan.tieColumns {
		_, definition, exists := canonicalWatermarkColumn(plan.sourceColumns, column)
		if !exists {
			return WatermarkCursor{}, fmt.Errorf("watermark 元数据缺少字段 %s", column)
		}
		value, err := watermarkValueFromRow(row, column, definition)
		if err != nil {
			return WatermarkCursor{}, err
		}
		cursor.TieBreakers = append(cursor.TieBreakers, value)
	}
	return cursor, nil
}

func watermarkValueFromRow(row map[string]interface{}, column string, definition connection.ColumnDefinition) (WatermarkCursorValue, error) {
	value, exists, ambiguous := lookupProjectionSourceValue(row, column)
	if ambiguous {
		return WatermarkCursorValue{}, fmt.Errorf("watermark 行包含多个大小写不一致的字段 %s", column)
	}
	if !exists {
		return WatermarkCursorValue{}, fmt.Errorf("watermark 行缺少字段 %s", column)
	}
	typed, err := watermarkCursorValueForColumn(value, definition)
	if err != nil {
		return WatermarkCursorValue{}, fmt.Errorf("watermark 字段 %s: %w", column, err)
	}
	return typed, nil
}

func watermarkCursorValueForColumn(value interface{}, definition connection.ColumnDefinition) (WatermarkCursorValue, error) {
	typeName := strings.ToLower(strings.TrimSpace(definition.Type))
	baseType := typeName
	if index := strings.IndexAny(baseType, "( "); index >= 0 {
		baseType = baseType[:index]
	}
	switch {
	case baseType == "date":
		parsed, err := projectionTime(value, SyncValueTransform{Type: "date"}, true)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "date", Value: parsed.Format("2006-01-02")}, nil
	case strings.Contains(baseType, "timestamp") || strings.Contains(baseType, "datetime"):
		parsed, err := watermarkTimestampValue(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "timestamp", Value: parsed.Format(time.RFC3339Nano)}, nil
	case watermarkIntegerColumnType(baseType):
		decimal, err := projectionDecimal(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		text := decimal.String()
		if strings.Contains(typeName, "unsigned") || strings.HasPrefix(baseType, "uint") {
			if _, err := strconv.ParseUint(text, 10, 64); err != nil {
				return WatermarkCursorValue{}, err
			}
			return WatermarkCursorValue{Type: "uint64", Value: text}, nil
		}
		if _, err := strconv.ParseInt(text, 10, 64); err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "int64", Value: text}, nil
	case watermarkDecimalColumnType(baseType):
		decimal, err := projectionDecimal(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "decimal", Value: decimal.String()}, nil
	case watermarkFloatColumnType(baseType):
		decimal, err := projectionDecimal(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		parsed, err := strconv.ParseFloat(decimal.String(), 64)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return finiteWatermarkFloat(parsed, 64)
	case baseType == "bool" || baseType == "boolean" || strings.HasPrefix(typeName, "bit(1") || strings.HasPrefix(typeName, "tinyint(1"):
		parsed, err := projectionBool(value)
		if err != nil {
			return WatermarkCursorValue{}, err
		}
		return WatermarkCursorValue{Type: "bool", Value: strconv.FormatBool(parsed)}, nil
	case watermarkBinaryColumnType(baseType):
		return watermarkBinaryCursorValue(value)
	default:
		return watermarkCursorValue(value)
	}
}

func watermarkTimestampValue(value interface{}) (time.Time, error) {
	switch typed := value.(type) {
	case time.Time:
		return typed, nil
	case []byte:
		return watermarkTimestampValue(string(typed))
	case string:
		text := strings.TrimSpace(typed)
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if parsed, err := time.Parse(layout, text); err == nil {
				return parsed, nil
			}
		}
		return parseProjectionTimeText(text, time.UTC)
	default:
		return time.Time{}, fmt.Errorf("无法把 %T 转为 timestamp watermark", value)
	}
}

func watermarkIntegerColumnType(baseType string) bool {
	switch baseType {
	case "int", "integer", "tinyint", "smallint", "mediumint", "bigint", "int2", "int4", "int8",
		"uint", "uint8", "uint16", "uint32", "uint64", "serial", "smallserial", "bigserial":
		return true
	default:
		return false
	}
}

func watermarkDecimalColumnType(baseType string) bool {
	switch baseType {
	case "decimal", "numeric", "number", "dec", "fixed", "money", "smallmoney":
		return true
	default:
		return false
	}
}

func watermarkFloatColumnType(baseType string) bool {
	switch baseType {
	case "float", "float4", "float8", "double", "real":
		return true
	default:
		return false
	}
}

func watermarkBinaryColumnType(baseType string) bool {
	switch baseType {
	case "binary", "varbinary", "blob", "bytea", "raw":
		return true
	default:
		return false
	}
}

func watermarkBinaryCursorValue(value interface{}) (WatermarkCursorValue, error) {
	var raw []byte
	switch typed := value.(type) {
	case []byte:
		raw = append([]byte(nil), typed...)
	case string:
		if strings.HasPrefix(strings.ToLower(typed), "0x") {
			decoded, err := hex.DecodeString(typed[2:])
			if err != nil {
				return WatermarkCursorValue{}, fmt.Errorf("无效二进制 watermark: %w", err)
			}
			raw = decoded
		} else {
			raw = []byte(typed)
		}
	default:
		return WatermarkCursorValue{}, fmt.Errorf("无法把 %T 转为二进制 watermark", value)
	}
	return WatermarkCursorValue{Type: "bytes", Value: base64.StdEncoding.EncodeToString(raw)}, nil
}

func validateWatermarkCursor(cursor WatermarkCursor, plan watermarkRuntimePlan) error {
	if cursor.Version != WatermarkCursorVersion {
		return fmt.Errorf("不支持的 watermark cursor 版本 %d", cursor.Version)
	}
	if !strings.EqualFold(strings.TrimSpace(cursor.SourceTable), strings.TrimSpace(plan.sourceQueryTable)) {
		return fmt.Errorf("watermark cursor 属于表 %s，当前表为 %s", cursor.SourceTable, plan.sourceQueryTable)
	}
	if !strings.EqualFold(strings.TrimSpace(cursor.WatermarkColumn), plan.watermarkColumn) {
		return fmt.Errorf("watermark cursor 字段 %s 与当前字段 %s 不一致", cursor.WatermarkColumn, plan.watermarkColumn)
	}
	if len(cursor.TieBreakerColumns) != len(plan.tieColumns) || len(cursor.TieBreakers) != len(plan.tieColumns) {
		return errors.New("watermark cursor tie-breaker 数量与当前配置不一致")
	}
	for index, column := range plan.tieColumns {
		if !strings.EqualFold(strings.TrimSpace(cursor.TieBreakerColumns[index]), column) {
			return fmt.Errorf("watermark cursor tie-breaker[%d] 与当前配置不一致", index)
		}
	}
	if _, err := watermarkCursorSQLLiteral(plan.sourceType, cursor.Watermark); err != nil {
		return fmt.Errorf("watermark cursor 水位值无效: %w", err)
	}
	for index, value := range cursor.TieBreakers {
		if _, err := watermarkCursorSQLLiteral(plan.sourceType, value); err != nil {
			return fmt.Errorf("watermark cursor tie-breaker[%d] 无效: %w", index, err)
		}
	}
	return nil
}

func compareWatermarkCursorPositions(left, right WatermarkCursor) (int, bool, error) {
	leftValues := watermarkPositionValues(left)
	rightValues := watermarkPositionValues(right)
	if len(leftValues) != len(rightValues) {
		return 0, false, errors.New("watermark cursor 复合位置长度不一致")
	}
	for index := range leftValues {
		comparison, comparable, err := compareWatermarkCursorValue(leftValues[index], rightValues[index])
		if err != nil {
			return 0, false, err
		}
		if !comparable {
			return 0, false, nil
		}
		if comparison != 0 {
			return comparison, true, nil
		}
	}
	return 0, true, nil
}

func compareWatermarkCursorValue(left, right WatermarkCursorValue) (int, bool, error) {
	leftType := strings.ToLower(strings.TrimSpace(left.Type))
	rightType := strings.ToLower(strings.TrimSpace(right.Type))
	if watermarkCursorNumericType(leftType) && watermarkCursorNumericType(rightType) {
		leftNumber, _, err := big.ParseFloat(left.Value, 10, 256, big.ToNearestEven)
		if err != nil {
			return 0, false, err
		}
		rightNumber, _, err := big.ParseFloat(right.Value, 10, 256, big.ToNearestEven)
		if err != nil {
			return 0, false, err
		}
		return leftNumber.Cmp(rightNumber), true, nil
	}
	if leftType == "timestamp" && rightType == "timestamp" {
		leftTime, err := time.Parse(time.RFC3339Nano, left.Value)
		if err != nil {
			return 0, false, err
		}
		rightTime, err := time.Parse(time.RFC3339Nano, right.Value)
		if err != nil {
			return 0, false, err
		}
		switch {
		case leftTime.Before(rightTime):
			return -1, true, nil
		case leftTime.After(rightTime):
			return 1, true, nil
		default:
			return 0, true, nil
		}
	}
	if leftType == "date" && rightType == "date" {
		leftTime, err := time.Parse("2006-01-02", left.Value)
		if err != nil {
			return 0, false, err
		}
		rightTime, err := time.Parse("2006-01-02", right.Value)
		if err != nil {
			return 0, false, err
		}
		switch {
		case leftTime.Before(rightTime):
			return -1, true, nil
		case leftTime.After(rightTime):
			return 1, true, nil
		default:
			return 0, true, nil
		}
	}
	if leftType == "bool" && rightType == "bool" {
		leftBool, err := strconv.ParseBool(left.Value)
		if err != nil {
			return 0, false, err
		}
		rightBool, err := strconv.ParseBool(right.Value)
		if err != nil {
			return 0, false, err
		}
		switch {
		case leftBool == rightBool:
			return 0, true, nil
		case !leftBool:
			return -1, true, nil
		default:
			return 1, true, nil
		}
	}
	// Text ordering is collation-dependent. Equality is safe to decide in Go;
	// unequal values fall back to one bounded SQL page instead of risking skips.
	if (leftType == "string" || leftType == "bytes") && (rightType == "string" || rightType == "bytes") {
		leftText, err := watermarkCursorText(left)
		if err != nil {
			return 0, false, err
		}
		rightText, err := watermarkCursorText(right)
		if err != nil {
			return 0, false, err
		}
		if leftText == rightText {
			return 0, true, nil
		}
		return 0, false, nil
	}
	return 0, false, nil
}

func watermarkCursorNumericType(valueType string) bool {
	switch valueType {
	case "int64", "uint64", "decimal", "float64":
		return true
	default:
		return false
	}
}

func watermarkCursorText(value WatermarkCursorValue) (string, error) {
	if strings.EqualFold(value.Type, "string") {
		return value.Value, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(value.Value)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

func buildWatermarkChangeSet(ctx context.Context, plan watermarkRuntimePlan, targetDB db.Database, projectedRows []map[string]interface{}) (connection.ChangeSet, error) {
	if plan.mode == "insert_only" {
		return connection.ChangeSet{Inserts: projectedRows}, nil
	}
	if len(projectedRows) == 0 {
		return connection.ChangeSet{}, nil
	}
	query, err := buildWatermarkTargetLookupQuery(plan, projectedRows)
	if err != nil {
		return connection.ChangeSet{}, err
	}
	targetRows, _, err := querySyncDatabaseContext(ctx, targetDB, query)
	if err != nil {
		return connection.ChangeSet{}, fmt.Errorf("按复合 tie-breaker 读取 watermark 目标行失败: %w", err)
	}
	targetByKey := make(map[string]map[string]interface{}, len(targetRows))
	for _, targetRow := range targetRows {
		key, err := watermarkCompositeRowKey(targetRow, plan.targetTieColumns)
		if err != nil {
			return connection.ChangeSet{}, fmt.Errorf("目标行复合主键无效: %w", err)
		}
		if _, duplicate := targetByKey[key]; duplicate {
			return connection.ChangeSet{}, errors.New("目标表存在重复的 watermark tie-breaker")
		}
		targetByKey[key] = targetRow
	}

	changeSet := connection.ChangeSet{
		Inserts: make([]map[string]interface{}, 0),
		Updates: make([]connection.UpdateRow, 0),
	}
	for _, sourceRow := range projectedRows {
		key, err := watermarkCompositeRowKey(sourceRow, plan.targetTieColumns)
		if err != nil {
			return connection.ChangeSet{}, fmt.Errorf("投影后源行复合主键无效: %w", err)
		}
		targetRow, exists := targetByKey[key]
		if !exists {
			changeSet.Inserts = append(changeSet.Inserts, sourceRow)
			continue
		}
		values := make(map[string]interface{})
		for column, sourceValue := range sourceRow {
			targetValue, _, ambiguous := lookupProjectionSourceValue(targetRow, column)
			if ambiguous {
				return connection.ChangeSet{}, fmt.Errorf("目标行字段 %s 大小写歧义", column)
			}
			if !watermarkValuesEqual(sourceValue, targetValue) {
				values[column] = sourceValue
			}
		}
		if len(values) == 0 {
			continue
		}
		keys := make(map[string]interface{}, len(plan.targetTieColumns))
		for _, column := range plan.targetTieColumns {
			value, exists, ambiguous := lookupProjectionSourceValue(sourceRow, column)
			if ambiguous || !exists || value == nil {
				return connection.ChangeSet{}, fmt.Errorf("投影后源行缺少目标主键 %s", column)
			}
			keys[column] = value
		}
		changeSet.Updates = append(changeSet.Updates, connection.UpdateRow{Keys: keys, Values: values})
	}
	return changeSet, nil
}

func buildWatermarkTargetLookupQuery(plan watermarkRuntimePlan, rows []map[string]interface{}) (string, error) {
	groups := make([]string, 0, len(rows))
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		key, err := watermarkCompositeRowKey(row, plan.targetTieColumns)
		if err != nil {
			return "", err
		}
		if _, duplicate := seen[key]; duplicate {
			continue
		}
		seen[key] = struct{}{}
		parts := make([]string, 0, len(plan.targetTieColumns))
		for _, column := range plan.targetTieColumns {
			value, exists, ambiguous := lookupProjectionSourceValue(row, column)
			if ambiguous || !exists || value == nil {
				return "", fmt.Errorf("投影后源行缺少目标 tie-breaker %s", column)
			}
			typed, err := watermarkCursorValue(value)
			if err != nil {
				return "", err
			}
			literal, err := watermarkCursorSQLLiteral(plan.targetType, typed)
			if err != nil {
				return "", err
			}
			parts = append(parts, fmt.Sprintf("%s = %s", quoteIdentByType(plan.targetType, column), literal))
		}
		groups = append(groups, "("+strings.Join(parts, " AND ")+")")
	}
	if len(groups) == 0 {
		return "", errors.New("watermark 目标主键查询为空")
	}
	selectList := buildColumnSelectListForSync(plan.targetType, plan.targetColumns)
	return fmt.Sprintf("SELECT %s FROM %s WHERE %s",
		selectList,
		quoteQualifiedIdentByType(plan.targetType, plan.targetQueryTable),
		strings.Join(groups, " OR ")), nil
}

func watermarkCompositeRowKey(row map[string]interface{}, columns []string) (string, error) {
	var builder strings.Builder
	for _, column := range columns {
		value, exists, ambiguous := lookupProjectionSourceValue(row, column)
		if ambiguous || !exists || value == nil {
			return "", fmt.Errorf("复合键字段 %s 缺失、为 NULL 或大小写歧义", column)
		}
		text := watermarkComparableText(value)
		builder.WriteString(strconv.Itoa(len(text)))
		builder.WriteByte(':')
		builder.WriteString(text)
		builder.WriteByte('|')
	}
	return builder.String(), nil
}

func watermarkComparableText(value interface{}) string {
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	case json.Number:
		return typed.String()
	default:
		return fmt.Sprint(value)
	}
}

func watermarkValuesEqual(left, right interface{}) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return watermarkComparableText(left) == watermarkComparableText(right)
}

func failWatermarkSync(result WatermarkSyncResult, ctx context.Context, err error) WatermarkSyncResult {
	result.Success = false
	if ctx != nil && ctx.Err() != nil {
		result.Cancelled = true
		result.Message = ctx.Err().Error()
		return result
	}
	if err != nil {
		result.Message = err.Error()
	}
	return result
}

func cloneWatermarkCursor(cursor *WatermarkCursor) *WatermarkCursor {
	if cursor == nil {
		return nil
	}
	cloned := *cursor
	cloned.TieBreakerColumns = append([]string(nil), cursor.TieBreakerColumns...)
	cloned.TieBreakers = append([]WatermarkCursorValue(nil), cursor.TieBreakers...)
	return &cloned
}

func watermarkCursorValue(value interface{}) (WatermarkCursorValue, error) {
	if value == nil {
		return WatermarkCursorValue{}, errors.New("watermark 游标字段不能为 NULL")
	}
	switch typed := value.(type) {
	case string:
		return WatermarkCursorValue{Type: "string", Value: typed}, nil
	case []byte:
		return WatermarkCursorValue{Type: "bytes", Value: base64.StdEncoding.EncodeToString(typed)}, nil
	case time.Time:
		return WatermarkCursorValue{Type: "timestamp", Value: typed.Format(time.RFC3339Nano)}, nil
	case json.Number:
		if !projectionDecimalPattern.MatchString(strings.TrimSpace(typed.String())) {
			return WatermarkCursorValue{}, errors.New("watermark decimal 值无效")
		}
		return WatermarkCursorValue{Type: "decimal", Value: strings.TrimSpace(typed.String())}, nil
	case bool:
		return WatermarkCursorValue{Type: "bool", Value: strconv.FormatBool(typed)}, nil
	case float32:
		return finiteWatermarkFloat(float64(typed), 32)
	case float64:
		return finiteWatermarkFloat(typed, 64)
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return WatermarkCursorValue{Type: "int64", Value: strconv.FormatInt(rv.Int(), 10)}, nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return WatermarkCursorValue{Type: "uint64", Value: strconv.FormatUint(rv.Uint(), 10)}, nil
	default:
		return WatermarkCursorValue{}, fmt.Errorf("watermark 游标不支持值类型 %T", value)
	}
}

func finiteWatermarkFloat(value float64, bitSize int) (WatermarkCursorValue, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return WatermarkCursorValue{}, errors.New("watermark 浮点游标不能是 NaN 或无穷大")
	}
	return WatermarkCursorValue{Type: "float64", Value: strconv.FormatFloat(value, 'g', -1, bitSize)}, nil
}

func watermarkCursorSQLLiteral(dbType string, value WatermarkCursorValue) (string, error) {
	switch strings.ToLower(strings.TrimSpace(value.Type)) {
	case "string":
		return quoteSyncSQLString(dbType, value.Value), nil
	case "bytes":
		decoded, err := base64.StdEncoding.DecodeString(value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 bytes 游标: %w", err)
		}
		hexValue := hex.EncodeToString(decoded)
		switch normalizeMigrationDBType(dbType) {
		case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
			return "decode('" + hexValue + "', 'hex')", nil
		case "sqlserver":
			return "0x" + hexValue, nil
		case "duckdb":
			return "from_hex('" + hexValue + "')", nil
		default:
			return "X'" + hexValue + "'", nil
		}
	case "date":
		parsed, err := time.Parse("2006-01-02", value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 date 游标: %w", err)
		}
		return quoteSyncSQLString(dbType, parsed.Format("2006-01-02")), nil
	case "timestamp":
		parsed, err := time.Parse(time.RFC3339Nano, value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 timestamp 游标: %w", err)
		}
		formatted := parsed.Format(time.RFC3339Nano)
		if normalized := normalizeMigrationDBType(dbType); normalized == "mysql" || normalized == "mariadb" {
			formatted = parsed.Format("2006-01-02 15:04:05.999999999")
		}
		return quoteSyncSQLString(dbType, formatted), nil
	case "int64":
		if _, err := strconv.ParseInt(value.Value, 10, 64); err != nil {
			return "", fmt.Errorf("无效 int64 游标: %w", err)
		}
		return value.Value, nil
	case "uint64":
		if _, err := strconv.ParseUint(value.Value, 10, 64); err != nil {
			return "", fmt.Errorf("无效 uint64 游标: %w", err)
		}
		return value.Value, nil
	case "decimal":
		if !projectionDecimalPattern.MatchString(value.Value) {
			return "", errors.New("无效 decimal 游标")
		}
		return value.Value, nil
	case "float64":
		parsed, err := strconv.ParseFloat(value.Value, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return "", errors.New("无效 float64 游标")
		}
		return value.Value, nil
	case "bool":
		parsed, err := strconv.ParseBool(value.Value)
		if err != nil {
			return "", fmt.Errorf("无效 bool 游标: %w", err)
		}
		if normalizeMigrationDBType(dbType) == "sqlserver" {
			if parsed {
				return "1", nil
			}
			return "0", nil
		}
		if parsed {
			return "TRUE", nil
		}
		return "FALSE", nil
	default:
		return "", fmt.Errorf("不支持的 watermark 游标类型 %q", value.Type)
	}
}
