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

func (a *App) preflightDataSyncJob(input syncjob.JobDefinition, now time.Time) DataSyncJobPreflightResult {
	return a.preflightDataSyncJobContext(context.Background(), input, now)
}

func (a *App) preflightDataSyncJobContext(ctx context.Context, input syncjob.JobDefinition, now time.Time) DataSyncJobPreflightResult {
	if ctx == nil {
		ctx = context.Background()
	}
	definition := syncjob.NormalizeDefinition(input)
	// Approval is backend-owned evidence. Never echo or validate a caller-
	// supplied approval object; only one-time tokens can mint this state.
	definition.Approval = nil
	result := DataSyncJobPreflightResult{
		Definition: definition,
		Issues:     []DataSyncJobPreflightIssue{},
		NextRunAt:  []int64{},
		CheckedAt:  now.UnixMilli(),
	}
	stopIfCancelled := func(stage string) bool {
		if err := ctx.Err(); err != nil {
			if hasPreflightIssueCode(result.Issues, "request_cancelled") {
				return true
			}
			result.Issues = append(result.Issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, stage, err.Error(), ""))
			return true
		}
		return false
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
			result.Issues = append(result.Issues, preflightIssue("same_object", DataSyncJobPreflightBlocker, "mappings", "source and target resolve to the same physical object", dataSyncJobMappingLabel(mapping)))
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
				result.Issues = append(result.Issues, preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", buildErr.Error(), dataSyncJobMappingLabel(mapping)))
				continue
			}
			if protectionErr := ensureDataSyncTargetProtection(config); protectionErr != nil {
				result.Issues = append(result.Issues, preflightIssue("target_protection_blocked", DataSyncJobPreflightBlocker, "delivery", protectionErr.Error(), dataSyncJobMappingLabel(mapping)))
			}
			if definition.Options.ErrorPolicy == syncjob.ErrorPolicySkipRow && definition.IncrementalMode == syncjob.IncrementalSnapshot {
				config.OnRowError = func(context.Context, sync.ChangeEventRowError) error { return nil }
				if validationErr := sync.ValidateSnapshotRowErrorConfig(config); validationErr != nil {
					result.Issues = append(result.Issues, preflightIssue("row_error_isolation_unsupported", DataSyncJobPreflightBlocker, "delivery", validationErr.Error(), dataSyncJobMappingLabel(mapping)))
				}
			}
		}
	}

	if stopIfCancelled("endpoints") {
		return finishDataSyncJobPreflight(result)
	}
	sourceDB, dbErr := a.getDatabaseSynchronouslyWithContext(ctx, normalizeMetadataRunConfig(source.Config, source.Database), false)
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
	targetDB, dbErr := a.getDatabaseSynchronouslyWithContext(ctx, normalizeMetadataRunConfig(target.Config, target.Database), false)
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

	if !hasPreflightBlocker(result.Issues) {
		result.Issues = append(result.Issues, a.preflightDataSyncMappingsContext(ctx, definition, source, target)...)
	}
	if stopIfCancelled("mappings") {
		return finishDataSyncJobPreflight(result)
	}
	if definition.IncrementalMode == syncjob.IncrementalWatermark {
		for _, mapping := range definition.Mappings {
			if !mapping.Enabled || mapping.Watermark == nil {
				continue
			}
			if len(mapping.Watermark.TieBreakerColumns) == 0 && len(mapping.KeyColumns) == 0 {
				result.Issues = append(result.Issues, preflightIssue("watermark_tie_breaker_required", DataSyncJobPreflightBlocker, "trigger", "watermark tasks require a stable tie-breaker or key column", dataSyncJobMappingLabel(mapping)))
			}
			if len(mapping.Watermark.InitialValue) > 0 {
				result.Issues = append(result.Issues, preflightIssue("watermark_initial_value_unsupported", DataSyncJobPreflightBlocker, "trigger", "watermark initialValue is not implemented; remove it instead of silently starting from the beginning", dataSyncJobMappingLabel(mapping)))
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
					result.Issues = append(result.Issues, preflightIssue("watermark_runtime_unsupported", DataSyncJobPreflightBlocker, "trigger", validationErr.Error(), dataSyncJobMappingLabel(mapping)))
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
				result.Issues = append(result.Issues, preflightIssue("cdc_authoritative_columns_required", DataSyncJobPreflightBlocker, "mappings", "CDC requires explicit source-to-target columns so removed document fields are cleared instead of leaving stale target values", dataSyncJobMappingLabel(mapping)))
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

func (a *App) preflightDataSyncMappings(definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint) []DataSyncJobPreflightIssue {
	return a.preflightDataSyncMappingsContext(context.Background(), definition, source, target)
}

func (a *App) preflightDataSyncMappingsContext(ctx context.Context, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint) []DataSyncJobPreflightIssue {
	issues := make([]DataSyncJobPreflightIssue, 0)
	for _, mapping := range definition.Mappings {
		if err := ctx.Err(); err != nil {
			return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), dataSyncJobMappingLabel(mapping)))
		}
		if !mapping.Enabled {
			continue
		}
		mappingID := dataSyncJobMappingLabel(mapping)
		if definition.Kind == syncjob.JobKindQuerySink {
			readOnly := isReadOnlySQLQuery(source.Config.Type, definition.SourceQuery)
			if !readOnly {
				issues = append(issues, preflightIssue("source_query_not_read_only", DataSyncJobPreflightBlocker, "mappings", "sourceQuery must be a single read-only query", mappingID))
			}
			targetIssues := a.preflightDataSyncQueryTargetContext(ctx, definition, mapping, target)
			issues = append(issues, targetIssues...)
			if err := ctx.Err(); err != nil {
				if hasPreflightIssueCode(issues, "request_cancelled") {
					return issues
				}
				return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
			}
			if readOnly && !hasPreflightBlocker(targetIssues) {
				queryColumns, queryErr := a.preflightDataSyncQueryColumnsContext(ctx, source, definition.SourceQuery)
				if queryErr != nil {
					if err := ctx.Err(); err != nil {
						return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
					}
					issues = append(issues, preflightIssue("query_schema_probe_failed", DataSyncJobPreflightBlocker, "mappings", queryErr.Error(), mappingID))
				} else {
					issues = append(issues, preflightQuerySourceColumnIssues(mapping, queryColumns, mappingID)...)
				}
			}
			continue
		}
		sourceTable := qualifyDataSyncJobObject(mapping.SourceSchema, mapping.SourceTable)
		sourceResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
			return session.DBGetColumns(source.Config, source.Database, sourceTable)
		})
		if !sourceResult.Success {
			if err := ctx.Err(); err != nil {
				return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
			}
			issues = append(issues, preflightIssue("source_columns_failed", DataSyncJobPreflightBlocker, "mappings", sourceResult.Message, mappingID))
			continue
		}
		sourceColumns, _ := sourceResult.Data.([]connection.ColumnDefinition)
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
		existsResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
			return session.DBTableExists(target.Config, target.Database, targetTable)
		})
		if !existsResult.Success {
			if err := ctx.Err(); err != nil {
				return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
			}
			issues = append(issues, preflightIssue("target_table_check_failed", DataSyncJobPreflightBlocker, "mappings", existsResult.Message, mappingID))
			continue
		}
		targetExists := false
		if payload, ok := existsResult.Data.(map[string]bool); ok {
			targetExists = payload["exists"]
		}
		if !targetExists {
			targetStrategy := firstNonEmptySyncJob(mapping.TargetTableStrategy, definition.Options.TargetTableStrategy)
			if dataSyncJobMappingNeedsExplicitProjection(definition, mapping) || targetStrategy == "existing_only" || !resultSupportsAutoCreate(sync.ResolveMigrationCapability(source.Config, target.Config)) {
				issues = append(issues, preflightIssue("target_table_missing", DataSyncJobPreflightBlocker, "mappings", "target table does not exist and this mapping cannot auto-create it", mappingID))
			} else {
				issues = append(issues, preflightIssue("target_table_will_be_created", DataSyncJobPreflightInfo, "mappings", "target table will be created by the migration planner", mappingID))
				issues = append(issues, a.preflightUnmigratedIndexesContext(ctx, definition, source, target, mapping)...)
			}
			continue
		}
		targetResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
			return session.DBGetColumns(target.Config, target.Database, targetTable)
		})
		if !targetResult.Success {
			if err := ctx.Err(); err != nil {
				return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
			}
			issues = append(issues, preflightIssue("target_columns_failed", DataSyncJobPreflightBlocker, "mappings", targetResult.Message, mappingID))
			continue
		}
		targetColumns, _ := targetResult.Data.([]connection.ColumnDefinition)
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
			sync.ResolveMigrationCapability(source.Config, target.Config),
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
	}
	return issues
}

func dataSyncJobSourceIndexLocation(source resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) (string, string) {
	schema := firstNonEmptySyncJob(mapping.SourceSchema, source.Schema, source.Database)
	return strings.TrimSpace(schema), strings.TrimSpace(mapping.SourceTable)
}

func (a *App) preflightUnmigratedIndexes(definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) []DataSyncJobPreflightIssue {
	return a.preflightUnmigratedIndexesContext(context.Background(), definition, source, target, mapping)
}

func (a *App) preflightUnmigratedIndexesContext(ctx context.Context, definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) []DataSyncJobPreflightIssue {
	mappingID := dataSyncJobMappingLabel(mapping)
	if err := ctx.Err(); err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	if !definition.Options.CreateIndexes {
		return nil
	}
	config, err := buildDataSyncJobEngineConfig(definition, "preflight", source, target, mapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	session := newMetadataSessionWithMode(a, ctx, true)
	if session == nil {
		return []DataSyncJobPreflightIssue{preflightIssue("metadata_session_unavailable", DataSyncJobPreflightBlocker, "mappings", "metadata session is unavailable", mappingID)}
	}
	defer session.Close()
	sourceDB, sourceErr := session.app.getDatabase(normalizeMetadataRunConfig(source.Config, source.Database))
	if err := ctx.Err(); err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	if sourceErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("source_connect_failed", DataSyncJobPreflightBlocker, "endpoints", sourceErr.Error(), mappingID)}
	}
	sourceSchema, sourceTable := dataSyncJobSourceIndexLocation(source, mapping)
	if _, indexErr := sourceDB.GetIndexes(sourceSchema, sourceTable); indexErr != nil {
		if err := ctx.Err(); err != nil {
			return []DataSyncJobPreflightIssue{preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
		}
		return []DataSyncJobPreflightIssue{preflightIssue("index_inspection_failed", DataSyncJobPreflightWarning, "mappings", indexErr.Error(), mappingID)}
	}
	targetDB, targetErr := session.app.getDatabase(normalizeMetadataRunConfig(target.Config, target.Database))
	if err := ctx.Err(); err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
	}
	if targetErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("target_connect_failed", DataSyncJobPreflightBlocker, "endpoints", targetErr.Error(), mappingID)}
	}
	qualifiedSourceTable := strings.TrimSpace(mapping.SourceTable)
	if strings.TrimSpace(mapping.SourceSchema) != "" {
		qualifiedSourceTable = strings.TrimSpace(mapping.SourceSchema) + "." + qualifiedSourceTable
	}
	plan, planErr := sync.InspectSchemaMigrationPlan(config, qualifiedSourceTable, sourceDB, targetDB)
	if planErr != nil {
		if err := ctx.Err(); err != nil {
			return []DataSyncJobPreflightIssue{preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID)}
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

func (a *App) preflightDataSyncQueryTarget(definition syncjob.JobDefinition, mapping syncjob.TableMapping, target resolvedDataSyncJobEndpoint) []DataSyncJobPreflightIssue {
	return a.preflightDataSyncQueryTargetContext(context.Background(), definition, mapping, target)
}

func (a *App) preflightDataSyncQueryTargetContext(ctx context.Context, definition syncjob.JobDefinition, mapping syncjob.TableMapping, target resolvedDataSyncJobEndpoint) []DataSyncJobPreflightIssue {
	mappingID := dataSyncJobMappingLabel(mapping)
	issues := make([]DataSyncJobPreflightIssue, 0)
	targetTable := qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
	existsResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.DBTableExists(target.Config, target.Database, targetTable)
	})
	if !existsResult.Success {
		if err := ctx.Err(); err != nil {
			return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
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
	targetResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
		return session.DBGetColumns(target.Config, target.Database, targetTable)
	})
	if !targetResult.Success {
		if err := ctx.Err(); err != nil {
			return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
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
		indexResult := a.runWebMetadataWithContext(ctx, func(session *App) connection.QueryResult {
			return session.DBGetIndexes(target.Config, target.Database, targetTable)
		})
		if !indexResult.Success {
			if err := ctx.Err(); err != nil {
				return append(issues, preflightIssue("request_cancelled", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
			}
			return append(issues, preflightIssue("target_indexes_failed", DataSyncJobPreflightBlocker, "mappings", indexResult.Message, mappingID))
		}
		targetIndexes, _ := indexResult.Data.([]connection.IndexDefinition)
		issues = append(issues, preflightQueryComparisonKeyIssuesWithIndexes(mapping, targetColumns, targetIndexes, mappingID)...)
	}
	return issues
}

// preflightDataSyncQueryColumns asks the source for result metadata without
// fetching any data. Running the same query only after a task starts turned a
// simple column alias typo into a failed write run.
func (a *App) preflightDataSyncQueryColumns(source resolvedDataSyncJobEndpoint, sourceQuery string) ([]string, error) {
	return a.preflightDataSyncQueryColumnsContext(context.Background(), source, sourceQuery)
}

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
	if definition.Kind != syncjob.JobKindMigration || !dataSyncJobMigrationAllowsSchemaChanges(definition) {
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

func previewDataSyncJobSchedule(definition syncjob.JobDefinition, now time.Time, count int) []int64 {
	if count < 1 || count > 20 {
		count = 5
	}
	result := make([]int64, 0, count)
	after := now
	for len(result) < count {
		next := syncjob.NextRunAt(definition, after)
		if next <= 0 {
			break
		}
		result = append(result, next)
		after = time.UnixMilli(next)
		if definition.Schedule.Kind == syncjob.ScheduleOnce {
			break
		}
	}
	return result
}
