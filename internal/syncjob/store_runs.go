package syncjob

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *Store) CreateRun(ctx context.Context, run RunRecord) (RunRecord, error) {
	return s.createRun(ctx, run, false)
}

func (s *Store) CreateRunWithPolicy(ctx context.Context, run RunRecord, policy string) (RunRecord, error) {
	forbidPending, err := forbidPendingForPolicy(policy)
	if err != nil {
		return RunRecord{}, err
	}
	return s.createRun(ctx, run, forbidPending)
}

func forbidPendingForPolicy(policy string) (bool, error) {
	policy = strings.TrimSpace(policy)
	if policy == "" {
		policy = "forbid"
	}
	switch policy {
	case "queue":
		return false, nil
	case "forbid":
		return true, nil
	default:
		return false, fmt.Errorf("unsupported data sync concurrency policy %q", policy)
	}
}

func (s *Store) createRun(ctx context.Context, run RunRecord, forbidPending bool) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	run, err := prepareRunForInsert(run)
	if err != nil {
		return RunRecord{}, err
	}
	if err := insertRun(ctx, s.db, run, forbidPending); err != nil {
		return RunRecord{}, err
	}
	return run, nil
}

func (s *Store) CreateRunWithPolicyAndQueuedEvent(ctx context.Context, run RunRecord, policy string, eventCreatedAt int64) (RunRecord, RunEvent, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	forbidPending, err := forbidPendingForPolicy(policy)
	if err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	run, err = prepareRunForInsert(run)
	if err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	if run.Status != RunStatusQueued {
		return RunRecord{}, RunEvent{}, errors.New("atomic data sync run creation requires queued status")
	}
	if eventCreatedAt <= 0 {
		eventCreatedAt = time.Now().UnixMilli()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RunRecord{}, RunEvent{}, fmt.Errorf("begin atomic data sync run creation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := insertRun(ctx, tx, run, forbidPending); err != nil {
		return RunRecord{}, RunEvent{}, err
	}
	event := RunEvent{
		RunID: run.ID, JobID: run.JobID, Sequence: 1, Type: RunEventQueued, Status: RunStatusQueued,
		Message: "queued", CreatedAt: eventCreatedAt,
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO data_sync_run_events(
		run_id, sequence, job_id, event_type, status, current_item, total_items, table_name, stage, message, payload_json, created_at
	) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`, event.RunID, event.Sequence, event.JobID, event.Type,
		event.Status, event.Current, event.Total, event.Table, event.Stage, event.Message, event.CreatedAt); err != nil {
		return RunRecord{}, RunEvent{}, fmt.Errorf("create queued data sync run event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return RunRecord{}, RunEvent{}, fmt.Errorf("commit atomic data sync run creation: %w", err)
	}
	return run, event, nil
}

func prepareRunForInsert(run RunRecord) (RunRecord, error) {
	now := time.Now().UnixMilli()
	if strings.TrimSpace(run.ID) == "" {
		run.ID = "sync-run-" + uuid.NewString()
	}
	if run.Status == "" {
		run.Status = RunStatusQueued
	}
	if run.Trigger == "" {
		run.Trigger = RunTriggerManual
	}
	if run.Attempt < 1 {
		run.Attempt = 1
	}
	if run.QueuedAt == 0 {
		run.QueuedAt = now
	}
	if len(run.DefinitionSnapshot) == 0 {
		return RunRecord{}, errors.New("data sync run definition snapshot is required")
	}
	run.CreatedAt = now
	run.UpdatedAt = now
	return run, nil
}

type contextExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

type contextQueryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

type contextExecerQueryRower interface {
	contextExecer
	contextQueryRower
}

func insertRun(ctx context.Context, executor contextExecer, run RunRecord, forbidPending bool) error {
	insertPrefix := `INSERT INTO data_sync_runs(
		id, job_id, owner_token, job_revision, trigger_kind, status, parent_run_id, attempt, queued_at, started_at, finished_at, heartbeat_at,
		current_item, total_items, table_name, stage, rows_inserted, rows_updated,
		rows_deleted, rows_failed, message, resumable, definition_snapshot, source_fingerprint, target_fingerprint, created_at, updated_at
	) `
	values := `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`
	query := insertPrefix + `VALUES(` + values + `)`
	args := []any{
		run.ID, run.JobID, run.OwnerToken, run.JobRevision, run.Trigger, run.Status, run.ParentRunID, run.Attempt, run.QueuedAt, run.StartedAt, run.FinishedAt, run.HeartbeatAt,
		run.Current, run.Total, run.Table, run.Stage, run.RowsInserted, run.RowsUpdated,
		run.RowsDeleted, run.RowsFailed, run.Message, boolInt(run.Resumable), []byte(run.DefinitionSnapshot), run.SourceFingerprint, run.TargetFingerprint, run.CreatedAt, run.UpdatedAt,
	}
	if forbidPending {
		query = insertPrefix + `SELECT ` + values + ` WHERE NOT EXISTS (
			SELECT 1 FROM data_sync_runs WHERE job_id = ? AND status IN (?, ?, ?, ?)
		)`
		args = append(args, run.JobID, RunStatusQueued, RunStatusRunning, RunStatusCancelling, RunStatusPaused)
	}
	result, err := executor.ExecContext(ctx, query, args...)
	if err != nil {
		return fmt.Errorf("create data sync run: %w", err)
	}
	if forbidPending {
		affected, affectedErr := result.RowsAffected()
		if affectedErr != nil {
			return fmt.Errorf("read created data sync run count: %w", affectedErr)
		}
		if affected == 0 {
			return ErrRunAlreadyActive
		}
	}
	return nil
}

func (s *Store) UpdateRun(ctx context.Context, run RunRecord) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	run.UpdatedAt = time.Now().UnixMilli()
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_runs SET
		status=?, started_at=?, finished_at=?, heartbeat_at=?, current_item=?, total_items=?, table_name=?, stage=?,
		rows_inserted=?, rows_updated=?, rows_deleted=?, rows_failed=?, message=?, resumable=?, updated_at=?
		WHERE id=? AND owner_token = ''`, run.Status, run.StartedAt, run.FinishedAt, run.HeartbeatAt, run.Current, run.Total, run.Table, run.Stage,
		run.RowsInserted, run.RowsUpdated, run.RowsDeleted, run.RowsFailed, run.Message, boolInt(run.Resumable),
		run.UpdatedAt, run.ID)
	if err != nil {
		return fmt.Errorf("update data sync run: %w", err)
	}
	return requireUnownedAffected(result)
}

func (s *Store) GetRun(ctx context.Context, id string) (RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return RunRecord{}, err
	}
	return scanRun(s.db.QueryRowContext(ctx, runSelect+` WHERE id = ?`, strings.TrimSpace(id)))
}

func (s *Store) ListRuns(ctx context.Context, jobID string, limit int) ([]RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	query := runSelect
	args := make([]any, 0, 2)
	if strings.TrimSpace(jobID) != "" {
		query += ` WHERE job_id = ?`
		args = append(args, strings.TrimSpace(jobID))
	}
	query += ` ORDER BY created_at DESC, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list data sync runs: %w", err)
	}
	defer rows.Close()
	result := make([]RunRecord, 0)
	for rows.Next() {
		run, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, run)
	}
	return result, rows.Err()
}

func (s *Store) ListRunsPage(ctx context.Context, jobID string, cursor *RunCursor, limit int) (RunPage, error) {
	if err := s.ensureOpen(); err != nil {
		return RunPage{}, err
	}
	if limit < 1 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	if cursor != nil && (cursor.CreatedAt <= 0 || strings.TrimSpace(cursor.ID) == "") {
		return RunPage{}, errors.New("data sync run cursor requires createdAt and id")
	}
	clauses := make([]string, 0, 2)
	args := make([]any, 0, 5)
	if jobID = strings.TrimSpace(jobID); jobID != "" {
		clauses = append(clauses, "job_id = ?")
		args = append(args, jobID)
	}
	countQuery := "SELECT COUNT(*) FROM data_sync_runs"
	if len(clauses) > 0 {
		countQuery += " WHERE " + strings.Join(clauses, " AND ")
	}
	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, args...).Scan(&total); err != nil {
		return RunPage{}, fmt.Errorf("count data sync runs: %w", err)
	}
	if cursor != nil {
		clauses = append(clauses, "(created_at < ? OR (created_at = ? AND id > ?))")
		args = append(args, cursor.CreatedAt, cursor.CreatedAt, strings.TrimSpace(cursor.ID))
	}
	query := runSelect
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY created_at DESC, id LIMIT ?"
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return RunPage{}, fmt.Errorf("page data sync runs: %w", err)
	}
	defer rows.Close()
	page := RunPage{Runs: make([]RunRecord, 0, limit), Total: total}
	for rows.Next() {
		run, scanErr := scanRun(rows)
		if scanErr != nil {
			return RunPage{}, scanErr
		}
		page.Runs = append(page.Runs, run)
	}
	if err := rows.Err(); err != nil {
		return RunPage{}, err
	}
	if len(page.Runs) > limit {
		last := page.Runs[limit-1]
		page.Runs = page.Runs[:limit]
		page.NextCursor = &RunCursor{CreatedAt: last.CreatedAt, ID: last.ID}
	}
	return page, nil
}

func terminalRunStatus(status RunStatus) bool {
	switch status {
	case RunStatusSucceeded, RunStatusPartial, RunStatusFailed, RunStatusCanceled, RunStatusInterrupted:
		return true
	default:
		return false
	}
}

func (s *Store) DeleteRun(ctx context.Context, runID string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	run, err := s.GetRun(ctx, strings.TrimSpace(runID))
	if err != nil {
		return err
	}
	if !terminalRunStatus(run.Status) {
		return ErrRunNotDeletable
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM data_sync_runs WHERE id = ? AND status IN (?, ?, ?, ?, ?)`,
		run.ID, RunStatusSucceeded, RunStatusPartial, RunStatusFailed, RunStatusCanceled, RunStatusInterrupted)
	if err != nil {
		return fmt.Errorf("delete data sync run: %w", err)
	}
	return requireAffected(result)
}

func (s *Store) ClearTerminalRuns(ctx context.Context, jobID string) (int, error) {
	if err := s.ensureOpen(); err != nil {
		return 0, err
	}
	query := `DELETE FROM data_sync_runs WHERE status IN (?, ?, ?, ?, ?)`
	args := []any{RunStatusSucceeded, RunStatusPartial, RunStatusFailed, RunStatusCanceled, RunStatusInterrupted}
	if jobID = strings.TrimSpace(jobID); jobID != "" {
		query += ` AND job_id = ?`
		args = append(args, jobID)
	}
	result, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("clear terminal data sync runs: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("read cleared data sync run count: %w", err)
	}
	return int(affected), nil
}

func (s *Store) ListQueuedRuns(ctx context.Context, limit int) ([]RunRecord, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	rows, err := s.db.QueryContext(ctx, runSelect+` WHERE status = ? AND EXISTS (
		SELECT 1 FROM data_sync_jobs AS job WHERE job.id = data_sync_runs.job_id AND job.archived_at = 0 AND (
			json_extract(job.definition_json, '$.lifecycle') = ? OR
			(json_extract(job.definition_json, '$.lifecycle') = ? AND job.enabled = 1)
		)
	) ORDER BY queued_at, created_at, id LIMIT ?`, RunStatusQueued, JobLifecycleReady, JobLifecycleEnabled, limit)
	if err != nil {
		return nil, fmt.Errorf("list queued data sync runs: %w", err)
	}
	defer rows.Close()
	result := make([]RunRecord, 0)
	for rows.Next() {
		run, scanErr := scanRun(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, run)
	}
	return result, rows.Err()
}
