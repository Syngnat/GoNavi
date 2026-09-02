package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"GoNavi-Wails/internal/db"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

type appDataSyncJobExecutor struct {
	app *App
}

type dataSyncMappingCursor struct {
	NextMapping int `json:"nextMapping"`
}

const dataSyncWatermarkStateVersion = 1

type dataSyncWatermarkState struct {
	Version  int                                    `json:"version"`
	Mappings map[string]syncbackend.WatermarkCursor `json:"mappings"`
}

func (executor appDataSyncJobExecutor) Execute(ctx context.Context, request syncjob.ExecutionRequest, reporter syncjob.RunReporter) (syncjob.ExecutionOutcome, error) {
	if executor.app == nil {
		return syncjob.ExecutionOutcome{}, errors.New("application is unavailable")
	}
	definition := request.Definition
	source, err := executor.app.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
	if err != nil {
		return syncjob.ExecutionOutcome{}, fmt.Errorf("resolve source connection: %w", err)
	}
	target, err := executor.app.resolveDataSyncJobEndpoint(definition.Target.ConnectionID, definition.Target.Database, definition.Target.Schema)
	if err != nil {
		return syncjob.ExecutionOutcome{}, fmt.Errorf("resolve target connection: %w", err)
	}
	if err := validateDataSyncJobEndpointDrift(definition, source, target); err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	if dataSyncJobRequiresExecutionApproval(definition, target) {
		if err := executor.app.validateStoredDataSyncJobApproval(definition, target.Fingerprint); err != nil {
			return syncjob.ExecutionOutcome{}, err
		}
	}
	enabledMappings := make([]syncjob.TableMapping, 0, len(definition.Mappings))
	for _, mapping := range definition.Mappings {
		if mapping.Enabled {
			enabledMappings = append(enabledMappings, mapping)
		}
	}
	if definition.IncrementalMode == syncjob.IncrementalCDC {
		return executor.executeCDCJob(ctx, request, definition, enabledMappings, source, target, reporter)
	}
	if definition.IncrementalMode == syncjob.IncrementalWatermark {
		return executor.executeWatermarkJob(ctx, request, definition, enabledMappings, source, target, reporter)
	}
	startIndex, err := dataSyncJobResumeIndex(request, enabledMappings)
	if err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	definitionHash, err := dataSyncJobDefinitionHash(definition)
	if err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	outcome := syncjob.ExecutionOutcome{}
	for index := startIndex; index < len(enabledMappings); index++ {
		if err := ctx.Err(); err != nil {
			outcome.Resumable = true
			return outcome, err
		}
		mapping := enabledMappings[index]
		tableLabel := dataSyncJobMappingLabel(mapping)
		if err := reporter.ReportProgress(syncjob.RunProgress{
			Current: index,
			Total:   len(enabledMappings),
			Table:   tableLabel,
			Stage:   "running",
			Message: fmt.Sprintf("running mapping %d/%d", index+1, len(enabledMappings)),
		}); err != nil {
			return outcome, err
		}

		config, err := buildDataSyncJobEngineConfig(definition, request.Run.ID, source, target, mapping)
		if err != nil {
			outcome.Resumable = true
			return outcome, err
		}
		if definition.Kind != syncjob.JobKindCompare {
			if err := ensureDataSyncTargetProtection(config); err != nil {
				return outcome, err
			}
		}
		configureDataSyncSnapshotErrorHandling(&config, definition, mapping, reporter)
		mappingOutcome, runErr := executor.executeMappingWithRetry(ctx, request.Run.ID, definition, config, reporter)
		outcome.RowsInserted += mappingOutcome.RowsInserted
		outcome.RowsUpdated += mappingOutcome.RowsUpdated
		outcome.RowsDeleted += mappingOutcome.RowsDeleted
		outcome.RowsFailed += mappingOutcome.RowsFailed
		if runErr != nil {
			outcome.Resumable = dataSyncJobMappingRetrySafe(definition) && !db.IsWriteOutcomeUnknown(runErr)
			return outcome, runErr
		}

		cursor, _ := json.Marshal(dataSyncMappingCursor{NextMapping: index + 1})
		if err := reporter.SaveCheckpoint(syncjob.Checkpoint{
			Version:       1,
			Kind:          "resume",
			Table:         tableLabel,
			Phase:         "mapping_completed",
			CursorType:    "mapping_index",
			Cursor:        cursor,
			BatchSequence: int64(index + 1),
			SchemaHash:    definitionHash,
		}); err != nil {
			outcome.Resumable = true
			return outcome, fmt.Errorf("persist mapping checkpoint: %w", err)
		}
		if err := reporter.ReportProgress(syncjob.RunProgress{
			Current: index + 1,
			Total:   len(enabledMappings),
			Table:   tableLabel,
			Stage:   "completed",
		}); err != nil {
			return outcome, err
		}
	}
	outcome.Message = "data sync job completed"
	return outcome, nil
}

func (executor appDataSyncJobExecutor) executeWatermarkJob(
	ctx context.Context,
	request syncjob.ExecutionRequest,
	definition syncjob.JobDefinition,
	mappings []syncjob.TableMapping,
	source resolvedDataSyncJobEndpoint,
	target resolvedDataSyncJobEndpoint,
	reporter syncjob.RunReporter,
) (syncjob.ExecutionOutcome, error) {
	definitionHash, err := dataSyncJobDefinitionHash(definition)
	if err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	state, sequence, err := decodeDataSyncWatermarkState(request.Checkpoint, definition, definitionHash)
	if err != nil {
		return syncjob.ExecutionOutcome{Resumable: true}, err
	}
	outcome := syncjob.ExecutionOutcome{Resumable: true}
	for index, mapping := range mappings {
		if err := ctx.Err(); err != nil {
			return outcome, err
		}
		if mapping.Watermark == nil {
			return outcome, fmt.Errorf("mapping %s has no watermark definition", dataSyncJobMappingLabel(mapping))
		}
		config, err := buildDataSyncJobEngineConfig(definition, request.Run.ID, source, target, mapping)
		if err != nil {
			return outcome, err
		}
		if err := ensureDataSyncTargetProtection(config); err != nil {
			return outcome, err
		}
		mappingID := dataSyncJobMappingLabel(mapping)
		tieBreakers := mapping.Watermark.TieBreakerColumns
		if len(tieBreakers) == 0 {
			tieBreakers = mapping.KeyColumns
		}
		var cursor *syncbackend.WatermarkCursor
		if persisted, exists := state.Mappings[mappingID]; exists {
			copy := persisted
			cursor = &copy
		}
		if err := reporter.ReportProgress(syncjob.RunProgress{
			Current: index,
			Total:   len(mappings),
			Table:   mappingID,
			Stage:   "watermark",
			Message: fmt.Sprintf("running watermark mapping %d/%d", index+1, len(mappings)),
		}); err != nil {
			return outcome, err
		}

		mappingOutcome, runErr := executor.executeWatermarkMappingWithRetry(ctx, definition, config, mapping, cursor, tieBreakers, definitionHash, &state, &sequence, reporter)
		outcome.RowsInserted += mappingOutcome.RowsInserted
		outcome.RowsUpdated += mappingOutcome.RowsUpdated
		outcome.RowsFailed += mappingOutcome.RowsFailed
		if runErr != nil {
			if db.IsWriteOutcomeUnknown(runErr) {
				outcome.Resumable = false
			}
			return outcome, runErr
		}
		if err := reporter.ReportProgress(syncjob.RunProgress{
			Current: index + 1,
			Total:   len(mappings),
			Table:   mappingID,
			Stage:   "completed",
		}); err != nil {
			return outcome, err
		}
	}
	outcome.Message = "watermark data sync job completed"
	outcome.Resumable = false
	return outcome, nil
}

func (executor appDataSyncJobExecutor) executeWatermarkMappingWithRetry(
	ctx context.Context,
	definition syncjob.JobDefinition,
	config syncbackend.SyncConfig,
	mapping syncjob.TableMapping,
	cursor *syncbackend.WatermarkCursor,
	tieBreakers []string,
	definitionHash string,
	state *dataSyncWatermarkState,
	sequence *int64,
	reporter syncjob.RunReporter,
) (syncjob.ExecutionOutcome, error) {
	maxAttempts := definition.Options.MaxRetries + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	backoff := time.Duration(definition.Options.RetryBackoffMillis) * time.Millisecond
	mappingID := dataSyncJobMappingLabel(mapping)
	outcome := syncjob.ExecutionOutcome{Resumable: true}
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if persisted, exists := state.Mappings[mappingID]; exists {
			copy := persisted
			cursor = &copy
		}
		engine := syncbackend.NewSyncEngine(syncbackend.Reporter{
			OnLog: func(event syncbackend.SyncLogEvent) {
				_ = reporter.Emit(syncjob.RunEventLog, event.Message, mustJSON(map[string]interface{}{"level": event.Level, "ts": event.Ts}))
			},
			OnProgress: func(event syncbackend.SyncProgressEvent) {
				_ = reporter.Emit(syncjob.RunEventProgress, event.Stage, mustJSON(event))
			},
		})
		result := engine.RunWatermarkSync(ctx, syncbackend.WatermarkSyncRequest{
			Sync:              config,
			Table:             strings.TrimSpace(mapping.SourceTable),
			WatermarkColumn:   mapping.Watermark.Column,
			TieBreakerColumns: tieBreakers,
			Cursor:            cursor,
			BatchSize:         definition.Options.BatchSize,
		}, func(checkpointCtx context.Context, event syncbackend.WatermarkCheckpoint) error {
			nextState := cloneDataSyncWatermarkState(*state)
			nextState.Mappings[mappingID] = event.Cursor
			payload, err := json.Marshal(nextState)
			if err != nil {
				return err
			}
			watermark, err := json.Marshal(event.Cursor)
			if err != nil {
				return err
			}
			nextSequence := *sequence + 1
			if err := reporter.SaveCheckpoint(syncjob.Checkpoint{
				Version:       1,
				Kind:          "watermark",
				Table:         mappingID,
				Phase:         "batch_committed",
				CursorType:    "watermark_map",
				Cursor:        payload,
				Watermark:     watermark,
				BatchSequence: nextSequence,
				SchemaHash:    definitionHash,
			}); err != nil {
				return err
			}
			*state = nextState
			*sequence = nextSequence
			outcome.RowsInserted += int64(event.RowsInserted)
			outcome.RowsUpdated += int64(event.RowsUpdated)
			return reporter.ReportProgress(syncjob.RunProgress{
				Table:   mappingID,
				Stage:   "checkpoint",
				Message: fmt.Sprintf("watermark batch %d committed", event.Batch),
			})
		})
		if result.Success {
			outcome.Resumable = false
			return outcome, nil
		}
		runErr := errors.New(result.Message)
		if result.OutcomeUnknown {
			return syncjob.ExecutionOutcome{Resumable: false}, db.MarkWriteOutcomeUnknown(runErr)
		}
		if result.Cancelled || ctx.Err() != nil || attempt == maxAttempts {
			if ctx.Err() != nil {
				return outcome, ctx.Err()
			}
			return outcome, runErr
		}
		_ = reporter.Emit(syncjob.RunEventLog, fmt.Sprintf("watermark attempt %d failed; retrying", attempt), mustJSON(map[string]interface{}{
			"level":   "warn",
			"attempt": attempt,
			"error":   result.Message,
		}))
		if err := waitDataSyncRetry(ctx, backoff); err != nil {
			return outcome, err
		}
		if backoff > 0 && backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
	return outcome, errors.New("watermark retry loop exhausted")
}

func decodeDataSyncWatermarkState(checkpoint *syncjob.Checkpoint, definition syncjob.JobDefinition, definitionHash string) (dataSyncWatermarkState, int64, error) {
	state := dataSyncWatermarkState{Version: dataSyncWatermarkStateVersion, Mappings: make(map[string]syncbackend.WatermarkCursor)}
	if checkpoint == nil {
		return state, 0, nil
	}
	if checkpoint.Kind != "watermark" || checkpoint.CursorType != "watermark_map" {
		return state, 0, errors.New("checkpoint type is incompatible with watermark execution")
	}
	if !secureTextEqual(checkpoint.SchemaHash, definitionHash) {
		return state, 0, errors.New("watermark checkpoint plan hash does not match the current task")
	}
	if err := json.Unmarshal(checkpoint.Cursor, &state); err != nil {
		return state, 0, fmt.Errorf("decode watermark checkpoint: %w", err)
	}
	if state.Version != dataSyncWatermarkStateVersion || state.Mappings == nil {
		return state, 0, fmt.Errorf("unsupported watermark checkpoint state version %d", state.Version)
	}
	return state, checkpoint.BatchSequence, nil
}

func cloneDataSyncWatermarkState(input dataSyncWatermarkState) dataSyncWatermarkState {
	result := dataSyncWatermarkState{Version: input.Version, Mappings: make(map[string]syncbackend.WatermarkCursor, len(input.Mappings))}
	for key, cursor := range input.Mappings {
		copy := cursor
		copy.TieBreakerColumns = append([]string(nil), cursor.TieBreakerColumns...)
		copy.TieBreakers = append([]syncbackend.WatermarkCursorValue(nil), cursor.TieBreakers...)
		result.Mappings[key] = copy
	}
	return result
}

func waitDataSyncRetry(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func validateDataSyncJobEndpointDrift(definition syncjob.JobDefinition, source, target resolvedDataSyncJobEndpoint) error {
	if expected := strings.TrimSpace(definition.Source.Fingerprint); expected == "" {
		return errors.New("source endpoint has not passed persisted preflight")
	} else if !secureTextEqual(expected, source.Fingerprint) {
		return errors.New("source connection changed after preflight; run preflight again")
	}
	if expected := strings.TrimSpace(definition.Target.Fingerprint); expected == "" {
		return errors.New("target endpoint has not passed persisted preflight")
	} else if !secureTextEqual(expected, target.Fingerprint) {
		return errors.New("target connection changed after preflight; run preflight again")
	}
	return nil
}

func dataSyncJobResumeIndex(request syncjob.ExecutionRequest, mappings []syncjob.TableMapping) (int, error) {
	checkpoint := request.Checkpoint
	if checkpoint == nil {
		return 0, nil
	}
	useCheckpoint := request.Run.Trigger == syncjob.RunTriggerResume ||
		(request.Run.Trigger == syncjob.RunTriggerSchedule && request.Definition.ResumePolicy == "auto")
	if !useCheckpoint {
		return 0, nil
	}
	if checkpoint.Kind != "resume" || checkpoint.CursorType != "mapping_index" {
		return 0, errors.New("checkpoint type is incompatible with snapshot execution")
	}
	var cursor dataSyncMappingCursor
	if err := json.Unmarshal(checkpoint.Cursor, &cursor); err != nil {
		return 0, fmt.Errorf("decode mapping checkpoint: %w", err)
	}
	if cursor.NextMapping < 0 || cursor.NextMapping > len(mappings) {
		return 0, errors.New("checkpoint mapping index is outside the current task")
	}
	definitionHash, err := dataSyncJobDefinitionHash(request.Definition)
	if err != nil {
		return 0, err
	}
	if !secureTextEqual(checkpoint.SchemaHash, definitionHash) {
		return 0, errors.New("checkpoint plan hash does not match the current task")
	}
	return cursor.NextMapping, nil
}

func (executor appDataSyncJobExecutor) executeMappingWithRetry(ctx context.Context, runID string, definition syncjob.JobDefinition, config syncbackend.SyncConfig, reporter syncjob.RunReporter) (syncjob.ExecutionOutcome, error) {
	return executeDataSyncMappingWithRetry(ctx, definition, reporter, func() (syncjob.ExecutionOutcome, error) {
		return executor.executeOneMapping(ctx, runID, definition.Kind, config, reporter)
	})
}

func executeDataSyncMappingWithRetry(ctx context.Context, definition syncjob.JobDefinition, reporter syncjob.RunReporter, operation func() (syncjob.ExecutionOutcome, error)) (syncjob.ExecutionOutcome, error) {
	maxAttempts := definition.Options.MaxRetries + 1
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	if !dataSyncJobMappingRetrySafe(definition) {
		// An append/insert-only retry can duplicate a batch that reached a
		// non-transactional target before the driver reported its error.
		maxAttempts = 1
	}
	backoff := time.Duration(definition.Options.RetryBackoffMillis) * time.Millisecond
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return syncjob.ExecutionOutcome{Resumable: true}, err
		}
		result, err := operation()
		if err == nil {
			return result, nil
		}
		if db.IsWriteOutcomeUnknown(err) {
			result.Resumable = false
			return result, err
		}
		if attempt == maxAttempts || ctx.Err() != nil {
			return result, err
		}
		_ = reporter.Emit(syncjob.RunEventLog, fmt.Sprintf("mapping attempt %d failed; retrying", attempt), mustJSON(map[string]interface{}{
			"level":   "warn",
			"attempt": attempt,
			"error":   err.Error(),
		}))
		if backoff > 0 {
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return result, ctx.Err()
			case <-timer.C:
			}
			if backoff < 30*time.Second {
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
			}
		}
	}
	return syncjob.ExecutionOutcome{}, errors.New("data sync retry loop exhausted")
}

func dataSyncJobMappingRetrySafe(definition syncjob.JobDefinition) bool {
	return !strings.EqualFold(strings.TrimSpace(definition.Options.SyncMode), "insert_only")
}

func (executor appDataSyncJobExecutor) executeOneMapping(ctx context.Context, runID string, kind syncjob.JobKind, config syncbackend.SyncConfig, reporter syncjob.RunReporter) (syncjob.ExecutionOutcome, error) {
	reporterAdapter := syncbackend.Reporter{
		OnLog: func(event syncbackend.SyncLogEvent) {
			_ = reporter.Emit(syncjob.RunEventLog, event.Message, mustJSON(map[string]interface{}{
				"level": event.Level,
				"ts":    event.Ts,
			}))
		},
		OnProgress: func(event syncbackend.SyncProgressEvent) {
			_ = reporter.Emit(syncjob.RunEventProgress, event.Stage, mustJSON(event))
		},
	}
	engine := syncbackend.NewSyncEngine(reporterAdapter)
	if kind == syncjob.JobKindCompare {
		if err := ctx.Err(); err != nil {
			return syncjob.ExecutionOutcome{Resumable: true}, err
		}
		analysis := engine.Analyze(config)
		if !analysis.Success {
			return syncjob.ExecutionOutcome{}, errors.New(analysis.Message)
		}
		if err := ctx.Err(); err != nil {
			return syncjob.ExecutionOutcome{Resumable: true}, err
		}
		_ = reporter.Emit(syncjob.RunEventLog, analysis.Message, mustJSON(analysis))
		return syncjob.ExecutionOutcome{Message: analysis.Message}, nil
	}
	result := engine.RunSyncContext(ctx, config)
	outcome := syncjob.ExecutionOutcome{
		RowsInserted: int64(result.RowsInserted),
		RowsUpdated:  int64(result.RowsUpdated),
		RowsDeleted:  int64(result.RowsDeleted),
		RowsFailed:   int64(result.RowsSkipped),
		Message:      result.Message,
		Resumable:    !result.Success && !result.OutcomeUnknown && !strings.EqualFold(strings.TrimSpace(config.Mode), "insert_only"),
	}
	if !result.Success {
		if result.OutcomeUnknown {
			return outcome, db.MarkWriteOutcomeUnknown(errors.New(result.Message))
		}
		if result.Cancelled && ctx.Err() != nil {
			return outcome, ctx.Err()
		}
		return outcome, errors.New(result.Message)
	}
	return outcome, nil
}

func buildDataSyncJobEngineConfig(definition syncjob.JobDefinition, runID string, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping) (syncbackend.SyncConfig, error) {
	if strings.TrimSpace(mapping.Filter) != "" {
		return syncbackend.SyncConfig{}, errors.New("table filter execution is not available; remove the filter or use a query sink task")
	}
	sourceTable := strings.TrimSpace(mapping.SourceTable)
	if mapping.SourceSchema != "" {
		sourceTable = strings.TrimSpace(mapping.SourceSchema) + "." + sourceTable
	}
	effectiveSyncMode := dataSyncJobEffectiveSyncMode(definition)
	config := syncbackend.SyncConfig{
		SourceConfig:        source.Config,
		TargetConfig:        target.Config,
		SourceDatabase:      source.Database,
		TargetDatabase:      target.Database,
		TargetSchema:        firstNonEmptySyncJob(mapping.TargetSchema, target.Schema),
		Tables:              []string{sourceTable},
		Content:             definition.Options.Content,
		Mode:                effectiveSyncMode,
		JobID:               runID,
		BatchSize:           definition.Options.BatchSize,
		RowErrorPolicy:      string(definition.Options.ErrorPolicy),
		AutoAddColumns:      definition.AutoAddColumnsEnabled(),
		TargetTableStrategy: firstNonEmptySyncJob(mapping.TargetTableStrategy, definition.Options.TargetTableStrategy),
		CreateIndexes:       definition.Options.CreateIndexes,
		TableOptions: map[string]syncbackend.TableOptions{
			sourceTable: {
				Insert: true,
				Update: effectiveSyncMode == "insert_update",
				Delete: definition.Options.PropagateDeletes,
			},
		},
	}
	if definition.Kind == syncjob.JobKindQuerySink {
		config.SourceQuery = definition.SourceQuery
		engineMapping, err := buildEngineObjectMapping(mapping)
		if err != nil {
			return syncbackend.SyncConfig{}, err
		}
		engineMapping.Source = syncbackend.SyncObjectRef{Name: "__query_result__"}
		config.Mappings = []syncbackend.SyncObjectMapping{engineMapping}
		config.Tables = nil
		config.TargetSchema = firstNonEmptySyncJob(mapping.TargetSchema, target.Schema)
		config.AutoAddColumns = false
		config.CreateIndexes = false
		config.TargetTableStrategy = "existing_only"
		config.TableOptions = map[string]syncbackend.TableOptions{
			"__query_result__": {
				Insert: true,
				Update: effectiveSyncMode == "insert_update",
				Delete: false,
			},
		}
		return config, nil
	}
	if dataSyncJobMappingNeedsExplicitProjection(definition, mapping) {
		engineMapping, err := buildEngineObjectMapping(mapping)
		if err != nil {
			return syncbackend.SyncConfig{}, err
		}
		config.Mappings = []syncbackend.SyncObjectMapping{engineMapping}
		config.AutoAddColumns = false
		config.CreateIndexes = false
		config.TargetTableStrategy = "existing_only"
		// Schema-only mapped tasks still need the migration planner to see
		// missing source columns. Data mappings keep the historical fail-closed
		// behavior for explicit projections.
		if strings.EqualFold(strings.TrimSpace(definition.Options.Content), "schema") {
			config.AutoAddColumns = definition.AutoAddColumnsEnabled()
		}
	}
	return config, nil
}

func dataSyncJobEffectiveSyncMode(definition syncjob.JobDefinition) string {
	switch strings.ToLower(strings.TrimSpace(definition.Options.SyncMode)) {
	case "insert_only":
		return "insert_only"
	case "full_overwrite":
		return "full_overwrite"
	default:
		return "insert_update"
	}
}

func dataSyncJobMappingNeedsExplicitProjection(definition syncjob.JobDefinition, mapping syncjob.TableMapping) bool {
	// 结构型迁移任务（同名表 + schema/both 内容）允许走隐式路径：
	// 运行时引擎会按物理主键做行匹配与差异回填，UI 自动填充的识别列
	// 恰好就是源表主键元数据，二者等价；若因 KeyColumns 降级为显式投影，
	// 引擎会强制关闭 AutoAddColumns，导致目标缺列永远不被补齐（issue #1014）。
	structureMigration := definition.Kind == syncjob.JobKindMigration &&
		dataSyncJobMigrationAllowsSchemaChanges(definition) &&
		strings.EqualFold(strings.TrimSpace(mapping.SourceTable), strings.TrimSpace(mapping.TargetTable))
	if len(mapping.Columns) > 0 ||
		(len(mapping.KeyColumns) > 0 && !structureMigration) ||
		!strings.EqualFold(strings.TrimSpace(mapping.SourceTable), strings.TrimSpace(mapping.TargetTable)) {
		return true
	}

	if strings.TrimSpace(mapping.TargetSchema) == "" || strings.EqualFold(
		strings.TrimSpace(mapping.SourceSchema),
		strings.TrimSpace(mapping.TargetSchema),
	) {
		return false
	}

	// The legacy migration planner must see the source and target schemas so it
	// can inspect the target table and emit ALTER TABLE statements. Explicit
	// mappings are intentionally rejected by the sync engine for schema/both
	// content, so only structure-capable migration tasks may omit the mapping.
	return !(definition.Kind == syncjob.JobKindMigration && dataSyncJobMigrationAllowsSchemaChanges(definition))
}

func dataSyncJobMigrationAllowsSchemaChanges(definition syncjob.JobDefinition) bool {
	switch strings.ToLower(strings.TrimSpace(definition.Options.Content)) {
	case "schema", "both":
		return true
	default:
		return false
	}
}

func buildEngineObjectMapping(mapping syncjob.TableMapping) (syncbackend.SyncObjectMapping, error) {
	result := syncbackend.SyncObjectMapping{
		ID:         dataSyncJobMappingLabel(mapping),
		Source:     syncbackend.SyncObjectRef{Schema: mapping.SourceSchema, Name: mapping.SourceTable},
		Target:     syncbackend.SyncObjectRef{Schema: mapping.TargetSchema, Name: mapping.TargetTable},
		KeyColumns: append([]string(nil), mapping.KeyColumns...),
	}
	for _, column := range mapping.Columns {
		converted := syncbackend.SyncColumnMapping{Source: column.Source, Target: column.Target}
		if len(column.DefaultValue) > 0 {
			var value interface{}
			if err := decodeDataSyncJobJSON(column.DefaultValue, &value); err != nil {
				return syncbackend.SyncObjectMapping{}, fmt.Errorf("decode default value for %s: %w", column.Target, err)
			}
			converted.Default = dataSyncJobEngineDefault(value)
		}
		kind := strings.ToLower(strings.TrimSpace(column.Transform.Kind))
		if kind != "" && kind != "identity" {
			args := make(map[string]string)
			if len(column.Transform.Argument) > 0 {
				var decoded map[string]interface{}
				if err := decodeDataSyncJobJSON(column.Transform.Argument, &decoded); err != nil {
					return syncbackend.SyncObjectMapping{}, fmt.Errorf("decode transform arguments for %s: %w", column.Target, err)
				}
				for key, value := range decoded {
					args[key] = fmt.Sprint(value)
				}
			}
			converted.Transforms = []syncbackend.SyncValueTransform{{Type: kind, Args: args}}
		}
		result.Columns = append(result.Columns, converted)
	}
	if _, err := syncbackend.CompileProjection(result); err != nil {
		return syncbackend.SyncObjectMapping{}, err
	}
	return result, nil
}

func dataSyncJobEngineDefault(value interface{}) *syncbackend.SyncDefaultValue {
	typeName := "string"
	text := fmt.Sprint(value)
	switch typed := value.(type) {
	case nil:
		typeName, text = "null", ""
	case bool:
		typeName, text = "bool", fmt.Sprint(typed)
	case float64:
		typeName, text = "decimal", fmt.Sprint(typed)
	case json.Number:
		typeName, text = "decimal", typed.String()
	case map[string]interface{}, []interface{}:
		typeName = "json"
		encoded, _ := json.Marshal(typed)
		text = string(encoded)
	}
	return &syncbackend.SyncDefaultValue{When: []string{"missing", "null"}, ValueType: typeName, Value: text}
}

func decodeDataSyncJobJSON(raw json.RawMessage, target interface{}) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON value contains trailing data")
		}
		return err
	}
	return nil
}

func dataSyncJobMappingLabel(mapping syncjob.TableMapping) string {
	source := strings.TrimSpace(mapping.SourceTable)
	if mapping.SourceSchema != "" {
		source = strings.TrimSpace(mapping.SourceSchema) + "." + source
	}
	target := strings.TrimSpace(mapping.TargetTable)
	if mapping.TargetSchema != "" {
		target = strings.TrimSpace(mapping.TargetSchema) + "." + target
	}
	return source + " -> " + target
}

func firstNonEmptySyncJob(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func mustJSON(value interface{}) json.RawMessage {
	encoded, _ := json.Marshal(value)
	return encoded
}
