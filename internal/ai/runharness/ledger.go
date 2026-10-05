package runharness

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
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
