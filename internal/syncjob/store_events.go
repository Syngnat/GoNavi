package syncjob

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

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
