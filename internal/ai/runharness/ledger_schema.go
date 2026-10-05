package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

func (l *Ledger) initialize(ctx context.Context) error {
	for _, pragma := range []string{
		"PRAGMA busy_timeout=5000", "PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=FULL", "PRAGMA foreign_keys=ON",
	} {
		if _, err := l.db.ExecContext(ctx, pragma); err != nil {
			return fmt.Errorf("configure agent ledger (%s): %w", pragma, err)
		}
	}
	var version int
	if err := l.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read agent ledger schema version: %w", err)
	}
	if version > ledgerSchemaVersion {
		return fmt.Errorf("agent ledger schema version %d is newer than supported %d", version, ledgerSchemaVersion)
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY, revision INTEGER NOT NULL, generation INTEGER NOT NULL,
			title BLOB NOT NULL, parent_session_id TEXT, branch_from_message_id TEXT,
			branch_from_sequence INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			run_id TEXT, sequence INTEGER NOT NULL, role TEXT NOT NULL,
			content BLOB NOT NULL, metadata BLOB, created_at INTEGER NOT NULL,
			UNIQUE(session_id, sequence))`,
		`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, sequence)`,
		`CREATE TABLE IF NOT EXISTS runs (
				id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
				request_id TEXT UNIQUE, task_kind TEXT NOT NULL DEFAULT 'chat', allow_tools INTEGER NOT NULL DEFAULT 1,
				session_generation INTEGER NOT NULL,
			state TEXT NOT NULL, revision INTEGER NOT NULL, attempt INTEGER NOT NULL,
			next_sequence INTEGER NOT NULL DEFAULT 1, owner_id TEXT, owner_token TEXT,
			owner_expires_at INTEGER NOT NULL DEFAULT 0, checkpoint_id TEXT,
			terminal_reason BLOB, policy BLOB NOT NULL, provider TEXT, model TEXT,
			thinking TEXT, temperature REAL, max_tokens INTEGER,
			provider_binding BLOB,
			context_source_id TEXT, context_source_instance_id TEXT,
			tool_catalog_binding BLOB, tool_catalog_hash TEXT,
			tool_catalog_revision INTEGER NOT NULL DEFAULT 0,
			active_duration_ns INTEGER NOT NULL DEFAULT 0,
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			total_tokens INTEGER NOT NULL DEFAULT 0,
			reserved_tokens INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_runs_session_state ON runs(session_id, state, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_runs_owner_expiry ON runs(owner_expires_at)`,
		`CREATE TABLE IF NOT EXISTS events (
			run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL, schema_version INTEGER NOT NULL,
			kind TEXT NOT NULL, resulting_state TEXT NOT NULL,
			run_revision INTEGER NOT NULL, attempt INTEGER NOT NULL,
			timestamp INTEGER NOT NULL, payload BLOB NOT NULL,
			PRIMARY KEY(run_id, sequence))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_terminal ON events(run_id) WHERE kind = 'terminal'`,
		`CREATE TABLE IF NOT EXISTS checkpoints (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL, state TEXT NOT NULL,
			conversation_cursor BLOB, provider_state BLOB, workspace_snapshot BLOB,
			created_at INTEGER NOT NULL,
			UNIQUE(run_id, sequence))`,
		`CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, sequence DESC)`,
		`CREATE TABLE IF NOT EXISTS tool_calls (
			run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			call_id TEXT NOT NULL, attempt INTEGER NOT NULL, tool_name TEXT NOT NULL,
				effect TEXT NOT NULL, status TEXT NOT NULL, args_hash TEXT NOT NULL,
				arguments BLOB NOT NULL, result BLOB, result_hash TEXT, error_code TEXT,
				unknown_outcome INTEGER NOT NULL DEFAULT 0, workspace_snapshot BLOB,
				result_original_bytes INTEGER NOT NULL DEFAULT 0,
				result_truncated INTEGER NOT NULL DEFAULT 0,
				started_at INTEGER NOT NULL, completed_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(run_id, call_id, attempt))`,
		`CREATE TABLE IF NOT EXISTS approvals (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			call_id TEXT NOT NULL, tool_name TEXT NOT NULL, effect TEXT NOT NULL,
			args_hash TEXT NOT NULL, arguments BLOB NOT NULL, status TEXT NOT NULL,
			run_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER NOT NULL DEFAULT 0,
			UNIQUE(run_id, call_id, args_hash))`,
		`CREATE TABLE IF NOT EXISTS queued_inputs (
			id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
			content BLOB NOT NULL, dispatch_mode TEXT NOT NULL, context_source_id TEXT,
			context_source_instance_id TEXT,
			created_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_queued_inputs_session ON queued_inputs(session_id, consumed_at, created_at)`,
		`CREATE TABLE IF NOT EXISTS control_commands (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			action TEXT NOT NULL, payload BLOB, expected_revision INTEGER NOT NULL DEFAULT 0,
			result_snapshot BLOB,
			created_at INTEGER NOT NULL, consumed_at INTEGER NOT NULL DEFAULT 0,
			claimed_by TEXT, claimed_at INTEGER NOT NULL DEFAULT 0,
			claim_expires_at INTEGER NOT NULL DEFAULT 0,
			applied_at INTEGER NOT NULL DEFAULT 0)`,
		// Keep this first-pass index compatible with ledgers created before the
		// claim/ack columns; the extended index is added after ensureColumn below.
		`CREATE INDEX IF NOT EXISTS idx_control_commands_run ON control_commands(run_id, consumed_at, created_at)`,
		`CREATE TABLE IF NOT EXISTS steer_requests (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			content_hash TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
			created_at INTEGER NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_steer_requests_run ON steer_requests(run_id, created_at)`,
		`CREATE TABLE IF NOT EXISTS workspace_snapshots (
			source_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, revision INTEGER NOT NULL,
			content_hash TEXT NOT NULL, captured_at INTEGER NOT NULL, payload BLOB NOT NULL,
			lease_expires_at INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(source_id, source_instance_id, revision))`,
		`CREATE INDEX IF NOT EXISTS idx_workspace_latest ON workspace_snapshots(source_id, source_instance_id, revision DESC)`,
		`CREATE TABLE IF NOT EXISTS migration_records (
			source_path TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, migrated_at INTEGER NOT NULL,
			payload BLOB)`,
		`CREATE TABLE IF NOT EXISTS token_reservations (
			id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
			reserved_tokens INTEGER NOT NULL, prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL, committed_sequence INTEGER NOT NULL DEFAULT 0,
			committed_revision INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL, reconciled_at INTEGER NOT NULL DEFAULT 0)`,
		`CREATE INDEX IF NOT EXISTS idx_token_reservations_run ON token_reservations(run_id, status, created_at)`,
	}
	for _, statement := range statements {
		if _, err := l.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize agent ledger: %w", err)
		}
	}
	// Schema version 1 did not have the explicit unknown-outcome marker. The
	// additive migration is deliberately idempotent so an interrupted startup
	// can be retried without losing any ledger rows.
	if err := ensureColumn(ctx, l.db, "tool_calls", "unknown_outcome", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	for _, column := range []struct{ name, definition string }{
		{"task_kind", "TEXT NOT NULL DEFAULT 'chat'"},
		{"allow_tools", "INTEGER NOT NULL DEFAULT 1"},
		{"thinking", "TEXT"}, {"temperature", "REAL"}, {"max_tokens", "INTEGER"},
		{"provider_binding", "BLOB"},
		{"context_source_instance_id", "TEXT"},
		{"prompt_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"completion_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"total_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"reserved_tokens", "INTEGER NOT NULL DEFAULT 0"},
		{"tool_catalog_binding", "BLOB"},
		{"tool_catalog_hash", "TEXT"},
		{"tool_catalog_revision", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := ensureColumn(ctx, l.db, "runs", column.name, column.definition); err != nil {
			return fmt.Errorf("migrate agent ledger: %w", err)
		}
	}
	for _, column := range []struct{ name, definition string }{
		{"parent_session_id", "TEXT"},
		{"branch_from_message_id", "TEXT"},
		{"branch_from_sequence", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := ensureColumn(ctx, l.db, "sessions", column.name, column.definition); err != nil {
			return fmt.Errorf("migrate agent ledger: %w", err)
		}
	}
	if err := ensureColumn(ctx, l.db, "queued_inputs", "context_source_instance_id", "TEXT"); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	if err := ensureColumn(ctx, l.db, "control_commands", "expected_revision", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	for _, column := range []struct{ name, definition string }{
		{"claimed_by", "TEXT"},
		{"claimed_at", "INTEGER NOT NULL DEFAULT 0"},
		{"claim_expires_at", "INTEGER NOT NULL DEFAULT 0"},
		{"applied_at", "INTEGER NOT NULL DEFAULT 0"},
		// result_snapshot is written only for synchronous recovery commands. It
		// makes a retried idempotency key return the projection committed by the
		// original command even after a worker has advanced the live run.
		{"result_snapshot", "BLOB"},
	} {
		if err := ensureColumn(ctx, l.db, "control_commands", column.name, column.definition); err != nil {
			return fmt.Errorf("migrate agent ledger: %w", err)
		}
	}
	if _, err := l.db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_control_commands_claim ON control_commands(run_id, consumed_at, applied_at, created_at)`); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	if err := ensureColumn(ctx, l.db, "migration_records", "payload", "BLOB"); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	for _, column := range []struct{ name, definition string }{
		{"committed_sequence", "INTEGER NOT NULL DEFAULT 0"},
		{"committed_revision", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := ensureColumn(ctx, l.db, "token_reservations", column.name, column.definition); err != nil {
			return fmt.Errorf("migrate agent ledger: %w", err)
		}
	}
	if err := ensureColumn(ctx, l.db, "checkpoints", "workspace_snapshot", "BLOB"); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	if err := ensureColumn(ctx, l.db, "tool_calls", "workspace_snapshot", "BLOB"); err != nil {
		return fmt.Errorf("migrate agent ledger: %w", err)
	}
	for _, column := range []struct{ name, definition string }{
		{"result_original_bytes", "INTEGER NOT NULL DEFAULT 0"},
		{"result_truncated", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := ensureColumn(ctx, l.db, "tool_calls", column.name, column.definition); err != nil {
			return fmt.Errorf("migrate agent ledger: %w", err)
		}
	}
	if _, err := l.db.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", ledgerSchemaVersion)); err != nil {
		return fmt.Errorf("set agent ledger schema version: %w", err)
	}
	return nil
}

func ensureColumn(ctx context.Context, db *sql.DB, table, column, definition string) error {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var found bool
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull, pk int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return err
		}
		if name == column {
			found = true
			break
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if found {
		return nil
	}
	_, err = db.ExecContext(ctx, `ALTER TABLE `+table+` ADD COLUMN `+column+` `+definition)
	return err
}

func beginTx(ctx context.Context, db *sql.DB) (*sql.Tx, error) {
	return db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
}

func nowUTC() time.Time { return time.Now().UTC() }

func toNano(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixNano()
}

func fromNano(v int64) time.Time {
	if v == 0 {
		return time.Time{}
	}
	return time.Unix(0, v).UTC()
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func (l *Ledger) seal(table, id, field string, value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return l.cipher.Encrypt(data, []byte(fmt.Sprintf("gonavi/agent-ledger/v%d/%s/%s/%s", CurrentSchemaVersion, table, id, field)))
}

func (l *Ledger) sealRaw(table, id, field string, data []byte) ([]byte, error) {
	return l.cipher.Encrypt(data, []byte(fmt.Sprintf("gonavi/agent-ledger/v%d/%s/%s/%s", CurrentSchemaVersion, table, id, field)))
}

func (l *Ledger) openRaw(table, id, field string, data []byte) ([]byte, error) {
	return l.cipher.Decrypt(data, []byte(fmt.Sprintf("gonavi/agent-ledger/v%d/%s/%s/%s", CurrentSchemaVersion, table, id, field)))
}

func (l *Ledger) openJSON(table, id, field string, data []byte, out any) error {
	plain, err := l.openRaw(table, id, field, data)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(plain, out); err != nil {
		return fmt.Errorf("decode ledger %s: %w", field, err)
	}
	return nil
}
