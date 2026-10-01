package app

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

// preflightDataSyncJob 是不带调用方 ctx 的入口，供桌面端 Wails 绑定使用。
//
// 桌面端的绑定不带 signal，驱动 Connect/Ping 阻塞时前端无法取消，界面只会在
// finally 里解锁 —— 无上界的等待会让「启用任务」「检查并运行」「保存」永久停在
// 转圈状态。这里统一套一层超时，让每个入口都必然返回一个可操作的结果。
// web 端走 dataSyncJobPreflightContext，其 ctx 已带超时；WithTimeout 取更早的
// 截止时间，叠加是安全的。
func (a *App) preflightDataSyncJob(input syncjob.JobDefinition, now time.Time) DataSyncJobPreflightResult {
	// 预算按映射规模放宽：固定 60 秒会让 Oracle 等慢元数据源端在大任务上必然超时。
	definition := syncjob.NormalizeDefinition(input)
	ctx, cancel := context.WithTimeout(context.Background(), dataSyncJobPreflightTimeoutFor(definition))
	defer cancel()
	return a.preflightDataSyncJobContext(ctx, input, now)
}

func (a *App) preflightDataSyncJobContext(ctx context.Context, input syncjob.JobDefinition, now time.Time) DataSyncJobPreflightResult {
	if ctx == nil {
		ctx = context.Background()
	}
	definition := syncjob.NormalizeDefinition(input)
	if definition.Kind == syncjob.JobKindBackup {
		return a.preflightBackupJob(ctx, definition, now)
	}
	// Approval is backend-owned evidence. Never echo or validate a caller-
	// supplied approval object; only one-time tokens can mint this state.
	definition.Approval = nil
	result := DataSyncJobPreflightResult{
		Definition: definition,
		Issues:     []DataSyncJobPreflightIssue{},
		NextRunAt:  []int64{},
		CheckedAt:  now.UnixMilli(),
	}
	// mappingProgress 只在映射校验阶段非 nil，用于把超时定位到具体那一行。
	var mappingProgress *DataSyncJobPreflightProgress
	stopIfCancelled := func(stage string) bool {
		err := ctx.Err()
		if err == nil {
			return false
		}
		code := dataSyncJobContextIssueCode(err)
		if hasPreflightIssueCode(result.Issues, code) {
			return true
		}
		issue := preflightIssue(code, DataSyncJobPreflightBlocker, stage, err.Error(), "")
		if mappingProgress != nil {
			issue.Detail = &DataSyncJobPreflightIssueDetail{PreflightProgress: mappingProgress}
		}
		result.Issues = append(result.Issues, issue)
		return true
	}
	if stopIfCancelled("preflight") {
		return finishDataSyncJobPreflight(result)
	}
	if err := syncjob.ValidateDefinition(definition); err != nil {
		result.Issues = append(result.Issues, preflightIssue("definition_invalid", DataSyncJobPreflightBlocker, "endpoints", err.Error(), ""))
		return finishDataSyncJobPreflight(result)
	}

	source, err := a.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
	if err != nil {
		result.Issues = append(result.Issues, preflightIssue("source_connection_failed", DataSyncJobPreflightBlocker, "endpoints", err.Error(), ""))
		return finishDataSyncJobPreflight(result)
	}
	if stopIfCancelled("endpoints") {
		return finishDataSyncJobPreflight(result)
	}
	target, err := a.resolveDataSyncJobEndpoint(definition.Target.ConnectionID, definition.Target.Database, definition.Target.Schema)
	if err != nil {
		result.Issues = append(result.Issues, preflightIssue("target_connection_failed", DataSyncJobPreflightBlocker, "endpoints", err.Error(), ""))
		return finishDataSyncJobPreflight(result)
	}
	definition.Source.ConnectionName = source.View.Name
	definition.Source.ConnectionType = source.Config.Type
	definition.Source.Fingerprint = source.Fingerprint
	definition.Target.ConnectionName = target.View.Name
	definition.Target.ConnectionType = target.Config.Type
	definition.Target.Fingerprint = target.Fingerprint
	if definition.IncrementalMode == syncjob.IncrementalCDC && definition.CDC != nil {
		adapter, adapterErr := a.resolveDataSyncCDCAdapter(source.Config)
		if adapterErr != nil {
			result.Issues = append(result.Issues, preflightIssue("cdc_adapter_unavailable", DataSyncJobPreflightBlocker, "trigger", adapterErr.Error(), ""))
		} else {
			definition.CDC.Adapter = adapter.Name()
		}
	}
	result.Definition = definition
	result.SourceFingerprint = source.Fingerprint
	result.TargetFingerprint = target.Fingerprint
	result.ApprovalRequired = dataSyncJobRequiresExecutionApproval(definition, target)
	result.Capability = sync.ResolveMigrationCapability(source.Config, target.Config)

	for _, mapping := range definition.Mappings {
		if mapping.Enabled && sameDataSyncJobObject(definition, mapping) {
			result.Issues = append(result.Issues, preflightIssue("same_object", DataSyncJobPreflightBlocker, "mappings", "source and target resolve to the same physical object", dataSyncJobMappingKey(mapping)))
		}
	}
	if !result.Capability.CanExecute {
		message := fmt.Sprintf("migration route %s -> %s is %s", result.Capability.SourceType, result.Capability.TargetType, result.Capability.SupportLevel)
		result.Issues = append(result.Issues, preflightIssue("route_unsupported", DataSyncJobPreflightBlocker, "endpoints", message, ""))
	}
	result.Issues = append(result.Issues, appendOnlyTargetPreflightIssues(definition, result.Capability)...)
	if definition.Kind != syncjob.JobKindCompare {
		for _, mapping := range definition.Mappings {
			if !mapping.Enabled {
				continue
			}
			config, buildErr := buildDataSyncJobEngineConfig(definition, "preflight", source, target, mapping)
			if buildErr != nil {
				result.Issues = append(result.Issues, preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", buildErr.Error(), dataSyncJobMappingKey(mapping)))
				continue
			}
			if protectionErr := ensureDataSyncTargetProtection(config); protectionErr != nil {
				result.Issues = append(result.Issues, preflightIssue("target_protection_blocked", DataSyncJobPreflightBlocker, "delivery", protectionErr.Error(), dataSyncJobMappingKey(mapping)))
			}
			if definition.Options.ErrorPolicy == syncjob.ErrorPolicySkipRow && definition.IncrementalMode == syncjob.IncrementalSnapshot {
				config.OnRowError = func(context.Context, sync.ChangeEventRowError) error { return nil }
				if validationErr := sync.ValidateSnapshotRowErrorConfig(config); validationErr != nil {
					result.Issues = append(result.Issues, preflightIssue("row_error_isolation_unsupported", DataSyncJobPreflightBlocker, "delivery", validationErr.Error(), dataSyncJobMappingKey(mapping)))
				}
			}
		}
	}

	if stopIfCancelled("endpoints") {
		return finishDataSyncJobPreflight(result)
	}
	// 用可取消版本：驱动 Connect/Ping 不监听 ctx，同步版本会在 SSH 转发下
	// 无限期阻塞，而预检在桌面端没有 signal 可取消 —— 界面就停在转圈。
	// 这里每一步后面都紧跟 stopIfCancelled，本函数契合可取消语义。
	sourceDB, dbErr := a.getDatabaseWithContext(ctx, normalizeMetadataRunConfig(source.Config, source.Database), false)
	if stopIfCancelled("endpoints") {
		return finishDataSyncJobPreflight(result)
	}
	if dbErr != nil {
		result.Issues = append(result.Issues, preflightIssue("source_connect_failed", DataSyncJobPreflightBlocker, "endpoints", dbErr.Error(), ""))
	} else {
		pingErr := pingDatabaseWithContext(ctx, sourceDB)
		if stopIfCancelled("endpoints") {
			return finishDataSyncJobPreflight(result)
		}
		if pingErr != nil {
			result.Issues = append(result.Issues, preflightIssue("source_ping_failed", DataSyncJobPreflightBlocker, "endpoints", pingErr.Error(), ""))
		}
	}
	if stopIfCancelled("endpoints") {
		return finishDataSyncJobPreflight(result)
	}
	// 同 sourceDB：目标端卡住同样会让预检永返回不了。
	targetDB, dbErr := a.getDatabaseWithContext(ctx, normalizeMetadataRunConfig(target.Config, target.Database), false)
	if stopIfCancelled("endpoints") {
		return finishDataSyncJobPreflight(result)
	}
	if dbErr != nil {
		result.Issues = append(result.Issues, preflightIssue("target_connect_failed", DataSyncJobPreflightBlocker, "endpoints", dbErr.Error(), ""))
	} else {
		pingErr := pingDatabaseWithContext(ctx, targetDB)
		if stopIfCancelled("endpoints") {
			return finishDataSyncJobPreflight(result)
		}
		if pingErr != nil {
			result.Issues = append(result.Issues, preflightIssue("target_ping_failed", DataSyncJobPreflightBlocker, "endpoints", pingErr.Error(), ""))
		}
	}

	// 进度用于把超时报成可定位的问题：只说「超时」而不说查到哪一张，
	// 用户无法区分任务太大与源端真卡住。
	progress := DataSyncJobPreflightProgress{Checked: 0, Total: countEnabledDataSyncMappings(definition)}
	if !hasPreflightBlocker(result.Issues) {
		mappingProgress = &progress
		result.Issues = append(result.Issues, a.preflightDataSyncMappingsWithProgress(ctx, definition, source, target, &progress)...)
	}
	// 映射阶段的中止在这里才收敛：内层返回后 ctx 可能刚过期，所以进度详情
	// 必须保留到这次判断之后，否则超时报文里就没有「卡在哪张表」。
	if stopIfCancelled("mappings") {
		return finishDataSyncJobPreflight(result)
	}
	mappingProgress = nil
	if definition.IncrementalMode == syncjob.IncrementalWatermark {
		for _, mapping := range definition.Mappings {
			if !mapping.Enabled || mapping.Watermark == nil {
				continue
			}
			if len(mapping.Watermark.TieBreakerColumns) == 0 && len(mapping.KeyColumns) == 0 {
				result.Issues = append(result.Issues, preflightIssue("watermark_tie_breaker_required", DataSyncJobPreflightBlocker, "trigger", "watermark tasks require a stable tie-breaker or key column", dataSyncJobMappingKey(mapping)))
			}
			if len(mapping.Watermark.InitialValue) > 0 {
				result.Issues = append(result.Issues, preflightIssue("watermark_initial_value_unsupported", DataSyncJobPreflightBlocker, "trigger", "watermark initialValue is not implemented; remove it instead of silently starting from the beginning", dataSyncJobMappingKey(mapping)))
			}
			config, buildErr := buildDataSyncJobEngineConfig(definition, "preflight", source, target, mapping)
			if buildErr == nil {
				ties := mapping.Watermark.TieBreakerColumns
				if len(ties) == 0 {
					ties = mapping.KeyColumns
				}
				if validationErr := sync.ValidateWatermarkSyncRequest(sync.WatermarkSyncRequest{
					Sync:              config,
					Table:             strings.TrimSpace(mapping.SourceTable),
					WatermarkColumn:   mapping.Watermark.Column,
					TieBreakerColumns: ties,
					BatchSize:         definition.Options.BatchSize,
				}); validationErr != nil {
					result.Issues = append(result.Issues, preflightIssue("watermark_runtime_unsupported", DataSyncJobPreflightBlocker, "trigger", validationErr.Error(), dataSyncJobMappingKey(mapping)))
				}
			}
		}
		if definition.Options.SyncMode == "full_overwrite" {
			result.Issues = append(result.Issues, preflightIssue("watermark_overwrite_unsupported", DataSyncJobPreflightBlocker, "delivery", "watermark tasks cannot use full overwrite", ""))
		}
		if definition.Options.PropagateDeletes {
			result.Issues = append(result.Issues, preflightIssue("watermark_delete_unsupported", DataSyncJobPreflightBlocker, "delivery", "watermark tasks cannot infer source deletes; use CDC or a snapshot reconcile task", ""))
		}
	}
	if definition.Options.ErrorPolicy == syncjob.ErrorPolicySkipRow && definition.IncrementalMode == syncjob.IncrementalWatermark {
		result.Issues = append(result.Issues, preflightIssue(
			"row_error_isolation_unsupported",
			DataSyncJobPreflightBlocker,
			"delivery",
			"row-level skip/quarantine is not supported by watermark execution because cursor advancement could skip an uncommitted row",
			"",
		))
	}
	if strings.EqualFold(definition.Options.SyncMode, "full_overwrite") {
		result.Issues = append(result.Issues, preflightIssue(
			"full_overwrite_non_atomic",
			DataSyncJobPreflightBlocker,
			"delivery",
			"full overwrite is disabled for persistent tasks until staging-table validation and atomic swap are available",
			"",
		))
	}
	if strings.EqualFold(definition.Options.SyncMode, "insert_only") && definition.Options.MaxRetries > 0 {
		result.Issues = append(result.Issues, preflightIssue(
			"append_retry_unsafe",
			DataSyncJobPreflightBlocker,
			"delivery",
			"append/insert-only tasks cannot retry a failed mapping safely because a non-transactional target may already contain part of the batch; set retries to zero or use idempotent upsert",
			"",
		))
	}
	if strings.EqualFold(definition.Options.SyncMode, "insert_only") && definition.ResumePolicy != "never" {
		result.Issues = append(result.Issues, preflightIssue(
			"append_resume_unsafe",
			DataSyncJobPreflightBlocker,
			"delivery",
			"append/insert-only tasks require resumePolicy=never because a failed mapping may have committed earlier batches that cannot be replayed safely",
			"",
		))
	}
	if definition.IncrementalMode == syncjob.IncrementalCDC {
		if definition.CDC != nil && strings.TrimSpace(definition.CDC.Adapter) != "" {
			cdcCapability, probeErr := a.probeDataSyncCDCContext(ctx, dataSyncCDCProbeConfig(source), "")
			if stopIfCancelled("trigger") {
				return finishDataSyncJobPreflight(result)
			}
			if probeErr != nil {
				result.Issues = append(result.Issues, preflightIssue("cdc_probe_failed", DataSyncJobPreflightBlocker, "trigger", probeErr.Error(), ""))
			} else {
				result.CDCCapability = &cdcCapability
				if !cdcCapability.Supported || !cdcCapability.Ready {
					message := strings.TrimSpace(cdcCapability.Reason)
					if message == "" {
						message = "the automatically selected CDC adapter is not ready for this source"
					}
					result.Issues = append(result.Issues, preflightIssue("cdc_adapter_not_ready", DataSyncJobPreflightBlocker, "trigger", message, ""))
				}
			}
		}
		if definition.Options.TargetTableStrategy != "existing_only" {
			result.Issues = append(result.Issues, preflightIssue("cdc_existing_target_required", DataSyncJobPreflightBlocker, "delivery", "CDC tasks currently require existing target tables", ""))
		}
		if !strings.EqualFold(definition.Options.SyncMode, "insert_update") {
			result.Issues = append(result.Issues, preflightIssue("cdc_upsert_required", DataSyncJobPreflightBlocker, "delivery", "CDC currently requires insert_update delivery; append mode would not be replay-safe", ""))
		}
		if !sync.SupportsAtomicChangeEventTarget(result.Capability.TargetType) {
			result.Issues = append(result.Issues, preflightIssue("cdc_target_non_atomic", DataSyncJobPreflightBlocker, "delivery", "CDC row isolation and checkpoint ordering require an atomic relational target", ""))
		}
		for _, mapping := range definition.Mappings {
			if mapping.Enabled && len(mapping.Columns) == 0 {
				result.Issues = append(result.Issues, preflightIssue("cdc_authoritative_columns_required", DataSyncJobPreflightBlocker, "mappings", "CDC requires explicit source-to-target columns so removed document fields are cleared instead of leaving stale target values", dataSyncJobMappingKey(mapping)))
			}
		}
		if definition.CDC.InitialSnapshot {
			result.Issues = append(result.Issues, preflightIssue(
				"cdc_initial_snapshot_handoff_unsupported",
				DataSyncJobPreflightBlocker,
				"trigger",
				"the current snapshot reader cannot enforce the MongoDB CDC barrier across every read; disable initial snapshot to avoid claiming a gap-free handoff",
				"",
			))
		}
		switch definition.CDC.StartPosition {
		case "earliest":
			result.Issues = append(result.Issues, preflightIssue("cdc_earliest_unsupported", DataSyncJobPreflightBlocker, "trigger", "the selected CDC adapter cannot start from an unbounded earliest position", ""))
		case "checkpoint":
			manager, managerErr := a.ensureDataSyncJobManager()
			if managerErr != nil {
				result.Issues = append(result.Issues, preflightIssue("cdc_checkpoint_unavailable", DataSyncJobPreflightBlocker, "trigger", managerErr.Error(), ""))
			} else {
				checkpoint, checkpointErr := manager.GetCheckpoint(ctx, definition.ID)
				if stopIfCancelled("trigger") {
					return finishDataSyncJobPreflight(result)
				}
				if checkpointErr != nil {
					result.Issues = append(result.Issues, preflightIssue("cdc_checkpoint_required", DataSyncJobPreflightBlocker, "trigger", "start position checkpoint requires a durable checkpoint from this task", ""))
				} else if planHash, hashErr := dataSyncJobDefinitionHash(definition); checkpoint.Kind != "cdc" || hashErr != nil || !secureTextEqual(checkpoint.SchemaHash, planHash) {
					result.Issues = append(result.Issues, preflightIssue("cdc_checkpoint_incompatible", DataSyncJobPreflightBlocker, "trigger", "the durable checkpoint belongs to a different task revision or incremental mode; reset it explicitly", ""))
				}
			}
		}
	}
	if stopIfCancelled("preflight") {
		return finishDataSyncJobPreflight(result)
	}
	if hash, hashErr := dataSyncJobDefinitionHash(definition); hashErr != nil {
		result.Issues = append(result.Issues, preflightIssue("definition_hash_failed", DataSyncJobPreflightBlocker, "preflight", hashErr.Error(), ""))
	} else {
		result.DefinitionHash = hash
	}
	result.NextRunAt = previewDataSyncJobSchedule(definition, now, 5)
	return finishDataSyncJobPreflight(result)
}

func pingDatabaseWithContext(ctx context.Context, database interface{ Ping() error }) error {
	if pinger, ok := database.(interface{ PingContext(context.Context) error }); ok {
		return pinger.PingContext(ctx)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	err := database.Ping()
	if err == nil {
		return ctx.Err()
	}
	return err
}

func appendOnlyTargetPreflightIssues(definition syncjob.JobDefinition, capability sync.MigrationCapability) []DataSyncJobPreflightIssue {
	if definition.Kind == syncjob.JobKindCompare || capability.SupportsMutations {
		return nil
	}
	issues := make([]DataSyncJobPreflightIssue, 0, 2)
	if !strings.EqualFold(definition.Options.SyncMode, "insert_only") {
		issues = append(issues, preflightIssue(
			"append_only_target_requires_insert_only",
			DataSyncJobPreflightBlocker,
			"delivery",
			fmt.Sprintf("%s targets support append/INSERT-only delivery; updates are not supported", capability.TargetType),
			"",
		))
	}
	if definition.Options.PropagateDeletes {
		issues = append(issues, preflightIssue(
			"append_only_target_delete_unsupported",
			DataSyncJobPreflightBlocker,
			"delivery",
			fmt.Sprintf("%s targets support append/INSERT-only delivery; deletes are not supported", capability.TargetType),
			"",
		))
	}
	return issues
}

// preflightDataSyncQueryColumnsContext asks the source for result metadata
// without fetching any data. Running the same query only after a task starts
// turned a simple column alias typo into a failed write run.
//
// 这里刻意走 dbQueryIsolatedContext 而不是共用元数据会话：探测需要以数据查询
// 身份执行用户 SQL，与元数据连接的权限与清理路径不同，混用会让共用会话承担
// 用户查询的连接生命周期。
func (a *App) preflightDataSyncQueryColumnsContext(ctx context.Context, source resolvedDataSyncJobEndpoint, sourceQuery string) ([]string, error) {
	result := a.dbQueryIsolatedContext(ctx, source.Config, source.Database, dataSyncJobQueryMetadataProbeSQL(source.Config, sourceQuery))
	if !result.Success {
		return nil, fmt.Errorf("read query result metadata: %s", strings.TrimSpace(result.Message))
	}
	if len(result.Fields) == 0 {
		return nil, fmt.Errorf("read query result metadata did not return any fields")
	}
	return result.Fields, nil
}

// dataSyncJobQueryMetadataProbeSQL preserves the source query as a derived
// table and makes the outer query empty. The database still resolves aliases
// and types, but no source result rows are fetched during preflight.
func dataSyncJobQueryMetadataProbeSQL(config connection.ConnectionConfig, sourceQuery string) string {
	query := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(sourceQuery), ";"))
	switch resolveDDLDBType(config) {
	case "sqlserver":
		return "SELECT TOP 0 * FROM (" + stripTopLevelSQLOrderBy(query) + ") AS __gonavi_preflight"
	case "oracle", "dameng":
		return "SELECT * FROM (" + query + ") __gonavi_preflight WHERE 1 = 0"
	default:
		return "SELECT * FROM (" + query + ") AS __gonavi_preflight WHERE 1 = 0"
	}
}

func preflightQuerySourceColumnIssues(mapping syncjob.TableMapping, queryColumns []string, mappingID string) []DataSyncJobPreflightIssue {
	queryColumnSet := make(map[string]struct{}, len(queryColumns))
	for _, column := range queryColumns {
		if normalized := strings.ToLower(strings.TrimSpace(column)); normalized != "" {
			queryColumnSet[normalized] = struct{}{}
		}
	}
	issues := make([]DataSyncJobPreflightIssue, 0)
	for _, mappingColumn := range mapping.Columns {
		sourceColumn := strings.TrimSpace(mappingColumn.Source)
		if sourceColumn == "" || len(mappingColumn.DefaultValue) > 0 {
			continue
		}
		if _, exists := queryColumnSet[strings.ToLower(sourceColumn)]; !exists {
			issues = append(issues, preflightIssue(
				"query_source_column_missing",
				DataSyncJobPreflightBlocker,
				"mappings",
				fmt.Sprintf("query result column %s does not exist", sourceColumn),
				mappingID,
			))
		}
	}
	return issues
}

func preflightImplicitTargetColumnIssues(definition syncjob.JobDefinition, mapping syncjob.TableMapping, sourceColumns, targetColumns []connection.ColumnDefinition, capability sync.MigrationCapability, mappingID string) []DataSyncJobPreflightIssue {
	if definition.Kind == syncjob.JobKindCompare || strings.EqualFold(strings.TrimSpace(definition.Options.Content), "schema") {
		return nil
	}
	if dataSyncJobMappingNeedsExplicitProjection(definition, mapping) {
		return nil
	}
	targetColumnSet := dataSyncJobColumnSet(targetColumns)
	missing := make([]string, 0)
	for _, sourceColumn := range sourceColumns {
		name := strings.TrimSpace(sourceColumn.Name)
		if name == "" {
			continue
		}
		if _, exists := targetColumnSet[strings.ToLower(name)]; !exists {
			missing = append(missing, name)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	message := fmt.Sprintf("target is missing source columns required for sync: %s", strings.Join(missing, ", "))
	if definition.AutoAddColumnsEnabled() && capability.SupportsAutoAddColumns {
		return []DataSyncJobPreflightIssue{preflightIssue(
			"target_columns_will_be_added",
			DataSyncJobPreflightInfo,
			"mappings",
			message,
			mappingID,
		)}
	}
	return []DataSyncJobPreflightIssue{preflightIssue(
		"target_columns_missing_for_sync",
		DataSyncJobPreflightBlocker,
		"mappings",
		message,
		mappingID,
	)}
}

func finishDataSyncJobPreflight(result DataSyncJobPreflightResult) DataSyncJobPreflightResult {
	blockers, warnings := 0, 0
	for _, issue := range result.Issues {
		switch issue.Severity {
		case DataSyncJobPreflightBlocker:
			blockers++
		case DataSyncJobPreflightWarning:
			warnings++
		}
	}
	result.Success = blockers == 0
	switch {
	case blockers > 0:
		result.Status = "blocked"
	case warnings > 0:
		result.Status = "warning"
	default:
		result.Status = "passed"
	}
	return result
}

func preflightIssue(code string, severity DataSyncJobPreflightSeverity, stage, message, mappingID string) DataSyncJobPreflightIssue {
	return DataSyncJobPreflightIssue{Code: code, Severity: severity, Stage: stage, Message: strings.TrimSpace(message), MappingID: mappingID}
}

func hasPreflightBlocker(issues []DataSyncJobPreflightIssue) bool {
	for _, issue := range issues {
		if issue.Severity == DataSyncJobPreflightBlocker {
			return true
		}
	}
	return false
}

func hasPreflightIssueCode(issues []DataSyncJobPreflightIssue, code string) bool {
	for _, issue := range issues {
		if issue.Code == code {
			return true
		}
	}
	return false
}

func sameDataSyncJobObject(definition syncjob.JobDefinition, mapping syncjob.TableMapping) bool {
	if !strings.EqualFold(definition.Source.ConnectionID, definition.Target.ConnectionID) ||
		!strings.EqualFold(definition.Source.Database, definition.Target.Database) {
		return false
	}
	sourceSchema := firstNonEmptySyncJob(mapping.SourceSchema, definition.Source.Schema)
	targetSchema := firstNonEmptySyncJob(mapping.TargetSchema, definition.Target.Schema)
	return strings.EqualFold(sourceSchema, targetSchema) && strings.EqualFold(mapping.SourceTable, mapping.TargetTable)
}

func qualifyDataSyncJobObject(schema, table string) string {
	if strings.TrimSpace(schema) == "" {
		return strings.TrimSpace(table)
	}
	return strings.TrimSpace(schema) + "." + strings.TrimSpace(table)
}

func dataSyncJobColumnSet(columns []connection.ColumnDefinition) map[string]struct{} {
	result := make(map[string]struct{}, len(columns))
	for _, column := range columns {
		name := strings.ToLower(strings.TrimSpace(column.Name))
		if name != "" {
			result[name] = struct{}{}
		}
	}
	return result
}

// preflightSourceComparisonKeyIssues verifies the physical primary key required
// to compare against an existing target. An explicit mapping key replaces the
// engine's default physical key, so a user-supplied business key cannot turn an
// update into an apparently safe upsert. New targets have no prior rows to
// match, so an initial auto-create import may proceed without a key.
func preflightSourceComparisonKeyIssues(definition syncjob.JobDefinition, mapping syncjob.TableMapping, sourceColumns, targetColumns []connection.ColumnDefinition, targetExists bool, mappingID string) []DataSyncJobPreflightIssue {
	content := strings.ToLower(strings.TrimSpace(definition.Options.Content))
	if !targetExists ||
		!dataSyncJobUsesInsertUpdate(definition) ||
		content == "schema" ||
		(definition.Kind != syncjob.JobKindMigration && definition.Kind != syncjob.JobKindReconcile) {
		return nil
	}

	physicalKeys := dataSyncJobPhysicalPrimaryKeyColumns(sourceColumns)
	if len(physicalKeys) == 0 {
		return []DataSyncJobPreflightIssue{preflightIssue(
			"source_primary_key_required",
			DataSyncJobPreflightBlocker,
			"mappings",
			"insert_update on an existing target requires a source physical primary key",
			mappingID,
		)}
	}
	if dataSyncJobHasExplicitKeyColumns(mapping) && !dataSyncJobSameColumnSet(mapping.KeyColumns, physicalKeys) {
		if !dataSyncJobMappingNeedsExplicitProjection(definition, mapping) {
			return []DataSyncJobPreflightIssue{preflightIssue(
				"structure_migration_primary_key_required",
				DataSyncJobPreflightBlocker,
				"mappings",
				"schema migration with an existing target uses source physical primary keys; mapped stable keys are unavailable on this route",
				mappingID,
			)}
		}
		return []DataSyncJobPreflightIssue{preflightIssue(
			"source_primary_key_must_be_used",
			DataSyncJobPreflightBlocker,
			"mappings",
			"insert_update on an existing target must use the complete source physical primary key instead of a business key",
			mappingID,
		)}
	}
	if !dataSyncJobMappingNeedsExplicitProjection(definition, mapping) {
		return nil
	}

	keyColumns := append([]string(nil), mapping.KeyColumns...)
	if len(keyColumns) == 0 {
		keyColumns = physicalKeys
	}
	engineMapping, err := buildEngineObjectMapping(mapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	projection, err := sync.CompileProjection(engineMapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}

	sourceColumnSet := make(map[string]string, len(sourceColumns))
	for _, column := range sourceColumns {
		name := strings.TrimSpace(column.Name)
		if name != "" {
			sourceColumnSet[strings.ToLower(name)] = name
		}
	}
	targetColumnSet := dataSyncJobColumnSet(targetColumns)
	issues := make([]DataSyncJobPreflightIssue, 0)
	for _, configuredKey := range keyColumns {
		configuredKey = strings.TrimSpace(configuredKey)
		canonicalKey, exists := sourceColumnSet[strings.ToLower(configuredKey)]
		if !exists {
			// The generic source-key validation above owns this diagnostic.
			continue
		}
		targetKey, mapped := projection.TargetColumn(canonicalKey)
		if !mapped || strings.TrimSpace(targetKey) == "" {
			issues = append(issues, preflightIssue("mapping_key_unmapped", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("stable key %s is not mapped to a target column", canonicalKey), mappingID))
			continue
		}
		if _, exists := targetColumnSet[strings.ToLower(strings.TrimSpace(targetKey))]; !exists {
			issues = append(issues, preflightIssue("mapping_key_target_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("stable key %s maps to missing target column %s", canonicalKey, targetKey), mappingID))
		}
	}
	return issues
}

func dataSyncJobUsesInsertUpdate(definition syncjob.JobDefinition) bool {
	mode := strings.ToLower(strings.TrimSpace(definition.Options.SyncMode))
	return mode == "" || mode == "insert_update"
}

func dataSyncJobHasExplicitKeyColumns(mapping syncjob.TableMapping) bool {
	for _, column := range mapping.KeyColumns {
		if strings.TrimSpace(column) != "" {
			return true
		}
	}
	return false
}

func preflightQueryComparisonKeyIssues(mapping syncjob.TableMapping, targetColumns []connection.ColumnDefinition, mappingID string) []DataSyncJobPreflightIssue {
	return preflightQueryComparisonKeyIssuesWithIndexes(mapping, targetColumns, nil, mappingID)
}

func preflightQueryComparisonKeyIssuesWithIndexes(mapping syncjob.TableMapping, targetColumns []connection.ColumnDefinition, targetIndexes []connection.IndexDefinition, mappingID string) []DataSyncJobPreflightIssue {
	if !dataSyncJobHasExplicitKeyColumns(mapping) {
		return []DataSyncJobPreflightIssue{preflightIssue("query_key_required", DataSyncJobPreflightBlocker, "mappings", "query sink insert_update requires at least one mapped stable key column", mappingID)}
	}

	engineMapping, err := buildEngineObjectMapping(mapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	projection, err := sync.CompileProjection(engineMapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}

	targetColumnSet := dataSyncJobColumnSet(targetColumns)
	issues := make([]DataSyncJobPreflightIssue, 0)
	targetKeys := make([]string, 0, len(mapping.KeyColumns))
	for _, sourceKey := range mapping.KeyColumns {
		sourceKey = strings.TrimSpace(sourceKey)
		if sourceKey == "" {
			issues = append(issues, preflightIssue("query_key_unmapped", DataSyncJobPreflightBlocker, "mappings", "query sink stable key cannot be empty", mappingID))
			continue
		}
		targetKey, ok := projection.TargetColumn(sourceKey)
		if !ok || strings.TrimSpace(targetKey) == "" {
			issues = append(issues, preflightIssue("query_key_unmapped", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("query sink stable key %s is not mapped to a target column", sourceKey), mappingID))
			continue
		}
		if _, exists := targetColumnSet[strings.ToLower(strings.TrimSpace(targetKey))]; !exists {
			issues = append(issues, preflightIssue("query_key_target_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("query sink stable key %s maps to missing target column %s", sourceKey, targetKey), mappingID))
			continue
		}
		targetKeys = append(targetKeys, targetKey)
	}
	// A nil slice means the caller did not provide index metadata (the legacy
	// helper is also used by mapping-only tests). An explicitly empty slice is
	// different: DBGetIndexes normalizes successful empty results to a non-nil
	// slice, so that case must still reject an unindexed comparison key.
	if len(issues) == 0 && targetIndexes != nil && !dataSyncJobHasUniqueIndexForColumns(targetIndexes, targetKeys) {
		issues = append(issues, preflightIssue(
			"query_key_target_non_unique",
			DataSyncJobPreflightBlocker,
			"mappings",
			fmt.Sprintf("query sink stable key must map to a primary or unique target index: %s", strings.Join(targetKeys, ", ")),
			mappingID,
		))
	}
	return issues
}

func dataSyncJobHasUniqueIndexForColumns(indexes []connection.IndexDefinition, columns []string) bool {
	if len(columns) == 0 {
		return false
	}
	groups := make(map[string][]connection.IndexDefinition)
	for _, index := range indexes {
		if index.NonUnique != 0 || strings.TrimSpace(index.Name) == "" || strings.TrimSpace(index.ColumnName) == "" {
			continue
		}
		groups[strings.ToLower(strings.TrimSpace(index.Name))] = append(groups[strings.ToLower(strings.TrimSpace(index.Name))], index)
	}
	for _, group := range groups {
		sort.Slice(group, func(left, right int) bool { return group[left].SeqInIndex < group[right].SeqInIndex })
		indexColumns := make([]string, 0, len(group))
		for _, index := range group {
			indexColumns = append(indexColumns, index.ColumnName)
		}
		if dataSyncJobSameColumnSet(indexColumns, columns) {
			return true
		}
	}
	return false
}

func preflightUnsupportedTargetSchemaIssues(definition syncjob.JobDefinition, mapping syncjob.TableMapping, sourceColumns, targetColumns []connection.ColumnDefinition, sourceType, targetType, mappingID string) []DataSyncJobPreflightIssue {
	if !dataSyncJobStructureSyncEnabled(definition) {
		return nil
	}
	// 对账任务带显式字段映射时走仅数据路径（引擎不会检查结构差异），预检不能比运行时更严。
	if definition.Kind == syncjob.JobKindReconcile && dataSyncJobMappingNeedsExplicitProjection(definition, mapping) {
		return nil
	}
	unsupported := sync.UnsupportedExistingTargetSchemaDiffs(sourceColumns, targetColumns, sourceType, targetType)
	if len(unsupported) == 0 {
		return nil
	}
	return []DataSyncJobPreflightIssue{preflightIssue(
		"schema_unsupported_difference",
		DataSyncJobPreflightBlocker,
		"mappings",
		fmt.Sprintf("target table has schema differences that cannot be repaired automatically (%s); only missing target columns can be added", sync.DescribeColumnStructureDiffs(unsupported)),
		mappingID,
	)}
}

func stripTopLevelSQLOrderBy(query string) string {
	depth := 0
	for index := 0; index < len(query); {
		switch query[index] {
		case '\'', '"', '`':
			index = skipSQLQuotedLiteral(query, index, query[index])
			continue
		case '[':
			index = skipSQLBracketIdentifier(query, index)
			continue
		case '-', '/':
			if next := skipSQLWhitespaceAndComments(query, index); next != index {
				index = next
				continue
			}
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		}
		if depth == 0 && isSQLIdentifierStart(query[index]) {
			start := index
			for index < len(query) && isSQLIdentifierPart(query[index]) {
				index++
			}
			if strings.EqualFold(query[start:index], "order") {
				next := skipSQLWhitespaceAndComments(query, index)
				byStart := next
				for next < len(query) && isSQLIdentifierPart(query[next]) {
					next++
				}
				if strings.EqualFold(query[byStart:next], "by") {
					if hasTopLevelSQLKeyword(query, next, "offset") {
						return strings.TrimSpace(query)
					}
					return strings.TrimSpace(query[:start])
				}
			}
			continue
		}
		index++
	}
	return strings.TrimSpace(query)
}

func hasTopLevelSQLKeyword(query string, start int, wanted string) bool {
	depth := 0
	for index := start; index < len(query); {
		switch query[index] {
		case '\'', '"', '`':
			index = skipSQLQuotedLiteral(query, index, query[index])
			continue
		case '[':
			index = skipSQLBracketIdentifier(query, index)
			continue
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		}
		if depth == 0 && isSQLIdentifierStart(query[index]) {
			wordStart := index
			for index < len(query) && isSQLIdentifierPart(query[index]) {
				index++
			}
			if strings.EqualFold(query[wordStart:index], wanted) {
				return true
			}
			continue
		}
		index++
	}
	return false
}

func dataSyncJobPhysicalPrimaryKeyColumns(columns []connection.ColumnDefinition) []string {
	keys := make([]string, 0, 2)
	for _, column := range columns {
		key := strings.TrimSpace(column.Key)
		if strings.EqualFold(key, "PRI") || strings.EqualFold(key, "PK") {
			keys = append(keys, strings.TrimSpace(column.Name))
		}
	}
	return keys
}

func dataSyncJobSameColumnSet(left, right []string) bool {
	if len(left) == 0 || len(left) != len(right) {
		return false
	}
	seen := make(map[string]struct{}, len(left))
	for _, name := range left {
		key := strings.ToLower(strings.TrimSpace(name))
		if key == "" {
			return false
		}
		if _, exists := seen[key]; exists {
			return false
		}
		seen[key] = struct{}{}
	}
	for _, name := range right {
		key := strings.ToLower(strings.TrimSpace(name))
		if _, exists := seen[key]; !exists {
			return false
		}
		delete(seen, key)
	}
	return len(seen) == 0
}

func resultSupportsAutoCreate(capability sync.MigrationCapability) bool {
	return capability.SupportsAutoCreate
}
