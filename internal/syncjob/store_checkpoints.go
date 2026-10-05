package syncjob

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

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
