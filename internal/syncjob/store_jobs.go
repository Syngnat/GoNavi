package syncjob

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (s *Store) PutJob(ctx context.Context, input JobDefinition) (JobDefinition, error) {
	return s.putJob(ctx, input, true)
}

func (s *Store) putJob(ctx context.Context, input JobDefinition, cancelInactiveRuns bool) (JobDefinition, error) {
	if err := s.ensureOpen(); err != nil {
		return JobDefinition{}, err
	}
	definition := NormalizeDefinition(input)
	if err := ValidatePersistableDefinition(definition); err != nil {
		return JobDefinition{}, err
	}
	now := time.Now().UnixMilli()
	if definition.Lifecycle == JobLifecycleArchived {
		if definition.ArchivedAt == 0 {
			definition.ArchivedAt = now
		}
	} else {
		definition.ArchivedAt = 0
	}
	if definition.Schedule.Kind == ScheduleInterval && definition.Schedule.AnchorAt <= 0 {
		definition.Schedule.AnchorAt = now
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return JobDefinition{}, fmt.Errorf("begin data sync job update: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if definition.ID == "" {
		definition.ID = "sync-job-" + uuid.NewString()
		definition.Revision = 1
		definition.CreatedAt = now
	} else {
		var revision, createdAt int64
		err := tx.QueryRowContext(ctx, `SELECT revision, created_at FROM data_sync_jobs WHERE id = ?`, definition.ID).Scan(&revision, &createdAt)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			if definition.Revision > 0 {
				return JobDefinition{}, ErrNotFound
			}
			definition.Revision = 1
			definition.CreatedAt = now
		case err != nil:
			return JobDefinition{}, fmt.Errorf("read data sync job revision: %w", err)
		default:
			if definition.Revision != revision {
				return JobDefinition{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, revision, definition.Revision)
			}
			definition.Revision = revision + 1
			definition.CreatedAt = createdAt
		}
	}
	definition.UpdatedAt = now
	definition.NextRunAt = NextRunAt(definition, time.UnixMilli(now))
	payload, err := json.Marshal(definition)
	if err != nil {
		return JobDefinition{}, fmt.Errorf("encode data sync job: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO data_sync_jobs(
		id, name, version, enabled, job_kind, incremental_mode, source_connection_id, target_connection_id,
		definition_json, revision, created_at, updated_at, next_run_at, last_scheduled_at, archived_at
	) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		name=excluded.name,
		version=excluded.version,
		enabled=excluded.enabled,
		job_kind=excluded.job_kind,
		incremental_mode=excluded.incremental_mode,
		source_connection_id=excluded.source_connection_id,
		target_connection_id=excluded.target_connection_id,
		definition_json=excluded.definition_json,
		revision=excluded.revision,
		updated_at=excluded.updated_at,
		next_run_at=excluded.next_run_at,
		archived_at=excluded.archived_at`,
		definition.ID, definition.Name, definition.Version, boolInt(definition.Enabled), definition.Kind, definition.IncrementalMode,
		definition.Source.ConnectionID, definition.Target.ConnectionID, payload, definition.Revision,
		definition.CreatedAt, definition.UpdatedAt, definition.NextRunAt, definition.LastScheduledAt, definition.ArchivedAt,
	)
	if err != nil {
		return JobDefinition{}, fmt.Errorf("save data sync job: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return JobDefinition{}, fmt.Errorf("commit data sync job update: %w", err)
	}
	if cancelInactiveRuns && (definition.Lifecycle == JobLifecyclePaused || definition.Lifecycle == JobLifecycleArchived) {
		if _, err := s.requestCancelRunsForJob(ctx, definition.ID, now, string(definition.Lifecycle)); err != nil {
			return JobDefinition{}, err
		}
	}
	return definition, nil
}

func (s *Store) PauseJob(ctx context.Context, id string) (JobDefinition, error) {
	definition, err := s.GetJob(ctx, strings.TrimSpace(id))
	if err != nil {
		return JobDefinition{}, err
	}
	if definition.Lifecycle == JobLifecycleArchived || definition.ArchivedAt != 0 {
		return JobDefinition{}, ErrNotFound
	}
	definition.Lifecycle = JobLifecyclePaused
	definition.Enabled = false
	paused, err := s.putJob(ctx, definition, false)
	if err != nil {
		return JobDefinition{}, err
	}
	if _, err := s.requestCancelRunsForJob(ctx, paused.ID, time.Now().UnixMilli(), "paused"); err != nil {
		return JobDefinition{}, err
	}
	return paused, nil
}

func (s *Store) GetJob(ctx context.Context, id string) (JobDefinition, error) {
	if err := s.ensureOpen(); err != nil {
		return JobDefinition{}, err
	}
	return scanJob(s.db.QueryRowContext(ctx, `SELECT definition_json, next_run_at, last_scheduled_at, archived_at FROM data_sync_jobs WHERE id = ?`, strings.TrimSpace(id)))
}

func (s *Store) ListJobs(ctx context.Context) ([]JobDefinition, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT definition_json, next_run_at, last_scheduled_at, archived_at FROM data_sync_jobs WHERE archived_at = 0 ORDER BY updated_at DESC, id`)
	if err != nil {
		return nil, fmt.Errorf("list data sync jobs: %w", err)
	}
	defer rows.Close()
	return scanJobs(rows)
}

func (s *Store) ListDueJobs(ctx context.Context, nowMillis int64) ([]JobDefinition, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT definition_json, next_run_at, last_scheduled_at, archived_at FROM data_sync_jobs
		WHERE enabled = 1 AND archived_at = 0 AND next_run_at > 0 AND next_run_at <= ? ORDER BY next_run_at, id`, nowMillis)
	if err != nil {
		return nil, fmt.Errorf("list due data sync jobs: %w", err)
	}
	defer rows.Close()
	return scanJobs(rows)
}

func (s *Store) AdvanceSchedule(ctx context.Context, id string, now time.Time) error {
	definition, err := s.GetJob(ctx, id)
	if err != nil {
		return err
	}
	scheduledAt := definition.NextRunAt
	base := now
	if definition.Schedule.MisfirePolicy == "catch_up" && scheduledAt > 0 {
		base = time.UnixMilli(scheduledAt)
	}
	next := NextRunAt(definition, base)
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_jobs SET next_run_at = ?, last_scheduled_at = ? WHERE id = ?`, next, scheduledAt, definition.ID)
	if err != nil {
		return fmt.Errorf("advance data sync job schedule: %w", err)
	}
	return requireAffected(result)
}

func (s *Store) AdvanceScheduleIfDue(ctx context.Context, id string, scheduledAt int64, now time.Time) (bool, error) {
	definition, err := s.GetJob(ctx, id)
	if err != nil {
		return false, err
	}
	if scheduledAt <= 0 || definition.NextRunAt != scheduledAt {
		return false, nil
	}
	base := now
	if definition.Schedule.MisfirePolicy == "catch_up" {
		base = time.UnixMilli(scheduledAt)
	}
	next := NextRunAt(definition, base)
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_jobs SET next_run_at = ?, last_scheduled_at = ? WHERE id = ? AND next_run_at = ? AND enabled = 1 AND archived_at = 0`,
		next, scheduledAt, definition.ID, scheduledAt)
	if err != nil {
		return false, fmt.Errorf("advance due data sync job schedule: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read advanced data sync job schedule count: %w", err)
	}
	return affected > 0, nil
}

func (s *Store) DelayScheduleIfDue(ctx context.Context, id string, scheduledAt, notBefore int64) (bool, error) {
	if err := s.ensureOpen(); err != nil {
		return false, err
	}
	if scheduledAt <= 0 || notBefore <= scheduledAt {
		return false, nil
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_jobs SET next_run_at = ?
		WHERE id = ? AND next_run_at = ? AND enabled = 1 AND archived_at = 0
		AND json_extract(definition_json, '$.lifecycle') = ?`, notBefore, strings.TrimSpace(id), scheduledAt,
		JobLifecycleEnabled)
	if err != nil {
		return false, fmt.Errorf("delay due data sync job schedule: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read delayed data sync job schedule count: %w", err)
	}
	return affected > 0, nil
}

func (s *Store) DeleteJob(ctx context.Context, id string) error {
	_, err := s.archiveJobAndCancelRuns(ctx, id, time.Now().UnixMilli())
	return err
}

// PurgeJob permanently removes the job row. Dependent runs, checkpoints,
// error rows, and run events are removed through ON DELETE CASCADE
// (foreign_keys=ON is set when the store opens).
func (s *Store) PurgeJob(ctx context.Context, id string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	result, err := s.db.ExecContext(ctx, `DELETE FROM data_sync_jobs
		WHERE id = ? AND NOT EXISTS (
			SELECT 1 FROM data_sync_runs
			WHERE job_id = ? AND status IN (?, ?, ?)
		)`, id, id, RunStatusQueued, RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return fmt.Errorf("purge data sync job: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read purged data sync job count: %w", err)
	}
	if affected == 0 {
		var exists bool
		if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM data_sync_jobs WHERE id = ?)`, id).Scan(&exists); err != nil {
			return fmt.Errorf("check purged data sync job: %w", err)
		}
		if exists {
			return ErrJobRunsActive
		}
		return ErrNotFound
	}
	return nil
}

type archivedRunTransition struct {
	Run RunRecord
}

func (s *Store) archiveJobAndCancelRuns(ctx context.Context, id string, nowMillis int64) ([]archivedRunTransition, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	definition, err := s.GetJob(ctx, strings.TrimSpace(id))
	if err != nil {
		return nil, err
	}
	if definition.ArchivedAt != 0 || definition.Lifecycle == JobLifecycleArchived {
		return nil, ErrNotFound
	}
	definition.Lifecycle = JobLifecycleArchived
	definition.Enabled = false
	if _, err = s.putJob(ctx, definition, false); err != nil {
		return nil, err
	}
	return s.requestCancelRunsForJob(ctx, definition.ID, nowMillis, "archived")
}

func (s *Store) requestCancelRunsForJob(ctx context.Context, jobID string, nowMillis int64, reason string) ([]archivedRunTransition, error) {
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "disabled"
	}
	canceledMessage := "canceled because task was " + reason
	cancellingMessage := "cancellation requested because task was " + reason
	rows, err := s.db.QueryContext(ctx, `UPDATE data_sync_runs SET
		status = CASE WHEN status IN (?, ?) THEN ? ELSE ? END,
		finished_at = CASE WHEN status IN (?, ?) THEN ? ELSE finished_at END,
		owner_token = CASE WHEN status IN (?, ?) THEN '' ELSE owner_token END,
		message = CASE
			WHEN status IN (?, ?) THEN ?
			WHEN message = '' THEN ?
			ELSE message
		END,
		updated_at = ?
		WHERE job_id = ? AND status IN (?, ?, ?, ?)
		RETURNING `+runColumns,
		RunStatusQueued, RunStatusPaused, RunStatusCanceled, RunStatusCancelling,
		RunStatusQueued, RunStatusPaused, nowMillis,
		RunStatusQueued, RunStatusPaused,
		RunStatusQueued, RunStatusPaused,
		canceledMessage, cancellingMessage,
		nowMillis, strings.TrimSpace(jobID), RunStatusQueued, RunStatusRunning, RunStatusCancelling, RunStatusPaused)
	if err != nil {
		return nil, fmt.Errorf("cancel runs for inactive data sync job: %w", err)
	}
	defer rows.Close()
	transitions := make([]archivedRunTransition, 0)
	for rows.Next() {
		run, scanErr := scanRun(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		transitions = append(transitions, archivedRunTransition{Run: run})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate inactive data sync run cancellations: %w", err)
	}
	return transitions, nil
}
