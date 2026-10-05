package syncjob

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
)

func decodeRunDefinition(run RunRecord) (JobDefinition, error) {
	var definition JobDefinition
	if err := json.Unmarshal(run.DefinitionSnapshot, &definition); err != nil {
		return JobDefinition{}, fmt.Errorf("decode data sync job run snapshot: %w", err)
	}
	definition = NormalizeDefinition(definition)
	if err := ValidateDefinition(definition); err != nil {
		return JobDefinition{}, fmt.Errorf("validate data sync job run snapshot: %w", err)
	}
	if definition.ID != run.JobID || definition.Revision != run.JobRevision {
		return JobDefinition{}, fmt.Errorf("data sync job run snapshot identity does not match run %s", run.ID)
	}
	if definition.Source.Fingerprint != run.SourceFingerprint || definition.Target.Fingerprint != run.TargetFingerprint {
		return JobDefinition{}, fmt.Errorf("data sync job run snapshot endpoint fingerprints do not match run %s", run.ID)
	}
	return definition, nil
}

type managerReporter struct {
	manager *Manager
	ctx     context.Context
	run     RunRecord
	mu      sync.Mutex
}

func (r *managerReporter) ReportProgress(progress RunProgress) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	run, err := r.manager.store.UpdateRunProgressOwned(r.ctx, r.run.ID, r.run.OwnerToken, progress, r.manager.nowMillis())
	if err != nil {
		return err
	}
	r.run = run
	payload, _ := json.Marshal(progress)
	_, err = r.manager.appendEvent(r.ctx, run, RunEventProgress, progress.Message, payload)
	return err
}

func (r *managerReporter) SaveCheckpoint(checkpoint Checkpoint) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	checkpoint.JobID = r.run.JobID
	checkpoint.RunID = r.run.ID
	checkpoint.DefinitionRevision = r.run.JobRevision
	persisted, err := r.manager.store.PutCheckpointOwned(r.ctx, checkpoint, r.run.OwnerToken)
	if err != nil {
		return err
	}
	publicCheckpoint := persisted
	publicCheckpoint.SchemaHash = ""
	payload, _ := json.Marshal(publicCheckpoint)
	_, err = r.manager.appendEvent(r.ctx, r.run, RunEventCheckpoint, "checkpoint saved", payload)
	return err
}

func (r *managerReporter) AppendErrorRow(row ErrorRow) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	row.RunID = r.run.ID
	row.JobID = r.run.JobID
	persisted, err := r.manager.store.AppendErrorRow(r.ctx, row)
	if err != nil {
		return err
	}
	// Error events are notification metadata only. Source keys and captured row
	// payloads stay in the explicit error-row store and are never broadcast.
	payload, _ := json.Marshal(struct {
		ID            string         `json:"id"`
		SourceTable   string         `json:"sourceTable,omitempty"`
		TargetTable   string         `json:"targetTable,omitempty"`
		Operation     string         `json:"operation,omitempty"`
		PayloadPolicy string         `json:"payloadPolicy,omitempty"`
		PayloadHash   string         `json:"payloadHash,omitempty"`
		PayloadSize   int64          `json:"payloadSize,omitempty"`
		ErrorCode     string         `json:"errorCode,omitempty"`
		ErrorClass    string         `json:"errorClass,omitempty"`
		Status        ErrorRowStatus `json:"status"`
	}{
		ID:            persisted.ID,
		SourceTable:   persisted.SourceTable,
		TargetTable:   persisted.TargetTable,
		Operation:     persisted.Operation,
		PayloadPolicy: persisted.PayloadPolicy,
		PayloadHash:   persisted.PayloadHash,
		PayloadSize:   persisted.PayloadSize,
		ErrorCode:     persisted.ErrorCode,
		ErrorClass:    persisted.ErrorClass,
		Status:        persisted.Status,
	})
	_, err = r.manager.appendEvent(r.ctx, r.run, RunEventErrorRow, persisted.Error, payload)
	return err
}

func (r *managerReporter) Emit(eventType RunEventType, message string, payload json.RawMessage) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if eventType == "" {
		eventType = RunEventLog
	}
	_, err := r.manager.appendEvent(r.ctx, r.run, eventType, message, payload)
	return err
}
