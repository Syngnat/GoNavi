package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

const dataSyncErrorRetryPayloadVersion = 1

type dataSyncErrorRetryPayload struct {
	Version           int                         `json:"version"`
	ProjectionApplied bool                        `json:"projectionApplied"`
	Event             syncbackend.DataChangeEvent `json:"event"`
}

func configureDataSyncSnapshotErrorHandling(config *syncbackend.SyncConfig, definition syncjob.JobDefinition, mapping syncjob.TableMapping, reporter syncjob.RunReporter) {
	if config == nil {
		return
	}
	config.RowErrorPolicy = string(definition.Options.ErrorPolicy)
	if definition.Options.ErrorPolicy != syncjob.ErrorPolicySkipRow {
		config.OnRowError = nil
		return
	}
	config.OnRowError = func(ctx context.Context, rowError syncbackend.ChangeEventRowError) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		projectionApplied := rowError.Code != "projection_failed"
		operation := strings.ToLower(strings.TrimSpace(rowError.Operation))
		if operation == "project" {
			operation = syncbackend.ChangeEventOperationReplace
		}
		key := dataSyncSnapshotErrorKey(mapping, rowError, projectionApplied)
		sourceRef := syncbackend.SyncObjectRef{Schema: mapping.SourceSchema, Name: mapping.SourceTable}
		if strings.TrimSpace(sourceRef.Name) == "" && len(config.Mappings) == 1 {
			sourceRef = config.Mappings[0].Source
		}
		event := syncbackend.DataChangeEvent{
			Object:    sourceRef,
			Operation: operation,
			Key:       key,
			After:     rowError.Row,
		}
		if operation == syncbackend.ChangeEventOperationDelete {
			event.After = nil
		}
		retryPayload := dataSyncErrorRetryPayload{
			Version:           dataSyncErrorRetryPayloadVersion,
			ProjectionApplied: projectionApplied,
			Event:             event,
		}
		encodedPayload, err := json.Marshal(retryPayload)
		if err != nil {
			return err
		}
		encodedKey := json.RawMessage(nil)
		if len(key) > 0 {
			encodedKey, err = json.Marshal(key)
			if err != nil {
				return err
			}
		}
		persistedPayload := json.RawMessage(nil)
		payloadPolicy := "keys_only"
		if definition.Options.CaptureErrorPayload {
			persistedPayload = encodedPayload
			payloadPolicy = "full"
		}
		sum := sha256.Sum256(encodedPayload)
		errorClass := "target_apply"
		if rowError.Code == "projection_failed" {
			errorClass = "projection"
		}
		return reporter.AppendErrorRow(syncjob.ErrorRow{
			SourceTable:   firstNonEmptySyncJob(rowError.SourceTable, mapping.SourceTable),
			TargetTable:   qualifyDataSyncJobObject(mapping.TargetSchema, mapping.TargetTable),
			Operation:     operation,
			SourceKey:     encodedKey,
			Payload:       persistedPayload,
			PayloadPolicy: payloadPolicy,
			PayloadHash:   "sha256:" + hex.EncodeToString(sum[:]),
			PayloadSize:   int64(len(encodedPayload)),
			Error:         rowError.Message,
			ErrorCode:     rowError.Code,
			ErrorClass:    errorClass,
			Status:        syncjob.ErrorRowPending,
		})
	}
}

func dataSyncSnapshotErrorKey(mapping syncjob.TableMapping, rowError syncbackend.ChangeEventRowError, projectionApplied bool) map[string]interface{} {
	if len(rowError.SourceKey) > 0 {
		return cloneDataSyncRow(rowError.SourceKey)
	}
	if len(mapping.KeyColumns) == 0 || len(rowError.Row) == 0 {
		return nil
	}
	projection, _ := syncbackend.CompileProjection(syncbackend.SyncObjectMapping{
		Columns: dataSyncEngineColumnsForKeyProjection(mapping),
	})
	result := make(map[string]interface{}, len(mapping.KeyColumns))
	for _, sourceKey := range mapping.KeyColumns {
		lookupName := sourceKey
		if projectionApplied && projection != nil {
			if targetKey, ok := projection.TargetColumn(sourceKey); ok {
				lookupName = targetKey
			}
		}
		if value, ok := dataSyncLookupRowValue(rowError.Row, lookupName); ok {
			result[lookupName] = value
		}
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func dataSyncEngineColumnsForKeyProjection(mapping syncjob.TableMapping) []syncbackend.SyncColumnMapping {
	result := make([]syncbackend.SyncColumnMapping, 0, len(mapping.Columns))
	for _, column := range mapping.Columns {
		result = append(result, syncbackend.SyncColumnMapping{Source: column.Source, Target: column.Target})
	}
	return result
}

func dataSyncLookupRowValue(row map[string]interface{}, name string) (interface{}, bool) {
	for key, value := range row {
		if strings.EqualFold(strings.TrimSpace(key), strings.TrimSpace(name)) {
			return value, true
		}
	}
	return nil, false
}

func cloneDataSyncRow(input map[string]interface{}) map[string]interface{} {
	if input == nil {
		return nil
	}
	result := make(map[string]interface{}, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func (a *App) retryDataSyncErrorRow(ctx context.Context, manager *syncjob.Manager, errorRowID string, expectedJobRevision int64, approvalToken string) (syncjob.ErrorRow, error) {
	if expectedJobRevision <= 0 {
		return syncjob.ErrorRow{}, errors.New("data sync error row retry requires a positive expected job revision")
	}
	row, err := manager.GetErrorRow(ctx, strings.TrimSpace(errorRowID))
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	if row.Status != syncjob.ErrorRowPending {
		return syncjob.ErrorRow{}, fmt.Errorf("data sync error row is %s, not pending", row.Status)
	}
	if row.PayloadPolicy != "full" || len(row.Payload) == 0 {
		return syncjob.ErrorRow{}, errors.New("data sync error row retry requires an explicitly captured full payload")
	}
	if row.PayloadSize > 0 && row.PayloadSize != int64(len(row.Payload)) {
		return syncjob.ErrorRow{}, errors.New("data sync error row payload size does not match persisted metadata")
	}
	sum := sha256.Sum256(row.Payload)
	if row.PayloadHash == "" || !secureTextEqual(row.PayloadHash, "sha256:"+hex.EncodeToString(sum[:])) {
		return syncjob.ErrorRow{}, errors.New("data sync error row payload integrity check failed")
	}
	run, err := manager.GetRun(ctx, row.RunID)
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	if run.JobID != row.JobID {
		return syncjob.ErrorRow{}, errors.New("data sync error row does not match its parent run")
	}
	var snapshot syncjob.JobDefinition
	if err := decodeDataSyncJobJSON(run.DefinitionSnapshot, &snapshot); err != nil {
		return syncjob.ErrorRow{}, fmt.Errorf("decode data sync error row definition snapshot: %w", err)
	}
	definition, err := manager.GetJob(ctx, row.JobID)
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	if definition.Revision != expectedJobRevision {
		return syncjob.ErrorRow{}, fmt.Errorf("data sync job revision changed: expected %d, current %d", expectedJobRevision, definition.Revision)
	}
	if definition.Lifecycle != syncjob.JobLifecycleReady && definition.Lifecycle != syncjob.JobLifecycleEnabled {
		return syncjob.ErrorRow{}, fmt.Errorf("data sync error row retry requires a ready or enabled task, got %s", definition.Lifecycle)
	}
	snapshotHash, err := syncjob.ExecutionPlanHash(snapshot)
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	currentHash, err := syncjob.ExecutionPlanHash(definition)
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	if !secureTextEqual(snapshotHash, currentHash) {
		return syncjob.ErrorRow{}, errors.New("data sync error row belongs to an incompatible execution plan")
	}

	source, err := a.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
	if err != nil {
		return syncjob.ErrorRow{}, fmt.Errorf("resolve source connection: %w", err)
	}
	target, err := a.resolveDataSyncJobEndpoint(definition.Target.ConnectionID, definition.Target.Database, definition.Target.Schema)
	if err != nil {
		return syncjob.ErrorRow{}, fmt.Errorf("resolve target connection: %w", err)
	}
	if err := validateDataSyncJobEndpointDrift(definition, source, target); err != nil {
		return syncjob.ErrorRow{}, err
	}
	if dataSyncJobRequiresExecutionApproval(definition, target) {
		if strings.TrimSpace(approvalToken) != "" {
			if _, err := a.consumeDataSyncJobApproval(approvalToken, definition, target.Fingerprint, time.Now()); err != nil {
				return syncjob.ErrorRow{}, err
			}
		} else if err := a.validateStoredDataSyncJobApproval(definition, target.Fingerprint); err != nil {
			return syncjob.ErrorRow{}, err
		}
	}

	payload, err := decodeDataSyncErrorRetryPayload(row.Payload)
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	mapping, found := dataSyncRetryMapping(definition, payload.Event)
	if !found {
		return syncjob.ErrorRow{}, errors.New("data sync error row source mapping no longer exists")
	}
	config, event, err := buildDataSyncErrorRetryRequest(definition, run.ID, source, target, mapping, payload)
	if err != nil {
		return syncjob.ErrorRow{}, err
	}
	if err := ensureDataSyncTargetProtection(config); err != nil {
		return syncjob.ErrorRow{}, err
	}
	return manager.RetryErrorRow(ctx, row.ID, func(replayCtx context.Context, _ syncjob.ErrorRow) error {
		result := appDataSyncJobExecutor{app: a}.runDataSyncChangeEvents(replayCtx, syncbackend.ChangeEventRequest{
			Sync:           config,
			Events:         []syncbackend.DataChangeEvent{event},
			RowErrorPolicy: syncbackend.RowErrorPolicyStop,
		})
		if result.Success && result.EventsApplied == 1 {
			return nil
		}
		message := strings.TrimSpace(result.Message)
		if message == "" {
			message = "data sync error row replay did not apply exactly one event"
		}
		return errors.New(message)
	})
}

func decodeDataSyncErrorRetryPayload(raw json.RawMessage) (dataSyncErrorRetryPayload, error) {
	var envelope dataSyncErrorRetryPayload
	if err := decodeDataSyncJobJSON(raw, &envelope); err == nil && envelope.Version != 0 {
		if envelope.Version != dataSyncErrorRetryPayloadVersion {
			return dataSyncErrorRetryPayload{}, fmt.Errorf("unsupported data sync error retry payload version %d", envelope.Version)
		}
		return envelope, nil
	}
	var event syncbackend.DataChangeEvent
	if err := decodeDataSyncJobJSON(raw, &event); err != nil {
		return dataSyncErrorRetryPayload{}, fmt.Errorf("decode data sync error retry payload: %w", err)
	}
	if strings.TrimSpace(event.Object.Name) == "" || strings.TrimSpace(event.Operation) == "" {
		return dataSyncErrorRetryPayload{}, errors.New("data sync error retry payload does not contain a change event")
	}
	return dataSyncErrorRetryPayload{Version: dataSyncErrorRetryPayloadVersion, Event: event}, nil
}

func dataSyncRetryMapping(definition syncjob.JobDefinition, event syncbackend.DataChangeEvent) (syncjob.TableMapping, bool) {
	if definition.Kind == syncjob.JobKindQuerySink && len(definition.Mappings) == 1 && definition.Mappings[0].Enabled {
		return definition.Mappings[0], true
	}
	return dataSyncMappingForSource(definition.Mappings, event.Object.Schema, event.Object.Name)
}

func buildDataSyncErrorRetryRequest(definition syncjob.JobDefinition, runID string, source, target resolvedDataSyncJobEndpoint, mapping syncjob.TableMapping, payload dataSyncErrorRetryPayload) (syncbackend.SyncConfig, syncbackend.DataChangeEvent, error) {
	event := payload.Event
	if payload.ProjectionApplied {
		targetSchema := firstNonEmptySyncJob(mapping.TargetSchema, target.Schema)
		event.Object = syncbackend.SyncObjectRef{Schema: targetSchema, Name: mapping.TargetTable}
		return syncbackend.SyncConfig{
			TargetConfig:        target.Config,
			TargetDatabase:      target.Database,
			TargetSchema:        targetSchema,
			Tables:              []string{qualifyDataSyncJobObject(targetSchema, mapping.TargetTable)},
			Content:             "data",
			Mode:                "insert_update",
			JobID:               runID,
			BatchSize:           1,
			TargetTableStrategy: "existing_only",
		}, event, nil
	}
	config, err := buildDataSyncJobEngineConfig(definition, runID, source, target, mapping)
	if err != nil {
		return syncbackend.SyncConfig{}, syncbackend.DataChangeEvent{}, err
	}
	config.SourceQuery = ""
	config.Mode = "insert_update"
	config.Content = "data"
	config.BatchSize = 1
	config.RowErrorPolicy = syncbackend.RowErrorPolicyStop
	config.OnRowError = nil
	config.TargetTableStrategy = "existing_only"
	config.AutoAddColumns = false
	config.CreateIndexes = false
	if len(config.Mappings) == 1 {
		event.Object = config.Mappings[0].Source
	}
	return config, event, nil
}
