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

	_ "modernc.org/sqlite"
)

const storeSchemaVersion = 5

var (
	ErrClosed                     = errors.New("data sync job store is closed")
	ErrNotFound                   = errors.New("data sync job record not found")
	ErrRevisionConflict           = errors.New("data sync job revision conflict")
	ErrRunAlreadyActive           = errors.New("data sync job already has an unfinished run")
	ErrJobRunsActive              = errors.New("data sync job cannot be deleted while runs are active")
	ErrRunNotCancelable           = errors.New("data sync run cannot be canceled")
	ErrRunNotDeletable            = errors.New("data sync run cannot be deleted while it is active")
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
