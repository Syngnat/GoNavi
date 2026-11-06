package sqlaudit

import (
	"context"
	"database/sql"
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

const (
	schemaVersion       = 4
	maxRetentionDays    = 3650
	maxConfiguredEvents = 10_000_000
)

var (
	ErrClosed                 = errors.New("sql audit store is closed")
	ErrBatchExceedsMaxRecords = errors.New("sql audit batch exceeds configured max records")
)

type Store struct {
	db   *sql.DB
	path string
}

func Open(path string) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("sql audit database path is empty")
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve sql audit database path: %w", err)
	}
	dir := filepath.Dir(absPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create sql audit directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("secure sql audit directory: %w", err)
	}

	database, err := sql.Open("sqlite", sqliteAuditDSN(absPath))
	if err != nil {
		return nil, fmt.Errorf("open sql audit database: %w", err)
	}
	database.SetMaxOpenConns(4)
	database.SetMaxIdleConns(4)
	store := &Store{db: database, path: absPath}
	if err := store.initialize(); err != nil {
		_ = database.Close()
		return nil, err
	}
	if err := os.Chmod(absPath, 0o600); err != nil {
		_ = database.Close()
		return nil, fmt.Errorf("secure sql audit database: %w", err)
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
	// Consolidate WAL content before a data-root migration or application exit.
	// App lifecycle locking ensures no new store operation starts during Close.
	_, checkpointErr := s.db.ExecContext(context.Background(), `PRAGMA wal_checkpoint(TRUNCATE)`)
	err := errors.Join(checkpointErr, s.db.Close())
	s.db = nil
	return err
}

func sqliteAuditDSN(path string) string {
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
	for _, pragma := range []string{
		"busy_timeout(5000)",
		"foreign_keys(ON)",
		"synchronous(FULL)",
		"journal_mode(WAL)",
	} {
		query.Add("_pragma", pragma)
	}
	dsn.RawQuery = query.Encode()
	return dsn.String()
}

// Append adds one terminal audit fact. When auditing is disabled this method is
// a successful no-op. SQL and error text are sanitized before the transaction.
func (s *Store) Append(event Event) error {
	return s.AppendBatch([]Event{event})
}

// AppendControl persists an audit-control event even when ordinary collection
// is disabled. It is reserved for settings and purge boundaries so disabling
// or clearing the audit stream cannot create an unmarked control-plane window.
func (s *Store) AppendControl(event Event) error {
	return s.appendBatch([]Event{event}, true)
}

// AppendBatch persists related facts in one durable SQLite transaction. It is
// primarily used for the statements executed inside one managed transaction,
// avoiding one FULL-sync round trip per statement while keeping the complete
// batch visible before the database transaction is returned to the caller.
func (s *Store) AppendBatch(events []Event) error {
	return s.appendBatch(events, false)
}

func (s *Store) appendBatch(events []Event, bypassDisabled bool) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	if len(events) == 0 {
		return nil
	}
	inputEvents := events

	return s.withImmediate(func(conn *sql.Conn) error {
		settings, err := getSettingsFrom(conn)
		if err != nil {
			return err
		}
		if !settings.Enabled && !bypassDisabled {
			return nil
		}
		return appendEventsLocked(conn, settings, inputEvents)
	})
}

func appendEventsLocked(conn *sql.Conn, settings Settings, inputEvents []Event) error {
	if len(inputEvents) > settings.MaxRecords {
		return fmt.Errorf(
			"%w: batch=%d limit=%d",
			ErrBatchExceedsMaxRecords,
			len(inputEvents),
			settings.MaxRecords,
		)
	}
	prepared := append([]Event(nil), inputEvents...)
	now := time.Now().UnixMilli()
	for index := range prepared {
		event := &prepared[index]
		if event.Timestamp <= 0 {
			event.Timestamp = now
		}
		if strings.TrimSpace(event.ID) == "" {
			event.ID = uuid.NewString()
		} else {
			event.ID = sanitizeLabel(event.ID, 256)
		}
		if strings.TrimSpace(event.EventType) == "" {
			return fmt.Errorf("sql audit event %d type is required", index+1)
		}
		if strings.TrimSpace(event.Status) == "" {
			return fmt.Errorf("sql audit event %d status is required", index+1)
		}
	}
	if _, err := pruneLocked(conn, settings, time.Now(), int64(len(prepared))); err != nil {
		return err
	}

	var previousHash string
	err := conn.QueryRowContext(context.Background(),
		`SELECT record_hash FROM sql_audit_events ORDER BY sequence DESC LIMIT 1`,
	).Scan(&previousHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read sql audit chain head: %w", err)
	}
	for index := range prepared {
		event := sanitizeEvent(prepared[index], settings)
		event.PrevHash = previousHash

		result, err := conn.ExecContext(context.Background(), `INSERT INTO sql_audit_events(
			id, timestamp, event_type, status, connection_id, connection_fingerprint,
			db_type, database_name, query_id, transaction_id, source, boundary_mode,
			commit_mode, sql_text, sql_redacted, sql_fingerprint, statement_index,
			statement_count, executed_count, failed_index, outcome_unknown, duration_ms, rows_affected, rows_returned, error_text,
			prev_hash, record_hash, mcp_request_id, mcp_client, user_name
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			event.ID, event.Timestamp, event.EventType, event.Status, event.ConnectionID,
			event.ConnectionFingerprint, event.DBType, event.Database, event.QueryID,
			event.TransactionID, event.Source, event.BoundaryMode, event.CommitMode,
			event.SQLText, boolToInt(event.SQLRedacted), event.SQLFingerprint,
			event.StatementIndex, event.StatementCount, event.ExecutedCount, event.FailedIndex, boolToInt(event.OutcomeUnknown), event.DurationMs,
			event.RowsAffected, event.RowsReturned, event.Error, event.PrevHash, "", event.MCPRequestID, event.MCPClient, event.UserName,
		)
		if err != nil {
			return fmt.Errorf("append sql audit event %d: %w", index+1, err)
		}
		event.Sequence, err = result.LastInsertId()
		if err != nil {
			return fmt.Errorf("read sql audit sequence for event %d: %w", index+1, err)
		}
		event.Hash, err = calculateEventHash(event)
		if err != nil {
			return err
		}
		if _, err := conn.ExecContext(context.Background(),
			`UPDATE sql_audit_events SET record_hash=? WHERE sequence=?`, event.Hash, event.Sequence,
		); err != nil {
			return fmt.Errorf("finalize sql audit event %d hash: %w", index+1, err)
		}
		previousHash = event.Hash
	}
	return nil
}

func (s *Store) Query(filter Filter) (Page, error) {
	if err := s.ensureOpen(); err != nil {
		return Page{}, err
	}
	filter = normalizeFilter(filter)
	where, args := buildFilterWhere(filter)
	page := Page{Items: []Event{}, Page: filter.Page, PageSize: filter.PageSize}

	summarySQL := `SELECT COUNT(*),
		COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0),
		COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END), 0),
		COUNT(DISTINCT CASE WHEN transaction_id <> '' THEN transaction_id END)
		FROM sql_audit_events` + where
	if err := s.db.QueryRowContext(context.Background(), summarySQL, args...).Scan(
		&page.Summary.TotalEvents,
		&page.Summary.SuccessCount,
		&page.Summary.ErrorCount,
		&page.Summary.TransactionCount,
	); err != nil {
		return Page{}, fmt.Errorf("summarize sql audit events: %w", err)
	}
	page.Total = page.Summary.TotalEvents

	queryArgs := append(append([]any{}, args...), filter.PageSize, (filter.Page-1)*filter.PageSize)
	rows, err := s.db.QueryContext(context.Background(), selectEventColumns+where+
		` ORDER BY timestamp DESC, sequence DESC LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return Page{}, fmt.Errorf("query sql audit events: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		event, err := scanEvent(rows)
		if err != nil {
			return Page{}, err
		}
		page.Items = append(page.Items, event)
	}
	if err := rows.Err(); err != nil {
		return Page{}, fmt.Errorf("iterate sql audit events: %w", err)
	}
	return page, nil
}

func (s *Store) UpdateSettings(settings Settings) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	normalized, err := normalizeSettings(settings)
	if err != nil {
		return err
	}
	return s.withImmediate(func(conn *sql.Conn) error {
		if _, err := conn.ExecContext(context.Background(), `UPDATE sql_audit_settings
			SET enabled=?, capture_mode=?, retention_days=?, max_records=? WHERE singleton=1`,
			boolToInt(normalized.Enabled), normalized.CaptureMode,
			normalized.RetentionDays, normalized.MaxRecords,
		); err != nil {
			return fmt.Errorf("update sql audit settings: %w", err)
		}
		_, err := pruneLocked(conn, normalized, time.Now(), 0)
		return err
	})
}

// UpdateSettingsWithControl atomically applies settings and appends a
// non-disableable control boundary describing the old and new safe values.
func (s *Store) UpdateSettingsWithControl(settings Settings, control Event) error {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	normalized, err := normalizeSettings(settings)
	if err != nil {
		return err
	}
	return s.withImmediate(func(conn *sql.Conn) error {
		previous, err := getSettingsFrom(conn)
		if err != nil {
			return err
		}
		if _, err := conn.ExecContext(context.Background(), `UPDATE sql_audit_settings
			SET enabled=?, capture_mode=?, retention_days=?, max_records=? WHERE singleton=1`,
			boolToInt(normalized.Enabled), normalized.CaptureMode,
			normalized.RetentionDays, normalized.MaxRecords,
		); err != nil {
			return fmt.Errorf("update sql audit settings: %w", err)
		}
		control.DBType = "gonavi"
		control.SQLText = settingsControlDescriptor(previous, normalized)
		return appendEventsLocked(conn, controlAuditSettings(normalized), []Event{control})
	})
}

// Control descriptors contain only GoNavi-owned structural metadata. Keep
// them visible even when ordinary events use metadata-only capture, otherwise
// disable/retention/purge boundaries would lose the values needed to explain
// an audit window.
func controlAuditSettings(settings Settings) Settings {
	settings.CaptureMode = CaptureModeRedacted
	return settings
}

func settingsControlDescriptor(previous, next Settings) string {
	return fmt.Sprintf(
		"AUDIT SETTINGS FROM_ENABLED_%s TO_ENABLED_%s FROM_CAPTURE_%s TO_CAPTURE_%s FROM_RETENTION_DAYS_%d TO_RETENTION_DAYS_%d FROM_MAX_RECORDS_%d TO_MAX_RECORDS_%d",
		settingsBoolToken(previous.Enabled),
		settingsBoolToken(next.Enabled),
		strings.ToUpper(previous.CaptureMode),
		strings.ToUpper(next.CaptureMode),
		previous.RetentionDays,
		next.RetentionDays,
		previous.MaxRecords,
		next.MaxRecords,
	)
}

func settingsBoolToken(value bool) string {
	if value {
		return "ON"
	}
	return "OFF"
}

func (s *Store) GetSettings() (Settings, error) {
	if err := s.ensureOpen(); err != nil {
		return Settings{}, err
	}
	return getSettingsFrom(s.db)
}

// Clear deletes the oldest contiguous sequence prefix whose timestamps are
// older than beforeTimestamp. A non-positive timestamp clears all events.
// Remaining records and their hashes are never rewritten; integrity checks
// report a truncated/partial chain when a retained first record still points
// at a deleted predecessor.
func (s *Store) Clear(beforeTimestamp int64) (int64, error) {
	if err := s.ensureOpen(); err != nil {
		return 0, err
	}
	var deleted int64
	err := s.withImmediate(func(conn *sql.Conn) error {
		var err error
		if beforeTimestamp <= 0 {
			deleted, err = deleteAllLocked(conn)
		} else {
			deleted, err = deleteTimestampPrefixLocked(conn, beforeTimestamp)
		}
		return err
	})
	return deleted, err
}

// ClearWithControl atomically removes the selected prefix and appends a control
// boundary that remains visible even when ordinary collection is disabled.
func (s *Store) ClearWithControl(beforeTimestamp int64, control Event) (int64, error) {
	if err := s.ensureOpen(); err != nil {
		return 0, err
	}
	var deleted int64
	err := s.withImmediate(func(conn *sql.Conn) error {
		settings, err := getSettingsFrom(conn)
		if err != nil {
			return err
		}
		if beforeTimestamp <= 0 {
			deleted, err = deleteAllLocked(conn)
			control.SQLText = "AUDIT CLEAR ALL"
		} else {
			deleted, err = deleteTimestampPrefixLocked(conn, beforeTimestamp)
			control.SQLText = fmt.Sprintf("AUDIT CLEAR BEFORE_TIMESTAMP_%d", beforeTimestamp)
		}
		if err != nil {
			return err
		}
		control.DBType = "gonavi"
		control.RowsAffected = deleted
		return appendEventsLocked(conn, controlAuditSettings(settings), []Event{control})
	})
	return deleted, err
}

func (s *Store) ensureOpen() error {
	if s == nil || s.db == nil {
		return ErrClosed
	}
	return nil
}

func (s *Store) withImmediate(operation func(*sql.Conn) error) (resultErr error) {
	if err := s.ensureOpen(); err != nil {
		return err
	}
	ctx := context.Background()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire sql audit connection: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, conn.Close()) }()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("begin sql audit transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_, rollbackErr := conn.ExecContext(context.Background(), "ROLLBACK")
			resultErr = errors.Join(resultErr, rollbackErr)
		}
	}()
	if operation != nil {
		if err := operation(conn); err != nil {
			return err
		}
	}
	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("commit sql audit transaction: %w", err)
	}
	committed = true
	return nil
}

type queryRower interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func getSettingsFrom(queryer queryRower) (Settings, error) {
	var enabled int
	var settings Settings
	err := queryer.QueryRowContext(context.Background(), `SELECT enabled, capture_mode, retention_days, max_records
		FROM sql_audit_settings WHERE singleton=1`).Scan(
		&enabled, &settings.CaptureMode, &settings.RetentionDays, &settings.MaxRecords,
	)
	if err != nil {
		return Settings{}, fmt.Errorf("read sql audit settings: %w", err)
	}
	settings.Enabled = enabled != 0
	normalized, err := normalizeSettings(settings)
	if err != nil {
		return Settings{}, fmt.Errorf("invalid persisted sql audit settings: %w", err)
	}
	return normalized, nil
}

func normalizeSettings(settings Settings) (Settings, error) {
	settings.CaptureMode = strings.ToLower(strings.TrimSpace(settings.CaptureMode))
	if settings.CaptureMode == "" {
		settings.CaptureMode = CaptureModeRedacted
	}
	if settings.CaptureMode != CaptureModeRedacted && settings.CaptureMode != CaptureModeMetadata {
		return Settings{}, fmt.Errorf("unsupported SQL audit capture mode %q", settings.CaptureMode)
	}
	if settings.RetentionDays <= 0 {
		settings.RetentionDays = defaultRetentionDays
	}
	if settings.RetentionDays > maxRetentionDays {
		return Settings{}, fmt.Errorf("SQL audit retention days cannot exceed %d", maxRetentionDays)
	}
	if settings.MaxRecords <= 0 {
		settings.MaxRecords = defaultMaxRecords
	}
	if settings.MaxRecords > maxConfiguredEvents {
		return Settings{}, fmt.Errorf("SQL audit max records cannot exceed %d", maxConfiguredEvents)
	}
	return settings, nil
}

func normalizeFilter(filter Filter) Filter {
	filter.Search = truncateRunes(strings.TrimSpace(filter.Search), 512)
	filter.ConnectionID = strings.TrimSpace(filter.ConnectionID)
	filter.Database = strings.TrimSpace(filter.Database)
	filter.DBType = strings.ToLower(strings.TrimSpace(filter.DBType))
	filter.EventType = strings.ToLower(strings.TrimSpace(filter.EventType))
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	filter.TransactionID = strings.TrimSpace(filter.TransactionID)
	filter.Source = strings.ToLower(strings.TrimSpace(filter.Source))
	filter.MCPRequestID = strings.TrimSpace(filter.MCPRequestID)
	if filter.Page <= 0 {
		filter.Page = 1
	}
	if filter.PageSize <= 0 {
		filter.PageSize = defaultPageSize
	}
	if filter.PageSize > maxPageSize {
		filter.PageSize = maxPageSize
	}
	return filter
}

func buildFilterWhere(filter Filter) (string, []any) {
	conditions := make([]string, 0, 11)
	args := make([]any, 0, 12)
	if filter.ExecutionHistory {
		sources := `source = 'query_editor'`
		if filter.IncludeMCP {
			sources = `source IN ('query_editor', 'mcp')`
		}
		conditions = append(conditions, `(`+sources+` AND (
			event_type = 'query'
			OR event_type = 'transaction_statement'
			OR (event_type = 'transaction_begin' AND status <> 'success')
		))`)
	}
	if filter.Search != "" {
		pattern := "%" + escapeLike(filter.Search) + "%"
		conditions = append(conditions, `(sql_text LIKE ? ESCAPE '\' OR error_text LIKE ? ESCAPE '\'
			OR connection_id LIKE ? ESCAPE '\' OR connection_fingerprint LIKE ? ESCAPE '\'
			OR database_name LIKE ? ESCAPE '\' OR db_type LIKE ? ESCAPE '\'
			OR query_id LIKE ? ESCAPE '\' OR transaction_id LIKE ? ESCAPE '\'
			OR sql_fingerprint LIKE ? ESCAPE '\' OR source LIKE ? ESCAPE '\')`)
		for range 10 {
			args = append(args, pattern)
		}
	}
	appendExact := func(column string, value string) {
		if value == "" {
			return
		}
		conditions = append(conditions, column+" = ?")
		args = append(args, value)
	}
	appendExact("connection_id", filter.ConnectionID)
	appendExact("database_name", filter.Database)
	appendExact("db_type", filter.DBType)
	appendExact("event_type", filter.EventType)
	appendExact("status", filter.Status)
	appendExact("transaction_id", filter.TransactionID)
	appendExact("source", filter.Source)
	appendExact("mcp_request_id", filter.MCPRequestID)
	if filter.FromTimestamp > 0 {
		conditions = append(conditions, "timestamp >= ?")
		args = append(args, filter.FromTimestamp)
	}
	if filter.ToTimestamp > 0 {
		conditions = append(conditions, "timestamp <= ?")
		args = append(args, filter.ToTimestamp)
	}
	if len(conditions) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(conditions, " AND "), args
}

func escapeLike(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func pruneLocked(conn *sql.Conn, settings Settings, now time.Time, reserve int64) (int64, error) {
	var deleted int64
	cutoff := now.Add(-time.Duration(settings.RetentionDays) * 24 * time.Hour).UnixMilli()
	expired, err := deleteTimestampPrefixLocked(conn, cutoff)
	if err != nil {
		return 0, fmt.Errorf("prune expired sql audit events: %w", err)
	}
	deleted += expired

	var current int64
	if err := conn.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM sql_audit_events`).Scan(&current); err != nil {
		return 0, fmt.Errorf("count sql audit events: %w", err)
	}
	target := int64(settings.MaxRecords) - reserve
	if target < 0 {
		target = 0
	}
	if current > target {
		removeCount := current - target
		result, err := conn.ExecContext(context.Background(), `DELETE FROM sql_audit_events WHERE sequence IN (
			SELECT sequence FROM sql_audit_events ORDER BY sequence ASC LIMIT ?
		)`, removeCount)
		if err != nil {
			return 0, fmt.Errorf("enforce sql audit record limit: %w", err)
		}
		if count, err := result.RowsAffected(); err == nil {
			deleted += count
		}
	}
	return deleted, nil
}

func deleteAllLocked(conn *sql.Conn) (int64, error) {
	result, err := conn.ExecContext(context.Background(), `DELETE FROM sql_audit_events`)
	if err != nil {
		return 0, fmt.Errorf("clear SQL audit events: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("count cleared SQL audit events: %w", err)
	}
	return deleted, nil
}

// deleteTimestampPrefixLocked never removes an event after the first retained
// sequence, even when a caller supplied an out-of-order timestamp. This keeps
// every remaining adjacency and record hash untouched.
func deleteTimestampPrefixLocked(conn *sql.Conn, beforeTimestamp int64) (int64, error) {
	var firstRetainedSequence int64
	err := conn.QueryRowContext(context.Background(), `SELECT sequence FROM sql_audit_events
		WHERE timestamp >= ? ORDER BY sequence ASC LIMIT 1`, beforeTimestamp).Scan(&firstRetainedSequence)
	if errors.Is(err, sql.ErrNoRows) {
		return deleteAllLocked(conn)
	}
	if err != nil {
		return 0, fmt.Errorf("locate SQL audit retention boundary: %w", err)
	}
	result, err := conn.ExecContext(context.Background(),
		`DELETE FROM sql_audit_events WHERE sequence < ?`, firstRetainedSequence)
	if err != nil {
		return 0, fmt.Errorf("delete SQL audit sequence prefix: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("count deleted SQL audit sequence prefix: %w", err)
	}
	return deleted, nil
}
func boolToInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
