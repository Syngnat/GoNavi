package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

func (a *App) preflightDataSyncJob(input syncjob.JobDefinition, now time.Time) DataSyncJobPreflightResult {
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
	if err := syncjob.ValidateDefinition(definition); err != nil {
		result.Issues = append(result.Issues, preflightIssue("definition_invalid", DataSyncJobPreflightBlocker, "endpoints", err.Error(), ""))
		return finishDataSyncJobPreflight(result)
	}

	source, err := a.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
	if err != nil {
		result.Issues = append(result.Issues, preflightIssue("source_connection_failed", DataSyncJobPreflightBlocker, "endpoints", err.Error(), ""))
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

	if sourceDB, dbErr := a.getDatabase(normalizeMetadataRunConfig(source.Config, source.Database)); dbErr != nil {
		result.Issues = append(result.Issues, preflightIssue("source_connect_failed", DataSyncJobPreflightBlocker, "endpoints", dbErr.Error(), ""))
	} else if pingErr := sourceDB.Ping(); pingErr != nil {
		result.Issues = append(result.Issues, preflightIssue("source_ping_failed", DataSyncJobPreflightBlocker, "endpoints", pingErr.Error(), ""))
	}
	if targetDB, dbErr := a.getDatabase(normalizeMetadataRunConfig(target.Config, target.Database)); dbErr != nil {
		result.Issues = append(result.Issues, preflightIssue("target_connect_failed", DataSyncJobPreflightBlocker, "endpoints", dbErr.Error(), ""))
	} else if pingErr := targetDB.Ping(); pingErr != nil {
		result.Issues = append(result.Issues, preflightIssue("target_ping_failed", DataSyncJobPreflightBlocker, "endpoints", pingErr.Error(), ""))
	}

	if !hasPreflightBlocker(result.Issues) {
		result.Issues = append(result.Issues, a.preflightDataSyncMappings(definition, source, target)...)
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
		cdcCapability, probeErr := a.probeDataSyncCDC(normalizeMetadataRunConfig(source.Config, source.Database), definition.CDC.Adapter)
		if probeErr != nil {
			result.Issues = append(result.Issues, preflightIssue("cdc_probe_failed", DataSyncJobPreflightBlocker, "trigger", probeErr.Error(), ""))
		} else {
			result.CDCCapability = &cdcCapability
			if !cdcCapability.Supported || !cdcCapability.Ready {
				message := strings.TrimSpace(cdcCapability.Reason)
				if message == "" {
					message = "the selected CDC adapter is not ready for this source"
				}
				result.Issues = append(result.Issues, preflightIssue("cdc_adapter_not_ready", DataSyncJobPreflightBlocker, "trigger", message, ""))
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
			} else if checkpoint, checkpointErr := manager.GetCheckpoint(context.Background(), definition.ID); checkpointErr != nil {
				result.Issues = append(result.Issues, preflightIssue("cdc_checkpoint_required", DataSyncJobPreflightBlocker, "trigger", "start position checkpoint requires a durable checkpoint from this task", ""))
			} else if planHash, hashErr := dataSyncJobDefinitionHash(definition); checkpoint.Kind != "cdc" || hashErr != nil || !secureTextEqual(checkpoint.SchemaHash, planHash) {
				result.Issues = append(result.Issues, preflightIssue("cdc_checkpoint_incompatible", DataSyncJobPreflightBlocker, "trigger", "the durable checkpoint belongs to a different task revision or incremental mode; reset it explicitly", ""))
			}
		}
	}
	if hash, hashErr := dataSyncJobDefinitionHash(definition); hashErr != nil {
		result.Issues = append(result.Issues, preflightIssue("definition_hash_failed", DataSyncJobPreflightBlocker, "preflight", hashErr.Error(), ""))
	} else {
		result.DefinitionHash = hash
	}
	result.NextRunAt = previewDataSyncJobSchedule(definition, now, 5)
	return finishDataSyncJobPreflight(result)
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
	issues := make([]DataSyncJobPreflightIssue, 0)
	for _, mapping := range definition.Mappings {
		if !mapping.Enabled {
			continue
		}
		mappingID := dataSyncJobMappingLabel(mapping)
		if definition.Kind == syncjob.JobKindQuerySink {
			if !isReadOnlySQLQuery(source.Config.Type, definition.SourceQuery) {
				issues = append(issues, preflightIssue("source_query_not_read_only", DataSyncJobPreflightBlocker, "mappings", "sourceQuery must be a single read-only query", mappingID))
			}
			issues = append(issues, a.preflightDataSyncQueryTarget(definition, mapping, target)...)
			continue
		}
		sourceTable := qualifyDataSyncJobObject(mapping.SourceSchema, mapping.SourceTable)
		sourceResult := a.DBGetColumns(source.Config, source.Database, sourceTable)
		if !sourceResult.Success {
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
		existsResult := a.DBTableExists(target.Config, target.Database, targetTable)
		if !existsResult.Success {
			issues = append(issues, preflightIssue("target_table_check_failed", DataSyncJobPreflightBlocker, "mappings", existsResult.Message, mappingID))
			continue
		}
		targetExists := false
		if payload, ok := existsResult.Data.(map[string]bool); ok {
			targetExists = payload["exists"]
		}
		if !targetExists {
			targetStrategy := firstNonEmptySyncJob(mapping.TargetTableStrategy, definition.Options.TargetTableStrategy)
			if dataSyncJobMappingNeedsExplicitProjection(mapping) || targetStrategy == "existing_only" || !resultSupportsAutoCreate(sync.ResolveMigrationCapability(source.Config, target.Config)) {
				issues = append(issues, preflightIssue("target_table_missing", DataSyncJobPreflightBlocker, "mappings", "target table does not exist and this mapping cannot auto-create it", mappingID))
			} else {
				issues = append(issues, preflightIssue("target_table_will_be_created", DataSyncJobPreflightInfo, "mappings", "target table will be created by the migration planner", mappingID))
				issues = append(issues, a.preflightUnmigratedIndexes(definition, source, target, mapping)...)
			}
			continue
		}
		targetResult := a.DBGetColumns(target.Config, target.Database, targetTable)
		if !targetResult.Success {
			issues = append(issues, preflightIssue("target_columns_failed", DataSyncJobPreflightBlocker, "mappings", targetResult.Message, mappingID))
			continue
		}
		targetColumns, _ := targetResult.Data.([]connection.ColumnDefinition)
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
	if !definition.Options.CreateIndexes {
		return nil
	}
	config, err := buildDataSyncJobEngineConfig(definition, "preflight", source, target, mapping)
	if err != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), dataSyncJobMappingLabel(mapping))}
	}
	sourceDB, sourceErr := a.getDatabase(normalizeMetadataRunConfig(source.Config, source.Database))
	if sourceErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("source_connect_failed", DataSyncJobPreflightBlocker, "endpoints", sourceErr.Error(), dataSyncJobMappingLabel(mapping))}
	}
	sourceSchema, sourceTable := dataSyncJobSourceIndexLocation(source, mapping)
	if _, indexErr := sourceDB.GetIndexes(sourceSchema, sourceTable); indexErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("index_inspection_failed", DataSyncJobPreflightWarning, "mappings", indexErr.Error(), dataSyncJobMappingLabel(mapping))}
	}
	targetDB, targetErr := a.getDatabase(normalizeMetadataRunConfig(target.Config, target.Database))
	if targetErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("target_connect_failed", DataSyncJobPreflightBlocker, "endpoints", targetErr.Error(), dataSyncJobMappingLabel(mapping))}
	}
	qualifiedSourceTable := strings.TrimSpace(mapping.SourceTable)
	if strings.TrimSpace(mapping.SourceSchema) != "" {
		qualifiedSourceTable = strings.TrimSpace(mapping.SourceSchema) + "." + qualifiedSourceTable
	}
	plan, planErr := sync.InspectSchemaMigrationPlan(config, qualifiedSourceTable, sourceDB, targetDB)
	if planErr != nil {
		return []DataSyncJobPreflightIssue{preflightIssue("schema_inspection_failed", DataSyncJobPreflightWarning, "mappings", planErr.Error(), dataSyncJobMappingLabel(mapping))}
	}
	issues := make([]DataSyncJobPreflightIssue, 0, len(plan.UnmigratedIndexes))
	for _, index := range plan.UnmigratedIndexes {
		indexCopy := index
		issues = append(issues, DataSyncJobPreflightIssue{
			Code:      "unmigrated_index",
			Severity:  DataSyncJobPreflightWarning,
			Stage:     "mappings",
			Message:   index.Reason,
			MappingID: dataSyncJobMappingLabel(mapping),
			Detail:    &DataSyncJobPreflightIssueDetail{UnmigratedIndex: &indexCopy},
		})
	}
	return issues
}

func (a *App) preflightDataSyncQueryTarget(definition syncjob.JobDefinition, mapping syncjob.TableMapping, target resolvedDataSyncJobEndpoint) []DataSyncJobPreflightIssue {
	mappingID := dataSyncJobMappingLabel(mapping)
	issues := make([]DataSyncJobPreflightIssue, 0)
	targetTable := qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
	existsResult := a.DBTableExists(target.Config, target.Database, targetTable)
	if !existsResult.Success {
		return append(issues, preflightIssue("target_table_check_failed", DataSyncJobPreflightBlocker, "mappings", existsResult.Message, mappingID))
	}
	targetExists := false
	if payload, ok := existsResult.Data.(map[string]bool); ok {
		targetExists = payload["exists"]
	}
	if !targetExists {
		return append(issues, preflightIssue("target_table_missing", DataSyncJobPreflightBlocker, "mappings", "query sink requires an existing target table", mappingID))
	}
	targetResult := a.DBGetColumns(target.Config, target.Database, targetTable)
	if !targetResult.Success {
		return append(issues, preflightIssue("target_columns_failed", DataSyncJobPreflightBlocker, "mappings", targetResult.Message, mappingID))
	}
	targetColumns, _ := targetResult.Data.([]connection.ColumnDefinition)
	targetColumnSet := dataSyncJobColumnSet(targetColumns)
	for _, column := range mapping.Columns {
		if _, exists := targetColumnSet[strings.ToLower(strings.TrimSpace(column.Target))]; !exists {
			issues = append(issues, preflightIssue("target_column_missing", DataSyncJobPreflightBlocker, "mappings", fmt.Sprintf("target column %s does not exist", column.Target), mappingID))
		}
	}
	if strings.EqualFold(definition.Options.SyncMode, "insert_update") {
		if len(mapping.KeyColumns) != 1 {
			issues = append(issues, preflightIssue("query_key_required", DataSyncJobPreflightBlocker, "mappings", "query sink insert_update requires exactly one stable key column", mappingID))
		} else {
			engineMapping, err := buildEngineObjectMapping(mapping)
			if err != nil {
				issues = append(issues, preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
			} else {
				projection, err := sync.CompileProjection(engineMapping)
				if err != nil {
					issues = append(issues, preflightIssue("mapping_compile_failed", DataSyncJobPreflightBlocker, "mappings", err.Error(), mappingID))
				} else {
					mappedKey, ok := projection.TargetColumn(mapping.KeyColumns[0])
					primaryKeys := make([]string, 0, 2)
					for _, column := range targetColumns {
						if strings.EqualFold(column.Key, "PRI") || strings.EqualFold(column.Key, "PK") {
							primaryKeys = append(primaryKeys, column.Name)
						}
					}
					if !ok || len(primaryKeys) != 1 || !strings.EqualFold(strings.TrimSpace(mappedKey), strings.TrimSpace(primaryKeys[0])) {
						issues = append(issues, preflightIssue("query_target_pk_mismatch", DataSyncJobPreflightBlocker, "mappings", "query sink stable key must map to the target table's single primary key", mappingID))
					}
				}
			}
		}
	}
	issues = append(issues, preflightIssue("query_schema_runtime_validation", DataSyncJobPreflightWarning, "mappings", "query result field names are validated against the mapping when the read-only query executes", mappingID))
	return issues
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
