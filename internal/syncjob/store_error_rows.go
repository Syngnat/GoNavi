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
