package sqlaudit

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// 初始化和升级共享 SQLite 写锁，避免多进程同时检查和添加列。
func (s *Store) initialize() error {
	return s.withImmediate(func(conn *sql.Conn) error { return initializeSchema(conn) })
}

func initializeSchema(conn *sql.Conn) error {
	ctx := context.Background()
	var existingSchemaVersion int
	if err := conn.QueryRowContext(ctx, `PRAGMA user_version`).Scan(&existingSchemaVersion); err != nil {
		return fmt.Errorf("read SQL audit schema version: %w", err)
	}
	if existingSchemaVersion > schemaVersion {
		return fmt.Errorf("SQL audit schema version %d is newer than supported version %d", existingSchemaVersion, schemaVersion)
	}

	statements := []string{
		`CREATE TABLE IF NOT EXISTS sql_audit_events (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			timestamp INTEGER NOT NULL,
			event_type TEXT NOT NULL,
			status TEXT NOT NULL,
			connection_id TEXT NOT NULL DEFAULT '',
			connection_fingerprint TEXT NOT NULL,
			db_type TEXT NOT NULL DEFAULT '',
			database_name TEXT NOT NULL DEFAULT '',
			query_id TEXT NOT NULL DEFAULT '',
			transaction_id TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT '',
			boundary_mode TEXT NOT NULL DEFAULT 'unknown',
			commit_mode TEXT NOT NULL DEFAULT '',
			sql_text TEXT NOT NULL DEFAULT '',
			sql_redacted INTEGER NOT NULL DEFAULT 1,
			sql_fingerprint TEXT NOT NULL,
			statement_index INTEGER NOT NULL DEFAULT 0,
			statement_count INTEGER NOT NULL DEFAULT 0,
			executed_count INTEGER NOT NULL DEFAULT 0,
			failed_index INTEGER NOT NULL DEFAULT 0,
			outcome_unknown INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			rows_affected INTEGER NOT NULL DEFAULT 0,
			rows_returned INTEGER NOT NULL DEFAULT 0,
			error_text TEXT NOT NULL DEFAULT '',
			prev_hash TEXT NOT NULL DEFAULT '',
			record_hash TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_sql_audit_events_timestamp ON sql_audit_events(timestamp DESC, sequence DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_sql_audit_events_connection ON sql_audit_events(connection_id, timestamp DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_sql_audit_events_transaction ON sql_audit_events(transaction_id, sequence)`,
		`CREATE INDEX IF NOT EXISTS idx_sql_audit_events_type_status ON sql_audit_events(event_type, status, timestamp DESC)`,
		`CREATE TABLE IF NOT EXISTS sql_audit_settings (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			enabled INTEGER NOT NULL,
			capture_mode TEXT NOT NULL,
			retention_days INTEGER NOT NULL,
			max_records INTEGER NOT NULL
		)`,
		`INSERT OR IGNORE INTO sql_audit_settings(singleton, enabled, capture_mode, retention_days, max_records)
		 VALUES(1, 1, 'redacted', 30, 100000)`,
	}
	for _, statement := range statements {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize sql audit database: %w", err)
		}
	}
	for _, column := range []struct {
		name       string
		definition string
	}{
		{name: "mcp_request_id", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "mcp_client", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "user_name", definition: "TEXT NOT NULL DEFAULT ''"},
		{name: "executed_count", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "failed_index", definition: "INTEGER NOT NULL DEFAULT 0"},
		{name: "outcome_unknown", definition: "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := ensureEventColumn(ctx, conn, column.name, column.definition); err != nil {
			return err
		}
	}
	if _, err := conn.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_sql_audit_events_mcp_request ON sql_audit_events(mcp_request_id, sequence)`); err != nil {
		return fmt.Errorf("index MCP audit requests: %w", err)
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", schemaVersion)); err != nil {
		return fmt.Errorf("set SQL audit schema version: %w", err)
	}
	return nil
}

func ensureEventColumn(ctx context.Context, conn *sql.Conn, name, definition string) error {
	rows, err := conn.QueryContext(ctx, `PRAGMA table_info(sql_audit_events)`)
	if err != nil {
		return fmt.Errorf("inspect SQL audit event columns: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var columnName, columnType string
		var notNull int
		var defaultValue any
		var primaryKey int
		if err := rows.Scan(&cid, &columnName, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return fmt.Errorf("scan SQL audit event column: %w", err)
		}
		if strings.EqualFold(columnName, name) {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate SQL audit event columns: %w", err)
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("ALTER TABLE sql_audit_events ADD COLUMN %s %s", name, definition)); err != nil {
		return fmt.Errorf("migrate SQL audit event column %s: %w", name, err)
	}
	return nil
}
