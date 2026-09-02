package app

import (
	"errors"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/importjob"
)

const importJobProgressPersistInterval = 500 * time.Millisecond

type managedImportJobStart struct {
	ID                  string
	Kind                importjob.Kind
	Stage               string
	SourcePath          string
	SourceIdentityToken string
	SourceContentSHA256 string
	SourceBytesTotal    int64
	ByteProgressKind    string
	TargetFingerprint   string
	ConnectionID        string
	DatabaseName        string
	TableName           string
	OptionsHash         string
	TableImportOptions  *importjob.TableImportOptions
	ParentJobID         string
	RecoveryAction      string
	Current             int64
	Succeeded           int64
	Skipped             int64
	Failed              int64
	BytesRead           int64
	Checkpoint          importjob.Checkpoint
}

type managedImportJobProgress struct {
	Stage               string
	Current             int64
	Total               int64
	Succeeded           int64
	Skipped             int64
	Failed              int64
	BytesRead           int64
	SourceBytesTotal    int64
	ByteProgressKind    string
	SourceContentSHA256 string
	Checkpoint          importjob.Checkpoint
	OutcomeUnknown      bool
	ForcePersist        bool
}

type managedImportJobFinish struct {
	Status                        importjob.Status
	Message                       string
	OutcomeUnknown                bool
	ErrorArtifactID               string
	ErrorArtifactCount            int64
	ErrorArtifactBytes            int64
	ErrorArtifactOmittedCount     int64
	ErrorArtifactTruncated        bool
	ErrorArtifactRetryableCount   int64
	ErrorArtifactUnretryableCount int64
	ErrorArtifactScopeKnown       bool
	ErrorArtifactMaxRows          int64
	ErrorArtifactMaxBytes         int64
}

type managedImportJob struct {
	mu            sync.Mutex
	store         *importjob.Store
	job           importjob.Job
	lastPersisted time.Time
}

func isImportJobTerminalStatus(status importjob.Status) bool {
	switch status {
	case importjob.StatusCompleted, importjob.StatusPartial, importjob.StatusFailed,
		importjob.StatusCancelled, importjob.StatusUnknown, importjob.StatusInterrupted:
		return true
	default:
		return false
	}
}

func (a *App) beginManagedImportJob(start managedImportJobStart) (*managedImportJob, error) {
	store, err := a.ensureImportJobStore()
	if err != nil {
		return nil, err
	}
	job := importjob.Job{
		ID:                  strings.TrimSpace(start.ID),
		Kind:                start.Kind,
		Status:              importjob.StatusPreparing,
		Stage:               firstNonEmptyString(strings.TrimSpace(start.Stage), "preparing"),
		SourcePath:          strings.TrimSpace(start.SourcePath),
		SourceIdentityToken: strings.TrimSpace(start.SourceIdentityToken),
		SourceContentSHA256: strings.TrimSpace(start.SourceContentSHA256),
		SourceBytesTotal:    max(0, start.SourceBytesTotal),
		ByteProgressKind:    strings.TrimSpace(start.ByteProgressKind),
		TargetFingerprint:   strings.TrimSpace(start.TargetFingerprint),
		ConnectionID:        strings.TrimSpace(start.ConnectionID),
		DatabaseName:        strings.TrimSpace(start.DatabaseName),
		TableName:           strings.TrimSpace(start.TableName),
		OptionsHash:         strings.TrimSpace(start.OptionsHash),
		TableImportOptions:  cloneImportJobTableOptions(start.TableImportOptions),
		ParentJobID:         strings.TrimSpace(start.ParentJobID),
		RecoveryAction:      strings.TrimSpace(start.RecoveryAction),
		Current:             max(0, start.Current),
		Succeeded:           max(0, start.Succeeded),
		Skipped:             max(0, start.Skipped),
		Failed:              max(0, start.Failed),
		BytesRead:           max(0, start.BytesRead),
		Checkpoint:          start.Checkpoint,
	}
	created, err := store.Put(job)
	if err != nil {
		return nil, err
	}
	managed := &managedImportJob{store: store, job: created, lastPersisted: time.Now()}
	if _, err := a.bindImportTaskLifecycle(created.ID, created.Kind, managed); err != nil {
		_ = managed.finish(managedImportJobFinish{Status: importjob.StatusFailed, Message: err.Error()})
		return nil, err
	}
	return managed, nil
}

func (managed *managedImportJob) requestStop() error {
	if managed == nil || managed.store == nil {
		return errors.New("import job lifecycle is unavailable")
	}
	managed.mu.Lock()
	defer managed.mu.Unlock()
	if isImportJobTerminalStatus(managed.job.Status) || managed.job.Status == importjob.StatusStopping {
		return nil
	}
	managed.job.Status = importjob.StatusStopping
	managed.job.Stage = string(importjob.StatusStopping)
	managed.job.Resumable = false
	updated, err := managed.store.Put(managed.job)
	if err != nil {
		return err
	}
	managed.job = updated
	managed.lastPersisted = time.Now()
	return nil
}

func (managed *managedImportJob) update(progress managedImportJobProgress) error {
	if managed == nil || managed.store == nil {
		return errors.New("import job lifecycle is unavailable")
	}
	managed.mu.Lock()
	defer managed.mu.Unlock()

	if isImportJobTerminalStatus(managed.job.Status) {
		return nil
	}
	stopping := managed.job.Status == importjob.StatusStopping
	if !stopping {
		managed.job.Status = importjob.StatusRunning
	}
	if stage := strings.TrimSpace(progress.Stage); stage != "" && !stopping {
		managed.job.Stage = stage
	}
	managed.job.Current = max(0, progress.Current)
	managed.job.Total = max(0, progress.Total)
	managed.job.Succeeded = max(0, progress.Succeeded)
	managed.job.Skipped = max(0, progress.Skipped)
	managed.job.Failed = max(0, progress.Failed)
	managed.job.BytesRead = max(0, progress.BytesRead)
	if progress.SourceBytesTotal > 0 {
		managed.job.SourceBytesTotal = progress.SourceBytesTotal
	}
	if kind := strings.TrimSpace(progress.ByteProgressKind); kind != "" {
		managed.job.ByteProgressKind = kind
	}
	if digest := strings.TrimSpace(progress.SourceContentSHA256); digest != "" {
		managed.job.SourceContentSHA256 = digest
	}
	managed.job.OutcomeUnknown = managed.job.OutcomeUnknown || progress.OutcomeUnknown
	managed.job.Checkpoint = progress.Checkpoint
	managed.job.Resumable = false

	if !progress.ForcePersist && time.Since(managed.lastPersisted) < importJobProgressPersistInterval {
		return nil
	}
	updated, err := managed.store.Put(managed.job)
	if err != nil {
		return err
	}
	managed.job = updated
	managed.lastPersisted = time.Now()
	return nil
}

func (managed *managedImportJob) finish(finish managedImportJobFinish) error {
	if managed == nil || managed.store == nil {
		return errors.New("import job lifecycle is unavailable")
	}
	managed.mu.Lock()
	defer managed.mu.Unlock()
	if isImportJobTerminalStatus(managed.job.Status) {
		return nil
	}

	outcomeUnknown := managed.job.OutcomeUnknown || finish.OutcomeUnknown
	if outcomeUnknown {
		managed.job.Status = importjob.StatusUnknown
	} else {
		switch finish.Status {
		case importjob.StatusCompleted, importjob.StatusPartial, importjob.StatusFailed,
			importjob.StatusCancelled, importjob.StatusUnknown, importjob.StatusInterrupted:
			managed.job.Status = finish.Status
		default:
			managed.job.Status = importjob.StatusFailed
		}
	}
	managed.job.Stage = string(managed.job.Status)
	managed.job.Message = strings.TrimSpace(finish.Message)
	managed.job.OutcomeUnknown = outcomeUnknown
	managed.job.ErrorArtifactID = strings.TrimSpace(finish.ErrorArtifactID)
	managed.job.ErrorArtifactCount = max(0, finish.ErrorArtifactCount)
	managed.job.ErrorArtifactBytes = max(0, finish.ErrorArtifactBytes)
	managed.job.ErrorArtifactOmittedCount = max(0, finish.ErrorArtifactOmittedCount)
	managed.job.ErrorArtifactTruncated = finish.ErrorArtifactTruncated
	managed.job.ErrorArtifactRetryableCount = max(0, finish.ErrorArtifactRetryableCount)
	managed.job.ErrorArtifactUnretryableCount = max(0, finish.ErrorArtifactUnretryableCount)
	managed.job.ErrorArtifactScopeKnown = finish.ErrorArtifactScopeKnown
	managed.job.ErrorArtifactMaxRows = max(0, finish.ErrorArtifactMaxRows)
	managed.job.ErrorArtifactMaxBytes = max(0, finish.ErrorArtifactMaxBytes)
	managed.job.Resumable = false
	updated, err := managed.store.Put(managed.job)
	if err != nil {
		return err
	}
	managed.job = updated
	managed.lastPersisted = time.Now()
	return nil
}

func (managed *managedImportJob) snapshot() importjob.Job {
	if managed == nil {
		return importjob.Job{}
	}
	managed.mu.Lock()
	defer managed.mu.Unlock()
	return managed.job
}

func managedImportJobFinishFromResult(result connection.QueryResult) managedImportJobFinish {
	finish := managedImportJobFinish{
		Status:  importjob.StatusFailed,
		Message: strings.TrimSpace(result.Message),
	}
	payload, _ := result.Data.(map[string]interface{})
	if payload != nil {
		finish.OutcomeUnknown, _ = payload["outcomeUnknown"].(bool)
		finish.ErrorArtifactID, _ = payload["errorArtifactId"].(string)
		finish.ErrorArtifactCount = importJobPayloadInt64(payload, "errorArtifactCount")
		finish.ErrorArtifactBytes = importJobPayloadInt64(payload, "errorArtifactBytes")
		finish.ErrorArtifactOmittedCount = importJobPayloadInt64(payload, "errorArtifactOmittedCount")
		finish.ErrorArtifactTruncated, _ = payload["errorArtifactTruncated"].(bool)
		finish.ErrorArtifactRetryableCount = importJobPayloadInt64(payload, "errorArtifactRetryableCount")
		finish.ErrorArtifactUnretryableCount = importJobPayloadInt64(payload, "errorArtifactUnretryableCount")
		finish.ErrorArtifactScopeKnown, _ = payload["errorArtifactScopeKnown"].(bool)
		finish.ErrorArtifactMaxRows = importJobPayloadInt64(payload, "errorArtifactMaxRows")
		finish.ErrorArtifactMaxBytes = importJobPayloadInt64(payload, "errorArtifactMaxBytes")
		if finish.OutcomeUnknown {
			finish.Status = importjob.StatusUnknown
			return finish
		}
		if cancelled, _ := payload["cancelled"].(bool); cancelled {
			finish.Status = importjob.StatusCancelled
			return finish
		}
		succeeded := importJobPayloadInt64(payload, "success")
		if executed := importJobPayloadInt64(payload, "executed"); executed > succeeded {
			succeeded = executed
		}
		failed := importJobPayloadInt64(payload, "failed")
		switch outcome, _ := payload["outcome"].(string); strings.ToLower(strings.TrimSpace(outcome)) {
		case "completed":
			if failed > 0 {
				finish.Status = importjob.StatusPartial
			} else {
				finish.Status = importjob.StatusCompleted
			}
			return finish
		case "partial":
			finish.Status = importjob.StatusPartial
			return finish
		case "cancelled":
			finish.Status = importjob.StatusCancelled
			return finish
		case "failed", "stopped":
			if succeeded > 0 {
				finish.Status = importjob.StatusPartial
			} else {
				finish.Status = importjob.StatusFailed
			}
			return finish
		}
		if !result.Success && succeeded > 0 {
			finish.Status = importjob.StatusPartial
			return finish
		}
	}
	if failed := importJobPayloadInt64(payload, "failed"); failed > 0 {
		if result.Success || importJobPayloadInt64(payload, "success") > 0 || importJobPayloadInt64(payload, "executed") > 0 {
			finish.Status = importjob.StatusPartial
		}
		return finish
	}
	if !result.Success {
		return finish
	}
	finish.Status = importjob.StatusCompleted
	return finish
}

func importJobPayloadInt64(payload map[string]interface{}, key string) int64 {
	if payload == nil {
		return 0
	}
	switch value := payload[key].(type) {
	case int:
		return int64(value)
	case int64:
		return value
	case float64:
		return int64(value)
	default:
		return 0
	}
}
