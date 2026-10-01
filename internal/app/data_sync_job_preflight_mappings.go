package app

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"GoNavi-Wails/internal/connection"
	syncengine "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

// 映射校验：逐表读取源端字段、目标端存在性与字段，并把问题定位回具体映射。
//
// 从 data_sync_job_preflight.go 析出。该文件已超出 800 行上限，而本次改动要给
// 映射循环加上进度记录与并发；按仓库规约「触碰超标文件时必须把本次改动抽到
// 新文件」，这里连同被它复用的索引与查询目标校验一起迁出。

// dataSyncJobPreflightConcurrency 限制映射校验的并发度。
//
// 耗时在源端数据字典往返，不在本地 CPU，所以并发能近似线性压缩总时长；但不设
// 上界会让大任务同时打满连接池与源库，反而拖慢同实例上的其它操作。取 4：足以
// 掩盖单次往返延迟，又不至于在受限账号上触发连接数告警。
const dataSyncJobPreflightConcurrency = 4

// preflightDataSyncMappingsWithProgress 并发校验全部映射，并记录进度。
//
// progress 可为 nil（调用方只关心问题列表）。非 nil 时记录「已完成几张、当前
// 在处理哪张」，供调用方把超时报成可定位的问题；并发下这是瞬时快照，不是精确
// 的完成数，但足以回答「卡在谁身上」。
func (a *App) preflightDataSyncMappingsWithProgress(ctx context.Context, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, progress *DataSyncJobPreflightProgress) []DataSyncJobPreflightIssue {
	enabled := make([]syncjob.TableMapping, 0, len(definition.Mappings))
	for _, mapping := range definition.Mappings {
		if mapping.Enabled {
			enabled = append(enabled, mapping)
		}
	}
	// 分母先落定：会话可能建不起来，但「共几张」与连接无关。
	if progress != nil {
		progress.Total = len(enabled)
	}
	if len(enabled) == 0 || ctx.Err() != nil {
		return nil
	}
	session := newMetadataSessionWithMode(a, ctx, true)
	if session == nil {
		return []DataSyncJobPreflightIssue{preflightIssue("metadata_session_unavailable", DataSyncJobPreflightBlocker, "mappings", errMetadataSessionUnavailable.Error(), "")}
	}
	defer session.Close()

	// 预取两端列定义：支持批量的驱动可以把同 schema 的多张表合并成一条查询。
	// 不可用时返回的缓存为空，逐表路径照常读取，行为与改动前一致。
	columnCache := a.prefetchDataSyncPreflightColumns(ctx, definition, source, target, session)

	limit := dataSyncJobPreflightConcurrency
	if limit > len(enabled) {
		limit = len(enabled)
	}
	slots := make(chan struct{}, limit)
	// 结果按映射原序落位，最后顺序拼接：并发不能改变问题列表的顺序，
	// 否则界面上的展示顺序会随调度抖动。
	results := make([][]DataSyncJobPreflightIssue, len(enabled))
	var mu sync.Mutex
	completed := 0
	var wg sync.WaitGroup

	for index, mapping := range enabled {
		if ctx.Err() != nil {
			// 已取消就不再排队新的映射；已派发的 goroutine 会各自感知 ctx。
			break
		}
		slots <- struct{}{}
		wg.Add(1)
		go func(index int, mapping syncjob.TableMapping) {
			defer wg.Done()
			defer func() { <-slots }()
			if progress != nil {
				mu.Lock()
				progress.Checked = completed
				progress.MappingKey = dataSyncJobMappingKey(mapping)
				progress.MappingLabel = dataSyncJobMappingLabel(mapping)
				mu.Unlock()
			}
			issues := a.preflightDataSyncMappingContext(ctx, session, definition, source, target, mapping, columnCache)
			mu.Lock()
			completed++
			results[index] = issues
			mu.Unlock()
		}(index, mapping)
	}
	wg.Wait()

	issues := make([]DataSyncJobPreflightIssue, 0)
	for _, item := range results {
		issues = append(issues, item...)
	}
	return issues
}

// preflightDataSyncMappingContext 校验单条映射。
//
// 从循环体抽出：并发执行要求每张表的状态彼此独立，因此这里不共享任何可变状态，
// 只读取 definition/session/cache 与自己的 mapping。返回空切片表示该映射无问题。
func (a *App) preflightDataSyncMappingContext(ctx context.Context, session *metadataSession, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping, columnCache *dataSyncPreflightColumnCache) []DataSyncJobPreflightIssue {
	if ctx.Err() != nil {
		// 中止原因由调用方的 stopIfCancelled 统一上报，这里只停止工作。
		return nil
	}
	mappingID := dataSyncJobMappingKey(mapping)
	issues := make([]DataSyncJobPreflightIssue, 0)
	if definition.Kind == syncjob.JobKindQuerySink {
		readOnly := isReadOnlySQLQuery(source.Config.Type, definition.SourceQuery)
		if !readOnly {
			issues = append(issues, preflightIssue("source_query_not_read_only", DataSyncJobPreflightBlocker, "mappings", "sourceQuery must be a single read-only query", mappingID))
		}
		targetIssues := a.preflightDataSyncQueryTargetContext(ctx, session, definition, mapping, target)
		issues = append(issues, targetIssues...)
		if ctx.Err() != nil {
			return issues
		}
		if readOnly && !hasPreflightBlocker(targetIssues) {
			queryColumns, queryErr := a.preflightDataSyncQueryColumnsContext(ctx, source, definition.SourceQuery)
			if queryErr != nil {
				if ctx.Err() != nil {
					return issues
				}
				issues = append(issues, preflightIssue("query_schema_probe_failed", DataSyncJobPreflightBlocker, "mappings", queryErr.Error(), mappingID))
			} else {
				issues = append(issues, preflightQuerySourceColumnIssues(mapping, queryColumns, mappingID)...)
			}
		}
		return issues
	}
	sourceColumns, sourceMessage := a.dataSyncPreflightColumns(ctx, session, columnCache, "source", source, mapping.SourceSchema, mapping.SourceTable)
	if sourceMessage != "" {
		if ctx.Err() != nil {
			return issues
		}
		issues = append(issues, preflightIssue("source_columns_failed", DataSyncJobPreflightBlocker, "mappings", sourceMessage, mappingID))
		return issues
	}
	if len(sourceColumns) == 0 {
		// 字典为空（例如同义词/受限账号）：保持与逐表路径一致的处理方式。
		issues = append(issues, preflightIssue("source_columns_failed", DataSyncJobPreflightBlocker, "mappings", "source columns are empty", mappingID))
		return issues
	}
	sourceColumnSet := dataSyncJobColumnSet(sourceColumns)
	for _, key := range mapping.KeyColumns {
		if _, exists := sourceColumnSet[strings.ToLower(strings.TrimSpace(key))]; !exists {
			issues = append(issues, preflightIssue("key_column_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("source key column %s does not exist", key), mappingID))
		}
	}
	if mapping.Watermark != nil {
		if _, exists := sourceColumnSet[strings.ToLower(strings.TrimSpace(mapping.Watermark.Column))]; !exists {
			issues = append(issues, preflightIssue("watermark_column_missing", DataSyncJobPreflightBlocker, "trigger", fmt.Sprintf("watermark column %s does not exist", mapping.Watermark.Column), mappingID))
		}
	}
	targetTable := qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
	existsResult := session.app.DBTableExists(target.Config, target.Database, targetTable)
	if !existsResult.Success {
		if ctx.Err() != nil {
			return issues
		}
		issues = append(issues, preflightIssue("target_table_check_failed", DataSyncJobPreflightBlocker, "mappings", existsResult.Message, mappingID))
		return issues
	}
	targetExists := false
	if payload, ok := existsResult.Data.(map[string]bool); ok {
		targetExists = payload["exists"]
	}
	if !targetExists {
		targetStrategy := dataSyncJobEffectiveTargetTableStrategy(definition, mapping)
		if dataSyncJobMappingNeedsExplicitProjection(definition, mapping) || targetStrategy == "existing_only" || !resultSupportsAutoCreate(syncengine.ResolveMigrationCapability(source.Config, target.Config)) {
			issues = append(issues, preflightIssue("target_table_missing", DataSyncJobPreflightBlocker, "mappings", "target table does not exist and this mapping cannot auto-create it", mappingID))
		} else {
			issues = append(issues, preflightIssue("target_table_will_be_created", DataSyncJobPreflightInfo, "mappings", "target table will be created by the migration planner", mappingID))
			issues = append(issues, a.preflightUnmigratedIndexesContext(ctx, session, definition, source, target, mapping)...)
		}
		return issues
	}
	targetColumns, targetMessage := a.dataSyncPreflightColumns(ctx, session, columnCache, "target", target, mapping.TargetSchema, mapping.TargetTable)
	if targetMessage != "" {
		if ctx.Err() != nil {
			return issues
		}
		issues = append(issues, preflightIssue("target_columns_failed", DataSyncJobPreflightBlocker, "mappings", targetMessage, mappingID))
		return issues
	}
	issues = append(issues, preflightSourceComparisonKeyIssues(definition, mapping, sourceColumns, targetColumns, targetExists, mappingID)...)
	issues = append(issues, preflightUnsupportedTargetSchemaIssues(
		definition,
		mapping,
		sourceColumns,
		targetColumns,
		source.Config.Type,
		target.Config.Type,
		mappingID,
	)...)
	issues = append(issues, preflightImplicitTargetColumnIssues(
		definition,
		mapping,
		sourceColumns,
		targetColumns,
		syncengine.ResolveMigrationCapability(source.Config, target.Config),
		mappingID,
	)...)
	targetColumnSet := dataSyncJobColumnSet(targetColumns)
	for _, column := range mapping.Columns {
		if column.Source != "" {
			if _, exists := sourceColumnSet[strings.ToLower(strings.TrimSpace(column.Source))]; !exists && len(column.DefaultValue) == 0 {
				issues = append(issues, preflightIssue("source_column_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("source column %s does not exist", column.Source), mappingID))
			}
		}
		if _, exists := targetColumnSet[strings.ToLower(strings.TrimSpace(column.Target))]; !exists {
			issues = append(issues, preflightIssue("target_column_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("target column %s does not exist", column.Target), mappingID))
		}
	}
	return issues
}

func dataSyncJobSourceIndexLocation(source resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) (string, string) {
	schema := firstNonEmptySyncJob(mapping.SourceSchema, source.Schema, source.Database)
	return strings.TrimSpace(schema), strings.TrimSpace(mapping.SourceTable)
}

// preflightUnmigratedIndexesContext 复用调用方已建立的元数据会话，
// 与映射校验共享连接，不再为每个映射单独建连。
func (a *App) preflightUnmigratedIndexesContext(ctx context.Context, session *metadataSession, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) []DataSyncJobPreflightIssue {
	mappingID := dataSyncJobMappingKey(mapping)
	if ctx.Err() != nil {
		return nil
	}
	if !definition.Options.CreateIndexes {
		return nil
	}
	config, err := buildDataSyncJobEngineConfig(definition, "preflight", source, target, mapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	if session == nil {
		return []DataSyncJobPreflightIssue{preflightIssue("metadata_session_unavailable", DataSyncJobPreflightBlocker, "mappings", errMetadataSessionUnavailable.Error(), mappingID)}
	}
	sourceDB, sourceErr := session.app.getDatabase(normalizeMetadataRunConfig(source.Config, source.Database))
	if ctx.Err() != nil {
		return nil
	}
	if sourceErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("source_connect_failed", DataSyncJobPreflightBlocker, "endpoints", sourceErr.Error(), mappingID)}
	}
	sourceSchema, sourceTable := dataSyncJobSourceIndexLocation(source, mapping)
	if _, indexErr := sourceDB.GetIndexes(sourceSchema, sourceTable); indexErr != nil {
		if ctx.Err() != nil {
			return nil
		}
		return []DataSyncJobPreflightIssue{preflightIssue("index_inspection_failed", DataSyncJobPreflightWarning, "mappings", indexErr.Error(), mappingID)}
	}
	targetDB, targetErr := session.app.getDatabase(normalizeMetadataRunConfig(target.Config, target.Database))
	if ctx.Err() != nil {
		return nil
	}
	if targetErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("target_connect_failed", DataSyncJobPreflightBlocker, "endpoints", targetErr.Error(), mappingID)}
	}
	qualifiedSourceTable := strings.TrimSpace(mapping.SourceTable)
	if strings.TrimSpace(mapping.SourceSchema) != "" {
		qualifiedSourceTable = strings.TrimSpace(mapping.SourceSchema) + "." + qualifiedSourceTable
	}
	plan, planErr := syncengine.InspectSchemaMigrationPlan(config, qualifiedSourceTable, sourceDB, targetDB)
	if planErr != nil {
		if ctx.Err() != nil {
			return nil
		}
		return []DataSyncJobPreflightIssue{preflightIssue("schema_inspection_failed", DataSyncJobPreflightWarning, "mappings", planErr.Error(), mappingID)}
	}
	issues := make([]DataSyncJobPreflightIssue, 0, len(plan.UnmigratedIndexes))
	for _, index := range plan.UnmigratedIndexes {
		indexCopy := index
		issues = append(issues, DataSyncJobPreflightIssue{
			Code:      "unmigrated_index",
			Severity:  DataSyncJobPreflightWarning,
			Stage:     "mappings",
			Message:   index.Reason,
			MappingID: mappingID,
			Detail:    &DataSyncJobPreflightIssueDetail{UnmigratedIndex: &indexCopy},
		})
	}
	return issues
}

// preflightDataSyncQueryTargetContext 复用调用方已建立的元数据会话。
func (a *App) preflightDataSyncQueryTargetContext(ctx context.Context, session *metadataSession, definition syncjob.JobDefinition, mapping syncjob.TableMapping, target resolvedDataSyncJobEndpoint) []DataSyncJobPreflightIssue {
	mappingID := dataSyncJobMappingKey(mapping)
	issues := make([]DataSyncJobPreflightIssue, 0)
	if session == nil {
		return append(issues, preflightIssue("metadata_session_unavailable", DataSyncJobPreflightBlocker, "mappings", errMetadataSessionUnavailable.Error(), mappingID))
	}
	targetTable := qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
	existsResult := session.app.DBTableExists(target.Config, target.Database, targetTable)
	if !existsResult.Success {
		if ctx.Err() != nil {
			return issues
		}
		return append(issues, preflightIssue("target_table_check_failed", DataSyncJobPreflightBlocker, "mappings", existsResult.Message, mappingID))
	}
	targetExists := false
	if payload, ok := existsResult.Data.(map[string]bool); ok {
		targetExists = payload["exists"]
	}
	if !targetExists {
		return append(issues, preflightIssue("target_table_missing", DataSyncJobPreflightBlocker, "mappings", "query sink requires an existing target table", mappingID))
	}
	targetResult := session.app.DBGetColumns(target.Config, target.Database, targetTable)
	if !targetResult.Success {
		if ctx.Err() != nil {
			return issues
		}
		return append(issues, preflightIssue("target_columns_failed", DataSyncJobPreflightBlocker, "mappings", targetResult.Message, mappingID))
	}
	targetColumns, _ := targetResult.Data.([]connection.ColumnDefinition)
	targetColumnSet := dataSyncJobColumnSet(targetColumns)
	for _, column := range mapping.Columns {
		if _, exists := targetColumnSet[strings.ToLower(strings.TrimSpace(column.Target))]; !exists {
			issues = append(issues, preflightIssue("target_column_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("target column %s does not exist", column.Target), mappingID))
		}
	}
	if dataSyncJobUsesInsertUpdate(definition) {
		indexResult := session.app.DBGetIndexes(target.Config, target.Database, targetTable)
		if !indexResult.Success {
			if ctx.Err() != nil {
				return issues
			}
			return append(issues, preflightIssue("target_indexes_failed", DataSyncJobPreflightBlocker, "mappings", indexResult.Message, mappingID))
		}
		targetIndexes, _ := indexResult.Data.([]connection.IndexDefinition)
		issues = append(issues, preflightQueryComparisonKeyIssuesWithIndexes(mapping, targetColumns, targetIndexes, mappingID)...)
	}
	return issues
}
