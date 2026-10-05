package syncjob

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *Store) ClaimRun(ctx context.Context, id string, nowMillis int64) (RunRecord, bool, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, false, err
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	ownerToken := uuid.NewString()
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs AS candidate SET
		status = ?, started_at = CASE WHEN started_at = 0 THEN ? ELSE started_at END,
		heartbeat_at = ?, owner_token = ?, updated_at = ?
		WHERE id = ? AND status = ? AND EXISTS (
			SELECT 1 FROM data_sync_jobs AS job
			WHERE job.id = candidate.job_id AND job.archived_at = 0 AND (
				json_extract(job.definition_json, '$.lifecycle') = ? OR
				(json_extract(job.definition_json, '$.lifecycle') = ? AND job.enabled = 1)
			)
		) AND NOT EXISTS (
			SELECT 1 FROM data_sync_runs AS active
			WHERE active.job_id = candidate.job_id AND active.id <> candidate.id AND active.status IN (?, ?)
		)`, RunStatusRunning, nowMillis, nowMillis, ownerToken, nowMillis, strings.TrimSpace(id), RunStatusQueued,
		JobLifecycleReady, JobLifecycleEnabled,
		RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return RunRecord{}, false, fmt.Errorf("claim data sync run: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return RunRecord{}, false, fmt.Errorf("read claimed data sync run count: %w", err)
	}
	if affected == 0 {
		return RunRecord{}, false, nil
	}
	run, err := s.GetRun(ctx, id)
	if err != nil {
		return RunRecord{}, false, err
	}
	return run, true, nil
}

func (s *Store) TouchRun(ctx context.Context, id string, nowMillis int64) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_token = '' AND status IN (?, ?)`,
		nowMillis, nowMillis, strings.TrimSpace(id), RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return fmt.Errorf("heartbeat data sync run: %w", err)
	}
	return requireUnownedAffected(result)
}

func (s *Store) TouchRunOwned(ctx context.Context, id, ownerToken string, nowMillis int64) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	if strings.TrimSpace(ownerToken) == "" {
		return ErrRunOwnershipLost
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET heartbeat_at = ?, updated_at = ?
		WHERE id = ? AND owner_token = ? AND status IN (?, ?)`, nowMillis, nowMillis,
		strings.TrimSpace(id), ownerToken, RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return fmt.Errorf("heartbeat owned data sync run: %w", err)
	}
	return requireOwnedAffected(result)
}

func (s *Store) UpdateRunProgress(ctx context.Context, id string, progress RunProgress, nowMillis int64) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	if progress.Current < 0 || progress.Total < 0 || (progress.Total > 0 && progress.Current > progress.Total) {
		return RunRecord{}, errors.New("data sync run progress is outside its valid range")
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET current_item = ?, total_items = ?, table_name = ?, stage = ?,
		message = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_token = '' AND status = ?`,
		progress.Current, progress.Total, strings.TrimSpace(progress.Table), strings.TrimSpace(progress.Stage), progress.Message,
		nowMillis, nowMillis, strings.TrimSpace(id), RunStatusRunning)
	if err != nil {
		return RunRecord{}, fmt.Errorf("update data sync run progress: %w", err)
	}
	if err := requireUnownedAffected(result); err != nil {
		return RunRecord{}, err
	}
	return s.GetRun(ctx, id)
}

func (s *Store) UpdateRunProgressOwned(ctx context.Context, id, ownerToken string, progress RunProgress, nowMillis int64) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	if strings.TrimSpace(ownerToken) == "" {
		return RunRecord{}, ErrRunOwnershipLost
	}
	if progress.Current < 0 || progress.Total < 0 || (progress.Total > 0 && progress.Current > progress.Total) {
		return RunRecord{}, errors.New("data sync run progress is outside its valid range")
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET current_item = ?, total_items = ?, table_name = ?, stage = ?,
		message = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND owner_token = ? AND status = ?`,
		progress.Current, progress.Total, strings.TrimSpace(progress.Table), strings.TrimSpace(progress.Stage), progress.Message,
		nowMillis, nowMillis, strings.TrimSpace(id), ownerToken, RunStatusRunning)
	if err != nil {
		return RunRecord{}, fmt.Errorf("update owned data sync run progress: %w", err)
	}
	if err := requireOwnedAffected(result); err != nil {
		return RunRecord{}, err
	}
	return s.GetRun(ctx, id)
}

func (s *Store) CompleteRun(ctx context.Context, id string, status RunStatus, outcome ExecutionOutcome, message string, nowMillis int64) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	message, nowMillis, resumable, err := normalizeTerminalRunCompletion(status, outcome, message, nowMillis)
	if err != nil {
		return RunRecord{}, err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET status = ?, finished_at = ?, heartbeat_at = ?, owner_token = '',
		rows_inserted = ?, rows_updated = ?, rows_deleted = ?, rows_failed = ?, message = ?, resumable = ?, updated_at = ?
		WHERE id = ? AND owner_token = '' AND status IN (?, ?)`, status, nowMillis, nowMillis, outcome.RowsInserted, outcome.RowsUpdated,
		outcome.RowsDeleted, outcome.RowsFailed, message, boolInt(resumable), nowMillis, strings.TrimSpace(id),
		RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return RunRecord{}, fmt.Errorf("complete data sync run: %w", err)
	}
	if err := requireUnownedAffected(result); err != nil {
		return RunRecord{}, err
	}
	return s.GetRun(ctx, id)
}

func (s *Store) CompleteRunOwned(ctx context.Context, id, ownerToken string, status RunStatus, outcome ExecutionOutcome, message string, nowMillis int64) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	if strings.TrimSpace(ownerToken) == "" {
		return RunRecord{}, ErrRunOwnershipLost
	}
	message, nowMillis, resumable, err := normalizeTerminalRunCompletion(status, outcome, message, nowMillis)
	if err != nil {
		return RunRecord{}, err
	}
	return completeRunOwned(ctx, s.db, id, ownerToken, status, outcome, message, nowMillis, resumable)
}

func (s *Store) CompleteRunOwnedWithTerminalEvent(ctx context.Context, id, ownerToken string, status RunStatus, outcome ExecutionOutcome, message string, nowMillis int64) (RunRecord, RunEvent, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	if strings.TrimSpace(ownerToken) == "" {
		return RunRecord{}, RunEvent{}, ErrRunOwnershipLost
	}
	message, nowMillis, resumable, err := normalizeTerminalRunCompletion(status, outcome, message, nowMillis)
	if err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RunRecord{}, RunEvent{}, fmt.Errorf("begin atomic data sync run completion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	completed, err := completeRunOwned(ctx, tx, id, ownerToken, status, outcome, message, nowMillis, resumable)
	if err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	event, err := appendRunEvent(ctx, tx, RunEvent{
		RunID: completed.ID, JobID: completed.JobID, Type: terminalEventTypeForStatus(status), Status: completed.Status,
		Current: completed.Current, Total: completed.Total, Table: completed.Table, Stage: completed.Stage,
		Message: completed.Message, CreatedAt: nowMillis,
	})
	if err != nil {
		return RunRecord{}, RunEvent{}, fmt.Errorf("append terminal data sync run event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return RunRecord{}, RunEvent{}, fmt.Errorf("commit atomic data sync run completion: %w", err)
	}
	return completed, event, nil
}

func completeRunOwned(ctx context.Context, executor contextExecerQueryRower, id, ownerToken string, status RunStatus, outcome ExecutionOutcome, message string, nowMillis int64, resumable bool) (RunRecord, error) {
	result, err := executor.ExecContext(ctx, `UPDATE data_sync_runs SET status = ?, finished_at = ?, heartbeat_at = ?, owner_token = '',
		rows_inserted = ?, rows_updated = ?, rows_deleted = ?, rows_failed = ?, message = ?, resumable = ?, updated_at = ?
		WHERE id = ? AND owner_token = ? AND status IN (?, ?)`, status, nowMillis, nowMillis, outcome.RowsInserted, outcome.RowsUpdated,
		outcome.RowsDeleted, outcome.RowsFailed, message, boolInt(resumable), nowMillis, strings.TrimSpace(id), ownerToken,
		RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return RunRecord{}, fmt.Errorf("complete owned data sync run: %w", err)
	}
	if err := requireOwnedAffected(result); err != nil {
		return RunRecord{}, err
	}
	return scanRun(executor.QueryRowContext(ctx, runSelect+` WHERE id = ?`, strings.TrimSpace(id)))
}

func normalizeTerminalRunCompletion(status RunStatus, outcome ExecutionOutcome, message string, nowMillis int64) (string, int64, bool, error) {
	switch status {
	case RunStatusSucceeded, RunStatusPartial, RunStatusFailed, RunStatusCanceled, RunStatusInterrupted:
	default:
		return "", 0, false, fmt.Errorf("unsupported terminal data sync run status %q", status)
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	if message == "" {
		message = outcome.Message
	}
	return message, nowMillis, outcome.Resumable || status == RunStatusInterrupted, nil
}

func terminalEventTypeForStatus(status RunStatus) RunEventType {
	switch status {
	case RunStatusSucceeded:
		return RunEventSucceeded
	case RunStatusPartial:
		return RunEventPartial
	case RunStatusCanceled:
		return RunEventCanceled
	case RunStatusInterrupted:
		return RunEventInterrupted
	default:
		return RunEventFailed
	}
}

func (s *Store) RequestCancelRun(ctx context.Context, id string, nowMillis int64) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET
		status = CASE WHEN status IN (?, ?) THEN ? ELSE ? END,
		finished_at = CASE WHEN status IN (?, ?) THEN ? ELSE finished_at END,
		message = CASE WHEN status IN (?, ?) THEN 'canceled before execution' ELSE message END,
		owner_token = CASE WHEN status IN (?, ?) THEN '' ELSE owner_token END,
		updated_at = ? WHERE id = ? AND status IN (?, ?, ?, ?)`,
		RunStatusQueued, RunStatusPaused, RunStatusCanceled, RunStatusCancelling,
		RunStatusQueued, RunStatusPaused, nowMillis,
		RunStatusQueued, RunStatusPaused,
		RunStatusQueued, RunStatusPaused,
		nowMillis, strings.TrimSpace(id), RunStatusQueued, RunStatusRunning, RunStatusCancelling, RunStatusPaused)
	if err != nil {
		return RunRecord{}, fmt.Errorf("request data sync run cancellation: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return RunRecord{}, fmt.Errorf("read canceled data sync run count: %w", err)
	}
	if affected == 0 {
		if _, getErr := s.GetRun(ctx, id); getErr != nil {
			return RunRecord{}, getErr
		}
		return RunRecord{}, ErrRunNotCancelable
	}
	return s.GetRun(ctx, id)
}

func (s *Store) InterruptStaleRuns(ctx context.Context, cutoffMillis, nowMillis int64) ([]RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	if cutoffMillis <= 0 {
		cutoffMillis = nowMillis
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin stale data sync run recovery: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, runSelect+` WHERE status IN (?, ?) AND (heartbeat_at = 0 OR heartbeat_at <= ?) ORDER BY updated_at, id`,
		RunStatusRunning, RunStatusCancelling, cutoffMillis)
	if err != nil {
		return nil, fmt.Errorf("list stale data sync runs: %w", err)
	}
	candidates := make([]RunRecord, 0)
	for rows.Next() {
		run, scanErr := scanRun(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		candidates = append(candidates, run)
	}
	if err := rows.Close(); err != nil {
		return nil, fmt.Errorf("close stale data sync run rows: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate stale data sync runs: %w", err)
	}
	recovered := make([]RunRecord, 0, len(candidates))
	for _, candidate := range candidates {
		status := RunStatusInterrupted
		message := "interrupted after manager restart"
		resumable := 1
		if candidate.Status == RunStatusCancelling {
			status = RunStatusCanceled
			message = "canceled after manager restart"
			resumable = 0
		}
		result, updateErr := tx.ExecContext(ctx, `UPDATE data_sync_runs SET status = ?, finished_at = ?, heartbeat_at = ?, owner_token = '',
			message = CASE WHEN message = '' THEN ? ELSE message END,
			resumable = ?, updated_at = ? WHERE id = ? AND status = ? AND owner_token = ? AND (heartbeat_at = 0 OR heartbeat_at <= ?)`,
			status, nowMillis, nowMillis, message, resumable, nowMillis, candidate.ID, candidate.Status, candidate.OwnerToken, cutoffMillis)
		if updateErr != nil {
			return nil, fmt.Errorf("recover stale data sync run %s: %w", candidate.ID, updateErr)
		}
		affected, affectedErr := result.RowsAffected()
		if affectedErr != nil {
			return nil, fmt.Errorf("read recovered data sync run count: %w", affectedErr)
		}
		if affected == 0 {
			continue
		}
		run, getErr := scanRun(tx.QueryRowContext(ctx, runSelect+` WHERE id = ?`, candidate.ID))
		if getErr != nil {
			return nil, getErr
		}
		recovered = append(recovered, run)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit stale data sync run recovery: %w", err)
	}
	return recovered, nil
}
