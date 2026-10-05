package syncjob

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func (m *Manager) StartRun(ctx context.Context, jobID string) (RunRecord, error) {
	if err := m.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	definition, err := m.store.GetJob(ctx, strings.TrimSpace(jobID))
	if err != nil {
		return RunRecord{}, err
	}
	if definition.Lifecycle != JobLifecycleReady && definition.Lifecycle != JobLifecycleEnabled {
		return RunRecord{}, ErrJobDisabled
	}
	if err := ValidateDefinition(definition); err != nil {
		return RunRecord{}, err
	}
	run, err := m.createRun(ctx, definition, RunTriggerManual, "", 1)
	if err != nil {
		return RunRecord{}, err
	}
	m.signalWake()
	return run, nil
}

func (m *Manager) CancelRun(ctx context.Context, runID string) error {
	if err := m.ensureOpen(); err != nil {
		return err
	}
	run, err := m.store.RequestCancelRun(ctx, strings.TrimSpace(runID), m.nowMillis())
	if err != nil {
		return err
	}
	eventType := RunEventCancelling
	message := "cancellation requested"
	if run.Status == RunStatusCanceled {
		eventType = RunEventCanceled
		message = "canceled before execution"
	}
	_, eventErr := m.appendEvent(ctx, run, eventType, message, nil)
	if run.Status == RunStatusCancelling {
		m.cancelLocalRun(run.ID, errRunCanceled)
	}
	return eventErr
}

func (m *Manager) ResumeRun(ctx context.Context, runID string) (RunRecord, error) {
	if err := m.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	parent, err := m.store.GetRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return RunRecord{}, err
	}
	switch parent.Status {
	case RunStatusFailed, RunStatusCanceled, RunStatusInterrupted, RunStatusPartial, RunStatusPaused:
	default:
		return RunRecord{}, ErrRunNotResumable
	}
	if !parent.Resumable {
		return RunRecord{}, ErrRunNotResumable
	}
	definition, err := decodeRunDefinition(parent)
	if err != nil {
		return RunRecord{}, err
	}
	current, err := m.requireCurrentRunnableDefinition(ctx, parent, definition)
	if err != nil {
		return RunRecord{}, err
	}
	if current.ResumePolicy == "never" {
		return RunRecord{}, ErrRunNotResumable
	}
	if current.Options.SyncMode == "insert_only" {
		return RunRecord{}, ErrRunNotResumable
	}
	checkpoint, err := m.store.GetCheckpoint(ctx, parent.JobID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return RunRecord{}, ErrRunNotResumable
		}
		return RunRecord{}, err
	}
	inLineage, err := m.checkpointBelongsToRunLineage(ctx, parent, checkpoint, current)
	if err != nil {
		return RunRecord{}, err
	}
	if !inLineage {
		return RunRecord{}, ErrRunNotResumable
	}
	resumed, err := m.createRun(ctx, current, RunTriggerResume, parent.ID, parent.Attempt+1)
	if err != nil {
		return RunRecord{}, err
	}
	m.signalWake()
	return resumed, nil
}

func (m *Manager) RetryRun(ctx context.Context, runID string) (RunRecord, error) {
	if err := m.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	parent, err := m.store.GetRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return RunRecord{}, err
	}
	switch parent.Status {
	case RunStatusFailed, RunStatusPartial, RunStatusCanceled, RunStatusInterrupted:
	default:
		return RunRecord{}, ErrRunNotRetryable
	}
	definition, err := decodeRunDefinition(parent)
	if err != nil {
		return RunRecord{}, err
	}
	current, err := m.requireCurrentRunnableDefinition(ctx, parent, definition)
	if err != nil {
		return RunRecord{}, err
	}
	if current.Options.SyncMode == "insert_only" {
		return RunRecord{}, ErrRunNotRetryable
	}
	retried, err := m.createRun(ctx, current, RunTriggerRetry, parent.ID, parent.Attempt+1)
	if err != nil {
		return RunRecord{}, err
	}
	m.signalWake()
	return retried, nil
}

func (m *Manager) checkpointBelongsToRunLineage(ctx context.Context, parent RunRecord, checkpoint Checkpoint, definition JobDefinition) (bool, error) {
	if checkpoint.JobID != parent.JobID || strings.TrimSpace(checkpoint.RunID) == "" {
		return false, nil
	}
	expectedPlanHash, err := ExecutionPlanHash(definition)
	if err != nil {
		return false, err
	}
	visited := make(map[string]struct{})
	candidate := parent
	for {
		if candidate.JobID != parent.JobID {
			return false, nil
		}
		if _, repeated := visited[candidate.ID]; repeated {
			return false, nil
		}
		visited[candidate.ID] = struct{}{}
		if candidate.ID == checkpoint.RunID {
			if checkpoint.DefinitionRevision != 0 && checkpoint.DefinitionRevision != candidate.JobRevision {
				return false, nil
			}
			candidateDefinition, err := decodeRunDefinition(candidate)
			if err != nil {
				return false, err
			}
			candidatePlanHash, err := ExecutionPlanHash(candidateDefinition)
			if err != nil {
				return false, err
			}
			return candidatePlanHash == expectedPlanHash, nil
		}
		if strings.TrimSpace(candidate.ParentRunID) == "" {
			return false, nil
		}
		candidate, err = m.store.GetRun(ctx, candidate.ParentRunID)
		if err != nil {
			return false, err
		}
	}
}

func (m *Manager) requireCurrentRunnableDefinition(ctx context.Context, run RunRecord, snapshot JobDefinition) (JobDefinition, error) {
	current, err := m.store.GetJob(ctx, run.JobID)
	if err != nil {
		return JobDefinition{}, err
	}
	if current.Lifecycle != JobLifecycleReady && current.Lifecycle != JobLifecycleEnabled {
		return JobDefinition{}, ErrJobDisabled
	}
	snapshotHash, err := ExecutionPlanHash(snapshot)
	if err != nil {
		return JobDefinition{}, err
	}
	currentHash, err := ExecutionPlanHash(current)
	if err != nil {
		return JobDefinition{}, err
	}
	if snapshot.ID != run.JobID || snapshot.Revision != run.JobRevision || snapshotHash != currentHash {
		return JobDefinition{}, fmt.Errorf("%w: the task execution plan changed after run %s", ErrRevisionConflict, run.ID)
	}
	return current, nil
}

func (m *Manager) createRun(ctx context.Context, definition JobDefinition, trigger RunTrigger, parentRunID string, attempt int) (RunRecord, error) {
	return m.createRunWithID(ctx, definition, trigger, parentRunID, attempt, "")
}

func (m *Manager) createRunWithID(ctx context.Context, definition JobDefinition, trigger RunTrigger, parentRunID string, attempt int, runID string) (RunRecord, error) {
	snapshot, err := json.Marshal(definition)
	if err != nil {
		return RunRecord{}, fmt.Errorf("encode data sync job run snapshot: %w", err)
	}
	run, event, err := m.store.CreateRunWithPolicyAndQueuedEvent(ctx, RunRecord{
		ID:                 runID,
		JobID:              definition.ID,
		JobRevision:        definition.Revision,
		Trigger:            trigger,
		Status:             RunStatusQueued,
		ParentRunID:        parentRunID,
		Attempt:            attempt,
		DefinitionSnapshot: snapshot,
		SourceFingerprint:  definition.Source.Fingerprint,
		TargetFingerprint:  definition.Target.Fingerprint,
	}, definition.ConcurrencyPolicy, m.nowMillis())
	if err != nil {
		return RunRecord{}, err
	}
	m.notifyRunEvent(event)
	return run, nil
}
