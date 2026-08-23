package syncjob

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

const storeSchemaVersion = 4

var (
	ErrClosed                     = errors.New("data sync job store is closed")
	ErrNotFound                   = errors.New("data sync job record not found")
	ErrRevisionConflict           = errors.New("data sync job revision conflict")
	ErrRunAlreadyActive           = errors.New("data sync job already has an unfinished run")
	ErrRunNotCancelable           = errors.New("data sync run cannot be canceled")
	ErrRunOwnershipLost           = errors.New("data sync run ownership was lost")
	ErrErrorRowStateConflict      = errors.New("data sync error row state transition conflict")
	ErrErrorRowRetryOwnershipLost = errors.New("data sync error row retry ownership was lost")
)

type Store struct {
	db   *sql.DB
	path string
}

func Open(path string) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("data sync job database path is empty")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve data sync job database path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o700); err != nil {
		return nil, fmt.Errorf("create data sync job directory: %w", err)
	}
	database, err := sql.Open("sqlite", sqliteDSN(absPath))
	if err != nil {
		return nil, fmt.Errorf("open data sync job database: %w", err)
	}
	database.SetMaxOpenConns(4)
	database.SetMaxIdleConns(4)
	store := &Store{db: database, path: absPath}
	if err := store.initialize(context.Background()); err != nil {
		_ = database.Close()
		return nil, err
	}
	if err := os.Chmod(absPath, 0o600); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("secure data sync job database: %w", err)
	}
	return store, nil
}

func (s *Store) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	_, checkpointErr := s.db.ExecContext(context.Background(), `PRAGMA wal_checkpoint(TRUNCATE)`)
	closeErr := s.db.Close()
	s.db = nil
	return errors.Join(checkpointErr, closeErr)
}

func (s *Store) initialize(ctx context.Context) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	for _, pragma := range []string{
		"PRAGMA busy_timeout=5000",
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL",
		"PRAGMA foreign_keys=ON",
	} {
		if _, err := s.db.ExecContext(ctx, pragma); err != nil {
			return fmt.Errorf("configure data sync job database (%s): %w", pragma, err)
		}
	}
	var version int
	if err := s.db.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("read data sync job schema version: %w", err)
	}
	if version > storeSchemaVersion {
		return fmt.Errorf("data sync job schema version %d is newer than supported version %d", version, storeSchemaVersion)
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS data_sync_jobs (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			version INTEGER NOT NULL,
			enabled INTEGER NOT NULL,
			job_kind TEXT NOT NULL,
			incremental_mode TEXT NOT NULL,
			source_connection_id TEXT NOT NULL,
			target_connection_id TEXT NOT NULL,
			definition_json BLOB NOT NULL,
			revision INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			next_run_at INTEGER NOT NULL DEFAULT 0,
			last_scheduled_at INTEGER NOT NULL DEFAULT 0,
			archived_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_data_sync_jobs_schedule ON data_sync_jobs(enabled, next_run_at)`,
		`CREATE TABLE IF NOT EXISTS data_sync_runs (
			id TEXT PRIMARY KEY,
			job_id TEXT NOT NULL,
			job_revision INTEGER NOT NULL,
			trigger_kind TEXT NOT NULL,
			status TEXT NOT NULL,
			parent_run_id TEXT NOT NULL DEFAULT '',
			attempt INTEGER NOT NULL DEFAULT 1,
			queued_at INTEGER NOT NULL DEFAULT 0,
			started_at INTEGER NOT NULL DEFAULT 0,
			finished_at INTEGER NOT NULL DEFAULT 0,
			heartbeat_at INTEGER NOT NULL DEFAULT 0,
			current_item INTEGER NOT NULL DEFAULT 0,
			total_items INTEGER NOT NULL DEFAULT 0,
			table_name TEXT NOT NULL DEFAULT '',
			stage TEXT NOT NULL DEFAULT '',
			rows_inserted INTEGER NOT NULL DEFAULT 0,
			rows_updated INTEGER NOT NULL DEFAULT 0,
			rows_deleted INTEGER NOT NULL DEFAULT 0,
			rows_failed INTEGER NOT NULL DEFAULT 0,
			message TEXT NOT NULL DEFAULT '',
			resumable INTEGER NOT NULL DEFAULT 0,
			definition_snapshot BLOB NOT NULL,
			source_fingerprint TEXT NOT NULL DEFAULT '',
			target_fingerprint TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY(job_id) REFERENCES data_sync_jobs(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_data_sync_runs_job_created ON data_sync_runs(job_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_data_sync_runs_status ON data_sync_runs(status, updated_at DESC)`,
		`CREATE TABLE IF NOT EXISTS data_sync_checkpoints (
			job_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL,
			kind TEXT NOT NULL,
			run_id TEXT NOT NULL,
			definition_revision INTEGER NOT NULL,
			table_name TEXT NOT NULL,
			phase TEXT NOT NULL,
			cursor_type TEXT NOT NULL,
			cursor_json BLOB,
			watermark_json BLOB,
			batch_sequence INTEGER NOT NULL DEFAULT 0,
			schema_hash TEXT NOT NULL DEFAULT '',
			updated_at INTEGER NOT NULL,
			FOREIGN KEY(job_id) REFERENCES data_sync_jobs(id) ON DELETE CASCADE,
			FOREIGN KEY(run_id) REFERENCES data_sync_runs(id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS data_sync_error_rows (
			id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			job_id TEXT NOT NULL,
			source_table TEXT NOT NULL DEFAULT '',
			target_table TEXT NOT NULL DEFAULT '',
			operation TEXT NOT NULL DEFAULT '',
			source_key_json BLOB,
			payload_json BLOB,
			payload_policy TEXT NOT NULL DEFAULT 'keys_only',
			payload_hash TEXT NOT NULL DEFAULT '',
			payload_size INTEGER NOT NULL DEFAULT 0,
			error_text TEXT NOT NULL,
			error_code TEXT NOT NULL DEFAULT '',
			error_class TEXT NOT NULL DEFAULT '',
			attempts INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			retry_owner TEXT NOT NULL DEFAULT '',
			retry_lease_expires_at INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY(job_id) REFERENCES data_sync_jobs(id) ON DELETE CASCADE,
			FOREIGN KEY(run_id) REFERENCES data_sync_runs(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_data_sync_error_rows_run ON data_sync_error_rows(run_id, status, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS data_sync_run_events (
			run_id TEXT NOT NULL,
			sequence INTEGER NOT NULL,
			job_id TEXT NOT NULL,
			event_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT '',
			current_item INTEGER NOT NULL DEFAULT 0,
			total_items INTEGER NOT NULL DEFAULT 0,
			table_name TEXT NOT NULL DEFAULT '',
			stage TEXT NOT NULL DEFAULT '',
			message TEXT NOT NULL DEFAULT '',
			payload_json BLOB,
			created_at INTEGER NOT NULL,
			PRIMARY KEY(run_id, sequence),
			FOREIGN KEY(job_id) REFERENCES data_sync_jobs(id) ON DELETE CASCADE,
			FOREIGN KEY(run_id) REFERENCES data_sync_runs(id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_data_sync_run_events_job ON data_sync_run_events(job_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS data_sync_scheduler_leases (
			name TEXT PRIMARY KEY,
			owner_id TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize data sync job database: %w", err)
		}
	}
	if version < 3 {
		hasOwnerToken, err := sqliteTableHasColumn(ctx, s.db, "data_sync_runs", "owner_token")
		if err != nil {
			return fmt.Errorf("inspect data sync job run ownership migration: %w", err)
		}
		if !hasOwnerToken {
			if _, err := s.db.ExecContext(ctx, `ALTER TABLE data_sync_runs ADD COLUMN owner_token TEXT NOT NULL DEFAULT ''`); err != nil {
				return fmt.Errorf("migrate data sync job run ownership: %w", err)
			}
		}
	}
	if version < 4 {
		hasRetryOwner, err := sqliteTableHasColumn(ctx, s.db, "data_sync_error_rows", "retry_owner")
		if err != nil {
			return fmt.Errorf("inspect data sync error row retry owner migration: %w", err)
		}
		if !hasRetryOwner {
			if _, err := s.db.ExecContext(ctx, `ALTER TABLE data_sync_error_rows ADD COLUMN retry_owner TEXT NOT NULL DEFAULT ''`); err != nil {
				return fmt.Errorf("migrate data sync error row retry owner: %w", err)
			}
		}
		hasRetryLease, err := sqliteTableHasColumn(ctx, s.db, "data_sync_error_rows", "retry_lease_expires_at")
		if err != nil {
			return fmt.Errorf("inspect data sync error row retry lease migration: %w", err)
		}
		if !hasRetryLease {
			if _, err := s.db.ExecContext(ctx, `ALTER TABLE data_sync_error_rows ADD COLUMN retry_lease_expires_at INTEGER NOT NULL DEFAULT 0`); err != nil {
				return fmt.Errorf("migrate data sync error row retry lease: %w", err)
			}
		}
	}
	if _, err := s.db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_data_sync_error_rows_retry ON data_sync_error_rows(status, retry_lease_expires_at)`); err != nil {
		return fmt.Errorf("initialize data sync error row retry index: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", storeSchemaVersion)); err != nil {
		return fmt.Errorf("record data sync job schema version: %w", err)
	}
	return nil
}

func sqliteTableHasColumn(ctx context.Context, database *sql.DB, table, column string) (bool, error) {
	rows, err := database.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid, notNull, primaryKey int
		var name, dataType string
		var defaultValue any
		if err := rows.Scan(&cid, &name, &dataType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

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

func (s *Store) PutCheckpoint(ctx context.Context, checkpoint Checkpoint) (Checkpoint, error) {
	if err := s.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	checkpoint.JobID = strings.TrimSpace(checkpoint.JobID)
	checkpoint.RunID = strings.TrimSpace(checkpoint.RunID)
	checkpoint.Table = strings.TrimSpace(checkpoint.Table)
	checkpoint.Phase = strings.TrimSpace(checkpoint.Phase)
	if checkpoint.Version == 0 {
		checkpoint.Version = 1
	}
	checkpoint.Kind = strings.TrimSpace(checkpoint.Kind)
	checkpoint.CursorType = strings.TrimSpace(checkpoint.CursorType)
	if checkpoint.JobID == "" || checkpoint.RunID == "" || checkpoint.Table == "" || checkpoint.Phase == "" || checkpoint.Kind == "" || checkpoint.CursorType == "" {
		return Checkpoint{}, errors.New("checkpoint requires jobId, runId, table, and phase")
	}
	if !validJSONOrEmpty(checkpoint.Cursor) || !validJSONOrEmpty(checkpoint.Watermark) {
		return Checkpoint{}, errors.New("checkpoint cursor and watermark must be valid JSON")
	}
	checkpoint.UpdatedAt = time.Now().UnixMilli()
	result, err := s.db.ExecContext(ctx, `INSERT INTO data_sync_checkpoints(job_id, version, kind, run_id, definition_revision, table_name, phase, cursor_type, cursor_json, watermark_json, batch_sequence, schema_hash, updated_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM data_sync_runs AS owner
		WHERE owner.id = ? AND owner.job_id = ? AND owner.owner_token = ''
		ON CONFLICT(job_id) DO UPDATE SET version=excluded.version, kind=excluded.kind, run_id=excluded.run_id,
		definition_revision=excluded.definition_revision, table_name=excluded.table_name, phase=excluded.phase,
		cursor_type=excluded.cursor_type, cursor_json=excluded.cursor_json, watermark_json=excluded.watermark_json,
		batch_sequence=excluded.batch_sequence, schema_hash=excluded.schema_hash, updated_at=excluded.updated_at`,
		checkpoint.JobID, checkpoint.Version, checkpoint.Kind, checkpoint.RunID, checkpoint.DefinitionRevision,
		checkpoint.Table, checkpoint.Phase, checkpoint.CursorType, nullableBytes(checkpoint.Cursor),
		nullableBytes(checkpoint.Watermark), checkpoint.BatchSequence, checkpoint.SchemaHash, checkpoint.UpdatedAt,
		checkpoint.RunID, checkpoint.JobID)
	if err != nil {
		return Checkpoint{}, fmt.Errorf("save data sync checkpoint: %w", err)
	}
	if err := requireUnownedAffected(result); err != nil {
		return Checkpoint{}, err
	}
	return checkpoint, nil
}

func (s *Store) PutCheckpointOwned(ctx context.Context, checkpoint Checkpoint, ownerToken string) (Checkpoint, error) {
	if err := s.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	if strings.TrimSpace(ownerToken) == "" {
		return Checkpoint{}, ErrRunOwnershipLost
	}
	checkpoint.JobID = strings.TrimSpace(checkpoint.JobID)
	checkpoint.RunID = strings.TrimSpace(checkpoint.RunID)
	checkpoint.Table = strings.TrimSpace(checkpoint.Table)
	checkpoint.Phase = strings.TrimSpace(checkpoint.Phase)
	if checkpoint.Version == 0 {
		checkpoint.Version = 1
	}
	checkpoint.Kind = strings.TrimSpace(checkpoint.Kind)
	checkpoint.CursorType = strings.TrimSpace(checkpoint.CursorType)
	if checkpoint.JobID == "" || checkpoint.RunID == "" || checkpoint.Table == "" || checkpoint.Phase == "" || checkpoint.Kind == "" || checkpoint.CursorType == "" {
		return Checkpoint{}, errors.New("checkpoint requires jobId, runId, table, and phase")
	}
	if !validJSONOrEmpty(checkpoint.Cursor) || !validJSONOrEmpty(checkpoint.Watermark) {
		return Checkpoint{}, errors.New("checkpoint cursor and watermark must be valid JSON")
	}
	checkpoint.UpdatedAt = time.Now().UnixMilli()
	result, err := s.db.ExecContext(ctx, `INSERT INTO data_sync_checkpoints(job_id, version, kind, run_id, definition_revision, table_name, phase, cursor_type, cursor_json, watermark_json, batch_sequence, schema_hash, updated_at)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM data_sync_runs AS owner
		WHERE owner.id = ? AND owner.job_id = ? AND owner.owner_token = ? AND owner.status = ?
		ON CONFLICT(job_id) DO UPDATE SET version=excluded.version, kind=excluded.kind, run_id=excluded.run_id,
		definition_revision=excluded.definition_revision, table_name=excluded.table_name, phase=excluded.phase,
		cursor_type=excluded.cursor_type, cursor_json=excluded.cursor_json, watermark_json=excluded.watermark_json,
		batch_sequence=excluded.batch_sequence, schema_hash=excluded.schema_hash, updated_at=excluded.updated_at`,
		checkpoint.JobID, checkpoint.Version, checkpoint.Kind, checkpoint.RunID, checkpoint.DefinitionRevision,
		checkpoint.Table, checkpoint.Phase, checkpoint.CursorType, nullableBytes(checkpoint.Cursor),
		nullableBytes(checkpoint.Watermark), checkpoint.BatchSequence, checkpoint.SchemaHash, checkpoint.UpdatedAt,
		checkpoint.RunID, checkpoint.JobID, ownerToken, RunStatusRunning)
	if err != nil {
		return Checkpoint{}, fmt.Errorf("save owned data sync checkpoint: %w", err)
	}
	if err := requireOwnedAffected(result); err != nil {
		return Checkpoint{}, err
	}
	return checkpoint, nil
}

func (s *Store) GetCheckpoint(ctx context.Context, jobID string) (Checkpoint, error) {
	if err := s.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	var checkpoint Checkpoint
	var cursor, watermark []byte
	err := s.db.QueryRowContext(ctx, `SELECT job_id, version, kind, run_id, definition_revision, table_name, phase, cursor_type, cursor_json, watermark_json, batch_sequence, schema_hash, updated_at
		FROM data_sync_checkpoints WHERE job_id = ?`, strings.TrimSpace(jobID)).Scan(&checkpoint.JobID, &checkpoint.Version,
		&checkpoint.Kind, &checkpoint.RunID, &checkpoint.DefinitionRevision, &checkpoint.Table, &checkpoint.Phase,
		&checkpoint.CursorType, &cursor, &watermark, &checkpoint.BatchSequence, &checkpoint.SchemaHash, &checkpoint.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, fmt.Errorf("read data sync checkpoint: %w", err)
	}
	checkpoint.Cursor = cloneRaw(cursor)
	checkpoint.Watermark = cloneRaw(watermark)
	return checkpoint, nil
}

func (s *Store) DeleteCheckpoint(ctx context.Context, jobID string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	jobID = strings.TrimSpace(jobID)
	result, err := s.db.ExecContext(ctx, `DELETE FROM data_sync_checkpoints WHERE job_id = ? AND NOT EXISTS (
		SELECT 1 FROM data_sync_runs WHERE job_id = ? AND owner_token <> '' AND status IN (?, ?)
	)`, jobID, jobID, RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return fmt.Errorf("delete data sync checkpoint: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		var owned int
		if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM data_sync_runs
			WHERE job_id = ? AND owner_token <> '' AND status IN (?, ?))`, jobID, RunStatusRunning, RunStatusCancelling).Scan(&owned); err != nil {
			return fmt.Errorf("verify data sync run ownership after checkpoint delete: %w", err)
		}
		if owned != 0 {
			return ErrRunOwnershipLost
		}
	}
	return nil
}

func (s *Store) DeleteCheckpointOwned(ctx context.Context, jobID, runID, ownerToken string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	if strings.TrimSpace(ownerToken) == "" {
		return ErrRunOwnershipLost
	}
	jobID = strings.TrimSpace(jobID)
	runID = strings.TrimSpace(runID)
	result, err := s.db.ExecContext(ctx, `DELETE FROM data_sync_checkpoints WHERE job_id = ? AND EXISTS (
		SELECT 1 FROM data_sync_runs AS owner WHERE owner.id = ? AND owner.job_id = ?
		AND owner.owner_token = ? AND owner.status = ?
	)`, jobID, runID, jobID, ownerToken, RunStatusRunning)
	if err != nil {
		return fmt.Errorf("delete owned data sync checkpoint: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected > 0 {
		return nil
	}
	var owned int
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM data_sync_runs
		WHERE id = ? AND job_id = ? AND owner_token = ? AND status = ?)`, runID, jobID, ownerToken, RunStatusRunning).Scan(&owned); err != nil {
		return fmt.Errorf("verify data sync run ownership after checkpoint delete: %w", err)
	}
	if owned == 0 {
		return ErrRunOwnershipLost
	}
	return nil
}

func (s *Store) ResetCheckpoint(ctx context.Context, jobID string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	jobID = strings.TrimSpace(jobID)
	result, err := s.db.ExecContext(ctx, `DELETE FROM data_sync_checkpoints
		WHERE job_id = ? AND NOT EXISTS (
			SELECT 1 FROM data_sync_runs
			WHERE job_id = ? AND status IN (?, ?, ?)
		)`, jobID, jobID, RunStatusQueued, RunStatusRunning, RunStatusCancelling)
	if err != nil {
		return fmt.Errorf("reset data sync checkpoint: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read reset data sync checkpoint count: %w", err)
	}
	if affected > 0 {
		return nil
	}
	var active int
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM data_sync_runs WHERE job_id = ? AND status IN (?, ?, ?)
	)`, jobID, RunStatusQueued, RunStatusRunning, RunStatusCancelling).Scan(&active); err != nil {
		return fmt.Errorf("check active data sync run before checkpoint reset: %w", err)
	}
	if active != 0 {
		return ErrRunAlreadyActive
	}
	return ErrNotFound
}

func (s *Store) AppendErrorRow(ctx context.Context, row ErrorRow) (ErrorRow, error) {
	if err := s.ensureOpen(); err != nil {
		return ErrorRow{}, err
	}
	if strings.TrimSpace(row.RunID) == "" || strings.TrimSpace(row.JobID) == "" || strings.TrimSpace(row.Error) == "" {
		return ErrorRow{}, errors.New("error row requires runId, jobId, and error")
	}
	if !validJSONOrEmpty(row.SourceKey) || !validJSONOrEmpty(row.Payload) {
		return ErrorRow{}, errors.New("error row source key and payload must be valid JSON")
	}
	const (
		maxErrorRowSourceKeyBytes = 64 << 10
		maxErrorRowPayloadBytes   = 1 << 20
	)
	if len(row.SourceKey) > maxErrorRowSourceKeyBytes {
		return ErrorRow{}, fmt.Errorf("error row source key exceeds %d bytes", maxErrorRowSourceKeyBytes)
	}
	if len(row.Payload) > maxErrorRowPayloadBytes {
		return ErrorRow{}, fmt.Errorf("error row payload exceeds %d bytes", maxErrorRowPayloadBytes)
	}
	if row.ID == "" {
		row.ID = "sync-error-" + uuid.NewString()
	}
	if row.Status == "" {
		row.Status = ErrorRowPending
	}
	if row.Status != ErrorRowPending {
		return ErrorRow{}, fmt.Errorf("unsupported initial error row status %q", row.Status)
	}
	if row.PayloadPolicy == "" {
		row.PayloadPolicy = "keys_only"
	}
	if row.PayloadPolicy != "none" && row.PayloadPolicy != "keys_only" && row.PayloadPolicy != "full" {
		return ErrorRow{}, fmt.Errorf("unsupported error row payload policy %q", row.PayloadPolicy)
	}
	if row.PayloadPolicy != "full" {
		row.Payload = nil
	}
	now := time.Now().UnixMilli()
	row.CreatedAt = now
	row.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `INSERT INTO data_sync_error_rows(
		id, run_id, job_id, source_table, target_table, operation, source_key_json, payload_json,
		payload_policy, payload_hash, payload_size, error_text, error_code, error_class, attempts, status, created_at, updated_at
	) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row.ID, row.RunID, row.JobID,
		row.SourceTable, row.TargetTable, row.Operation, nullableBytes(row.SourceKey), nullableBytes(row.Payload),
		row.PayloadPolicy, row.PayloadHash, row.PayloadSize, row.Error, row.ErrorCode, row.ErrorClass,
		row.Attempts, row.Status, row.CreatedAt, row.UpdatedAt)
	if err != nil {
		return ErrorRow{}, fmt.Errorf("append data sync error row: %w", err)
	}
	return row, nil
}

func (s *Store) ListErrorRows(ctx context.Context, runID string, status ErrorRowStatus, limit int) ([]ErrorRow, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	if limit < 1 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}
	query := `SELECT ` + errorRowColumns + ` FROM data_sync_error_rows WHERE run_id = ?`
	args := []any{strings.TrimSpace(runID)}
	if status != "" {
		query += ` AND status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY created_at DESC, id LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list data sync error rows: %w", err)
	}
	defer rows.Close()
	result := make([]ErrorRow, 0)
	for rows.Next() {
		row, err := scanErrorRow(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

func (s *Store) GetErrorRow(ctx context.Context, id string) (ErrorRow, error) {
	if err := s.ensureOpen(); err != nil {
		return ErrorRow{}, err
	}
	return scanErrorRow(s.db.QueryRowContext(ctx, `SELECT `+errorRowColumns+` FROM data_sync_error_rows WHERE id = ?`, strings.TrimSpace(id)))
}

func (s *Store) ClaimErrorRowRetry(ctx context.Context, id string, nowMillis int64, leaseTTL time.Duration) (ErrorRow, error) {
	if err := s.ensureOpen(); err != nil {
		return ErrorRow{}, err
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return ErrorRow{}, errors.New("data sync error row id is required")
	}
	leaseMillis := leaseTTL.Milliseconds()
	if leaseMillis <= 0 {
		return ErrorRow{}, errors.New("data sync error row retry lease must be positive")
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	owner := uuid.NewString()
	leaseExpiresAt := nowMillis + leaseMillis
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_error_rows SET
		status=?, retry_owner=?, retry_lease_expires_at=?,
		attempts=attempts+CASE WHEN status=? THEN 1 ELSE 0 END, updated_at=?
		WHERE id=? AND (status=? OR (status=? AND retry_lease_expires_at <= ?))`,
		ErrorRowRetrying, owner, leaseExpiresAt, ErrorRowRetrying, nowMillis,
		id, ErrorRowPending, ErrorRowRetrying, nowMillis)
	if err != nil {
		return ErrorRow{}, fmt.Errorf("claim data sync error row retry: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return ErrorRow{}, fmt.Errorf("read claimed data sync error row count: %w", err)
	}
	if affected == 0 {
		if _, err := s.GetErrorRow(ctx, id); err != nil {
			return ErrorRow{}, err
		}
		return ErrorRow{}, ErrErrorRowStateConflict
	}
	claimed, err := s.GetErrorRow(ctx, id)
	if err != nil {
		return ErrorRow{}, err
	}
	if claimed.Status != ErrorRowRetrying || claimed.RetryOwner != owner {
		return ErrorRow{}, ErrErrorRowRetryOwnershipLost
	}
	return claimed, nil
}

func (s *Store) RenewErrorRowRetry(ctx context.Context, id, owner string, nowMillis int64, leaseTTL time.Duration) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	owner = strings.TrimSpace(owner)
	if id == "" || owner == "" {
		return errors.New("data sync error row retry renewal requires id and owner")
	}
	leaseMillis := leaseTTL.Milliseconds()
	if leaseMillis <= 0 {
		return errors.New("data sync error row retry lease must be positive")
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_error_rows SET retry_lease_expires_at=?, updated_at=?
		WHERE id=? AND status=? AND retry_owner=?`, nowMillis+leaseMillis, nowMillis,
		id, ErrorRowRetrying, owner)
	if err != nil {
		return fmt.Errorf("renew data sync error row retry: %w", err)
	}
	return s.requireErrorRowRetryOwnerAffected(ctx, id, result)
}

func (s *Store) ResolveErrorRowRetry(ctx context.Context, id, owner string, nowMillis int64) error {
	return s.finishErrorRowRetry(ctx, id, owner, ErrorRowResolved, nowMillis)
}

func (s *Store) FailErrorRowRetry(ctx context.Context, id, owner string, nowMillis int64) error {
	return s.finishErrorRowRetry(ctx, id, owner, ErrorRowPending, nowMillis)
}

func (s *Store) finishErrorRowRetry(ctx context.Context, id, owner string, status ErrorRowStatus, nowMillis int64) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	owner = strings.TrimSpace(owner)
	if id == "" || owner == "" {
		return errors.New("data sync error row retry completion requires id and owner")
	}
	if status != ErrorRowPending && status != ErrorRowResolved {
		return fmt.Errorf("unsupported data sync error row retry completion status %q", status)
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_error_rows SET status=?, attempts=attempts+1,
		retry_owner='', retry_lease_expires_at=0, updated_at=? WHERE id=? AND status=? AND retry_owner=?`,
		status, nowMillis, id, ErrorRowRetrying, owner)
	if err != nil {
		return fmt.Errorf("complete data sync error row retry: %w", err)
	}
	return s.requireErrorRowRetryOwnerAffected(ctx, id, result)
}

func (s *Store) RecoverExpiredErrorRowRetries(ctx context.Context, nowMillis int64) (int64, error) {
	if err := s.ensureOpen(); err != nil {
		return 0, err
	}
	if nowMillis <= 0 {
		nowMillis = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_error_rows SET status=?, attempts=attempts+1,
		retry_owner='', retry_lease_expires_at=0, updated_at=? WHERE status=? AND retry_lease_expires_at <= ?`,
		ErrorRowPending, nowMillis, ErrorRowRetrying, nowMillis)
	if err != nil {
		return 0, fmt.Errorf("recover expired data sync error row retries: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("read recovered data sync error row retry count: %w", err)
	}
	return affected, nil
}

func (s *Store) requireErrorRowRetryOwnerAffected(ctx context.Context, id string, result sql.Result) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read updated data sync error row retry count: %w", err)
	}
	if affected > 0 {
		return nil
	}
	if _, err := s.GetErrorRow(ctx, id); err != nil {
		return err
	}
	return ErrErrorRowRetryOwnershipLost
}

func (s *Store) UpdateErrorRowStatus(ctx context.Context, id string, status ErrorRowStatus, incrementAttempts bool) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	if status != ErrorRowResolved && status != ErrorRowDiscarded {
		return fmt.Errorf("unsupported error row status %q", status)
	}
	attemptDelta := 0
	if incrementAttempts {
		attemptDelta = 1
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_error_rows SET status=?, attempts=attempts+?, updated_at=? WHERE id=? AND status=?`,
		status, attemptDelta, time.Now().UnixMilli(), strings.TrimSpace(id), ErrorRowPending)
	if err != nil {
		return fmt.Errorf("update data sync error row: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read updated data sync error row count: %w", err)
	}
	if affected > 0 {
		return nil
	}
	if _, err := s.GetErrorRow(ctx, id); err != nil {
		return err
	}
	return ErrErrorRowStateConflict
}

// IncrementErrorRowAttempts records a failed replay while keeping the row
// pending. The CAS prevents a concurrent discard/resolve from being undone.
func (s *Store) IncrementErrorRowAttempts(ctx context.Context, id string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE data_sync_error_rows SET attempts=attempts+1, updated_at=? WHERE id=? AND status=?`,
		time.Now().UnixMilli(), strings.TrimSpace(id), ErrorRowPending)
	if err != nil {
		return fmt.Errorf("increment data sync error row attempts: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read incremented data sync error row count: %w", err)
	}
	if affected > 0 {
		return nil
	}
	if _, err := s.GetErrorRow(ctx, id); err != nil {
		return err
	}
	return ErrErrorRowStateConflict
}

func (s *Store) AcquireSchedulerLease(ctx context.Context, name, owner string, now time.Time, ttl time.Duration) (bool, error) {
	if err := s.ensureOpen(); err != nil {
		return false, err
	}
	name = strings.TrimSpace(name)
	owner = strings.TrimSpace(owner)
	if name == "" || owner == "" {
		return false, errors.New("scheduler lease requires name and owner")
	}
	if ttl <= 0 {
		return false, errors.New("scheduler lease ttl must be positive")
	}
	nowMillis := now.UnixMilli()
	expiresAt := now.Add(ttl).UnixMilli()
	result, err := s.db.ExecContext(ctx, `INSERT INTO data_sync_scheduler_leases(name, owner_id, expires_at, updated_at)
		VALUES(?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at
		WHERE data_sync_scheduler_leases.owner_id = excluded.owner_id OR data_sync_scheduler_leases.expires_at <= ?`,
		name, owner, expiresAt, nowMillis, nowMillis)
	if err != nil {
		return false, fmt.Errorf("acquire data sync scheduler lease: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("read data sync scheduler lease acquisition: %w", err)
	}
	return affected > 0, nil
}

func (s *Store) ReleaseSchedulerLease(ctx context.Context, name, owner string) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	name = strings.TrimSpace(name)
	owner = strings.TrimSpace(owner)
	if name == "" || owner == "" {
		return errors.New("scheduler lease requires name and owner")
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM data_sync_scheduler_leases WHERE name = ? AND owner_id = ?`, name, owner); err != nil {
		return fmt.Errorf("release data sync scheduler lease: %w", err)
	}
	return nil
}

func (s *Store) AppendRunEvent(ctx context.Context, event RunEvent) (RunEvent, error) {
	if err := s.ensureOpen(); err != nil {
		return RunEvent{}, err
	}
	return appendRunEvent(ctx, s.db, event)
}

func appendRunEvent(ctx context.Context, queryer contextQueryRower, event RunEvent) (RunEvent, error) {
	event.RunID = strings.TrimSpace(event.RunID)
	if event.RunID == "" || event.Type == "" {
		return RunEvent{}, errors.New("data sync run event requires runId and type")
	}
	if !validJSONOrEmpty(event.Payload) {
		return RunEvent{}, errors.New("data sync run event payload must be valid JSON")
	}
	if event.CreatedAt <= 0 {
		event.CreatedAt = time.Now().UnixMilli()
	}
	const insert = `INSERT INTO data_sync_run_events(
		run_id, sequence, job_id, event_type, status, current_item, total_items, table_name, stage, message, payload_json, created_at
	) SELECT run.id,
		COALESCE((SELECT MAX(existing.sequence) + 1 FROM data_sync_run_events AS existing WHERE existing.run_id = run.id), 1),
		run.job_id, ?, ?, ?, ?, ?, ?, ?, ?, ?
	FROM data_sync_runs AS run WHERE run.id = ?
	RETURNING sequence, job_id`
	for attempt := 0; attempt < 8; attempt++ {
		err := queryer.QueryRowContext(ctx, insert, event.Type, event.Status, event.Current, event.Total,
			strings.TrimSpace(event.Table), strings.TrimSpace(event.Stage), event.Message, nullableBytes(event.Payload),
			event.CreatedAt, event.RunID).Scan(&event.Sequence, &event.JobID)
		switch {
		case err == nil:
			return event, nil
		case errors.Is(err, sql.ErrNoRows):
			return RunEvent{}, ErrNotFound
		case strings.Contains(strings.ToLower(err.Error()), "unique constraint failed"):
			continue
		default:
			return RunEvent{}, fmt.Errorf("append data sync run event: %w", err)
		}
	}
	return RunEvent{}, errors.New("append data sync run event: sequence contention did not settle")
}

func (s *Store) ListRunEvents(ctx context.Context, runID string, afterSequence int64, limit int) ([]RunEvent, error) {
	if err := s.ensureOpen(); err != nil {
		return nil, err
	}
	if afterSequence < 0 {
		afterSequence = 0
	}
	if limit < 1 {
		limit = 200
	}
	if limit > 2000 {
		limit = 2000
	}
	rows, err := s.db.QueryContext(ctx, `SELECT run_id, job_id, sequence, event_type, status, current_item,
		total_items, table_name, stage, message, payload_json, created_at
		FROM data_sync_run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`,
		strings.TrimSpace(runID), afterSequence, limit)
	if err != nil {
		return nil, fmt.Errorf("list data sync run events: %w", err)
	}
	defer rows.Close()
	result := make([]RunEvent, 0)
	for rows.Next() {
		var event RunEvent
		var payload []byte
		if err := rows.Scan(&event.RunID, &event.JobID, &event.Sequence, &event.Type, &event.Status,
			&event.Current, &event.Total, &event.Table, &event.Stage, &event.Message, &payload, &event.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan data sync run event: %w", err)
		}
		event.Payload = cloneRaw(payload)
		result = append(result, event)
	}
	return result, rows.Err()
}

const runColumns = `id, job_id, owner_token, job_revision, trigger_kind, status, started_at, finished_at,
	parent_run_id, attempt, queued_at, heartbeat_at, current_item, total_items, table_name, stage,
	rows_inserted, rows_updated, rows_deleted, rows_failed, message, resumable, definition_snapshot,
	source_fingerprint, target_fingerprint, created_at, updated_at`

const runSelect = `SELECT ` + runColumns + ` FROM data_sync_runs`

const errorRowColumns = `id, run_id, job_id, source_table, target_table, operation, source_key_json, payload_json,
	payload_policy, payload_hash, payload_size, error_text, error_code, error_class, attempts, status,
	retry_owner, retry_lease_expires_at, created_at, updated_at`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanJob(scanner rowScanner) (JobDefinition, error) {
	var payload []byte
	var nextRunAt, lastScheduledAt, archivedAt int64
	if err := scanner.Scan(&payload, &nextRunAt, &lastScheduledAt, &archivedAt); errors.Is(err, sql.ErrNoRows) {
		return JobDefinition{}, ErrNotFound
	} else if err != nil {
		return JobDefinition{}, fmt.Errorf("scan data sync job: %w", err)
	}
	var definition JobDefinition
	if err := json.Unmarshal(payload, &definition); err != nil {
		return JobDefinition{}, fmt.Errorf("decode data sync job: %w", err)
	}
	definition.NextRunAt = nextRunAt
	definition.LastScheduledAt = lastScheduledAt
	definition.ArchivedAt = archivedAt
	return definition, nil
}

func scanJobs(rows *sql.Rows) ([]JobDefinition, error) {
	result := make([]JobDefinition, 0)
	for rows.Next() {
		definition, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, definition)
	}
	return result, rows.Err()
}

func scanRun(scanner rowScanner) (RunRecord, error) {
	var run RunRecord
	var resumable int
	var snapshot []byte
	err := scanner.Scan(&run.ID, &run.JobID, &run.OwnerToken, &run.JobRevision, &run.Trigger, &run.Status,
		&run.StartedAt, &run.FinishedAt, &run.ParentRunID, &run.Attempt, &run.QueuedAt, &run.HeartbeatAt,
		&run.Current, &run.Total, &run.Table, &run.Stage,
		&run.RowsInserted, &run.RowsUpdated, &run.RowsDeleted, &run.RowsFailed, &run.Message,
		&resumable, &snapshot, &run.SourceFingerprint, &run.TargetFingerprint, &run.CreatedAt, &run.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return RunRecord{}, ErrNotFound
	}
	if err != nil {
		return RunRecord{}, fmt.Errorf("scan data sync run: %w", err)
	}
	run.Resumable = resumable != 0
	run.DefinitionSnapshot = cloneRaw(snapshot)
	return run, nil
}

func scanErrorRow(scanner rowScanner) (ErrorRow, error) {
	var row ErrorRow
	var sourceKey, payload []byte
	err := scanner.Scan(&row.ID, &row.RunID, &row.JobID, &row.SourceTable, &row.TargetTable,
		&row.Operation, &sourceKey, &payload, &row.PayloadPolicy, &row.PayloadHash, &row.PayloadSize,
		&row.Error, &row.ErrorCode, &row.ErrorClass, &row.Attempts, &row.Status, &row.RetryOwner,
		&row.RetryLeaseExpiresAt, &row.CreatedAt, &row.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrorRow{}, ErrNotFound
	}
	if err != nil {
		return ErrorRow{}, fmt.Errorf("scan data sync error row: %w", err)
	}
	row.SourceKey = cloneRaw(sourceKey)
	row.Payload = cloneRaw(payload)
	return row, nil
}

func (s *Store) ensureOpen() error {
	if s == nil || s.db == nil {
		return ErrClosed
	}
	return nil
}

func requireAffected(result sql.Result) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrNotFound
	}
	return nil
}

func requireOwnedAffected(result sql.Result) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrRunOwnershipLost
	}
	return nil
}

func requireUnownedAffected(result sql.Result) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return ErrRunOwnershipLost
	}
	return nil
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullableBytes(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return []byte(raw)
}

func cloneRaw(raw []byte) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

func sqliteDSN(path string) string {
	uriPath := filepath.ToSlash(path)
	dsn := &url.URL{Scheme: "file", Path: uriPath}
	if runtime.GOOS == "windows" {
		if strings.HasPrefix(uriPath, "//") {
			withoutPrefix := strings.TrimPrefix(uriPath, "//")
			if separator := strings.IndexByte(withoutPrefix, '/'); separator >= 0 {
				dsn.Host = withoutPrefix[:separator]
				dsn.Path = withoutPrefix[separator:]
			}
		} else if !strings.HasPrefix(uriPath, "/") {
			dsn.Path = "/" + uriPath
		}
	}
	query := url.Values{}
	for _, pragma := range []string{"busy_timeout(5000)", "foreign_keys(ON)", "synchronous(FULL)", "journal_mode(WAL)"} {
		query.Add("_pragma", pragma)
	}
	query.Set("_txlock", "immediate")
	dsn.RawQuery = query.Encode()
	return dsn.String()
}
