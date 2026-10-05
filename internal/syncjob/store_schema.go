package syncjob

import (
	"context"
	"database/sql"
	"fmt"
)

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
			FOREIGN KEY(job_id) REFERENCES data_sync_jobs(id) ON DELETE CASCADE
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
	if version < 5 {
		if err := migrateCheckpointRunHistoryReference(ctx, s.db); err != nil {
			return err
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

// Checkpoints are task recovery state, not disposable run history. Removing
// the run foreign key allows users to clean terminal history without losing a
// durable resume position; deleting the parent job still cascades normally.
func migrateCheckpointRunHistoryReference(ctx context.Context, database *sql.DB) error {
	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin checkpoint history migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `CREATE TABLE data_sync_checkpoints_replacement (
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
		FOREIGN KEY(job_id) REFERENCES data_sync_jobs(id) ON DELETE CASCADE
	)`); err != nil {
		return fmt.Errorf("create replacement data sync checkpoints: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO data_sync_checkpoints_replacement(
		job_id, version, kind, run_id, definition_revision, table_name, phase,
		cursor_type, cursor_json, watermark_json, batch_sequence, schema_hash, updated_at
	) SELECT job_id, version, kind, run_id, definition_revision, table_name, phase,
		cursor_type, cursor_json, watermark_json, batch_sequence, schema_hash, updated_at
		FROM data_sync_checkpoints`); err != nil {
		return fmt.Errorf("copy data sync checkpoints: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DROP TABLE data_sync_checkpoints`); err != nil {
		return fmt.Errorf("drop legacy data sync checkpoints: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `ALTER TABLE data_sync_checkpoints_replacement RENAME TO data_sync_checkpoints`); err != nil {
		return fmt.Errorf("rename migrated data sync checkpoints: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit checkpoint history migration: %w", err)
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
