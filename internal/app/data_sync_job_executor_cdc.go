package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"GoNavi-Wails/internal/db"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/synccdc"
	"GoNavi-Wails/internal/syncjob"
)

const dataSyncCDCCheckpointVersion = 1

func (executor appDataSyncJobExecutor) executeCDCJob(
	ctx context.Context,
	request syncjob.ExecutionRequest,
	definition syncjob.JobDefinition,
	mappings []syncjob.TableMapping,
	source resolvedDataSyncJobEndpoint,
	target resolvedDataSyncJobEndpoint,
	reporter syncjob.RunReporter,
) (syncjob.ExecutionOutcome, error) {
	if definition.CDC == nil {
		return syncjob.ExecutionOutcome{}, errors.New("CDC definition is required")
	}
	if definition.CDC.InitialSnapshot {
		return syncjob.ExecutionOutcome{}, errors.New("CDC initial snapshot is blocked because the current snapshot reader cannot enforce the change-stream barrier")
	}
	if len(mappings) == 0 {
		return syncjob.ExecutionOutcome{}, errors.New("CDC requires at least one enabled object mapping")
	}
	adapter, err := executor.app.dataSyncCDCAdapters().Get(definition.CDC.Adapter)
	if err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	cdcRequest := buildDataSyncCDCRequest(source, mappings)
	definitionHash, err := dataSyncJobDefinitionHash(definition)
	if err != nil {
		return syncjob.ExecutionOutcome{}, err
	}
	position, sequence, err := executor.resolveDataSyncCDCPosition(ctx, request.Checkpoint, definition, definitionHash, adapter, cdcRequest)
	if err != nil {
		return syncjob.ExecutionOutcome{Resumable: request.Checkpoint != nil}, err
	}
	if request.Checkpoint == nil {
		cursor, marshalErr := json.Marshal(position)
		if marshalErr != nil {
			return syncjob.ExecutionOutcome{}, fmt.Errorf("encode CDC bootstrap checkpoint: %w", marshalErr)
		}
		if saveErr := reporter.SaveCheckpoint(syncjob.Checkpoint{
			Version:       dataSyncCDCCheckpointVersion,
			Kind:          "cdc",
			Phase:         "stream_initialized",
			CursorType:    "synccdc_position",
			Cursor:        cursor,
			BatchSequence: 0,
			SchemaHash:    definitionHash,
		}); saveErr != nil {
			return syncjob.ExecutionOutcome{}, fmt.Errorf("persist CDC bootstrap checkpoint: %w", saveErr)
		}
	}
	stream, err := adapter.Open(ctx, cdcRequest, position)
	if err != nil {
		return syncjob.ExecutionOutcome{Resumable: true}, fmt.Errorf("open CDC stream: %w", err)
	}
	defer func() { _ = stream.Close() }()

	config, err := buildDataSyncCDCChangeConfig(definition, request.Run.ID, source, target, mappings)
	if err != nil {
		return syncjob.ExecutionOutcome{Resumable: true}, err
	}
	if err := ensureDataSyncTargetProtection(config); err != nil {
		return syncjob.ExecutionOutcome{Resumable: true}, err
	}
	var changeEventSession *syncbackend.ChangeEventSession
	if executor.app.dataSyncChangeEventRunner == nil {
		changeEventSession, err = syncbackend.NewSyncEngine(syncbackend.Reporter{}).OpenChangeEventSessionContext(ctx, config)
		if err != nil {
			return syncjob.ExecutionOutcome{Resumable: true}, fmt.Errorf("open CDC target session: %w", err)
		}
		defer func() { _ = changeEventSession.Close() }()
	}
	outcome := syncjob.ExecutionOutcome{Resumable: true}
	for {
		if err := ctx.Err(); err != nil {
			return outcome, err
		}
		transaction, nextErr := stream.Next(ctx)
		if nextErr != nil {
			if ctx.Err() != nil {
				return outcome, ctx.Err()
			}
			if errors.Is(nextErr, io.EOF) {
				return outcome, errors.New("CDC stream ended; the continuous scheduler will retry from the durable checkpoint")
			}
			return outcome, nextErr
		}
		if err := synccdc.ValidatePosition(transaction.Position, adapter.Name()); err != nil {
			return outcome, fmt.Errorf("validate CDC position: %w", err)
		}

		events, sourceEvents, err := buildDataSyncChangeEvents(definition, mappings, transaction.Events)
		if err != nil {
			return outcome, err
		}
		if len(events) > 0 {
			changeRequest := syncbackend.ChangeEventRequest{
				Sync:           config,
				Events:         events,
				RowErrorPolicy: string(definition.Options.ErrorPolicy),
				OnRowError: func(callbackCtx context.Context, rowError syncbackend.ChangeEventRowError) error {
					if rowError.Index < 0 || rowError.Index >= len(sourceEvents) {
						return errors.New("CDC row error index is outside the delivered transaction")
					}
					return appendDataSyncCDCErrorRow(callbackCtx, reporter, definition, mappings, sourceEvents[rowError.Index], rowError)
				},
			}
			var result syncbackend.ChangeEventResult
			if changeEventSession != nil {
				result = changeEventSession.ApplyContext(ctx, changeRequest.Events, changeRequest.RowErrorPolicy, changeRequest.OnRowError)
			} else {
				// Keep the historical runner seam for deterministic executor tests
				// and error-retry injection. Production CDC runs use one session.
				result = executor.runDataSyncChangeEvents(ctx, changeRequest)
			}
			outcome.RowsInserted += int64(result.RowsInserted)
			outcome.RowsUpdated += int64(result.RowsUpdated)
			outcome.RowsDeleted += int64(result.RowsDeleted)
			outcome.RowsFailed += int64(result.EventsSkipped)
			if !result.Success {
				if result.OutcomeUnknown {
					outcome.Resumable = false
					return outcome, db.MarkWriteOutcomeUnknown(errors.New(result.Message))
				}
				if result.Cancelled && ctx.Err() != nil {
					return outcome, ctx.Err()
				}
				return outcome, errors.New(result.Message)
			}
		}

		cursor, err := json.Marshal(transaction.Position)
		if err != nil {
			return outcome, fmt.Errorf("encode CDC checkpoint: %w", err)
		}
		sequence++
		if err := reporter.SaveCheckpoint(syncjob.Checkpoint{
			Version:       dataSyncCDCCheckpointVersion,
			Kind:          "cdc",
			Phase:         "transaction_committed",
			CursorType:    "synccdc_position",
			Cursor:        cursor,
			BatchSequence: sequence,
			SchemaHash:    definitionHash,
		}); err != nil {
			return outcome, fmt.Errorf("persist CDC checkpoint: %w", err)
		}
		if err := stream.Acknowledge(ctx, transaction.Position); err != nil {
			return outcome, fmt.Errorf("acknowledge durable CDC position: %w", err)
		}
		if err := reporter.ReportProgress(syncjob.RunProgress{
			Current: int(sequence),
			Total:   0,
			Stage:   "streaming",
			Message: fmt.Sprintf("CDC transaction %d committed", sequence),
		}); err != nil {
			return outcome, err
		}
	}
}

func (executor appDataSyncJobExecutor) runDataSyncChangeEvents(ctx context.Context, request syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult {
	if executor.app.dataSyncChangeEventRunner != nil {
		return executor.app.dataSyncChangeEventRunner(ctx, request)
	}
	return syncbackend.NewSyncEngine(syncbackend.Reporter{}).RunChangeEventsContext(ctx, request)
}

func (executor appDataSyncJobExecutor) resolveDataSyncCDCPosition(
	ctx context.Context,
	checkpoint *syncjob.Checkpoint,
	definition syncjob.JobDefinition,
	definitionHash string,
	adapter synccdc.Adapter,
	request synccdc.Request,
) (synccdc.Position, int64, error) {
	if checkpoint != nil {
		if checkpoint.Kind != "cdc" || checkpoint.CursorType != "synccdc_position" || !secureTextEqual(checkpoint.SchemaHash, definitionHash) {
			return synccdc.Position{}, 0, errors.New("CDC checkpoint is incompatible with the current execution plan; reset it explicitly")
		}
		var position synccdc.Position
		if err := json.Unmarshal(checkpoint.Cursor, &position); err != nil {
			return synccdc.Position{}, 0, fmt.Errorf("decode CDC checkpoint: %w", err)
		}
		if err := synccdc.ValidatePosition(position, adapter.Name()); err != nil {
			return synccdc.Position{}, 0, err
		}
		return position, checkpoint.BatchSequence, nil
	}

	switch strings.ToLower(strings.TrimSpace(definition.CDC.StartPosition)) {
	case "", "latest":
		barrier, err := adapter.BeginSnapshot(ctx, request)
		if err != nil {
			return synccdc.Position{}, 0, fmt.Errorf("create CDC latest barrier: %w", err)
		}
		if err := synccdc.ValidatePosition(barrier.Position, adapter.Name()); err != nil {
			return synccdc.Position{}, 0, err
		}
		return barrier.Position, 0, nil
	case "checkpoint":
		return synccdc.Position{}, 0, errors.New("CDC start position checkpoint requires an existing durable checkpoint")
	case "earliest":
		return synccdc.Position{}, 0, errors.New("CDC earliest start position is not supported by this adapter")
	default:
		return synccdc.Position{}, 0, fmt.Errorf("unsupported CDC start position %q", definition.CDC.StartPosition)
	}
}

func buildDataSyncCDCRequest(source resolvedDataSyncJobEndpoint, mappings []syncjob.TableMapping) synccdc.Request {
	objects := make([]synccdc.ObjectRef, 0, len(mappings))
	for _, mapping := range mappings {
		objects = append(objects, synccdc.ObjectRef{
			Database: source.Database,
			Schema:   mapping.SourceSchema,
			Name:     mapping.SourceTable,
		})
	}
	return synccdc.Request{Config: source.Config, Objects: objects, Database: source.Database, Schema: source.Schema}
}

func buildDataSyncCDCChangeConfig(definition syncjob.JobDefinition, runID string, source, target resolvedDataSyncJobEndpoint, mappings []syncjob.TableMapping) (syncbackend.SyncConfig, error) {
	if !strings.EqualFold(strings.TrimSpace(definition.Options.SyncMode), "insert_update") {
		return syncbackend.SyncConfig{}, errors.New("CDC execution requires insert_update delivery")
	}
	config := syncbackend.SyncConfig{
		SourceConfig:        source.Config,
		TargetConfig:        target.Config,
		SourceDatabase:      source.Database,
		TargetDatabase:      target.Database,
		TargetSchema:        target.Schema,
		Content:             "data",
		Mode:                "insert_update",
		JobID:               runID,
		BatchSize:           definition.Options.BatchSize,
		TargetTableStrategy: "existing_only",
		Mappings:            make([]syncbackend.SyncObjectMapping, 0, len(mappings)),
	}
	for _, mapping := range mappings {
		if strings.TrimSpace(mapping.Filter) != "" {
			return syncbackend.SyncConfig{}, errors.New("CDC mappings do not support source filters")
		}
		converted, err := buildEngineObjectMapping(mapping)
		if err != nil {
			return syncbackend.SyncConfig{}, err
		}
		config.Mappings = append(config.Mappings, converted)
	}
	return config, nil
}

func buildDataSyncChangeEvents(definition syncjob.JobDefinition, mappings []syncjob.TableMapping, input []synccdc.Event) ([]syncbackend.DataChangeEvent, []synccdc.Event, error) {
	events := make([]syncbackend.DataChangeEvent, 0, len(input))
	sourceEvents := make([]synccdc.Event, 0, len(input))
	for _, event := range input {
		operation := strings.ToLower(strings.TrimSpace(event.Operation))
		if operation == syncbackend.ChangeEventOperationDelete && !definition.Options.PropagateDeletes {
			continue
		}
		if operation != syncbackend.ChangeEventOperationDelete && len(event.After) == 0 {
			return nil, nil, fmt.Errorf("CDC %s event for %s has no apply-safe row; checkpoint was not advanced", operation, event.Object.Name)
		}
		if operation != syncbackend.ChangeEventOperationDelete {
			mapping, found := dataSyncMappingForSource(mappings, event.Object.Schema, event.Object.Name)
			if !found || len(mapping.Columns) == 0 {
				return nil, nil, fmt.Errorf("CDC %s requires an explicit authoritative column mapping; checkpoint was not advanced", event.Object.Name)
			}
			event.After = dataSyncMaterializeAuthoritativeRow(event.After, mapping)
		}
		events = append(events, syncbackend.DataChangeEvent{
			Object: syncbackend.SyncObjectRef{
				Database: event.Object.Database,
				Schema:   event.Object.Schema,
				Name:     event.Object.Name,
			},
			Operation:  operation,
			Key:        event.Key,
			Before:     event.Before,
			After:      event.After,
			SourceTxID: event.SourceTxID,
		})
		sourceEvents = append(sourceEvents, event)
	}
	return events, sourceEvents, nil
}

func dataSyncMappingForSource(mappings []syncjob.TableMapping, schema, table string) (syncjob.TableMapping, bool) {
	for _, mapping := range mappings {
		if !strings.EqualFold(strings.TrimSpace(mapping.SourceTable), strings.TrimSpace(table)) {
			continue
		}
		if strings.TrimSpace(schema) != "" && strings.TrimSpace(mapping.SourceSchema) != "" &&
			!strings.EqualFold(strings.TrimSpace(mapping.SourceSchema), strings.TrimSpace(schema)) {
			continue
		}
		return mapping, true
	}
	return syncjob.TableMapping{}, false
}

func dataSyncMaterializeAuthoritativeRow(row map[string]interface{}, mapping syncjob.TableMapping) map[string]interface{} {
	result := cloneDataSyncRow(row)
	if result == nil {
		result = make(map[string]interface{}, len(mapping.Columns))
	}
	for _, column := range mapping.Columns {
		source := strings.TrimSpace(column.Source)
		if source == "" {
			continue
		}
		if _, exists := dataSyncLookupRowValue(result, source); !exists {
			// MongoDB updateLookup/replace delivers the authoritative current
			// document. A missing mapped field therefore means it was removed;
			// materialize nil so the target column is cleared/defaulted instead
			// of retaining stale data during merge-style updates.
			result[source] = nil
		}
	}
	return result
}

func appendDataSyncCDCErrorRow(ctx context.Context, reporter syncjob.RunReporter, definition syncjob.JobDefinition, mappings []syncjob.TableMapping, event synccdc.Event, rowError syncbackend.ChangeEventRowError) error {
	encodedEvent, err := json.Marshal(syncbackend.DataChangeEvent{
		Object:     syncbackend.SyncObjectRef{Database: event.Object.Database, Schema: event.Object.Schema, Name: event.Object.Name},
		Operation:  event.Operation,
		Key:        event.Key,
		Before:     event.Before,
		After:      event.After,
		SourceTxID: event.SourceTxID,
	})
	if err != nil {
		return err
	}
	encodedKey, err := json.Marshal(event.Key)
	if err != nil {
		return err
	}
	payload := json.RawMessage(nil)
	payloadPolicy := "keys_only"
	if definition.Options.CaptureErrorPayload {
		payload = encodedEvent
		payloadPolicy = "full"
	}
	sum := sha256.Sum256(encodedEvent)
	return reporter.AppendErrorRow(syncjob.ErrorRow{
		SourceTable:   event.Object.Name,
		TargetTable:   dataSyncTargetTableForSource(mappings, event.Object.Name),
		Operation:     strings.ToLower(strings.TrimSpace(event.Operation)),
		SourceKey:     encodedKey,
		Payload:       payload,
		PayloadPolicy: payloadPolicy,
		PayloadHash:   "sha256:" + hex.EncodeToString(sum[:]),
		PayloadSize:   int64(len(encodedEvent)),
		Error:         rowError.Message,
		ErrorCode:     rowError.Code,
		ErrorClass:    "target_apply",
		Status:        syncjob.ErrorRowPending,
	})
}

func dataSyncTargetTableForSource(mappings []syncjob.TableMapping, sourceTable string) string {
	for _, mapping := range mappings {
		if strings.EqualFold(strings.TrimSpace(mapping.SourceTable), strings.TrimSpace(sourceTable)) {
			return qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable)
		}
	}
	return ""
}
