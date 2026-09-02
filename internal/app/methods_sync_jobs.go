package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/syncjob"
	"github.com/google/uuid"
)

func (a *App) DataSyncJobList() connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	jobs, err := manager.ListJobs(context.Background())
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range jobs {
		jobs[index] = publicDataSyncJobDefinition(jobs[index])
	}
	return connection.QueryResult{Success: true, Data: jobs}
}

func (a *App) DataSyncJobGet(jobID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := manager.GetJob(context.Background(), strings.TrimSpace(jobID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: publicDataSyncJobDefinition(job)}
}

// DataSyncJobPreflight validates the exact versioned definition without
// mutating it. Endpoint fingerprints remain backend-only; callers submit the
// returned public definition and Save resolves/validates endpoints again.
func (a *App) DataSyncJobPreflight(definition syncjob.JobDefinition) connection.QueryResult {
	result := a.preflightDataSyncJob(definition, time.Now())
	message := "data sync job preflight passed"
	if !result.Success {
		message = "data sync job preflight is blocked"
	}
	return connection.QueryResult{Success: result.Success, Message: message, Data: publicDataSyncJobPreflight(result)}
}

// DataSyncJobApprovalBegin creates a server-held countdown challenge after a
// successful preflight. The challenge contains no approval evidence.
func (a *App) DataSyncJobApprovalBegin(definition syncjob.JobDefinition) connection.QueryResult {
	now := time.Now()
	preflight := a.preflightDataSyncJob(definition, now)
	if !preflight.Success {
		return connection.QueryResult{Success: false, Message: "data sync job preflight is blocked", Data: publicDataSyncJobPreflight(preflight)}
	}
	if !preflight.ApprovalRequired {
		return connection.QueryResult{Success: true, Message: "production approval is not required", Data: DataSyncJobApprovalChallengeResult{}}
	}
	challenge, notBefore, expiresAt, err := a.beginDataSyncJobApproval(preflight.Definition, preflight.TargetFingerprint, now)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "production approval countdown started", Data: DataSyncJobApprovalChallengeResult{
		Challenge: challenge,
		NotBefore: notBefore.UnixMilli(),
		ExpiresAt: expiresAt.UnixMilli(),
	}}
}

// DataSyncJobApprove consumes a completed backend countdown challenge and
// issues a short-lived one-time token bound to the exact approval scope.
func (a *App) DataSyncJobApprove(definition syncjob.JobDefinition, challenge string) connection.QueryResult {
	now := time.Now()
	preflight := a.preflightDataSyncJob(definition, now)
	if !preflight.Success {
		return connection.QueryResult{Success: false, Message: "data sync job preflight is blocked", Data: publicDataSyncJobPreflight(preflight)}
	}
	if !preflight.ApprovalRequired {
		return connection.QueryResult{Success: true, Message: "production approval is not required", Data: DataSyncJobApprovalResult{}}
	}
	token, _, err := a.confirmDataSyncJobApproval(challenge, preflight.Definition, preflight.TargetFingerprint, now)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	ttl := a.dataSyncJobApprovalTokenTTL
	if ttl <= 0 {
		ttl = defaultDataSyncJobApprovalTokenTTL
	}
	return connection.QueryResult{
		Success: true,
		Message: "production approval token issued",
		Data: DataSyncJobApprovalResult{
			Token:     token,
			ExpiresAt: now.Add(ttl).UnixMilli(),
		},
	}
}

func (a *App) DataSyncJobSave(definition syncjob.JobDefinition, approvalToken string) connection.QueryResult {
	definition = syncjob.NormalizeDefinition(definition)
	// Caller-provided approval structs are untrusted. A production approval can
	// only come from consuming a server-held one-time token or from the exact
	// existing stored revision below.
	definition.Approval = nil
	if err := syncjob.ValidatePersistableDefinition(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := a.validateDataSyncJobDraftTransition(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if definition.Lifecycle == syncjob.JobLifecycleDraft || definition.Lifecycle == syncjob.JobLifecyclePaused || definition.Lifecycle == syncjob.JobLifecycleArchived {
		enriched, err := a.enrichDraftDataSyncJobEndpoints(definition)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		enriched.Approval = nil
		manager, err := a.ensureDataSyncJobManager()
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		saved, err := manager.PutJob(context.Background(), enriched)
		if err != nil {
			return connection.QueryResult{Success: false, Message: err.Error()}
		}
		return connection.QueryResult{Success: true, Message: "data sync inactive job saved", Data: publicDataSyncJobDefinition(saved)}
	}
	preflight := a.preflightDataSyncJob(definition, time.Now())
	if !preflight.Success {
		return connection.QueryResult{Success: false, Message: "data sync job preflight is blocked", Data: publicDataSyncJobPreflight(preflight)}
	}
	definition = preflight.Definition
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if preflight.ApprovalRequired {
		if strings.TrimSpace(approvalToken) != "" {
			approval, err := a.consumeDataSyncJobApproval(approvalToken, definition, preflight.TargetFingerprint, time.Now())
			if err != nil {
				return connection.QueryResult{Success: false, Message: err.Error()}
			}
			// The approval endpoint can authorize a new task before it has a
			// persistent ID. Allocate that server-owned identity before storage
			// and rebind the already-consumed approval to it; subsequent changes
			// to ID/lifecycle/schedule then invalidate the approval normally.
			if definition.ID == "" {
				definition.ID = "sync-job-" + uuid.NewString()
				approval.DefinitionHash, err = dataSyncJobApprovalScopeHash(definition)
				if err != nil {
					return connection.QueryResult{Success: false, Message: err.Error()}
				}
			}
			definition.Approval = &approval
		} else {
			stored, loadErr := manager.GetJob(context.Background(), definition.ID)
			if loadErr != nil || stored.Revision != definition.Revision || stored.Approval == nil {
				return connection.QueryResult{Success: false, Message: "data sync production approval token is required"}
			}
			definition.Approval = stored.Approval
			if approvalErr := a.validateStoredDataSyncJobApproval(definition, preflight.TargetFingerprint); approvalErr != nil {
				return connection.QueryResult{Success: false, Message: approvalErr.Error()}
			}
		}
	} else {
		definition.Approval = nil
	}
	saved, err := manager.PutJob(context.Background(), definition)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync job saved", Data: publicDataSyncJobDefinition(saved)}
}

func (a *App) validateDataSyncJobDraftTransition(definition syncjob.JobDefinition) error {
	if definition.Lifecycle != syncjob.JobLifecycleDraft || strings.TrimSpace(definition.ID) == "" {
		return nil
	}
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return err
	}
	stored, err := manager.GetJob(context.Background(), definition.ID)
	if errors.Is(err, syncjob.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if stored.Lifecycle != syncjob.JobLifecycleDraft {
		return fmt.Errorf("data sync job lifecycle cannot transition from %s back to draft", stored.Lifecycle)
	}
	return nil
}

func (a *App) enrichDraftDataSyncJobEndpoints(definition syncjob.JobDefinition) (syncjob.JobDefinition, error) {
	if definition.Source.ConnectionID != "" {
		source, err := a.resolveDataSyncJobEndpoint(definition.Source.ConnectionID, definition.Source.Database, definition.Source.Schema)
		if err != nil {
			return syncjob.JobDefinition{}, fmt.Errorf("resolve draft source endpoint: %w", err)
		}
		definition.Source.ConnectionName = source.View.Name
		definition.Source.ConnectionType = source.Config.Type
		definition.Source.Database = source.Database
		definition.Source.Fingerprint = source.Fingerprint
	}
	if definition.Target.ConnectionID != "" {
		target, err := a.resolveDataSyncJobEndpoint(definition.Target.ConnectionID, definition.Target.Database, definition.Target.Schema)
		if err != nil {
			return syncjob.JobDefinition{}, fmt.Errorf("resolve draft target endpoint: %w", err)
		}
		definition.Target.ConnectionName = target.View.Name
		definition.Target.ConnectionType = target.Config.Type
		definition.Target.Database = target.Database
		definition.Target.Fingerprint = target.Fingerprint
	}
	return definition, nil
}

func (a *App) DataSyncJobDelete(jobID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	// 删除即永久移除任务及其运行记录/检查点/错误行（区别于"归档"生命周期）。
	if err := manager.PurgeJob(context.Background(), strings.TrimSpace(jobID)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync job deleted"}
}

func (a *App) DataSyncSchedulePreview(definition syncjob.JobDefinition, count int) connection.QueryResult {
	if err := syncjob.ValidateDefinition(definition); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: previewDataSyncJobSchedule(syncjob.NormalizeDefinition(definition), time.Now(), count)}
}

func (a *App) DataSyncRunStart(jobID string, expectedRevision int64, approvalToken string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	job, err := manager.GetJob(context.Background(), strings.TrimSpace(jobID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if expectedRevision > 0 && job.Revision != expectedRevision {
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("data sync job revision changed: expected %d, current %d", expectedRevision, job.Revision)}
	}
	target, err := a.resolveDataSyncJobEndpoint(job.Target.ConnectionID, job.Target.Database, job.Target.Schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if dataSyncJobRequiresExecutionApproval(job, target) {
		if strings.TrimSpace(approvalToken) != "" {
			approval, consumeErr := a.consumeDataSyncJobApproval(approvalToken, job, target.Fingerprint, time.Now())
			if consumeErr != nil {
				return connection.QueryResult{Success: false, Message: consumeErr.Error()}
			}
			job.Approval = &approval
			saved, saveErr := manager.PutJob(context.Background(), job)
			if saveErr != nil {
				return connection.QueryResult{Success: false, Message: saveErr.Error()}
			}
			job = saved
		} else if approvalErr := a.validateStoredDataSyncJobApproval(job, target.Fingerprint); approvalErr != nil {
			return connection.QueryResult{Success: false, Message: approvalErr.Error()}
		}
	}
	run, err := manager.StartRun(context.Background(), job.ID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync run queued", Data: publicDataSyncRun(run)}
}

func (a *App) DataSyncRunGet(runID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	run, err := manager.GetRun(context.Background(), strings.TrimSpace(runID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: publicDataSyncRun(run)}
}

func (a *App) DataSyncRunCancel(runID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := manager.CancelRun(context.Background(), strings.TrimSpace(runID)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync run cancellation requested"}
}

func (a *App) DataSyncRunResume(runID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	run, err := manager.ResumeRun(context.Background(), strings.TrimSpace(runID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync run queued for resume", Data: publicDataSyncRun(run)}
}

func (a *App) DataSyncRunRetry(runID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	run, err := manager.RetryRun(context.Background(), strings.TrimSpace(runID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync run queued for retry", Data: publicDataSyncRun(run)}
}

func (a *App) DataSyncRunList(jobID string, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runs, err := manager.ListRuns(context.Background(), strings.TrimSpace(jobID), limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range runs {
		runs[index] = publicDataSyncRun(runs[index])
	}
	return connection.QueryResult{Success: true, Data: runs}
}

// DataSyncRunPage returns terminal and active run history through a stable
// keyset cursor. The cursor is opaque to callers apart from being echoed into
// the next request.
func (a *App) DataSyncRunPage(jobID string, beforeCreatedAt int64, beforeID string, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	var cursor *syncjob.RunCursor
	if beforeCreatedAt != 0 || strings.TrimSpace(beforeID) != "" {
		if beforeCreatedAt <= 0 || strings.TrimSpace(beforeID) == "" {
			return connection.QueryResult{Success: false, Message: "data sync run cursor requires createdAt and id"}
		}
		cursor = &syncjob.RunCursor{CreatedAt: beforeCreatedAt, ID: strings.TrimSpace(beforeID)}
	}
	if limit != 10 && limit != 50 && limit != 100 {
		return connection.QueryResult{Success: false, Message: "data sync run page size must be 10, 50, or 100"}
	}
	page, err := manager.ListRunsPage(context.Background(), strings.TrimSpace(jobID), cursor, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: publicDataSyncRunPage(page)}
}

func (a *App) DataSyncRunDelete(runID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := manager.DeleteRun(context.Background(), strings.TrimSpace(runID)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync terminal run deleted"}
}

func (a *App) DataSyncRunClearTerminal(jobID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	deleted, err := manager.ClearTerminalRuns(context.Background(), strings.TrimSpace(jobID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync terminal run history cleared", Data: map[string]int{"deleted": deleted}}
}

func (a *App) DataSyncRunEventList(runID string, afterSequence int64, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	events, err := manager.ListRunEvents(context.Background(), strings.TrimSpace(runID), afterSequence, limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range events {
		events[index] = publicDataSyncRunEvent(events[index])
	}
	return connection.QueryResult{Success: true, Data: events}
}

func (a *App) DataSyncErrorRowList(runID string, status string, limit int) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	rows, err := manager.ListErrorRows(context.Background(), strings.TrimSpace(runID), syncjob.ErrorRowStatus(strings.TrimSpace(status)), limit)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for index := range rows {
		rows[index] = publicDataSyncErrorRow(rows[index])
	}
	return connection.QueryResult{Success: true, Data: rows}
}

func (a *App) DataSyncErrorRowGet(errorRowID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	row, err := manager.GetErrorRow(context.Background(), strings.TrimSpace(errorRowID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: row}
}

func (a *App) DataSyncErrorRowRetry(errorRowID string, expectedJobRevision int64, approvalToken string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	row, err := a.retryDataSyncErrorRow(context.Background(), manager, errorRowID, expectedJobRevision, approvalToken)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync error row replayed", Data: publicDataSyncErrorRow(row)}
}

func (a *App) DataSyncErrorRowDiscard(errorRowID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := manager.DiscardErrorRow(context.Background(), strings.TrimSpace(errorRowID)); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync error row discarded"}
}

func (a *App) DataSyncCheckpointGet(jobID string) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	checkpoint, err := manager.GetCheckpoint(context.Background(), strings.TrimSpace(jobID))
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	checkpoint.SchemaHash = ""
	return connection.QueryResult{Success: true, Data: checkpoint}
}

func (a *App) DataSyncCheckpointReset(jobID string, expectedJobRevision int64) connection.QueryResult {
	manager, err := a.ensureDataSyncJobManager()
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	jobID = strings.TrimSpace(jobID)
	if expectedJobRevision <= 0 {
		return connection.QueryResult{Success: false, Message: "data sync checkpoint reset requires the current task revision"}
	}
	job, err := manager.GetJob(context.Background(), jobID)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if job.Revision != expectedJobRevision {
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("data sync job revision changed: expected %d, current %d", expectedJobRevision, job.Revision)}
	}
	if job.Lifecycle != syncjob.JobLifecyclePaused {
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("data sync checkpoint reset requires a paused task, got %s", job.Lifecycle)}
	}
	if _, err := manager.GetCheckpoint(context.Background(), jobID); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runs, err := manager.ListRuns(context.Background(), jobID, 500)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	for _, run := range runs {
		switch run.Status {
		case syncjob.RunStatusQueued, syncjob.RunStatusRunning, syncjob.RunStatusCancelling:
			return connection.QueryResult{Success: false, Message: fmt.Sprintf("data sync checkpoint reset requires no active run; run %s is %s", run.ID, run.Status)}
		}
	}

	// Persisting the paused definition with no approval both invalidates any
	// prior production authorization and advances the optimistic revision. A
	// concurrent lifecycle edit therefore cannot race the destructive reset.
	job.Approval = nil
	saved, err := manager.PutJob(context.Background(), job)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	a.invalidateDataSyncJobApprovals(jobID)
	if err := manager.ResetCheckpoint(context.Background(), jobID); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Message: "data sync checkpoint reset", Data: publicDataSyncJobDefinition(saved)}
}
