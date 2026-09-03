package runharness

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

var (
	ErrClosed   = errors.New("agent ledger is closed")
	ErrNotFound = errors.New("agent ledger record not found")
	// ErrRevisionConflict is intentionally a stable adapter-visible error code.
	// Callers use errors.Is for Go control flow and can reliably surface the
	// same code over Wails/CLI when a revision guard rejects a stale mutation.
	ErrRevisionConflict    = errors.New("revision_conflict")
	ErrSequenceConflict    = errors.New("agent ledger event sequence conflict")
	ErrRunAlreadyActive    = errors.New("agent session already has an active run")
	ErrTerminalRun         = errors.New("agent run is terminal")
	ErrLeaseLost           = errors.New("agent run lease was lost")
	ErrLeaseUnavailable    = errors.New("agent run lease is held by another owner")
	ErrSnapshotConflict    = errors.New("workspace snapshot revision conflict")
	ErrApprovalConflict    = errors.New("approval is no longer valid")
	ErrToolConflict        = errors.New("agent tool call conflicts with an existing call")
	ErrToolStatus          = errors.New("invalid agent tool call status")
	ErrSnapshotExpired     = errors.New("workspace snapshot lease expired")
	ErrSnapshotLeaseConfig = errors.New("workspace snapshot lease duration must be positive")
	ErrLedgerLocked        = errors.New("agent ledger is locked")
	ErrTokenBudgetExceeded = errors.New("agent run token budget exceeded")
	ErrTokenReservation    = errors.New("agent token reservation is invalid")
	ErrInvalidBranchCursor = errors.New("agent session branch cursor must be a user message")
	ErrBranchConflict      = errors.New("agent session branch conflicts with an existing session")
	// ErrControlCommandConflict means an idempotency key was reused for a
	// different control command.  Treating this as a successful duplicate can
	// silently apply the wrong cancel/steer/approval action across processes.
	ErrControlCommandConflict = errors.New("agent control command conflicts with existing command")
	// ErrControlCommandClaimLost means an owner tried to acknowledge a command
	// after its claim expired or was replaced by another owner.
	ErrControlCommandClaimLost = errors.New("agent control command claim was lost")
)

const ledgerSchemaVersion = 12

type ledgerConfig struct {
	keyProvider               KeyProvider
	workspaceSnapshotLeaseTTL time.Duration
}

// LedgerOption customizes Open. Encryption is mandatory; callers must provide
// a key provider or use the default OS keyring provider.
type LedgerOption func(*ledgerConfig) error

func WithKeyProvider(provider KeyProvider) LedgerOption {
	return func(cfg *ledgerConfig) error {
		if provider == nil {
			return ErrInvalidKey
		}
		cfg.keyProvider = provider
		return nil
	}
}

func WithKey(key []byte) LedgerOption {
	return func(cfg *ledgerConfig) error {
		provider, err := NewStaticKeyProvider(key)
		if err != nil {
			return err
		}
		cfg.keyProvider = provider
		return nil
	}
}

func WithKeyFile(path string) LedgerOption {
	return func(cfg *ledgerConfig) error {
		provider, err := NewKeyFileProvider(path)
		if err != nil {
			return err
		}
		cfg.keyProvider = provider
		return nil
	}
}

// WithKeyring selects an OS keyring entry. The store argument may be nil to
// use the platform default.
func WithKeyring(ref string, store interface {
	Put(string, []byte) error
	Get(string) ([]byte, error)
	Delete(string) error
	HealthCheck() error
}) LedgerOption {
	return func(cfg *ledgerConfig) error {
		// Keep this adapter interface local so callers do not need to import the
		// concrete secret-store package just to configure the ledger.
		provider, err := newKeyringProviderFromInterface(ref, store)
		if err != nil {
			return err
		}
		cfg.keyProvider = provider
		return nil
	}
}

// WithWorkspaceSnapshotLeaseDuration configures the liveness window applied
// to newly published (and repeated heartbeat) workspace snapshots. A zero
// value leaves the shared default unchanged; negative values are rejected so
// a caller cannot accidentally make every snapshot immediately stale.
func WithWorkspaceSnapshotLeaseDuration(duration time.Duration) LedgerOption {
	return func(cfg *ledgerConfig) error {
		if duration < 0 {
			return ErrSnapshotLeaseConfig
		}
		if duration > 0 {
			cfg.workspaceSnapshotLeaseTTL = duration
		}
		return nil
	}
}

// WithWorkspaceSnapshotLeaseTTL is an alias kept for callers that use the
// database terminology. Both options update the same Ledger setting.
func WithWorkspaceSnapshotLeaseTTL(duration time.Duration) LedgerOption {
	return WithWorkspaceSnapshotLeaseDuration(duration)
}

// Ledger is a concurrency-safe encrypted SQLite event ledger.
type Ledger struct {
	db                        *sql.DB
	path                      string
	cipher                    *Cipher
	workspaceSnapshotLeaseTTL time.Duration
	mu                        sync.RWMutex
	closed                    atomic.Bool
}

// Open opens or creates an encrypted ledger. The default key provider is the
// platform keyring; tests and headless deployments should pass WithKey or
// WithKeyFile explicitly.
func Open(path string, options ...LedgerOption) (*Ledger, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("agent ledger path is empty")
	}
	cfg := ledgerConfig{}
	for _, option := range options {
		if option == nil {
			continue
		}
		if err := option(&cfg); err != nil {
			return nil, err
		}
	}
	if cfg.keyProvider == nil {
		provider, err := NewKeyringKeyProvider("", nil)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrLedgerLocked, err)
		}
		cfg.keyProvider = provider
	}
	workspaceSnapshotLeaseTTL := cfg.workspaceSnapshotLeaseTTL
	if workspaceSnapshotLeaseTTL <= 0 {
		workspaceSnapshotLeaseTTL = DefaultWorkspaceSnapshotLeaseDuration
	}
	dsn, absPath, err := ledgerDSN(path)
	if err != nil {
		return nil, err
	}

	var loaded LoadedKey
	var keyErr error
	if loader, canLoad := cfg.keyProvider.(KeyLoader); canLoad && ledgerFileHasContent(absPath) {
		// An existing ledger must never trigger key generation. Minting a key
		// writes it straight into the key store, overwriting the original entry
		// right when access is granted again (macOS reports a denied Keychain
		// ACL prompt as "item not found"). Load passively and refuse when the
		// key is gone so a denied prompt stays fully recoverable.
		var found bool
		loaded, found, keyErr = loader.LoadExisting()
		if keyErr == nil && !found {
			return nil, fmt.Errorf("%w: existing agent ledger %s has no matching encryption key in the key store; refusing to generate a new key because it would overwrite the original. Restore the original key or archive the ledger file to start a new one", ErrLedgerLocked, absPath)
		}
	} else if detailed, ok := cfg.keyProvider.(DetailedKeyProvider); ok {
		loaded, keyErr = detailed.LoadOrCreateDetailed()
	} else {
		var classicKey []byte
		classicKey, keyErr = cfg.keyProvider.LoadOrCreate()
		loaded = LoadedKey{Key: classicKey}
	}
	if keyErr != nil {
		return nil, fmt.Errorf("%w: %v", ErrLedgerLocked, keyErr)
	}
	// Providers that cannot load passively (test fakes and legacy hosts) still
	// get the post-hoc guard: a freshly minted key in front of an existing
	// ledger means the original was lost — proceeding would silently re-key
	// the ledger and permanently lock out every existing row.
	if loaded.Fresh && ledgerFileHasContent(absPath) {
		return nil, fmt.Errorf("%w: existing agent ledger %s does not match the available encryption key; refusing to re-key existing data. Restore the original keyring entry or archive the ledger file to start a new one", ErrLedgerLocked, absPath)
	}
	key := loaded.Key
	cipherImpl, err := NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLedgerLocked, err)
	}

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open agent ledger: %w", err)
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(8)
	if path == ":memory:" {
		// A plain :memory: database is private to each SQLite connection. Keep
		// one connection so reads and writes always observe the initialized
		// schema; file-backed ledgers retain a small pool for adapters.
		db.SetMaxOpenConns(1)
		db.SetMaxIdleConns(1)
	}
	l := &Ledger{db: db, path: absPath, cipher: cipherImpl, workspaceSnapshotLeaseTTL: workspaceSnapshotLeaseTTL}
	if err := l.initialize(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := l.reconcileKeyFingerprint(context.Background(), loaded); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Legacy sessions live beside the ordinary file-backed ledger. Import them
	// during the first open so every adapter observes one source of truth. URI
	// and in-memory DSNs are intentionally excluded: their directory semantics
	// are caller-owned (and may not map to a local data root).
	if sessionsDir, ok := legacySessionsDirForLedger(absPath); ok {
		if _, err := l.MigrateLegacySessions(context.Background(), sessionsDir); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("migrate legacy agent sessions: %w", err)
		}
	}
	if absPath != ":memory:" && !strings.HasPrefix(absPath, "file:") {
		if err := os.Chmod(absPath, 0o600); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("secure agent ledger: %w", err)
		}
	}
	return l, nil
}

func legacySessionsDirForLedger(absPath string) (string, bool) {
	if absPath == "" || absPath == ":memory:" || strings.HasPrefix(absPath, "file:") {
		return "", false
	}
	return filepath.Join(filepath.Dir(absPath), "sessions"), true
}

const ledgerMetaKeyFingerprint = "key_fingerprint"

// ledgerFileHasContent reports whether a file-backed ledger already holds
// data. In-memory and URI DSNs are caller-owned and never count as existing
// content.
func ledgerFileHasContent(absPath string) bool {
	if absPath == "" || absPath == ":memory:" || strings.HasPrefix(absPath, "file:") {
		return false
	}
	info, err := os.Stat(absPath)
	return err == nil && info.Size() > 0
}

func keyFingerprint(key []byte) string {
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:])
}

// reconcileKeyFingerprint detects key/ledger mismatches at open time instead
// of letting AES-GCM authentication failures surface mid-conversation. A
// missing fingerprint on an existing ledger is only adopted after a sample
// payload decrypts, so a silently re-keyed ledger fails fast with an
// actionable error rather than staying undiagnosable.
func (l *Ledger) reconcileKeyFingerprint(ctx context.Context, loaded LoadedKey) error {
	fingerprint := keyFingerprint(loaded.Key)
	var stored string
	err := l.db.QueryRowContext(ctx, `SELECT value FROM ledger_meta WHERE key = ?`, ledgerMetaKeyFingerprint).Scan(&stored)
	switch {
	case err == nil:
		if stored != fingerprint {
			return fmt.Errorf("%w: agent ledger was encrypted with a different key; the keyring entry no longer matches this ledger. Restore the original key or archive the ledger file to start a new one", ErrLedgerLocked)
		}
		return nil
	case errors.Is(err, sql.ErrNoRows):
		// Adopt the fingerprint below, after verifying the key against
		// pre-existing data when there is any.
	default:
		return fmt.Errorf("read agent ledger key fingerprint: %w", err)
	}
	if !loaded.Fresh {
		if err := l.verifySamplePayloadDecryptable(ctx); err != nil {
			return err
		}
	}
	if _, err := l.db.ExecContext(ctx, `INSERT INTO ledger_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, ledgerMetaKeyFingerprint, fingerprint); err != nil {
		return fmt.Errorf("store agent ledger key fingerprint: %w", err)
	}
	return nil
}

// verifySamplePayloadDecryptable proves the loaded key matches data already
// stored in this ledger by decrypting one sealed value from the newest rows.
func (l *Ledger) verifySamplePayloadDecryptable(ctx context.Context) error {
	var runID string
	var sequence int64
	var payload []byte
	err := l.db.QueryRowContext(ctx, `SELECT run_id, sequence, payload FROM events ORDER BY timestamp DESC LIMIT 1`).Scan(&runID, &sequence, &payload)
	if err == nil {
		if _, err := l.openRaw("events", runID, fmt.Sprintf("payload/%d", sequence), payload); err != nil {
			return fmt.Errorf("%w: sample event decrypt failed: %v", ErrLedgerLocked, err)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("sample agent ledger event: %w", err)
	}
	var messageID string
	var content []byte
	err = l.db.QueryRowContext(ctx, `SELECT id, content FROM messages ORDER BY created_at DESC LIMIT 1`).Scan(&messageID, &content)
	if err == nil {
		if _, err := l.openRaw("messages", messageID, "content", content); err != nil {
			return fmt.Errorf("%w: sample message decrypt failed: %v", ErrLedgerLocked, err)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("sample agent ledger message: %w", err)
	}
	var snapshotKey string
	var snapshotPayload []byte
	err = l.db.QueryRowContext(ctx, `SELECT source_id || '/' || source_instance_id || '/' || revision, payload FROM workspace_snapshots ORDER BY captured_at DESC LIMIT 1`).Scan(&snapshotKey, &snapshotPayload)
	if err == nil {
		if _, err := l.openRaw("workspace_snapshots", snapshotKey, "payload", snapshotPayload); err != nil {
			return fmt.Errorf("%w: sample workspace snapshot decrypt failed: %v", ErrLedgerLocked, err)
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("sample agent ledger workspace snapshot: %w", err)
	}
	return nil
}

// OpenWithKey is a convenience for callers with a securely obtained DEK.
func OpenWithKey(path string, key []byte) (*Ledger, error) { return Open(path, WithKey(key)) }

func ledgerDSN(path string) (dsn, absPath string, err error) {
	if path == ":memory:" || strings.HasPrefix(path, "file:") {
		return path, path, nil
	}
	absPath, err = filepath.Abs(path)
	if err != nil {
		return "", "", fmt.Errorf("resolve agent ledger path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absPath), 0o700); err != nil {
		return "", "", fmt.Errorf("create agent ledger directory: %w", err)
	}
	// Use the same file URI form as the rest of the repository. PathEscape is
	// unsuitable here because it escapes the path's '/' separators.
	uri := &url.URL{Scheme: "file", Path: filepath.ToSlash(absPath)}
	if runtime.GOOS == "windows" && !strings.HasPrefix(uri.Path, "/") {
		uri.Path = "/" + uri.Path
	}
	query := url.Values{}
	for _, pragma := range []string{"busy_timeout(5000)", "foreign_keys(ON)", "synchronous(FULL)", "journal_mode(WAL)"} {
		query.Add("_pragma", pragma)
	}
	query.Set("_txlock", "immediate")
	uri.RawQuery = query.Encode()
	return uri.String(), absPath, nil
}

func (l *Ledger) Path() string {
	if l == nil {
		return ""
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	return l.path
}

func (l *Ledger) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed.Load() {
		return nil
	}
	if l.db == nil {
		l.closed.Store(true)
		return nil
	}
	_, checkpointErr := l.db.ExecContext(context.Background(), `PRAGMA wal_checkpoint(TRUNCATE)`)
	closeErr := l.db.Close()
	l.db = nil
	l.closed.Store(true)
	return errors.Join(checkpointErr, closeErr)
}

func (l *Ledger) ensureOpen() error {
	if l == nil || l.db == nil || l.closed.Load() {
		return ErrClosed
	}
	return nil
}

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

func scanRun(scanner interface{ Scan(...any) error }, l *Ledger) (RunSnapshot, error) {
	var id, sessionID, state, taskKind string
	var requestID, ownerID, ownerToken, checkpointID, provider, model, thinking, contextSource, contextSourceInstance, toolCatalogHash sql.NullString
	var generation, revision, attempt, nextSequence, ownerExpires, activeNS, promptTokens, completionTokens, totalTokens, reservedTokens, created, updated int64
	var toolCatalogRevision int64
	var allowTools int
	var terminalBlob, policyBlob, providerBindingBlob, toolCatalogBindingBlob []byte
	var temperature sql.NullFloat64
	var maxTokens sql.NullInt64
	if err := scanner.Scan(&id, &sessionID, &requestID, &taskKind, &allowTools, &generation, &state, &revision, &attempt, &nextSequence,
		&ownerID, &ownerToken, &ownerExpires, &checkpointID, &terminalBlob, &policyBlob,
		&provider, &model, &thinking, &temperature, &maxTokens, &providerBindingBlob, &contextSource, &contextSourceInstance,
		&toolCatalogBindingBlob, &toolCatalogHash, &toolCatalogRevision,
		&activeNS, &promptTokens, &completionTokens, &totalTokens, &reservedTokens, &created, &updated); err != nil {
		return RunSnapshot{}, err
	}
	snapshot := RunSnapshot{ID: id, SessionID: sessionID, RequestID: requestID.String, TaskKind: AgentTaskKind(taskKind).Normalize(), AllowTools: allowTools != 0, SessionGeneration: generation, State: RunState(state), Revision: revision,
		Attempt: int(attempt), NextSequence: nextSequence, ownerToken: ownerToken.String, OwnerExpiresAt: fromNano(ownerExpires),
		CheckpointID: checkpointID.String, Provider: provider.String, Model: model.String, ContextSourceID: contextSource.String, ContextSourceInstanceID: contextSourceInstance.String,
		ToolCatalogHash: toolCatalogHash.String, ToolCatalogRevision: toolCatalogRevision,
		CreatedAt: fromNano(created), UpdatedAt: fromNano(updated), ActiveDurationMS: activeNS / 1e6,
		PromptTokens: int(promptTokens), CompletionTokens: int(completionTokens), TotalTokens: int(totalTokens), ReservedTokens: int(reservedTokens),
		Thinking: thinking.String}
	if temperature.Valid {
		v := temperature.Float64
		snapshot.Temperature = &v
	}
	if maxTokens.Valid {
		v := int(maxTokens.Int64)
		snapshot.MaxTokens = &v
	}
	if len(terminalBlob) > 0 {
		if err := l.openJSON("runs", id, "terminal_reason", terminalBlob, &snapshot.TerminalReason); err != nil {
			return RunSnapshot{}, err
		}
	}
	if len(policyBlob) > 0 {
		if err := l.openJSON("runs", id, "policy", policyBlob, &snapshot.Policy); err != nil {
			return RunSnapshot{}, err
		}
	}
	return snapshot, nil
}

const runColumns = `id, session_id, request_id, task_kind, allow_tools, session_generation, state, revision, attempt, next_sequence,
 owner_id, owner_token, owner_expires_at, checkpoint_id, terminal_reason, policy,
 provider, model, thinking, temperature, max_tokens, provider_binding, context_source_id, context_source_instance_id,
 tool_catalog_binding, tool_catalog_hash, tool_catalog_revision,
 active_duration_ns, prompt_tokens, completion_tokens, total_tokens, reserved_tokens, created_at, updated_at`

func (l *Ledger) getRunTx(ctx context.Context, tx *sql.Tx, runID string) (RunSnapshot, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id=?`, runID)
	snapshot, err := scanRun(row, l)
	if errors.Is(err, sql.ErrNoRows) {
		return RunSnapshot{}, ErrNotFound
	}
	return snapshot, err
}

func (l *Ledger) GetRun(ctx context.Context, runID string) (RunSnapshot, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, runID)
}

// GetRunByRequestID returns the run durably associated with an input
// idempotency key.  Request IDs are unique across the ledger, so looking up
// the existing run before validating mutable provider/tool state lets a
// retried submission return the original receipt even while the host is
// reconfiguring.  Keep this lookup read-only and map SQL's no-row result to
// the ledger's stable ErrNotFound sentinel.
func (l *Ledger) GetRunByRequestID(ctx context.Context, requestID string) (RunSnapshot, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return RunSnapshot{}, ErrNotFound
	}
	var runID string
	if err := l.db.QueryRowContext(ctx, `SELECT id FROM runs WHERE request_id=?`, requestID).Scan(&runID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RunSnapshot{}, ErrNotFound
		}
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, runID)
}

// GetControlCommand returns the durable command associated with a control
// idempotency key. Its payload is decrypted only within the Ledger boundary.
func (l *Ledger) GetControlCommand(ctx context.Context, commandID string) (ControlCommand, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ControlCommand{}, err
	}
	commandID = strings.TrimSpace(commandID)
	if commandID == "" {
		return ControlCommand{}, ErrNotFound
	}
	var runID, action string
	var sealedPayload []byte
	var expectedRevision, createdAt, consumedAt int64
	err := l.db.QueryRowContext(ctx, `SELECT run_id,action,payload,expected_revision,created_at,consumed_at FROM control_commands WHERE id=?`, commandID).
		Scan(&runID, &action, &sealedPayload, &expectedRevision, &createdAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlCommand{}, ErrNotFound
	}
	if err != nil {
		return ControlCommand{}, err
	}
	payload, err := l.openRaw("control_commands", commandID, "payload", sealedPayload)
	if err != nil {
		return ControlCommand{}, err
	}
	return ControlCommand{
		ID: commandID, RunID: runID, Action: RunControlAction(action),
		Payload: append(json.RawMessage(nil), payload...), ExpectedRevision: expectedRevision,
		CreatedAt: fromNano(createdAt), ConsumedAt: fromNano(consumedAt),
	}, nil
}

// GetProviderBinding returns the immutable provider contract captured when a
// run was accepted. The encrypted payload is decrypted only inside the
// Ledger boundary and is never attached to RunSnapshot projections.
func (l *Ledger) GetProviderBinding(ctx context.Context, runID string) (ProviderBinding, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ProviderBinding{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return ProviderBinding{}, ErrNotFound
	}
	var blob []byte
	var provider sql.NullString
	if err := l.db.QueryRowContext(ctx, `SELECT provider, provider_binding FROM runs WHERE id=?`, runID).Scan(&provider, &blob); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ProviderBinding{}, ErrNotFound
		}
		return ProviderBinding{}, err
	}
	if len(blob) == 0 {
		return ProviderBinding{}, ErrProviderBindingUnbound
	}
	var binding ProviderBinding
	if err := l.openJSON("runs", runID, "provider_binding", blob, &binding); err != nil {
		return ProviderBinding{}, fmt.Errorf("%w: decrypt provider binding: %v", ErrProviderBindingCorrupt, err)
	}
	validated, err := binding.Validate()
	if err != nil {
		return ProviderBinding{}, fmt.Errorf("%w: %v", ErrProviderBindingCorrupt, err)
	}
	indexedProvider := strings.TrimSpace(provider.String)
	if !provider.Valid || indexedProvider == "" {
		return ProviderBinding{}, fmt.Errorf("%w: indexed provider is empty", ErrProviderBindingCorrupt)
	}
	if !strings.EqualFold(indexedProvider, validated.ProviderID) {
		return ProviderBinding{}, fmt.Errorf("%w: provider %q does not match binding %q", ErrProviderBindingCorrupt, provider.String, validated.ProviderID)
	}
	return validated, nil
}

// GetToolCatalogBinding returns the immutable catalog captured for a run. The
// descriptor payload is decrypted only inside the Ledger boundary; callers
// should use it for validation/execution and must not expose it as a run
// snapshot. Runs created by older ledger versions have no binding and return
// ErrToolCatalogUnbound.
func (l *Ledger) GetToolCatalogBinding(ctx context.Context, runID string) (ToolCatalogBinding, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ToolCatalogBinding{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return ToolCatalogBinding{}, ErrNotFound
	}
	var (
		blob      []byte
		indexHash sql.NullString
		indexRev  sql.NullInt64
	)
	if err := l.db.QueryRowContext(ctx, `SELECT tool_catalog_binding, tool_catalog_hash, tool_catalog_revision FROM runs WHERE id=?`, runID).Scan(&blob, &indexHash, &indexRev); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ToolCatalogBinding{}, ErrNotFound
		}
		return ToolCatalogBinding{}, err
	}
	if len(blob) == 0 {
		// A legacy/unbound run has no indexed identity either.  If only one side
		// exists, fail closed instead of silently treating an incomplete binding
		// as a valid legacy run.
		if strings.TrimSpace(indexHash.String) != "" || (indexRev.Valid && indexRev.Int64 != 0) {
			return ToolCatalogBinding{}, fmt.Errorf("%w: indexed metadata exists without encrypted descriptor", ErrToolCatalogBindingCorrupt)
		}
		return ToolCatalogBinding{}, ErrToolCatalogUnbound
	}
	var binding ToolCatalogBinding
	if err := l.openJSON("runs", runID, "tool_catalog_binding", blob, &binding); err != nil {
		return ToolCatalogBinding{}, err
	}
	validated, err := binding.Validate()
	if err != nil {
		return ToolCatalogBinding{}, err
	}
	// The hash and revision columns are an index/projection of the encrypted
	// binding.  They are not trusted merely because the ciphertext decrypted:
	// compare both values before handing descriptors to the harness.  A missing
	// index is corruption for a bound run, while hash comparison remains
	// case-insensitive to tolerate canonical hex casing from older ledgers.
	if !indexHash.Valid || strings.TrimSpace(indexHash.String) == "" {
		return ToolCatalogBinding{}, fmt.Errorf("%w: encrypted descriptor has no indexed hash", ErrToolCatalogBindingCorrupt)
	}
	if !strings.EqualFold(strings.TrimSpace(indexHash.String), validated.Hash) {
		return ToolCatalogBinding{}, fmt.Errorf("%w: indexed hash %q does not match binding hash %q", ErrToolCatalogBindingCorrupt, indexHash.String, validated.Hash)
	}
	if !indexRev.Valid || indexRev.Int64 != validated.Revision {
		return ToolCatalogBinding{}, fmt.Errorf("%w: indexed revision %d does not match binding revision %d", ErrToolCatalogBindingCorrupt, indexRev.Int64, validated.Revision)
	}
	return validated, nil
}

func (l *Ledger) getRunDB(ctx context.Context, runID string) (RunSnapshot, error) {
	row := l.db.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id=?`, runID)
	snapshot, err := scanRun(row, l)
	if errors.Is(err, sql.ErrNoRows) {
		return RunSnapshot{}, ErrNotFound
	}
	return snapshot, err
}

func (l *Ledger) CreateSession(ctx context.Context, request CreateSessionRequest) (SessionProjection, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	id := strings.TrimSpace(request.SessionID)
	if id == "" {
		id = uuid.NewString()
	}
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()
	if existing, err := l.getSessionTx(ctx, tx, id, false); err == nil {
		return existing, nil
	} else if !errors.Is(err, ErrNotFound) {
		return SessionProjection{}, err
	}
	titleBlob, err := l.seal("sessions", id, "title", strings.TrimSpace(request.Title))
	if err != nil {
		return SessionProjection{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, 1, 1, titleBlob, 0, toNano(now), toNano(now)); err != nil {
		return SessionProjection{}, err
	}
	if err := tx.Commit(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, id, false)
}

// CreateSessionBranch creates a new immutable transcript branch from a user
// message in an existing session. The source transcript remains unchanged;
// only messages strictly before the cursor are copied, so the caller's next
// input can replace or retry that user turn without rewriting completed work.
// A stable caller-provided SessionID makes retrying the same submission
// idempotent.
func (l *Ledger) CreateSessionBranch(ctx context.Context, request CreateSessionBranchRequest) (SessionProjection, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.SourceSessionID = strings.TrimSpace(request.SourceSessionID)
	request.BranchFromMessageID = strings.TrimSpace(request.BranchFromMessageID)
	if request.SessionID == "" || request.SourceSessionID == "" || request.BranchFromMessageID == "" {
		return SessionProjection{}, errors.New("sessionId, sourceSessionId, and branchFromMessageId are required")
	}
	if request.SessionID == request.SourceSessionID {
		return SessionProjection{}, ErrBranchConflict
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()

	// Idempotent replays must return precisely the branch created by the first
	// request. They must not create a second branch merely because the source
	// session has advanced after the original edit/retry was accepted.
	if existing, existingErr := l.getSessionTx(ctx, tx, request.SessionID, true); existingErr == nil {
		if existing.ParentSessionID != request.SourceSessionID ||
			existing.BranchFromMessageID != request.BranchFromMessageID {
			return SessionProjection{}, ErrBranchConflict
		}
		return existing, nil
	} else if !errors.Is(existingErr, ErrNotFound) {
		return SessionProjection{}, existingErr
	}

	var sourceRevision, sourceGeneration int64
	var sourceTitleBlob []byte
	if err := tx.QueryRowContext(ctx, `SELECT revision,generation,title FROM sessions WHERE id=?`, request.SourceSessionID).
		Scan(&sourceRevision, &sourceGeneration, &sourceTitleBlob); errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrNotFound
	} else if err != nil {
		return SessionProjection{}, err
	}
	if request.ExpectedSourceRevision > 0 && request.ExpectedSourceRevision != sourceRevision {
		return SessionProjection{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedSourceRevision, sourceRevision)
	}

	var cursorSequence int64
	var cursorRole string
	if err := tx.QueryRowContext(ctx, `SELECT sequence,role FROM messages WHERE id=? AND session_id=?`, request.BranchFromMessageID, request.SourceSessionID).
		Scan(&cursorSequence, &cursorRole); errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrInvalidBranchCursor
	} else if err != nil {
		return SessionProjection{}, err
	}
	if strings.TrimSpace(cursorRole) != "user" || cursorSequence <= 0 {
		return SessionProjection{}, ErrInvalidBranchCursor
	}

	title := strings.TrimSpace(request.Title)
	if title == "" {
		if err := l.openJSON("sessions", request.SourceSessionID, "title", sourceTitleBlob, &title); err != nil {
			return SessionProjection{}, err
		}
	}
	titleBlob, err := l.seal("sessions", request.SessionID, "title", title)
	if err != nil {
		return SessionProjection{}, err
	}
	now := nowUTC()
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,parent_session_id,branch_from_message_id,branch_from_sequence,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
		request.SessionID, 1, sourceGeneration+1, titleBlob, request.SourceSessionID, request.BranchFromMessageID, cursorSequence, 0, toNano(now), toNano(now)); err != nil {
		return SessionProjection{}, err
	}

	messages, err := l.getMessagesBeforeSequenceTx(ctx, tx, request.SourceSessionID, cursorSequence)
	if err != nil {
		return SessionProjection{}, err
	}
	for _, source := range messages {
		copy := source
		copy.ID = uuid.NewString()
		copy.SessionID = request.SessionID
		// The originating run belongs to the source session. Keeping it in the
		// branch would make a provider projection look like it can resume an old
		// tool execution, so branch copies intentionally become transcript-only.
		copy.RunID = ""
		copy.CreatedAt = now
		if err := l.appendMessageTx(ctx, tx, copy); err != nil {
			return SessionProjection{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, request.SessionID, true)
}

func (l *Ledger) ensureSessionTx(ctx context.Context, tx *sql.Tx, id, title string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		id = uuid.NewString()
	}
	var found string
	err := tx.QueryRowContext(ctx, `SELECT id FROM sessions WHERE id=?`, id).Scan(&found)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	now := nowUTC()
	titleBlob, err := l.seal("sessions", id, "title", strings.TrimSpace(title))
	if err != nil {
		return "", err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sessions(id,revision,generation,title,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`, id, 1, 1, titleBlob, 0, toNano(now), toNano(now)); err != nil {
		return "", err
	}
	return id, nil
}

func (l *Ledger) getSessionTx(ctx context.Context, tx *sql.Tx, id string, includeMessages bool) (SessionProjection, error) {
	var revision, generation, branchFromSequence, archived, created, updated int64
	var titleBlob []byte
	var parentSessionID, branchFromMessageID string
	err := tx.QueryRowContext(ctx, `SELECT id,revision,generation,title,COALESCE(parent_session_id,''),COALESCE(branch_from_message_id,''),branch_from_sequence,archived,created_at,updated_at FROM sessions WHERE id=?`, id).Scan(&id, &revision, &generation, &titleBlob, &parentSessionID, &branchFromMessageID, &branchFromSequence, &archived, &created, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrNotFound
	}
	if err != nil {
		return SessionProjection{}, err
	}
	var title string
	if err := l.openJSON("sessions", id, "title", titleBlob, &title); err != nil {
		return SessionProjection{}, err
	}
	projection := SessionProjection{ID: id, Title: title, Revision: revision, Generation: generation,
		ParentSessionID: parentSessionID, BranchFromMessageID: branchFromMessageID,
		BranchFromSequence: branchFromSequence, Archived: archived != 0,
		CreatedAt: fromNano(created), UpdatedAt: fromNano(updated)}
	rows, err := tx.QueryContext(ctx, `SELECT `+runColumns+` FROM runs WHERE session_id=? ORDER BY created_at,id`, id)
	if err != nil {
		return SessionProjection{}, err
	}
	for rows.Next() {
		run, scanErr := scanRun(rows, l)
		if scanErr != nil {
			rows.Close()
			return SessionProjection{}, scanErr
		}
		projection.Runs = append(projection.Runs, run)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return SessionProjection{}, err
	}
	rows.Close()
	if includeMessages {
		messages, err := l.getMessagesTx(ctx, tx, id, 0, 0)
		if err != nil {
			return SessionProjection{}, err
		}
		projection.Messages = messages
	}
	return projection, nil
}

func (l *Ledger) getSessionDB(ctx context.Context, id string, includeMessages bool) (SessionProjection, error) {
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()
	projection, err := l.getSessionTx(ctx, tx, id, includeMessages)
	if err != nil {
		return SessionProjection{}, err
	}
	return projection, nil
}

func (l *Ledger) GetSession(ctx context.Context, id string, includeMessages bool) (SessionProjection, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, strings.TrimSpace(id), includeMessages)
}

func (l *Ledger) MutateSession(ctx context.Context, request SessionMutationRequest) (SessionProjection, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SessionProjection{}, err
	}
	if strings.TrimSpace(request.SessionID) == "" {
		return SessionProjection{}, errors.New("sessionId is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SessionProjection{}, err
	}
	defer tx.Rollback()
	var revision, generation, archived int64
	var titleBlob []byte
	if err := tx.QueryRowContext(ctx, `SELECT revision,generation,archived,title FROM sessions WHERE id=?`, request.SessionID).Scan(&revision, &generation, &archived, &titleBlob); errors.Is(err, sql.ErrNoRows) {
		return SessionProjection{}, ErrNotFound
	} else if err != nil {
		return SessionProjection{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != revision {
		return SessionProjection{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, revision)
	}
	newRevision := revision + 1
	setTitle := titleBlob
	if request.Title != nil {
		setTitle, err = l.seal("sessions", request.SessionID, "title", strings.TrimSpace(*request.Title))
		if err != nil {
			return SessionProjection{}, err
		}
	}
	newArchived := archived
	if request.Archived != nil {
		newArchived = int64(boolInt(*request.Archived))
	}
	result, err := tx.ExecContext(ctx, `UPDATE sessions SET revision=?,title=?,archived=?,updated_at=? WHERE id=? AND revision=?`, newRevision, setTitle, newArchived, toNano(nowUTC()), request.SessionID, revision)
	if err != nil {
		return SessionProjection{}, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return SessionProjection{}, err
	} else if affected != 1 {
		return SessionProjection{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return SessionProjection{}, err
	}
	return l.getSessionDB(ctx, request.SessionID, true)
}

func (l *Ledger) ListSessions(ctx context.Context, request SessionListRequest) (SessionListResult, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return SessionListResult{}, err
	}
	limit := request.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset := request.Offset
	if offset < 0 {
		offset = 0
	}
	where := ""
	args := []any{}
	if request.ActiveOnly {
		where = ` WHERE archived=0 AND EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.state NOT IN ('completed','failed','canceled','exhausted'))`
	}
	var total int
	if err := l.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions s`+where, args...).Scan(&total); err != nil {
		return SessionListResult{}, err
	}
	rows, err := l.db.QueryContext(ctx, `SELECT id FROM sessions s`+where+` ORDER BY updated_at DESC LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return SessionListResult{}, err
	}
	// Materialize IDs before opening a read transaction for each projection.
	// Keeping rows open while calling getSessionDB can exhaust the SQLite pool
	// (the cursor pins one connection and each projection needs another).
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return SessionListResult{}, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return SessionListResult{}, err
	}
	if err := rows.Err(); err != nil {
		return SessionListResult{}, err
	}
	result := SessionListResult{Total: total, Sessions: make([]SessionProjection, 0, len(ids))}
	for _, id := range ids {
		projection, err := l.getSessionDB(ctx, id, false)
		if err != nil {
			return SessionListResult{}, err
		}
		result.Sessions = append(result.Sessions, projection)
	}
	return result, nil
}

// CreateRun creates a queued run and atomically records its initial user
// message, if provided. A duplicate requestId is idempotent.
func (l *Ledger) CreateRun(ctx context.Context, request CreateRunRequest) (RunSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunSnapshot{}, err
	}
	defer tx.Rollback()
	run, err := l.createRunTx(ctx, tx, request)
	if err != nil {
		return RunSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, run.ID)
}

// createRunTx is the transaction-scoped implementation shared by ordinary
// queue submissions and the steer/terminal race boundary. The caller owns the
// transaction and must commit it after this function returns.
func (l *Ledger) createRunTx(ctx context.Context, tx *sql.Tx, request CreateRunRequest) (RunSnapshot, error) {
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.Provider = strings.TrimSpace(request.Provider)
	if request.SessionID == "" {
		return RunSnapshot{}, errors.New("sessionId is required")
	}
	if request.Provider != "" && request.ProviderBinding == nil {
		return RunSnapshot{}, ErrProviderBindingUnbound
	}
	if request.Provider == "" && request.ProviderBinding != nil {
		return RunSnapshot{}, ErrProviderBindingUnbound
	}
	var validatedProviderBinding *ProviderBinding
	if request.ProviderBinding != nil {
		binding, bindingErr := request.ProviderBinding.Validate()
		if bindingErr != nil {
			return RunSnapshot{}, fmt.Errorf("%w: %v", ErrProviderBindingCorrupt, bindingErr)
		}
		if !strings.EqualFold(request.Provider, binding.ProviderID) {
			return RunSnapshot{}, fmt.Errorf("%w: provider %q does not match binding %q", ErrProviderBindingCorrupt, request.Provider, binding.ProviderID)
		}
		validatedProviderBinding = &binding
		request.Provider = binding.ProviderID
	}
	policy := request.Policy.Normalize()
	if err := policy.Validate(); err != nil {
		return RunSnapshot{}, err
	}
	taskKind := request.TaskKind.Normalize()
	if !taskKind.Valid() {
		return RunSnapshot{}, fmt.Errorf("invalid taskKind %q", request.TaskKind)
	}
	allowTools := true
	if request.AllowTools != nil {
		allowTools = *request.AllowTools
	}
	runID := strings.TrimSpace(request.RunID)
	if runID == "" {
		runID = uuid.NewString()
	}
	if request.RequestID != "" {
		var existing string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM runs WHERE request_id=?`, request.RequestID).Scan(&existing); err == nil {
			return l.getRunTx(ctx, tx, existing)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return RunSnapshot{}, err
		}
	}
	if _, err := l.ensureSessionTx(ctx, tx, request.SessionID, ""); err != nil {
		return RunSnapshot{}, err
	}
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT generation FROM sessions WHERE id=?`, request.SessionID).Scan(&generation); err != nil {
		return RunSnapshot{}, err
	}
	if request.ExpectedSessionRevision > 0 {
		var sessionRevision int64
		if err := tx.QueryRowContext(ctx, `SELECT revision FROM sessions WHERE id=?`, request.SessionID).Scan(&sessionRevision); err != nil {
			return RunSnapshot{}, err
		}
		if sessionRevision != request.ExpectedSessionRevision {
			return RunSnapshot{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedSessionRevision, sessionRevision)
		}
	}
	// A session may have one executing owner but an arbitrary durable FIFO
	// backlog.  The worker's ordering gate and lease CAS ensure that only the
	// oldest non-terminal run executes; rejecting here would make queue mode
	// unusable whenever a previous run is still active.
	now := nowUTC()
	policyBlob, err := l.seal("runs", runID, "policy", policy)
	if err != nil {
		return RunSnapshot{}, err
	}
	var providerBindingBlob []byte
	if validatedProviderBinding != nil {
		binding := *validatedProviderBinding
		providerBindingBlob, err = l.seal("runs", runID, "provider_binding", binding)
		if err != nil {
			return RunSnapshot{}, err
		}
	}
	var toolCatalogBindingBlob []byte
	var toolCatalogHash any
	var toolCatalogRevision int64
	if request.ToolCatalogBinding != nil {
		binding, bindingErr := request.ToolCatalogBinding.Validate()
		if bindingErr != nil {
			return RunSnapshot{}, bindingErr
		}
		toolCatalogBindingBlob, err = l.seal("runs", runID, "tool_catalog_binding", binding)
		if err != nil {
			return RunSnapshot{}, err
		}
		toolCatalogHash = binding.Hash
		toolCatalogRevision = binding.Revision
	}
	var temperature any
	if request.Temperature != nil {
		temperature = *request.Temperature
	}
	var maxTokens any
	if request.MaxTokens != nil {
		maxTokens = *request.MaxTokens
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO runs(id,session_id,request_id,task_kind,allow_tools,session_generation,state,revision,attempt,next_sequence,policy,provider,model,thinking,temperature,max_tokens,provider_binding,context_source_id,context_source_instance_id,tool_catalog_binding,tool_catalog_hash,tool_catalog_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, runID, request.SessionID, nullString(request.RequestID), taskKind, boolInt(allowTools), generation, RunStateQueued, 1, 1, 1, policyBlob, request.Provider, request.Model, request.Thinking, temperature, maxTokens, providerBindingBlob, request.ContextSourceID, request.ContextSourceInstanceID, toolCatalogBindingBlob, toolCatalogHash, toolCatalogRevision, toNano(now), toNano(now)); err != nil {
		return RunSnapshot{}, err
	}
	if request.InitialMessage != nil {
		message := *request.InitialMessage
		message.SessionID = request.SessionID
		message.RunID = runID
		if err := l.appendMessageTx(ctx, tx, message); err != nil {
			return RunSnapshot{}, err
		}
	}
	return l.getRunTx(ctx, tx, runID)
}

// EnqueueSteerOrCreateRun closes the small but important race between finding
// an active run and persisting a steer command. The target run and the command
// are inspected in the same SQLite transaction. If the target has reached a
// terminal/non-steerable state, the exact request id is instead used to create
// one queued run, so callers never receive a "steered" receipt for a command
// that can no longer be consumed.
func (l *Ledger) EnqueueSteerOrCreateRun(ctx context.Context, request SteerOrQueueRequest) (SteerOrQueueResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SteerOrQueueResult{}, err
	}
	command := request.Command
	command.ID = strings.TrimSpace(command.ID)
	command.RunID = strings.TrimSpace(command.RunID)
	command.Action = RunControlAction(strings.TrimSpace(string(command.Action)))
	if command.ID == "" {
		return SteerOrQueueResult{}, errors.New("commandId is required")
	}
	if command.RunID == "" {
		return SteerOrQueueResult{}, errors.New("runId is required")
	}
	if command.Action != ControlSteer {
		return SteerOrQueueResult{}, fmt.Errorf("unsupported steer action %q", command.Action)
	}
	if command.CreatedAt.IsZero() {
		command.CreatedAt = nowUTC()
	}
	payload := command.Payload
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	if !json.Valid(payload) {
		return SteerOrQueueResult{}, errors.New("command payload must be valid JSON")
	}
	create := request.CreateRun
	if strings.TrimSpace(create.RequestID) == "" {
		create.RequestID = command.ID
	}
	if create.RequestID != command.ID {
		return SteerOrQueueResult{}, fmt.Errorf("steer and queued request ids must match")
	}
	if strings.TrimSpace(create.SessionID) == "" {
		return SteerOrQueueResult{}, errors.New("sessionId is required for queued fallback")
	}
	sealed, err := l.sealRaw("control_commands", command.ID, "payload", payload)
	if err != nil {
		return SteerOrQueueResult{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SteerOrQueueResult{}, err
	}
	defer tx.Rollback()

	// Resolve either durable idempotency representation before reading mutable
	// run state. A retry after the command was applied may observe a terminal
	// target, but it must still return the original steered run.
	var existingRunID, existingAction string
	var existingPayload []byte
	var existingExpected, existingCreated int64
	existingErr := tx.QueryRowContext(ctx, `SELECT run_id,action,payload,expected_revision,created_at FROM control_commands WHERE id=?`, command.ID).
		Scan(&existingRunID, &existingAction, &existingPayload, &existingExpected, &existingCreated)
	if existingErr == nil {
		plain, openErr := l.openRaw("control_commands", command.ID, "payload", existingPayload)
		if openErr != nil {
			return SteerOrQueueResult{}, openErr
		}
		if existingRunID != command.RunID || RunControlAction(existingAction) != command.Action || existingExpected != command.ExpectedRevision ||
			!bytes.Equal(bytes.TrimSpace(plain), bytes.TrimSpace(payload)) {
			return SteerOrQueueResult{}, fmt.Errorf("%w: id %q is already bound to another steer", ErrControlCommandConflict, command.ID)
		}
		run, runErr := l.getRunTx(ctx, tx, existingRunID)
		if runErr != nil {
			return SteerOrQueueResult{}, runErr
		}
		if err := tx.Commit(); err != nil {
			return SteerOrQueueResult{}, err
		}
		return SteerOrQueueResult{Run: run, Disposition: "steered"}, nil
	} else if !errors.Is(existingErr, sql.ErrNoRows) {
		return SteerOrQueueResult{}, existingErr
	}
	// A prior terminal-race fallback is represented by the ordinary run
	// request_id rather than a control command.
	var existingQueuedID string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM runs WHERE request_id=?`, command.ID).Scan(&existingQueuedID); err == nil {
		run, runErr := l.getRunTx(ctx, tx, existingQueuedID)
		if runErr != nil {
			return SteerOrQueueResult{}, runErr
		}
		if err := tx.Commit(); err != nil {
			return SteerOrQueueResult{}, err
		}
		return SteerOrQueueResult{Run: run, Disposition: "queued"}, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return SteerOrQueueResult{}, err
	}

	target, targetErr := l.getRunTx(ctx, tx, command.RunID)
	if targetErr == nil {
		steerable := false
		switch target.State {
		case RunStateQueued, RunStateRunningModel, RunStateRunningTool,
			RunStateAwaitingApproval, RunStateAwaitingWorkspace:
			steerable = true
		}
		if steerable {
			if command.ExpectedRevision > 0 && command.ExpectedRevision != target.Revision {
				return SteerOrQueueResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, command.ExpectedRevision, target.Revision)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO control_commands(id,run_id,action,payload,expected_revision,created_at) VALUES(?,?,?,?,?,?)`, command.ID, command.RunID, command.Action, sealed, command.ExpectedRevision, toNano(command.CreatedAt)); err != nil {
				return SteerOrQueueResult{}, err
			}
			if err := tx.Commit(); err != nil {
				return SteerOrQueueResult{}, err
			}
			command.Payload = append(json.RawMessage(nil), payload...)
			return SteerOrQueueResult{Run: target, Disposition: "steered"}, nil
		}
	} else if !errors.Is(targetErr, ErrNotFound) {
		return SteerOrQueueResult{}, targetErr
	}

	// The target was terminal (or disappeared). Do not persist a command that
	// no worker can consume; createRunTx records the same request id atomically.
	create.InitialMessage = cloneMessagePointer(create.InitialMessage)
	run, createErr := l.createRunTx(ctx, tx, create)
	if createErr != nil {
		return SteerOrQueueResult{}, createErr
	}
	if err := tx.Commit(); err != nil {
		return SteerOrQueueResult{}, err
	}
	return SteerOrQueueResult{Run: run, Disposition: "queued"}, nil
}

func cloneMessagePointer(message *Message) *Message {
	if message == nil {
		return nil
	}
	copy := *message
	copy.Attachments = append([]Attachment(nil), message.Attachments...)
	copy.ToolCalls = cloneRaw(message.ToolCalls)
	copy.Images = append([]string(nil), message.Images...)
	copy.Metadata = cloneRaw(message.Metadata)
	return &copy
}

func nullString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func (l *Ledger) appendMessageTx(ctx context.Context, tx *sql.Tx, message Message) error {
	if strings.TrimSpace(message.SessionID) == "" {
		return errors.New("sessionId is required")
	}
	if strings.TrimSpace(message.Role) == "" {
		return errors.New("message role is required")
	}
	if message.ID == "" {
		message.ID = uuid.NewString()
	}
	if message.CreatedAt.IsZero() {
		message.CreatedAt = nowUTC()
	} else {
		message.CreatedAt = message.CreatedAt.UTC()
	}
	if message.Sequence <= 0 {
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?`, message.SessionID).Scan(&message.Sequence); err != nil {
			return err
		}
	}
	contentBlob, err := l.seal("messages", message.ID, "content", message.Content)
	if err != nil {
		return err
	}
	metadata := messageMetadata{
		ToolCallID:  message.ToolCallID,
		ToolCalls:   message.ToolCalls,
		Images:      append([]string(nil), message.Images...),
		Attachments: append([]Attachment(nil), message.Attachments...),
		Reasoning:   message.Reasoning,
		Extra:       cloneRaw(message.Metadata),
	}
	metadataBlob, err := l.seal("messages", message.ID, "metadata", metadata)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,session_id,run_id,sequence,role,content,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)`, message.ID, message.SessionID, nullString(message.RunID), message.Sequence, message.Role, contentBlob, metadataBlob, toNano(message.CreatedAt)); err != nil {
		return err
	}
	// Session revision is a projection revision, separate from run revision.
	if _, err := tx.ExecContext(ctx, `UPDATE sessions SET revision=revision+1,updated_at=? WHERE id=?`, toNano(message.CreatedAt), message.SessionID); err != nil {
		return err
	}
	return nil
}

// messageMetadata keeps fields that are useful to providers/UI adapters out
// of the indexed message columns while still encrypting them at rest.
type messageMetadata struct {
	ToolCallID  string          `json:"toolCallId,omitempty"`
	ToolCalls   json.RawMessage `json:"toolCalls,omitempty"`
	Images      []string        `json:"images,omitempty"`
	Attachments []Attachment    `json:"attachments,omitempty"`
	Reasoning   string          `json:"reasoning,omitempty"`
	Extra       json.RawMessage `json:"extra,omitempty"`
}

func decodeMessageMetadata(l *Ledger, id string, blob []byte) (messageMetadata, error) {
	var metadata messageMetadata
	if len(blob) == 0 {
		return metadata, nil
	}
	if err := l.openJSON("messages", id, "metadata", blob, &metadata); err != nil {
		return messageMetadata{}, err
	}
	return metadata, nil
}

func (l *Ledger) AppendMessage(ctx context.Context, message Message) (Message, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Message{}, err
	}
	if message.ID == "" {
		message.ID = uuid.NewString()
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	if err := l.appendMessageTx(ctx, tx, message); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return l.getMessageDB(ctx, message.ID)
}

func (l *Ledger) getMessageDB(ctx context.Context, messageID string) (Message, error) {
	var id, sessionID, runID, role string
	var sequence, created int64
	var contentBlob, metadataBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE id=?`, messageID).Scan(&id, &sessionID, &runID, &sequence, &role, &contentBlob, &metadataBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Message{}, ErrNotFound
	}
	if err != nil {
		return Message{}, err
	}
	var content string
	if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
		return Message{}, err
	}
	metadata, err := decodeMessageMetadata(l, id, metadataBlob)
	if err != nil {
		return Message{}, err
	}
	return Message{ID: id, SessionID: sessionID, RunID: runID, Sequence: sequence, Role: role, Content: content,
		Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
		ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)}, nil
}

func (l *Ledger) getMessagesTx(ctx context.Context, tx *sql.Tx, sessionID string, afterSequence int64, limit int) ([]Message, error) {
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?`, sessionID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var id, sid, runID, role string
		var sequence, created int64
		var contentBlob, metadataBlob []byte
		if err := rows.Scan(&id, &sid, &runID, &sequence, &role, &contentBlob, &metadataBlob, &created); err != nil {
			return nil, err
		}
		var content string
		if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
			return nil, err
		}
		metadata, err := decodeMessageMetadata(l, id, metadataBlob)
		if err != nil {
			return nil, err
		}
		result = append(result, Message{ID: id, SessionID: sid, RunID: runID, Sequence: sequence, Role: role, Content: content,
			Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
			ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)})
	}
	return result, rows.Err()
}

// getMessagesBeforeSequenceTx loads the exact prefix needed for a session
// branch. Unlike the public paging API it deliberately has no presentation
// limit: a branch must preserve the complete provider context before its safe
// user cursor rather than silently dropping older messages.
func (l *Ledger) getMessagesBeforeSequenceTx(ctx context.Context, tx *sql.Tx, sessionID string, beforeSequence int64) ([]Message, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE session_id=? AND sequence<? ORDER BY sequence`, sessionID, beforeSequence)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var id, sid, runID, role string
		var sequence, created int64
		var contentBlob, metadataBlob []byte
		if err := rows.Scan(&id, &sid, &runID, &sequence, &role, &contentBlob, &metadataBlob, &created); err != nil {
			return nil, err
		}
		var content string
		if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
			return nil, err
		}
		metadata, err := decodeMessageMetadata(l, id, metadataBlob)
		if err != nil {
			return nil, err
		}
		result = append(result, Message{ID: id, SessionID: sid, RunID: runID, Sequence: sequence, Role: role, Content: content,
			Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
			ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)})
	}
	return result, rows.Err()
}

func (l *Ledger) GetMessages(ctx context.Context, sessionID string, afterSequence int64, limit int) ([]Message, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	return l.getMessagesTx(ctx, tx, sessionID, afterSequence, limit)
}

// GetRunMessages returns only the messages that belong to one durable run.
// Query-editor generation requests are intentionally isolated from the chat
// session transcript: several editors can share a session ID without their
// drafts or generated SQL becoming model context for each other.
func (l *Ledger) GetRunMessages(ctx context.Context, runID string, afterSequence int64, limit int) ([]Message, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(runID) == "" {
		return nil, errors.New("runId is required")
	}
	if limit <= 0 || limit > 10000 {
		limit = 10000
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,session_id,COALESCE(run_id,''),sequence,role,content,metadata,created_at FROM messages WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`, runID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var id, sessionID, storedRunID, role string
		var sequence, created int64
		var contentBlob, metadataBlob []byte
		if err := rows.Scan(&id, &sessionID, &storedRunID, &sequence, &role, &contentBlob, &metadataBlob, &created); err != nil {
			return nil, err
		}
		var content string
		if err := l.openJSON("messages", id, "content", contentBlob, &content); err != nil {
			return nil, err
		}
		metadata, err := decodeMessageMetadata(l, id, metadataBlob)
		if err != nil {
			return nil, err
		}
		result = append(result, Message{ID: id, SessionID: sessionID, RunID: storedRunID, Sequence: sequence, Role: role, Content: content,
			Images: metadata.Images, Attachments: metadata.Attachments, Reasoning: metadata.Reasoning,
			ToolCallID: metadata.ToolCallID, ToolCalls: metadata.ToolCalls, Metadata: metadata.Extra, CreatedAt: fromNano(created)})
	}
	return result, rows.Err()
}

// TransitionRun performs a compare-and-swap non-terminal state transition.
// Terminal state changes must use AppendEvent with EventTerminal so every run
// has one durable terminal event written in the same transaction.
func (l *Ledger) TransitionRun(ctx context.Context, runID string, from, to RunState, expectedRevision int64, ownerToken string) (RunSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	if err := ValidateTransition(from, to); err != nil {
		return RunSnapshot{}, err
	}
	if to.Terminal() {
		return RunSnapshot{}, fmt.Errorf("%w: terminal state %s requires %s", ErrInvalidTransition, to, EventTerminal)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunSnapshot{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return RunSnapshot{}, err
	}
	if run.State != from {
		return RunSnapshot{}, fmt.Errorf("%w: expected state %s, got %s", ErrRevisionConflict, from, run.State)
	}
	if expectedRevision > 0 && run.Revision != expectedRevision {
		return RunSnapshot{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, expectedRevision, run.Revision)
	}
	if err := verifyOwner(run, ownerToken); err != nil {
		return RunSnapshot{}, err
	}
	nextRevision := run.Revision + 1
	now := nowUTC()
	ownerPredicate, ownerArgs := ownerCAS(run, ownerToken, now)
	args := []any{to, nextRevision, nil, toNano(now), runID, from, run.Revision}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,terminal_reason=?,updated_at=? WHERE id=? AND state=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return RunSnapshot{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return RunSnapshot{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, runID)
}

func verifyOwner(run RunSnapshot, token string) error {
	// An unleased run can be manipulated by a single-process caller without a
	// token. Once a lease exists, however, *every* mutating operation must carry
	// the current fencing token, including an empty-token attempt. This prevents
	// a stale owner or a second process from writing after ownership changes.
	if strings.TrimSpace(run.ownerToken) == "" {
		if strings.TrimSpace(token) != "" {
			return ErrLeaseLost
		}
		return nil
	}
	if strings.TrimSpace(token) == "" ||
		!ConstantTimeEqual([]byte(run.ownerToken), []byte(token)) ||
		(!run.OwnerExpiresAt.IsZero() && !run.OwnerExpiresAt.After(nowUTC())) {
		return ErrLeaseLost
	}
	return nil
}

// ownerCAS adds the lease fence to a mutating UPDATE.  verifyOwner performs
// the friendly error check, but that check alone is not sufficient across
// processes: another supervisor can replace the lease between the read and
// the UPDATE.  Keeping the owner predicate in the same SQLite CAS closes that
// race.  Unleased runs deliberately require an empty owner token so a caller
// cannot accidentally mutate a run after a lease was acquired.
func ownerCAS(run RunSnapshot, token string, now time.Time) (string, []any) {
	if strings.TrimSpace(run.ownerToken) == "" {
		return " AND (owner_token IS NULL OR owner_token='')", nil
	}
	return " AND owner_token=? AND owner_expires_at>?", []any{token, toNano(now)}
}

// AppendEvent persists an event before returning it to the caller for
// publication. Sequence and run revision are allocated transactionally.
func (l *Ledger) AppendEvent(ctx context.Context, request AppendEventRequest) (RunEvent, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunEvent{}, err
	}
	if strings.TrimSpace(request.RunID) == "" {
		return RunEvent{}, errors.New("runId is required")
	}
	if !validEventKind(request.Kind) {
		return RunEvent{}, fmt.Errorf("unknown event kind %q", request.Kind)
	}
	if !request.ResultingState.Valid() {
		return RunEvent{}, fmt.Errorf("unknown resulting state %q", request.ResultingState)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunEvent{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return RunEvent{}, err
	}
	if run.State.Terminal() {
		return RunEvent{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return RunEvent{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return RunEvent{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	sequence := run.NextSequence
	if request.ExpectedSequence > 0 && request.ExpectedSequence != sequence {
		return RunEvent{}, fmt.Errorf("%w: expected %d, got %d", ErrSequenceConflict, request.ExpectedSequence, sequence)
	}
	state := request.ResultingState
	if state == "" {
		state = run.State
	}
	if state != run.State {
		if err := ValidateTransition(run.State, state); err != nil {
			return RunEvent{}, err
		}
	}
	if request.Kind == EventTerminal && !state.Terminal() {
		return RunEvent{}, errors.New("terminal event must result in a terminal state")
	}
	if request.Kind != EventTerminal && state.Terminal() {
		return RunEvent{}, errors.New("non-terminal event cannot result in a terminal state")
	}
	attempt := request.Attempt
	if attempt <= 0 {
		attempt = run.Attempt
	}
	payload := request.PayloadJSON
	if len(payload) == 0 {
		if request.Payload == nil {
			payload = []byte(`{}`)
		} else {
			payload, err = json.Marshal(request.Payload)
			if err != nil {
				return RunEvent{}, fmt.Errorf("marshal event payload: %w", err)
			}
		}
	}
	if !json.Valid(payload) {
		return RunEvent{}, errors.New("event payload must be valid JSON")
	}
	if request.Kind == EventCheckpoint {
		payload, err = l.enrichCheckpointEventPayloadTx(ctx, tx, run, payload)
		if err != nil {
			return RunEvent{}, err
		}
	}
	newRevision := run.Revision + 1
	sealed, err := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), payload)
	if err != nil {
		return RunEvent{}, err
	}
	now := nowUTC()
	terminalReason := any(nil)
	if state.Terminal() {
		reason := strings.TrimSpace(request.TerminalReason)
		if reason == "" {
			reason = run.TerminalReason
		}
		if reason != "" {
			terminalReason, err = l.seal("runs", request.RunID, "terminal_reason", reason)
			if err != nil {
				return RunEvent{}, err
			}
		}
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	args := []any{state, newRevision, sequence + 1, attempt, terminalReason, toNano(now), request.RunID, run.Revision, sequence}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,attempt=?,terminal_reason=?,updated_at=? WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, args...)
	if err != nil {
		return RunEvent{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return RunEvent{}, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, sequence, CurrentSchemaVersion, request.Kind, state, newRevision, attempt, toNano(now), sealed); err != nil {
		return RunEvent{}, err
	}
	if state.Terminal() {
		if err := l.markTerminalControlCommandAppliedTx(ctx, tx, request.RunID, request.AppliedControlCommandID, toNano(now)); err != nil {
			return RunEvent{}, err
		}
		if err := l.discardPendingControlCommandsTx(ctx, tx, request.RunID, toNano(now)); err != nil {
			return RunEvent{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return RunEvent{}, err
	}
	return RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: run.ID, SessionID: run.SessionID,
		SessionGeneration: run.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: attempt, Timestamp: now, Kind: request.Kind, ResultingState: state,
		Payload: append(json.RawMessage(nil), payload...)}, nil
}

// discardPendingControlCommandsTx makes commands that lost a terminal race
// non-replayable without claiming that their actions executed. It runs in the
// same transaction as the terminal state/event, so an enqueue either lands
// before this boundary and is discarded or observes the terminal run and is
// rejected.
func (l *Ledger) discardPendingControlCommandsTx(ctx context.Context, tx *sql.Tx, runID string, consumedAt int64) error {
	_, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE run_id=? AND consumed_at=0 AND applied_at=0`, consumedAt, runID)
	return err
}

// markTerminalControlCommandAppliedTx records a synchronous control action
// together with the terminal state it caused. Unlike a delayed command that
// loses the terminal race, this command did execute and must remain auditable
// as such. The run/action boundary is fenced by the surrounding transaction.
func (l *Ledger) markTerminalControlCommandAppliedTx(ctx context.Context, tx *sql.Tx, runID, commandID string, appliedAt int64) error {
	commandID = strings.TrimSpace(commandID)
	if commandID == "" {
		return nil
	}
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET applied_at=?,consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND run_id=? AND applied_at=0 AND consumed_at=0`, appliedAt, appliedAt, commandID, runID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("%w: control command %q cannot be applied with terminal run", ErrControlCommandClaimLost, commandID)
	}
	return nil
}

// enrichCheckpointEventPayloadTx carries the last durable workspace
// reference onto state-only checkpoint events (interrupt, workspace wait,
// cancel, and recovery transitions). Atomic model/tool commits provide their
// own reference explicitly; this helper keeps the generic AppendEvent seam
// consistent for all other checkpoint events.
func (l *Ledger) enrichCheckpointEventPayloadTx(ctx context.Context, tx *sql.Tx, run RunSnapshot, payload []byte) ([]byte, error) {
	var event CheckpointEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return payload, nil
	}
	if event.WorkspaceSnapshot != nil {
		if !event.WorkspaceSnapshot.valid() {
			return nil, errors.New("workspace snapshot reference is incomplete")
		}
		return payload, nil
	}
	if strings.TrimSpace(run.CheckpointID) == "" {
		return payload, nil
	}
	var sealed []byte
	err := tx.QueryRowContext(ctx, `SELECT workspace_snapshot FROM checkpoints WHERE id=?`, run.CheckpointID).Scan(&sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return payload, nil
	}
	if err != nil {
		return nil, err
	}
	workspace, err := l.openWorkspaceSnapshotReference(run.CheckpointID, sealed)
	if err != nil {
		return nil, err
	}
	if workspace == nil {
		return payload, nil
	}
	event.WorkspaceSnapshot = workspace
	enriched, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	return enriched, nil
}

func (l *Ledger) ReadRun(ctx context.Context, request RunReadRequest) (RunReadResult, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunReadResult{}, err
	}
	run, err := l.getRunDB(ctx, request.RunID)
	if err != nil {
		return RunReadResult{}, err
	}
	limit := request.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := l.db.QueryContext(ctx, `SELECT sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`, request.RunID, request.AfterSequence, limit+1)
	if err != nil {
		return RunReadResult{}, err
	}
	defer rows.Close()
	result := RunReadResult{Run: run}
	for rows.Next() {
		if len(result.Events) >= limit {
			result.HasMore = true
			break
		}
		var sequence int64
		var schema, revision, attempt, timestamp int64
		var kind, state string
		var sealed []byte
		if err := rows.Scan(&sequence, &schema, &kind, &state, &revision, &attempt, &timestamp, &sealed); err != nil {
			return RunReadResult{}, err
		}
		payload, err := l.openRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), sealed)
		if err != nil {
			return RunReadResult{}, err
		}
		result.Events = append(result.Events, RunEvent{SchemaVersion: int(schema), RunID: request.RunID, SessionID: run.SessionID,
			SessionGeneration: run.SessionGeneration, Sequence: sequence, RunRevision: revision, Attempt: int(attempt), Timestamp: fromNano(timestamp), Kind: EventKind(kind), ResultingState: RunState(state), Payload: payload})
	}
	if err := rows.Err(); err != nil {
		return RunReadResult{}, err
	}
	result.NextSequence = run.NextSequence
	return result, nil
}

func (l *Ledger) ListEvents(ctx context.Context, runID string, afterSequence int64, limit int) ([]RunEvent, error) {
	result, err := l.ReadRun(ctx, RunReadRequest{RunID: runID, AfterSequence: afterSequence, Limit: limit})
	return result.Events, err
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// SaveCheckpoint durably records the provider/conversation cursor and points
// the run at it in the same transaction. It is safe to call after every
// completed model/tool turn.
func (l *Ledger) SaveCheckpoint(ctx context.Context, request SaveCheckpointRequest) (Checkpoint, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	request.RunID = strings.TrimSpace(request.RunID)
	if request.RunID == "" {
		return Checkpoint{}, errors.New("runId is required")
	}
	if request.State == "" || !request.State.Valid() {
		return Checkpoint{}, errors.New("valid checkpoint state is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return Checkpoint{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return Checkpoint{}, err
	}
	if run.State.Terminal() {
		return Checkpoint{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return Checkpoint{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return Checkpoint{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	// A checkpoint is a snapshot of an event boundary, never an independent
	// state mutation.  Keep recovery marker states out of this API: those rows
	// are created only by the atomic recovery transaction below.  This prevents
	// a caller from making an interrupted run appear resumable by writing a
	// synthetic checkpoint.
	switch request.State {
	case RunStateQueued, RunStateInterrupted, RunStateRecoveryRequired,
		RunStateCanceling:
		return Checkpoint{}, fmt.Errorf("checkpoint state %s is not executable", request.State)
	}
	if request.State.Terminal() {
		return Checkpoint{}, fmt.Errorf("checkpoint state %s must be non-terminal", request.State)
	}
	if request.State != run.State {
		if err := ValidateTransition(run.State, request.State); err != nil {
			return Checkpoint{}, err
		}
	}
	boundary := run.NextSequence - 1
	if boundary < 0 {
		boundary = 0
	}
	if request.Sequence != boundary {
		return Checkpoint{}, fmt.Errorf("%w: checkpoint sequence %d must equal current boundary %d", ErrSequenceConflict, request.Sequence, boundary)
	}
	var latestSequence sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT MAX(sequence) FROM checkpoints WHERE run_id=?`, request.RunID).Scan(&latestSequence); err != nil {
		return Checkpoint{}, err
	}
	if latestSequence.Valid && request.Sequence <= latestSequence.Int64 {
		return Checkpoint{}, fmt.Errorf("%w: checkpoint sequence %d is not newer than %d", ErrSequenceConflict, request.Sequence, latestSequence.Int64)
	}
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	if workspace == nil {
		// State-only checkpoints (for example an interrupt or lease recovery)
		// still belong to the last workspace view used by the run. Carrying the
		// reference forward keeps the audit chain intact when callers do not have
		// to rebuild the full snapshot context themselves.
		_, _, inherited, previousErr := l.previousCheckpointDataTx(ctx, tx, run)
		if previousErr != nil {
			return Checkpoint{}, previousErr
		}
		workspace = inherited
	}
	id := uuid.NewString()
	now := nowUTC()
	cursorBlob, err := l.seal("checkpoints", id, "conversation_cursor", request.ConversationCursor)
	if err != nil {
		return Checkpoint{}, err
	}
	providerBlob, err := l.sealRaw("checkpoints", id, "provider_state", request.ProviderState)
	if err != nil {
		return Checkpoint{}, err
	}
	workspaceBlob, err := l.sealWorkspaceSnapshotReference(id, workspace)
	if err != nil {
		return Checkpoint{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, id, request.RunID, request.Sequence, request.State, cursorBlob, providerBlob, workspaceBlob, toNano(now)); err != nil {
		return Checkpoint{}, err
	}
	newRevision := run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	args := []any{id, newRevision, toNano(now), request.RunID, run.Revision}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET checkpoint_id=?,revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return Checkpoint{}, err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return Checkpoint{}, err
		}
		return Checkpoint{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: request.RunID, Sequence: request.Sequence, State: request.State, ConversationCursor: request.ConversationCursor, ProviderState: append(json.RawMessage(nil), request.ProviderState...), WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), CreatedAt: now}, nil
}

func (l *Ledger) GetCheckpoint(ctx context.Context, checkpointID string) (Checkpoint, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	var id, runID, state string
	var sequence, created int64
	var cursorBlob, providerBlob, workspaceBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at FROM checkpoints WHERE id=?`, checkpointID).Scan(&id, &runID, &sequence, &state, &cursorBlob, &providerBlob, &workspaceBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	var cursor string
	if len(cursorBlob) > 0 {
		if err := l.openJSON("checkpoints", id, "conversation_cursor", cursorBlob, &cursor); err != nil {
			return Checkpoint{}, err
		}
	}
	providerState, err := l.openRaw("checkpoints", id, "provider_state", providerBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	workspace, err := l.openWorkspaceSnapshotReference(id, workspaceBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: runID, Sequence: sequence, State: RunState(state), ConversationCursor: cursor, ProviderState: providerState, WorkspaceSnapshot: workspace, CreatedAt: fromNano(created)}, nil
}

func (l *Ledger) LatestCheckpoint(ctx context.Context, runID string) (Checkpoint, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	var id string
	err := l.db.QueryRowContext(ctx, `SELECT id FROM checkpoints WHERE run_id=? ORDER BY sequence DESC,created_at DESC LIMIT 1`, runID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	return l.getCheckpointDB(ctx, id)
}

func (l *Ledger) getCheckpointDB(ctx context.Context, id string) (Checkpoint, error) {
	var runID, state string
	var sequence, created int64
	var cursorBlob, providerBlob, workspaceBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at FROM checkpoints WHERE id=?`, id).Scan(&runID, &sequence, &state, &cursorBlob, &providerBlob, &workspaceBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	var cursor string
	if len(cursorBlob) > 0 {
		if err := l.openJSON("checkpoints", id, "conversation_cursor", cursorBlob, &cursor); err != nil {
			return Checkpoint{}, err
		}
	}
	provider, err := l.openRaw("checkpoints", id, "provider_state", providerBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	workspace, err := l.openWorkspaceSnapshotReference(id, workspaceBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: runID, Sequence: sequence, State: RunState(state), ConversationCursor: cursor, ProviderState: provider, WorkspaceSnapshot: workspace, CreatedAt: fromNano(created)}, nil
}

func (l *Ledger) sealWorkspaceSnapshotReference(checkpointID string, reference *WorkspaceSnapshotReference) ([]byte, error) {
	return l.sealWorkspaceSnapshotReferenceFor("checkpoints", checkpointID, reference)
}

func (l *Ledger) sealWorkspaceSnapshotReferenceFor(table, id string, reference *WorkspaceSnapshotReference) ([]byte, error) {
	if reference == nil {
		return nil, nil
	}
	if !reference.valid() {
		return nil, errors.New("workspace snapshot reference is incomplete")
	}
	return l.seal(table, id, "workspace_snapshot", reference)
}

func (l *Ledger) openWorkspaceSnapshotReference(checkpointID string, sealed []byte) (*WorkspaceSnapshotReference, error) {
	return l.openWorkspaceSnapshotReferenceFor("checkpoints", checkpointID, sealed)
}

func (l *Ledger) openWorkspaceSnapshotReferenceFor(table, id string, sealed []byte) (*WorkspaceSnapshotReference, error) {
	if len(sealed) == 0 {
		return nil, nil
	}
	var reference WorkspaceSnapshotReference
	if err := l.openJSON(table, id, "workspace_snapshot", sealed, &reference); err != nil {
		return nil, err
	}
	if !reference.valid() {
		return nil, errors.New("stored workspace snapshot reference is incomplete")
	}
	return &reference, nil
}

var ErrToolAlreadyStarted = errors.New("tool call already started")

func validToolStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "started", "completed", "failed", "canceled", "unknown":
		return true
	default:
		return false
	}
}

func (l *Ledger) decodeToolCallRecord(runID, callID string, attempt int, toolName string, effect ToolEffect, status, argsHash string, argsBlob, resultBlob, workspaceBlob []byte, resultHash, errorCode sql.NullString, unknown, resultTruncated int, resultOriginalBytes, started, completed int64) (ToolCallRecord, error) {
	args, err := l.openRaw("tool_calls", runID, fmt.Sprintf("arguments/%s/%d", callID, attempt), argsBlob)
	if err != nil {
		return ToolCallRecord{}, err
	}
	var result json.RawMessage
	if len(resultBlob) > 0 {
		result, err = l.openRaw("tool_calls", runID, fmt.Sprintf("result/%s/%d", callID, attempt), resultBlob)
		if err != nil {
			return ToolCallRecord{}, err
		}
	}
	workspace, err := l.openWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(runID, callID, attempt), workspaceBlob)
	if err != nil {
		return ToolCallRecord{}, err
	}
	return ToolCallRecord{RunID: runID, CallID: callID, Attempt: attempt, ToolName: toolName,
		Effect: effect, Status: status, ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...),
		Result: append(json.RawMessage(nil), result...), ResultHash: resultHash.String, ErrorCode: errorCode.String,
		UnknownOutcome: unknown != 0, Truncated: resultTruncated != 0, OriginalBytes: resultOriginalBytes,
		WorkspaceSnapshot: workspace, StartedAt: fromNano(started), CompletedAt: fromNano(completed)}, nil
}

func toolCallRecordID(runID, callID string, attempt int) string {
	return fmt.Sprintf("%s/%s/%d", runID, callID, attempt)
}

func (l *Ledger) StartTool(ctx context.Context, request StartToolRequest) (ToolCallRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ToolCallRecord{}, err
	}
	if strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.CallID) == "" || strings.TrimSpace(request.ToolName) == "" {
		return ToolCallRecord{}, errors.New("runId, callId and toolName are required")
	}
	if !request.Effect.Valid() {
		return ToolCallRecord{}, fmt.Errorf("invalid tool effect %q", request.Effect)
	}
	args := request.Arguments
	if len(args) == 0 {
		args = []byte(`{}`)
	}
	if !json.Valid(args) {
		return ToolCallRecord{}, errors.New("tool arguments must be valid JSON")
	}
	attempt := request.Attempt
	if attempt < 0 {
		return ToolCallRecord{}, errors.New("tool attempt cannot be negative")
	}
	if attempt == 0 {
		attempt = 1
	}
	argsHash := hashBytes(args)
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ToolCallRecord{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if run.State.Terminal() {
		return ToolCallRecord{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return ToolCallRecord{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return ToolCallRecord{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	var existingToolName, existingEffect, existingStatus, existingArgsHash string
	var existingArgs, existingResult, existingWorkspace []byte
	var existingResultHash, existingErrorCode sql.NullString
	var existingUnknown, existingTruncated int
	var existingOriginalBytes, existingStarted, existingCompleted int64
	err = tx.QueryRowContext(ctx, `SELECT tool_name,effect,status,args_hash,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at FROM tool_calls WHERE run_id=? AND call_id=? AND attempt=?`, request.RunID, request.CallID, attempt).
		Scan(&existingToolName, &existingEffect, &existingStatus, &existingArgsHash, &existingArgs, &existingResult, &existingWorkspace, &existingResultHash, &existingErrorCode, &existingUnknown, &existingOriginalBytes, &existingTruncated, &existingStarted, &existingCompleted)
	if err == nil {
		if existingToolName != request.ToolName || ToolEffect(existingEffect) != request.Effect || existingArgsHash != argsHash {
			return ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: existingToolName, Effect: ToolEffect(existingEffect), Status: existingStatus, ArgsHash: existingArgsHash}, fmt.Errorf("%w: run=%s call=%s attempt=%d", ErrToolConflict, request.RunID, request.CallID, attempt)
		}
		record, decodeErr := l.decodeToolCallRecord(request.RunID, request.CallID, attempt, existingToolName, ToolEffect(existingEffect), existingStatus, existingArgsHash, existingArgs, existingResult, existingWorkspace, existingResultHash, existingErrorCode, existingUnknown, existingTruncated, existingOriginalBytes, existingStarted, existingCompleted)
		if decodeErr != nil {
			return ToolCallRecord{}, decodeErr
		}
		return record, ErrToolAlreadyStarted
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ToolCallRecord{}, err
	}

	sealedArgs, err := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("arguments/%s/%d", request.CallID, attempt), args)
	if err != nil {
		return ToolCallRecord{}, err
	}
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	workspaceBlob, err := l.sealWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(request.RunID, request.CallID, attempt), workspace)
	if err != nil {
		return ToolCallRecord{}, err
	}
	target := run.State
	if run.State == RunStateRunningModel || run.State == RunStateAwaitingApproval {
		target = RunStateRunningTool
	}
	if target != run.State {
		if err := ValidateTransition(run.State, target); err != nil {
			return ToolCallRecord{}, err
		}
	}
	newRevision := run.Revision + 1
	if _, err := tx.ExecContext(ctx, `INSERT INTO tool_calls(run_id,call_id,attempt,tool_name,effect,status,args_hash,arguments,workspace_snapshot,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, request.RunID, request.CallID, attempt, request.ToolName, request.Effect, "started", argsHash, sealedArgs, workspaceBlob, toNano(now)); err != nil {
		return ToolCallRecord{}, err
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	runArgs := []any{target, newRevision, toNano(now), request.RunID, run.Revision}
	runArgs = append(runArgs, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, runArgs...)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if affected, err := runUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return ToolCallRecord{}, err
		}
		return ToolCallRecord{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return ToolCallRecord{}, err
	}
	return ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: request.ToolName,
		Effect: request.Effect, Status: "started", ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...),
		WorkspaceSnapshot: workspace, StartedAt: now}, nil
}

func (l *Ledger) FinishTool(ctx context.Context, request FinishToolRequest) (ToolCallRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ToolCallRecord{}, err
	}
	if strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.CallID) == "" {
		return ToolCallRecord{}, errors.New("runId and callId are required")
	}
	if strings.TrimSpace(request.Status) == "" {
		return ToolCallRecord{}, errors.New("tool status is required")
	}
	if request.Attempt < 0 {
		return ToolCallRecord{}, errors.New("tool attempt cannot be negative")
	}
	request.Status = strings.ToLower(strings.TrimSpace(request.Status))
	if !validToolStatus(request.Status) || request.Status == "started" {
		return ToolCallRecord{}, fmt.Errorf("%w: %q", ErrToolStatus, request.Status)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ToolCallRecord{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if run.State.Terminal() {
		return ToolCallRecord{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return ToolCallRecord{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return ToolCallRecord{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	var toolName, effect, status, argsHash string
	var attempt int
	var started, completed int64
	var argsBlob, resultBlob, workspaceBlob []byte
	var resultHash, errorCode sql.NullString
	var unknownOutcome, resultTruncated int
	var resultOriginalBytes int64
	query := `SELECT tool_name,effect,status,args_hash,attempt,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at FROM tool_calls WHERE run_id=? AND call_id=?`
	queryArgs := []any{request.RunID, request.CallID}
	if request.Attempt > 0 {
		query += ` AND attempt=?`
		queryArgs = append(queryArgs, request.Attempt)
	}
	query += ` ORDER BY attempt DESC LIMIT 1`
	err = tx.QueryRowContext(ctx, query, queryArgs...).Scan(&toolName, &effect, &status, &argsHash, &attempt, &argsBlob, &resultBlob, &workspaceBlob, &resultHash, &errorCode, &unknownOutcome, &resultOriginalBytes, &resultTruncated, &started, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return ToolCallRecord{}, ErrNotFound
	}
	if err != nil {
		return ToolCallRecord{}, err
	}
	if !validToolStatus(status) {
		return ToolCallRecord{}, fmt.Errorf("%w: persisted status %q", ErrToolStatus, status)
	}
	if request.Attempt > 0 && attempt != request.Attempt {
		return ToolCallRecord{}, fmt.Errorf("%w: requested attempt %d, got %d", ErrToolConflict, request.Attempt, attempt)
	}
	if status != "started" {
		record, decodeErr := l.decodeToolCallRecord(request.RunID, request.CallID, attempt, toolName, ToolEffect(effect), status, argsHash, argsBlob, resultBlob, workspaceBlob, resultHash, errorCode, unknownOutcome, resultTruncated, resultOriginalBytes, started, completed)
		if decodeErr != nil {
			return ToolCallRecord{}, decodeErr
		}
		return record, nil
	}
	encodedResult, encodeErr := normalizedFinishResult(request)
	if encodeErr != nil {
		return ToolCallRecord{}, encodeErr
	}
	raw := encodedResult.JSON
	resultHashValue := hashBytes(raw)
	sealedResult, err := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("result/%s/%d", request.CallID, attempt), raw)
	if err != nil {
		return ToolCallRecord{}, err
	}
	completedAt := nowUTC()
	newRevision := run.Revision + 1
	resultUpdate, err := tx.ExecContext(ctx, `UPDATE tool_calls SET status=?,result=?,result_hash=?,error_code=?,unknown_outcome=?,result_original_bytes=?,result_truncated=?,completed_at=? WHERE run_id=? AND call_id=? AND attempt=? AND status='started'`, request.Status, sealedResult, nullString(resultHashValue), nullString(request.ErrorCode), boolInt(request.UnknownOutcome || request.Status == "unknown"), encodedResult.OriginalBytes, boolInt(encodedResult.Truncated), toNano(completedAt), request.RunID, request.CallID, attempt)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if affected, err := resultUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return ToolCallRecord{}, err
		}
		return ToolCallRecord{}, ErrToolAlreadyStarted
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, completedAt)
	args := []any{newRevision, toNano(completedAt), request.RunID, run.Revision}
	args = append(args, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if affected, err := runUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return ToolCallRecord{}, err
		}
		return ToolCallRecord{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return ToolCallRecord{}, err
	}
	workspace, err := l.openWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(request.RunID, request.CallID, attempt), workspaceBlob)
	if err != nil {
		return ToolCallRecord{}, err
	}
	return ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: toolName, Effect: ToolEffect(effect), Status: request.Status, ArgsHash: argsHash, Result: cloneRaw(raw), ResultHash: resultHashValue, ErrorCode: request.ErrorCode, UnknownOutcome: request.UnknownOutcome || request.Status == "unknown", Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes, WorkspaceSnapshot: workspace, StartedAt: fromNano(started), CompletedAt: completedAt}, nil
}

func mustMarshal(value any) json.RawMessage {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}

// CreateApproval stores an encrypted, argument-bound approval request. An
// existing identical request is returned idempotently.
func (l *Ledger) CreateApproval(ctx context.Context, request PutApprovalRequest) (ApprovalRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	if request.RunID == "" || request.CallID == "" || request.ToolName == "" {
		return ApprovalRecord{}, errors.New("runId, callId and toolName are required")
	}
	if !request.Effect.Valid() {
		return ApprovalRecord{}, fmt.Errorf("invalid tool effect %q", request.Effect)
	}
	args := request.Arguments
	if len(args) == 0 {
		args = []byte(`{}`)
	}
	if !json.Valid(args) {
		return ApprovalRecord{}, errors.New("approval arguments must be valid JSON")
	}
	argsHash := hashBytes(args)
	id := request.ApprovalID
	if id == "" {
		id = uuid.NewString()
	}
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ApprovalRecord{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return ApprovalRecord{}, err
	}
	if run.State.Terminal() {
		return ApprovalRecord{}, ErrTerminalRun
	}
	if request.OwnerToken != "" {
		if err := verifyOwner(run, request.OwnerToken); err != nil {
			return ApprovalRecord{}, err
		}
	}
	if request.RunRevision == 0 {
		request.RunRevision = run.Revision
	}
	if request.RunRevision != run.Revision {
		return ApprovalRecord{}, fmt.Errorf("%w: expected run revision %d, got %d", ErrApprovalConflict, run.Revision, request.RunRevision)
	}
	var existing ApprovalRecord
	var created, decided int64
	var status string
	var existingArgs []byte
	err = tx.QueryRowContext(ctx, `SELECT id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments FROM approvals WHERE run_id=? AND call_id=? AND args_hash=?`, request.RunID, request.CallID, argsHash).Scan(&existing.ApprovalID, &existing.ToolName, &existing.Effect, &existing.ArgsHash, &status, &existing.RunRevision, &created, &decided, &existingArgs)
	if err == nil {
		existing.RunID = request.RunID
		existing.CallID = request.CallID
		existing.Status = status
		existing.Arguments, err = l.openRaw("approvals", existing.ApprovalID, "arguments", existingArgs)
		if err != nil {
			return ApprovalRecord{}, err
		}
		existing.CreatedAt = fromNano(created)
		existing.DecidedAt = fromNano(decided)
		if existing.RunRevision != run.Revision {
			return ApprovalRecord{}, fmt.Errorf("%w: run revision changed", ErrApprovalConflict)
		}
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, err
	}
	sealed, err := l.sealRaw("approvals", id, "arguments", args)
	if err != nil {
		return ApprovalRecord{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO approvals(id,run_id,call_id,tool_name,effect,args_hash,arguments,status,run_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, request.RunID, request.CallID, request.ToolName, request.Effect, argsHash, sealed, "pending", request.RunRevision, toNano(now)); err != nil {
		return ApprovalRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{ApprovalID: id, RunID: request.RunID, CallID: request.CallID, ToolName: request.ToolName, Effect: request.Effect, ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...), Status: "pending", RunRevision: request.RunRevision, CreatedAt: now}, nil
}

func (l *Ledger) DecideApproval(ctx context.Context, request DecideApprovalRequest) (ApprovalRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	decision := strings.ToLower(strings.TrimSpace(request.Decision))
	if decision != "approved" && decision != "denied" && decision != "expired" {
		return ApprovalRecord{}, errors.New("approval decision must be approved, denied, or expired")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ApprovalRecord{}, err
	}
	defer tx.Rollback()
	var runID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err = tx.QueryRowContext(ctx, `SELECT run_id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments FROM approvals WHERE id=?`, request.ApprovalID).Scan(&runID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	}
	if err != nil {
		return ApprovalRecord{}, err
	}
	// Bind the decision to the exact approval card rendered by an adapter. This
	// check must happen before any status/revision handling: a malformed or
	// stale request must never expire or otherwise mutate a pending approval.
	if expectedRunID := strings.TrimSpace(request.ExpectedRunID); expectedRunID == "" || expectedRunID != runID {
		return ApprovalRecord{}, fmt.Errorf("%w: approval run mismatch", ErrApprovalConflict)
	}
	if expectedCallID := strings.TrimSpace(request.ExpectedCallID); expectedCallID == "" || expectedCallID != callID {
		return ApprovalRecord{}, fmt.Errorf("%w: approval call mismatch", ErrApprovalConflict)
	}
	if expectedArgsHash := strings.TrimSpace(request.ExpectedArgsHash); expectedArgsHash == "" || !ConstantTimeEqual([]byte(expectedArgsHash), []byte(argsHash)) {
		return ApprovalRecord{}, fmt.Errorf("%w: approval arguments mismatch", ErrApprovalConflict)
	}
	if request.ExpectedRunRevision <= 0 || request.ExpectedRunRevision != runRevision {
		return ApprovalRecord{}, fmt.Errorf("%w: approval revision mismatch", ErrApprovalConflict)
	}
	if status != "pending" {
		args, openErr := l.openRaw("approvals", request.ApprovalID, "arguments", argsBlob)
		if openErr != nil {
			return ApprovalRecord{}, openErr
		}
		return ApprovalRecord{ApprovalID: request.ApprovalID, RunID: runID, CallID: callID, ToolName: toolName, Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args, Status: status, RunRevision: runRevision, CreatedAt: fromNano(created), DecidedAt: fromNano(decided)}, ErrApprovalConflict
	}
	var currentRevision int64
	var currentState string
	if err := tx.QueryRowContext(ctx, `SELECT revision,state FROM runs WHERE id=?`, runID).Scan(&currentRevision, &currentState); errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	} else if err != nil {
		return ApprovalRecord{}, err
	}
	if RunState(currentState).Terminal() || currentRevision != runRevision || request.ExpectedRunRevision != currentRevision {
		// A revision change invalidates the pending approval. Mark it expired in
		// the same transaction before returning the conflict so stale UI/CLI
		// approval cards cannot remain actionable.
		if status == "pending" {
			_, _ = tx.ExecContext(ctx, `UPDATE approvals SET status='expired',decided_at=? WHERE id=? AND status='pending'`, toNano(nowUTC()), request.ApprovalID)
		}
		return ApprovalRecord{}, fmt.Errorf("%w: run revision changed", ErrApprovalConflict)
	}
	decidedAt := nowUTC()
	if _, err := tx.ExecContext(ctx, `UPDATE approvals SET status=?,decided_at=? WHERE id=? AND status='pending'`, decision, toNano(decidedAt), request.ApprovalID); err != nil {
		return ApprovalRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return ApprovalRecord{}, err
	}
	args, err := l.openRaw("approvals", request.ApprovalID, "arguments", argsBlob)
	if err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{ApprovalID: request.ApprovalID, RunID: runID, CallID: callID, ToolName: toolName, Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args, Status: decision, RunRevision: runRevision, CreatedAt: fromNano(created), DecidedAt: decidedAt}, nil
}

// GetApproval returns the current decision for an approval request. Arguments
// remain encrypted at rest and are only decrypted for the caller that already
// knows the approval ID. It is intentionally read-only so workers can poll it
// while waiting without changing the run revision.
func (l *Ledger) GetApproval(ctx context.Context, approvalID string) (ApprovalRecord, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		return ApprovalRecord{}, errors.New("approvalId is required")
	}
	var runID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT run_id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments FROM approvals WHERE id=?`, approvalID).
		Scan(&runID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	}
	if err != nil {
		return ApprovalRecord{}, err
	}
	args, err := l.openRaw("approvals", approvalID, "arguments", argsBlob)
	if err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{ApprovalID: approvalID, RunID: runID, CallID: callID,
		ToolName: toolName, Effect: ToolEffect(effect), ArgsHash: argsHash,
		Arguments: args, Status: status, RunRevision: runRevision,
		CreatedAt: fromNano(created), DecidedAt: fromNano(decided)}, nil
}

// LatestApprovalForRun returns the most recently created approval for a run.
// A run can have more than one approval over its lifetime (for example after
// a steer or an explicit recovery retry), so callers must use the newest
// record when resuming an awaiting_approval run.
func (l *Ledger) LatestApprovalForRun(ctx context.Context, runID string) (ApprovalRecord, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return ApprovalRecord{}, errors.New("runId is required")
	}
	var approvalID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments
		FROM approvals WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, runID).
		Scan(&approvalID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	}
	if err != nil {
		return ApprovalRecord{}, err
	}
	args, err := l.openRaw("approvals", approvalID, "arguments", argsBlob)
	if err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{
		ApprovalID: approvalID, RunID: runID, CallID: callID, ToolName: toolName,
		Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args,
		Status: status, RunRevision: runRevision, CreatedAt: fromNano(created),
		DecidedAt: fromNano(decided),
	}, nil
}

// EnqueueCommand persists a cross-process control command. The owner consumes
// it using DequeueCommands, which atomically marks each command consumed.
func (l *Ledger) EnqueueCommand(ctx context.Context, command ControlCommand) (ControlCommand, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ControlCommand{}, err
	}
	command.ID = strings.TrimSpace(command.ID)
	command.RunID = strings.TrimSpace(command.RunID)
	command.Action = RunControlAction(strings.TrimSpace(string(command.Action)))
	if command.RunID == "" {
		return ControlCommand{}, errors.New("runId is required")
	}
	if command.Action == "" {
		return ControlCommand{}, errors.New("action is required")
	}
	if command.ID == "" {
		command.ID = uuid.NewString()
	}
	if command.CreatedAt.IsZero() {
		command.CreatedAt = nowUTC()
	}
	payload := command.Payload
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	if !json.Valid(payload) {
		return ControlCommand{}, errors.New("command payload must be valid JSON")
	}
	sealed, err := l.sealRaw("control_commands", command.ID, "payload", payload)
	if err != nil {
		return ControlCommand{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ControlCommand{}, err
	}
	defer tx.Rollback()
	// Resolve an existing idempotency key before checking the mutable run
	// revision. A retry must return the original command even if the run has
	// advanced since it was first accepted; a different payload/action must be
	// rejected rather than silently swallowed as a SQLite UNIQUE error.
	var existingRunID, existingAction string
	var existingPayload []byte
	var existingExpected, existingCreated, existingConsumed int64
	existingErr := tx.QueryRowContext(ctx, `SELECT run_id,action,payload,expected_revision,created_at,consumed_at FROM control_commands WHERE id=?`, command.ID).
		Scan(&existingRunID, &existingAction, &existingPayload, &existingExpected, &existingCreated, &existingConsumed)
	if existingErr == nil {
		plain, openErr := l.openRaw("control_commands", command.ID, "payload", existingPayload)
		if openErr != nil {
			return ControlCommand{}, openErr
		}
		existing := ControlCommand{ID: command.ID, RunID: existingRunID, Action: RunControlAction(existingAction),
			Payload: plain, ExpectedRevision: existingExpected, CreatedAt: fromNano(existingCreated), ConsumedAt: fromNano(existingConsumed)}
		if existing.RunID == command.RunID && existing.Action == command.Action && existing.ExpectedRevision == command.ExpectedRevision &&
			bytes.Equal(bytes.TrimSpace(existing.Payload), bytes.TrimSpace(payload)) {
			return existing, nil
		}
		return ControlCommand{}, fmt.Errorf("%w: id %q is already bound to run %q/action %q", ErrControlCommandConflict, command.ID, existing.RunID, existing.Action)
	} else if !errors.Is(existingErr, sql.ErrNoRows) {
		return ControlCommand{}, existingErr
	}
	if command.ExpectedRevision <= 0 {
		return ControlCommand{}, fmt.Errorf("%w: expectedRevision must be positive", ErrRevisionConflict)
	}
	var currentRevision int64
	var currentState string
	err = tx.QueryRowContext(ctx, `SELECT revision,state FROM runs WHERE id=?`, command.RunID).Scan(&currentRevision, &currentState)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlCommand{}, ErrNotFound
	}
	if err != nil {
		return ControlCommand{}, err
	}
	if currentRevision != command.ExpectedRevision {
		return ControlCommand{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, command.ExpectedRevision, currentRevision)
	}
	if RunState(currentState).Terminal() {
		return ControlCommand{}, fmt.Errorf("%w: run %q", ErrTerminalRun, command.RunID)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO control_commands(id,run_id,action,payload,expected_revision,created_at) VALUES(?,?,?,?,?,?)`, command.ID, command.RunID, command.Action, sealed, command.ExpectedRevision, toNano(command.CreatedAt)); err != nil {
		return ControlCommand{}, err
	}
	if err := tx.Commit(); err != nil {
		return ControlCommand{}, err
	}
	command.Payload = append(json.RawMessage(nil), payload...)
	return command, nil
}

func (l *Ledger) DequeueCommands(ctx context.Context, runID string, limit int) ([]ControlCommand, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,action,payload,expected_revision,created_at FROM control_commands WHERE run_id=? AND consumed_at=0 ORDER BY created_at LIMIT ?`, runID, limit)
	if err != nil {
		return nil, err
	}
	type item struct {
		id, action        string
		payload           []byte
		expected, created int64
	}
	var items []item
	for rows.Next() {
		var x item
		if err := rows.Scan(&x.id, &x.action, &x.payload, &x.expected, &x.created); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, x)
	}
	rows.Close()
	now := toNano(nowUTC())
	out := make([]ControlCommand, 0, len(items))
	for _, x := range items {
		payload, err := l.openRaw("control_commands", x.id, "payload", x.payload)
		if err != nil {
			return nil, err
		}
		result, err := tx.ExecContext(ctx, `UPDATE control_commands SET consumed_at=? WHERE id=? AND consumed_at=0`, now, x.id)
		if err != nil {
			return nil, err
		}
		// A second supervisor may have selected the same row before the write
		// lock was acquired (for example when using a legacy/non-immediate
		// SQLite DSN). Only return commands this transaction actually claimed.
		if affected, err := result.RowsAffected(); err != nil {
			return nil, err
		} else if affected != 1 {
			continue
		}
		out = append(out, ControlCommand{ID: x.id, RunID: runID, Action: RunControlAction(x.action), Payload: payload, ExpectedRevision: x.expected, CreatedAt: fromNano(x.created), ConsumedAt: fromNano(now)})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// ClaimCommands leases control commands to one supervisor without marking
// them consumed. The lease is deliberately separate from application: if a
// worker crashes after this method returns, a later owner can reclaim the row
// once the claim expires and safely decide whether the durable action already
// happened. Commands claimed by the same owner are returned again (with a
// renewed lease), which lets a long-running action survive a polling cycle.
func (l *Ledger) ClaimCommands(ctx context.Context, runID, ownerToken string, limit int, leaseTTL time.Duration) ([]ControlCommand, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	runID = strings.TrimSpace(runID)
	ownerToken = strings.TrimSpace(ownerToken)
	if runID == "" {
		return nil, errors.New("runId is required")
	}
	if ownerToken == "" {
		return nil, errors.New("ownerToken is required")
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	if leaseTTL <= 0 {
		leaseTTL = defaultLeaseDuration
	}
	now := nowUTC()
	nowNS := toNano(now)
	expires := now.Add(leaseTTL)
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,action,payload,expected_revision,created_at,
		COALESCE(claimed_by,''),claimed_at,claim_expires_at,applied_at,consumed_at
		FROM control_commands
		WHERE run_id=? AND consumed_at=0 AND applied_at=0
		AND (COALESCE(claimed_by,'')='' OR claim_expires_at<=? OR claimed_by=?)
		ORDER BY created_at,id LIMIT ?`, runID, nowNS, ownerToken, limit)
	if err != nil {
		return nil, err
	}
	type commandRow struct {
		id, action, claimedBy string
		payload               []byte
		expected, created     int64
		claimedAt, expires    int64
		applied, consumed     int64
	}
	rowsData := make([]commandRow, 0, limit)
	for rows.Next() {
		var row commandRow
		if err := rows.Scan(&row.id, &row.action, &row.payload, &row.expected, &row.created,
			&row.claimedBy, &row.claimedAt, &row.expires, &row.applied, &row.consumed); err != nil {
			rows.Close()
			return nil, err
		}
		rowsData = append(rowsData, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := make([]ControlCommand, 0, len(rowsData))
	for _, row := range rowsData {
		// The conditional update is the fencing point. It protects against a
		// second supervisor that selected the same expired row before this
		// transaction acquired SQLite's write lock.
		result, err := tx.ExecContext(ctx, `UPDATE control_commands
			SET claimed_by=?,claimed_at=?,claim_expires_at=?
			WHERE id=? AND consumed_at=0 AND applied_at=0
			AND (COALESCE(claimed_by,'')='' OR claim_expires_at<=? OR claimed_by=?)`,
			ownerToken, nowNS, toNano(expires), row.id, nowNS, ownerToken)
		if err != nil {
			return nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if affected != 1 {
			continue
		}
		payload, err := l.openRaw("control_commands", row.id, "payload", row.payload)
		if err != nil {
			return nil, err
		}
		out = append(out, ControlCommand{
			ID: row.id, RunID: runID, Action: RunControlAction(row.action), Payload: payload,
			ExpectedRevision: row.expected, CreatedAt: fromNano(row.created),
			ClaimedBy: ownerToken, ClaimedAt: now, ClaimExpiresAt: expires,
			AppliedAt: fromNano(row.applied), ConsumedAt: fromNano(row.consumed),
		})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// AckCommand durably marks a claimed command as applied. Only the current
// claim owner may acknowledge an unapplied row; an expired/fenced owner gets a
// stable claim-loss error and must not report the command as completed.
func (l *Ledger) AckCommand(ctx context.Context, commandID, ownerToken string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return errors.New("commandId is required")
	}
	if ownerToken == "" {
		return errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var claimedBy string
	var claimExpires, applied, consumed int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(claimed_by,''),claim_expires_at,applied_at,consumed_at FROM control_commands WHERE id=?`, commandID).
		Scan(&claimedBy, &claimExpires, &applied, &consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// A duplicate acknowledgement is intentionally idempotent, even if it is
	// received by a process that no longer owns the (already applied) claim.
	if applied != 0 {
		return nil
	}
	// A terminal transition can consume a previously claimed command before its
	// worker reaches this acknowledgement. Leave applied_at at zero: the action
	// was superseded by the terminal boundary and must not be recorded as having
	// executed merely because a delayed callback arrived.
	if consumed != 0 {
		return nil
	}
	now := nowUTC()
	if claimedBy != ownerToken || claimExpires <= toNano(now) {
		return ErrControlCommandClaimLost
	}
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET applied_at=?,consumed_at=?
		WHERE id=? AND applied_at=0 AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), toNano(now), commandID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		// If another owner applied it between the read and update, the operation
		// is still an idempotent success. Otherwise the fence was lost.
		var appliedAfter int64
		if scanErr := tx.QueryRowContext(ctx, `SELECT applied_at FROM control_commands WHERE id=?`, commandID).Scan(&appliedAfter); scanErr == nil && appliedAfter != 0 {
			if commitErr := tx.Commit(); commitErr != nil {
				return commitErr
			}
			return nil
		}
		return ErrControlCommandClaimLost
	}
	return tx.Commit()
}

// TombstoneCommand consumes a claimed command without recording it as applied.
// This is used when its expected revision lost a durable race, so the audit
// trail distinguishes a rejected stale request from an executed action.
func (l *Ledger) TombstoneCommand(ctx context.Context, commandID, ownerToken string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return errors.New("commandId is required")
	}
	if ownerToken == "" {
		return errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var claimedBy string
	var claimExpires, applied, consumed int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(claimed_by,''),claim_expires_at,applied_at,consumed_at FROM control_commands WHERE id=?`, commandID).
		Scan(&claimedBy, &claimExpires, &applied, &consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if consumed != 0 || applied != 0 {
		return nil
	}
	now := nowUTC()
	if claimedBy != ownerToken || claimExpires <= toNano(now) {
		return ErrControlCommandClaimLost
	}
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND applied_at=0 AND consumed_at=0 AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), commandID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return ErrControlCommandClaimLost
	}
	return tx.Commit()
}

// ControlCancelCommandResult is the durable outcome of attempting to apply a
// claimed cancel command.  A stale command is consumed without being applied;
// when the run is still mutable Event contains the revision_conflict that was
// committed in the same transaction as that tombstone.
type ControlCancelCommandResult struct {
	Run     RunSnapshot
	Event   *RunEvent
	Applied bool
	Stale   bool
}

type claimedControlCommandState struct {
	command ControlCommand
	run     RunSnapshot
}

// loadClaimedControlCommandTx verifies the control-command claim and the run
// owner fence together.  A command claim is intentionally distinct from the
// run lease: an unleased queued run may still be processed by a local
// supervisor, while a leased run requires the command claimant to be its
// current owner.
func (l *Ledger) loadClaimedControlCommandTx(ctx context.Context, tx *sql.Tx, commandID, ownerToken string, now time.Time) (claimedControlCommandState, bool, error) {
	var state claimedControlCommandState
	var action, claimedBy string
	var expectedRevision, createdAt, claimedAt, claimExpiresAt, appliedAt, consumedAt int64
	err := tx.QueryRowContext(ctx, `SELECT run_id,action,expected_revision,created_at,
		COALESCE(claimed_by,''),claimed_at,claim_expires_at,applied_at,consumed_at
		FROM control_commands WHERE id=?`, commandID).
		Scan(&state.command.RunID, &action, &expectedRevision, &createdAt,
			&claimedBy, &claimedAt, &claimExpiresAt, &appliedAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return claimedControlCommandState{}, false, ErrNotFound
	}
	if err != nil {
		return claimedControlCommandState{}, false, err
	}
	state.command.ID = commandID
	state.command.Action = RunControlAction(action)
	state.command.ExpectedRevision = expectedRevision
	state.command.CreatedAt = fromNano(createdAt)
	state.command.ClaimedBy = claimedBy
	state.command.ClaimedAt = fromNano(claimedAt)
	state.command.ClaimExpiresAt = fromNano(claimExpiresAt)
	state.command.AppliedAt = fromNano(appliedAt)
	state.command.ConsumedAt = fromNano(consumedAt)
	run, err := l.getRunTx(ctx, tx, state.command.RunID)
	if err != nil {
		return claimedControlCommandState{}, false, err
	}
	state.run = run
	if appliedAt != 0 || consumedAt != 0 {
		return state, true, nil
	}
	if claimedBy != ownerToken || claimExpiresAt <= toNano(now) {
		return claimedControlCommandState{}, false, ErrControlCommandClaimLost
	}
	// A control claim by itself never authorizes mutation of a leased run.
	// For unleased runs a local durable-command owner is allowed to resolve the
	// command, and ownerCAS below prevents a lease acquired concurrently from
	// being overwritten.
	if strings.TrimSpace(run.ownerToken) != "" &&
		(!ConstantTimeEqual([]byte(run.ownerToken), []byte(ownerToken)) || !run.OwnerExpiresAt.After(now)) {
		return claimedControlCommandState{}, false, ErrLeaseLost
	}
	return state, false, nil
}

func staleControlCommandRevision(command ControlCommand, run RunSnapshot) bool {
	return command.ExpectedRevision <= 0 || command.ExpectedRevision != run.Revision
}

func (l *Ledger) tombstoneClaimedControlCommandTx(ctx context.Context, tx *sql.Tx, command ControlCommand, ownerToken string, now time.Time) error {
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND run_id=? AND applied_at=0 AND consumed_at=0
		AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), command.ID, command.RunID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrControlCommandClaimLost
	}
	return nil
}

func (l *Ledger) markClaimedControlCommandAppliedTx(ctx context.Context, tx *sql.Tx, command ControlCommand, ownerToken string, now time.Time) error {
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET applied_at=?,consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND run_id=? AND applied_at=0 AND consumed_at=0
		AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), toNano(now), command.ID, command.RunID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrControlCommandClaimLost
	}
	return nil
}

// rejectStaleControlCommandTx tombstones a command whose expected revision no
// longer matches the run.  The error event and tombstone share one transaction
// so a late AckCommand cannot convert the rejected action into an applied one.
func (l *Ledger) rejectStaleControlCommandTx(ctx context.Context, tx *sql.Tx, state claimedControlCommandState, ownerToken string, now time.Time) (RunSnapshot, *RunEvent, error) {
	run := state.run
	if run.State.Terminal() {
		if err := l.tombstoneClaimedControlCommandTx(ctx, tx, state.command, ownerToken, now); err != nil {
			return RunSnapshot{}, nil, err
		}
		return run, nil, nil
	}
	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	payload, err := json.Marshal(RunErrorEvent{
		Code:      "revision_conflict",
		Message:   fmt.Sprintf("control command revision conflict: expected %d, got %d", state.command.ExpectedRevision, run.Revision),
		Retryable: true,
	})
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	sealed, err := l.sealRaw("events", run.ID, fmt.Sprintf("payload/%d", sequence), payload)
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	if err := l.tombstoneClaimedControlCommandTx(ctx, tx, state.command, ownerToken, now); err != nil {
		return RunSnapshot{}, nil, err
	}
	newRevision := run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(run, ownerToken, now)
	args := []any{newRevision, sequence + 1, toNano(now), run.ID, run.Revision, sequence}
	args = append(args, ownerArgs...)
	updated, err := tx.ExecContext(ctx, `UPDATE runs SET revision=?,next_sequence=?,updated_at=?
		WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, args...)
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	affected, err := updated.RowsAffected()
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	if affected != 1 {
		return RunSnapshot{}, nil, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`,
		run.ID, sequence, CurrentSchemaVersion, EventRunError, run.State, newRevision, run.Attempt, toNano(now), sealed); err != nil {
		return RunSnapshot{}, nil, err
	}
	run.Revision = newRevision
	run.NextSequence = sequence + 1
	run.UpdatedAt = now
	event := RunEvent{
		SchemaVersion: CurrentSchemaVersion, RunID: run.ID, SessionID: run.SessionID,
		SessionGeneration: run.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: run.Attempt, Timestamp: now, Kind: EventRunError, ResultingState: run.State,
		Payload: append(json.RawMessage(nil), payload...),
	}
	return run, &event, nil
}

// RejectStaleControlCommand checks a claimed command at the consumption
// boundary.  It returns stale=false when the command still targets the exact
// current run revision.  Stale commands are consumed without applying their
// action and produce one typed revision_conflict event while the run remains
// non-terminal.
func (l *Ledger) RejectStaleControlCommand(ctx context.Context, commandID, ownerToken string) (RunEvent, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunEvent{}, false, err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return RunEvent{}, false, errors.New("commandId is required")
	}
	if ownerToken == "" {
		return RunEvent{}, false, errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunEvent{}, false, err
	}
	defer tx.Rollback()
	now := nowUTC()
	state, settled, err := l.loadClaimedControlCommandTx(ctx, tx, commandID, ownerToken, now)
	if err != nil {
		return RunEvent{}, false, err
	}
	if settled || !staleControlCommandRevision(state.command, state.run) {
		if err := tx.Commit(); err != nil {
			return RunEvent{}, false, err
		}
		return RunEvent{}, false, nil
	}
	_, event, err := l.rejectStaleControlCommandTx(ctx, tx, state, ownerToken, now)
	if err != nil {
		return RunEvent{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return RunEvent{}, false, err
	}
	if event == nil {
		return RunEvent{}, true, nil
	}
	return *event, true, nil
}

// ApplyCancelControlCommand transitions a claimed, current-revision cancel
// command to canceling and marks that exact command applied in the same
// transaction.  A caller cancels in-memory work only after this method commits.
func (l *Ledger) ApplyCancelControlCommand(ctx context.Context, commandID, ownerToken string) (ControlCancelCommandResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ControlCancelCommandResult{}, err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return ControlCancelCommandResult{}, errors.New("commandId is required")
	}
	if ownerToken == "" {
		return ControlCancelCommandResult{}, errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	defer tx.Rollback()
	now := nowUTC()
	state, settled, err := l.loadClaimedControlCommandTx(ctx, tx, commandID, ownerToken, now)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	if settled {
		if err := tx.Commit(); err != nil {
			return ControlCancelCommandResult{}, err
		}
		return ControlCancelCommandResult{Run: state.run}, nil
	}
	if state.command.Action != ControlCancel {
		return ControlCancelCommandResult{}, fmt.Errorf("control command %q is not a cancel", state.command.Action)
	}
	if staleControlCommandRevision(state.command, state.run) || state.run.State.Terminal() {
		updated, event, rejectErr := l.rejectStaleControlCommandTx(ctx, tx, state, ownerToken, now)
		if rejectErr != nil {
			return ControlCancelCommandResult{}, rejectErr
		}
		if err := tx.Commit(); err != nil {
			return ControlCancelCommandResult{}, err
		}
		return ControlCancelCommandResult{Run: updated, Event: event, Stale: true}, nil
	}
	if state.run.State == RunStateCanceling {
		if err := l.markClaimedControlCommandAppliedTx(ctx, tx, state.command, ownerToken, now); err != nil {
			return ControlCancelCommandResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return ControlCancelCommandResult{}, err
		}
		return ControlCancelCommandResult{Run: state.run, Applied: true}, nil
	}
	if err := ValidateTransition(state.run.State, RunStateCanceling); err != nil {
		return ControlCancelCommandResult{}, err
	}
	sequence := state.run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	payload, err := json.Marshal(CheckpointEvent{Sequence: sequence - 1})
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	payload, err = l.enrichCheckpointEventPayloadTx(ctx, tx, state.run, payload)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	sealed, err := l.sealRaw("events", state.run.ID, fmt.Sprintf("payload/%d", sequence), payload)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	newRevision := state.run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(state.run, ownerToken, now)
	args := []any{RunStateCanceling, newRevision, sequence + 1, toNano(now), state.run.ID, state.run.Revision, sequence}
	args = append(args, ownerArgs...)
	updated, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,updated_at=?
		WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, args...)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	affected, err := updated.RowsAffected()
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	if affected != 1 {
		return ControlCancelCommandResult{}, ErrRevisionConflict
	}
	if err := l.markClaimedControlCommandAppliedTx(ctx, tx, state.command, ownerToken, now); err != nil {
		return ControlCancelCommandResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`,
		state.run.ID, sequence, CurrentSchemaVersion, EventCheckpoint, RunStateCanceling, newRevision, state.run.Attempt, toNano(now), sealed); err != nil {
		return ControlCancelCommandResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ControlCancelCommandResult{}, err
	}
	state.run.State = RunStateCanceling
	state.run.Revision = newRevision
	state.run.NextSequence = sequence + 1
	state.run.UpdatedAt = now
	event := RunEvent{
		SchemaVersion: CurrentSchemaVersion, RunID: state.run.ID, SessionID: state.run.SessionID,
		SessionGeneration: state.run.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: state.run.Attempt, Timestamp: now, Kind: EventCheckpoint, ResultingState: RunStateCanceling,
		Payload: append(json.RawMessage(nil), payload...),
	}
	return ControlCancelCommandResult{Run: state.run, Event: &event, Applied: true}, nil
}

// PutWorkspaceSnapshot accepts only strictly newer revisions for a source
// instance. Replaying the same revision is idempotent when its content hash
// matches; conflicting content is rejected.
func (l *Ledger) PutWorkspaceSnapshot(ctx context.Context, snapshot WorkspaceSnapshot) (WorkspaceSnapshot, error) {
	return l.PutWorkspaceSnapshotWithLeaseDuration(ctx, snapshot, 0)
}

// PutWorkspaceSnapshotWithLeaseDuration is the Harness-facing variant that
// allows the owner to freeze a lease policy for a run. A zero duration uses
// the Ledger's configured default. Repeated publication of the same revision
// and hash renews the existing row without creating another snapshot.
func (l *Ledger) PutWorkspaceSnapshotWithLeaseDuration(ctx context.Context, snapshot WorkspaceSnapshot, leaseDuration time.Duration) (WorkspaceSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	if leaseDuration < 0 {
		return WorkspaceSnapshot{}, ErrSnapshotLeaseConfig
	}
	if leaseDuration == 0 {
		leaseDuration = l.workspaceSnapshotLeaseTTL
		if leaseDuration <= 0 {
			leaseDuration = DefaultWorkspaceSnapshotLeaseDuration
		}
	}
	now := nowUTC()
	leaseExpiresAt := toNano(now.Add(leaseDuration))
	if err := snapshot.Normalize(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	defer tx.Rollback()
	var latestRevision int64
	var latestHash string
	err = tx.QueryRowContext(ctx, `SELECT revision,content_hash FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? ORDER BY revision DESC LIMIT 1`, snapshot.SourceID, snapshot.SourceInstanceID).Scan(&latestRevision, &latestHash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, err
	}
	if err == nil {
		if snapshot.Revision < latestRevision {
			return WorkspaceSnapshot{}, fmt.Errorf("%w: expected revision > %d", ErrSnapshotConflict, latestRevision)
		}
		if snapshot.Revision == latestRevision && snapshot.ContentHash != latestHash {
			return WorkspaceSnapshot{}, fmt.Errorf("%w: content hash changed at revision %d", ErrSnapshotConflict, snapshot.Revision)
		}
		if snapshot.Revision == latestRevision {
			// A repeated full snapshot is also the source heartbeat. Refresh the
			// lease even when the source has not changed its revision.
			if _, err := tx.ExecContext(ctx, `UPDATE workspace_snapshots SET lease_expires_at=? WHERE source_id=? AND source_instance_id=? AND revision=? AND content_hash=?`, leaseExpiresAt, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision, snapshot.ContentHash); err != nil {
				return WorkspaceSnapshot{}, err
			}
			if err := tx.Commit(); err != nil {
				return WorkspaceSnapshot{}, err
			}
			return snapshot, nil
		}
	}
	payload, err := json.Marshal(snapshot)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	sealed, err := l.sealRaw("workspace_snapshots", fmt.Sprintf("%s/%s/%d", snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision), "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_snapshots(source_id,source_instance_id,revision,content_hash,captured_at,payload,lease_expires_at) VALUES(?,?,?,?,?,?,?)`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision, snapshot.ContentHash, toNano(snapshot.CapturedAt), sealed, leaseExpiresAt); err != nil {
		return WorkspaceSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	return snapshot, nil
}

// PutWorkspaceSnapshotWithTTL is a naming alias for adapters that model the
// source liveness window as a time-to-live.
func (l *Ledger) PutWorkspaceSnapshotWithTTL(ctx context.Context, snapshot WorkspaceSnapshot, ttl time.Duration) (WorkspaceSnapshot, error) {
	return l.PutWorkspaceSnapshotWithLeaseDuration(ctx, snapshot, ttl)
}

func (l *Ledger) LatestWorkspaceSnapshot(ctx context.Context, sourceID, instanceID string) (WorkspaceSnapshot, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, err
	}
	var revision, leaseExpiresAt int64
	var payload []byte
	sourceID = strings.TrimSpace(sourceID)
	instanceID = strings.TrimSpace(instanceID)
	if sourceID == "" || instanceID == "" {
		return WorkspaceSnapshot{}, errors.New("workspace sourceId and sourceInstanceId are required")
	}
	err := l.db.QueryRowContext(ctx, `SELECT revision,payload,lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? ORDER BY revision DESC LIMIT 1`, sourceID, instanceID).Scan(&revision, &payload, &leaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, ErrNotFound
	}
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	if leaseExpiresAt <= toNano(nowUTC()) {
		return WorkspaceSnapshot{}, ErrSnapshotExpired
	}
	plain, err := l.openRaw("workspace_snapshots", fmt.Sprintf("%s/%s/%d", sourceID, instanceID, revision), "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, err
	}
	var snapshot WorkspaceSnapshot
	if err := json.Unmarshal(plain, &snapshot); err != nil {
		return WorkspaceSnapshot{}, err
	}
	return snapshot, nil
}

// LatestWorkspaceSnapshotAllowExpired returns the newest encrypted snapshot
// together with whether its source lease has expired. It is only for an
// explicit user-confirmed recovery path; normal tool execution must use
// LatestWorkspaceSnapshot so a disconnected desktop/CLI cannot silently leak
// stale state into a run.
func (l *Ledger) LatestWorkspaceSnapshotAllowExpired(ctx context.Context, sourceID, instanceID string) (WorkspaceSnapshot, bool, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	sourceID = strings.TrimSpace(sourceID)
	instanceID = strings.TrimSpace(instanceID)
	if sourceID == "" || instanceID == "" {
		return WorkspaceSnapshot{}, false, errors.New("workspace sourceId and sourceInstanceId are required")
	}
	var revision, leaseExpiresAt int64
	var payload []byte
	err := l.db.QueryRowContext(ctx, `SELECT revision,payload,lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? ORDER BY revision DESC LIMIT 1`, sourceID, instanceID).Scan(&revision, &payload, &leaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, false, ErrNotFound
	}
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	plain, err := l.openRaw("workspace_snapshots", fmt.Sprintf("%s/%s/%d", sourceID, instanceID, revision), "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	var snapshot WorkspaceSnapshot
	if err := json.Unmarshal(plain, &snapshot); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	return snapshot, leaseExpiresAt <= toNano(nowUTC()), nil
}

// WorkspaceSnapshotByReference loads the exact encrypted snapshot identified
// by a durable tool/checkpoint reference. The boolean reports whether that
// row's source lease has expired; callers may still use the payload when they
// have an explicit stale-workspace policy. Unlike LatestWorkspaceSnapshot this
// method never silently substitutes a newer revision.
func (l *Ledger) WorkspaceSnapshotByReference(ctx context.Context, reference WorkspaceSnapshotReference) (WorkspaceSnapshot, bool, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	if !reference.valid() {
		return WorkspaceSnapshot{}, false, errors.New("workspace snapshot reference is incomplete")
	}
	var payload []byte
	var leaseExpiresAt int64
	err := l.db.QueryRowContext(ctx, `SELECT payload,lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? AND revision=? AND content_hash=?`, reference.SourceID, reference.SourceInstanceID, reference.Revision, reference.ContentHash).Scan(&payload, &leaseExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return WorkspaceSnapshot{}, false, ErrNotFound
	}
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	key := fmt.Sprintf("%s/%s/%d", reference.SourceID, reference.SourceInstanceID, reference.Revision)
	plain, err := l.openRaw("workspace_snapshots", key, "payload", payload)
	if err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	var snapshot WorkspaceSnapshot
	if err := json.Unmarshal(plain, &snapshot); err != nil {
		return WorkspaceSnapshot{}, false, err
	}
	if snapshot.SourceID != reference.SourceID || snapshot.SourceInstanceID != reference.SourceInstanceID || snapshot.Revision != reference.Revision || snapshot.ContentHash != reference.ContentHash {
		return WorkspaceSnapshot{}, false, fmt.Errorf("%w: workspace snapshot reference does not match payload", ErrSnapshotConflict)
	}
	return snapshot, leaseExpiresAt <= toNano(nowUTC()), nil
}

// GetWorkspaceSnapshotByReference is a descriptive alias for adapters and
// tests that prefer Get* naming. Both methods intentionally share the exact
// revision/content-hash semantics above.
func (l *Ledger) GetWorkspaceSnapshotByReference(ctx context.Context, reference WorkspaceSnapshotReference) (WorkspaceSnapshot, bool, error) {
	return l.WorkspaceSnapshotByReference(ctx, reference)
}

// AcquireLease obtains a fencing token for a run. A live lease owned by a
// different process is never stolen; callers must wait until it expires or
// explicitly recover the run after a restart.
func (l *Ledger) AcquireLease(ctx context.Context, runID, ownerID string, ttl time.Duration) (Lease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Lease{}, err
	}
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return Lease{}, errors.New("ownerId is required")
	}
	if ttl <= 0 {
		ttl = defaultLeaseDuration
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return Lease{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return Lease{}, err
	}
	if run.State.Terminal() {
		return Lease{}, ErrTerminalRun
	}
	now := nowUTC()
	var currentOwner, currentToken string
	var expiry int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(owner_id,''),COALESCE(owner_token,''),owner_expires_at FROM runs WHERE id=?`, runID).Scan(&currentOwner, &currentToken, &expiry); err != nil {
		return Lease{}, err
	}
	if currentOwner != "" && currentOwner != ownerID && expiry > toNano(now) {
		return Lease{}, ErrLeaseUnavailable
	}
	token := currentToken
	if currentOwner != ownerID || expiry <= toNano(now) || token == "" {
		token = uuid.NewString()
	}
	expires := now.Add(ttl)
	newRevision := run.Revision + 1
	result, err := tx.ExecContext(ctx, `UPDATE runs SET owner_id=?,owner_token=?,owner_expires_at=?,revision=?,updated_at=? WHERE id=? AND revision=?`, ownerID, token, toNano(expires), newRevision, toNano(now), runID, run.Revision)
	if err != nil {
		return Lease{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return Lease{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return Lease{}, err
	}
	return Lease{RunID: runID, OwnerID: ownerID, Token: token, ExpiresAt: expires}, nil
}

func (l *Ledger) RenewLease(ctx context.Context, lease Lease, ttl time.Duration) (Lease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Lease{}, err
	}
	if lease.RunID == "" || lease.OwnerID == "" || lease.Token == "" {
		return Lease{}, errors.New("runId, ownerId and token are required")
	}
	if ttl <= 0 {
		ttl = defaultLeaseDuration
	}
	now := nowUTC()
	expires := now.Add(ttl)
	result, err := l.db.ExecContext(ctx, `UPDATE runs SET owner_expires_at=?,updated_at=? WHERE id=? AND owner_id=? AND owner_token=? AND owner_expires_at>? AND state NOT IN ('completed','failed','canceled','exhausted')`, toNano(expires), toNano(now), lease.RunID, lease.OwnerID, lease.Token, toNano(now))
	if err != nil {
		return Lease{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return Lease{}, ErrLeaseLost
	}
	lease.ExpiresAt = expires
	return lease, nil
}

func (l *Ledger) ReleaseLease(ctx context.Context, lease Lease) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	if lease.RunID == "" || lease.OwnerID == "" || lease.Token == "" {
		return errors.New("runId, ownerId and token are required")
	}
	result, err := l.db.ExecContext(ctx, `UPDATE runs SET owner_id=NULL,owner_token=NULL,owner_expires_at=0,updated_at=? WHERE id=? AND owner_id=? AND owner_token=?`, toNano(nowUTC()), lease.RunID, lease.OwnerID, lease.Token)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (l *Ledger) ValidateLease(ctx context.Context, lease Lease) error {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	var expiry int64
	var state string
	err := l.db.QueryRowContext(ctx, `SELECT owner_expires_at,state FROM runs WHERE id=? AND owner_id=? AND owner_token=?`, lease.RunID, lease.OwnerID, lease.Token).Scan(&expiry, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return err
	}
	if RunState(state).Terminal() || expiry <= toNano(nowUTC()) {
		return ErrLeaseLost
	}
	return nil
}

// RecoverRuns marks runs that were actively executing when an owner vanished.
// The recovery transition, checkpoint and event are committed atomically. Runs
// that are queued (or already waiting for an explicit user recovery decision)
// are deliberately left untouched so startup cannot break FIFO or repeatedly
// advance attempts. A live lease is also left alone; another supervisor may
// still be executing the run.
func (l *Ledger) RecoverRuns(ctx context.Context) ([]RunSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := nowUTC()
	nowNS := toNano(now)
	rows, err := tx.QueryContext(ctx, `SELECT id FROM runs
		WHERE state IN ('running_model','running_tool','awaiting_workspace','canceling')
		AND (owner_token IS NULL OR owner_token='' OR owner_expires_at<=?)
		ORDER BY created_at`, nowNS)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for _, id := range ids {
		run, err := l.getRunTx(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		// The selector above is intentionally repeated here because this method
		// may be called by more than one supervisor after the initial read.
		if run.State == RunStateQueued || run.State.Terminal() ||
			run.State == RunStateInterrupted || run.State == RunStateRecoveryRequired ||
			(!run.OwnerExpiresAt.IsZero() && run.OwnerExpiresAt.After(now)) {
			continue
		}
		target := RunStateInterrupted
		var unknown int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tool_calls
			WHERE run_id=? AND effect IN ('side_effect','side_effect_unknown')
			AND (status IN ('started','unknown') OR unknown_outcome<>0)`, id).Scan(&unknown); err != nil {
			return nil, err
		}
		if unknown > 0 {
			target = RunStateRecoveryRequired
		}
		if err := ValidateTransition(run.State, target); err != nil {
			return nil, err
		}
		// Any approval was bound to the pre-crash run revision. Invalidate it
		// while the recovery transition is still in the same transaction; a
		// resumed worker must create a fresh approval for a fresh attempt.
		if _, err := tx.ExecContext(ctx, `UPDATE approvals SET status='expired',decided_at=? WHERE run_id=? AND status='pending'`, nowNS, id); err != nil {
			return nil, err
		}
		// A reserved model turn has no committed usage/message/checkpoint after
		// the owner disappears. Reconcile it with zero usage in the same recovery
		// transaction so the resumed run is not permanently blocked by leaked
		// capacity; usage from completed turns remains in the run counters.
		if _, err := tx.ExecContext(ctx, `UPDATE token_reservations SET prompt_tokens=0,completion_tokens=0,total_tokens=0,status='reconciled',reconciled_at=? WHERE run_id=? AND status='reserved'`, nowNS, id); err != nil {
			return nil, err
		}

		// Carry forward the last provider cursor when one exists. The new
		// checkpoint is still encrypted under a fresh record id, so recovery
		// metadata cannot be confused with the previous checkpoint.
		var cursor string
		var providerState json.RawMessage
		var workspace *WorkspaceSnapshotReference
		if strings.TrimSpace(run.CheckpointID) != "" {
			var cursorBlob, providerBlob, workspaceSnapshotBlob []byte
			checkpointErr := tx.QueryRowContext(ctx, `SELECT conversation_cursor,provider_state,workspace_snapshot FROM checkpoints WHERE id=?`, run.CheckpointID).Scan(&cursorBlob, &providerBlob, &workspaceSnapshotBlob)
			if checkpointErr != nil && !errors.Is(checkpointErr, sql.ErrNoRows) {
				return nil, checkpointErr
			}
			if checkpointErr == nil {
				if len(cursorBlob) > 0 {
					if err := l.openJSON("checkpoints", run.CheckpointID, "conversation_cursor", cursorBlob, &cursor); err != nil {
						return nil, err
					}
				}
				if len(providerBlob) > 0 {
					providerState, err = l.openRaw("checkpoints", run.CheckpointID, "provider_state", providerBlob)
					if err != nil {
						return nil, err
					}
				}
				workspace, err = l.openWorkspaceSnapshotReference(run.CheckpointID, workspaceSnapshotBlob)
				if err != nil {
					return nil, err
				}
			}
		}
		checkpointID := uuid.NewString()
		cursorBlob, err := l.seal("checkpoints", checkpointID, "conversation_cursor", cursor)
		if err != nil {
			return nil, err
		}
		providerBlob, err := l.sealRaw("checkpoints", checkpointID, "provider_state", providerState)
		if err != nil {
			return nil, err
		}
		workspaceBlob, err := l.sealWorkspaceSnapshotReference(checkpointID, workspace)
		if err != nil {
			return nil, err
		}
		sequence := run.NextSequence
		if sequence < 1 {
			sequence = 1
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, id, sequence, target, cursorBlob, providerBlob, workspaceBlob, nowNS); err != nil {
			return nil, err
		}

		payload := CheckpointEvent{CheckpointID: checkpointID, Sequence: sequence, WorkspaceSnapshot: workspace}
		payloadJSON, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		sealedEvent, err := l.sealRaw("events", id, fmt.Sprintf("payload/%d", sequence), payloadJSON)
		if err != nil {
			return nil, err
		}
		newRevision := run.Revision + 1
		newAttempt := run.Attempt + 1
		result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,attempt=?,next_sequence=?,checkpoint_id=?,reserved_tokens=0,owner_id=NULL,owner_token=NULL,owner_expires_at=0,updated_at=?
			WHERE id=? AND state=? AND revision=? AND next_sequence=?
			AND (owner_token IS NULL OR owner_token='' OR owner_expires_at<=?)`, target, newRevision, newAttempt, sequence+1, checkpointID, nowNS, id, run.State, run.Revision, run.NextSequence, nowNS)
		if err != nil {
			return nil, err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return nil, err
			}
			return nil, ErrRevisionConflict
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, id, sequence, CurrentSchemaVersion, EventCheckpoint, target, newRevision, newAttempt, nowNS, sealedEvent); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := make([]RunSnapshot, 0, len(ids))
	for _, id := range ids {
		run, err := l.getRunDB(ctx, id)
		if err != nil {
			return nil, err
		}
		if run.State == RunStateInterrupted || run.State == RunStateRecoveryRequired {
			result = append(result, run)
		}
	}
	return result, nil
}

func (l *Ledger) EnqueueInput(ctx context.Context, request QueueInputRequest) (QueueInputRequest, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return QueueInputRequest{}, err
	}
	if request.RequestID == "" || request.RunID == "" || request.SessionID == "" {
		return QueueInputRequest{}, errors.New("requestId, runId and sessionId are required")
	}
	if request.DispatchMode == "" {
		request.DispatchMode = DispatchQueue
	}
	if !request.DispatchMode.Valid() {
		return QueueInputRequest{}, errors.New("invalid dispatch mode")
	}
	id := uuid.NewString()
	sealed, err := l.seal("queued_inputs", id, "content", request.Content)
	if err != nil {
		return QueueInputRequest{}, err
	}
	_, err = l.db.ExecContext(ctx, `INSERT INTO queued_inputs(id,request_id,run_id,session_id,content,dispatch_mode,context_source_id,context_source_instance_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, request.RequestID, request.RunID, request.SessionID, sealed, request.DispatchMode, request.ContextSourceID, request.ContextSourceInstanceID, toNano(nowUTC()))
	if err != nil {
		return QueueInputRequest{}, err
	}
	return request, nil
}

func (l *Ledger) DequeueInputs(ctx context.Context, runID string, limit int) ([]QueueInputRequest, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,request_id,session_id,content,dispatch_mode,COALESCE(context_source_id,''),COALESCE(context_source_instance_id,''),created_at FROM queued_inputs WHERE run_id=? AND consumed_at=0 ORDER BY created_at LIMIT ?`, runID, limit)
	if err != nil {
		return nil, err
	}
	type rowData struct {
		id, requestID, sessionID     string
		content                      []byte
		mode, source, sourceInstance string
		created                      int64
	}
	var pending []rowData
	for rows.Next() {
		var x rowData
		if err := rows.Scan(&x.id, &x.requestID, &x.sessionID, &x.content, &x.mode, &x.source, &x.sourceInstance, &x.created); err != nil {
			rows.Close()
			return nil, err
		}
		pending = append(pending, x)
	}
	rows.Close()
	now := toNano(nowUTC())
	out := make([]QueueInputRequest, 0, len(pending))
	for _, x := range pending {
		var content string
		if err := l.openJSON("queued_inputs", x.id, "content", x.content, &content); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE queued_inputs SET consumed_at=? WHERE id=? AND consumed_at=0`, now, x.id); err != nil {
			return nil, err
		}
		out = append(out, QueueInputRequest{RequestID: x.requestID, RunID: runID, SessionID: x.sessionID, Content: content, DispatchMode: DispatchMode(x.mode), ContextSourceID: x.source, ContextSourceInstanceID: x.sourceInstance})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// AddActiveDuration reconciles model/tool execution time into the run budget.
// It is deliberately a small CAS update so an owner heartbeat or another
// metadata revision cannot overwrite the accumulated duration.
func (l *Ledger) AddActiveDuration(ctx context.Context, runID string, duration time.Duration, ownerToken string) error {
	if duration <= 0 {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return err
	}
	if run.State.Terminal() {
		return ErrTerminalRun
	}
	if err := verifyOwner(run, ownerToken); err != nil {
		return err
	}
	now := nowUTC()
	ownerPredicate, ownerArgs := ownerCAS(run, ownerToken, now)
	args := []any{duration.Nanoseconds(), toNano(now), runID}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET active_duration_ns=active_duration_ns+?,revision=revision+1,updated_at=? WHERE id=? AND state NOT IN ('completed','failed','canceled','exhausted')`+ownerPredicate, args...)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return ErrRevisionConflict
	}
	return tx.Commit()
}
