package runharness

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/secretstore"
)

// flakyKeyringStore simulates macOS surfacing a denied Keychain ACL prompt as
// "item not found" for the next N reads, even though the item still exists.
type flakyKeyringStore struct {
	denyReads int
	items     map[string][]byte
	puts      int
}

func (s *flakyKeyringStore) Put(ref string, payload []byte) error {
	s.puts++
	s.items[ref] = append([]byte(nil), payload...)
	return nil
}

func (s *flakyKeyringStore) Get(ref string) ([]byte, error) {
	if s.denyReads > 0 {
		s.denyReads--
		return nil, os.ErrNotExist
	}
	if payload, ok := s.items[ref]; ok {
		return append([]byte(nil), payload...), nil
	}
	return nil, os.ErrNotExist
}

func (s *flakyKeyringStore) Delete(ref string) error {
	delete(s.items, ref)
	return nil
}

func (s *flakyKeyringStore) HealthCheck() error { return nil }

// freshKeyProvider simulates a provider that just minted a brand-new key, as
// happens when the keyring entry is missing (or when macOS reports a denied
// Keychain ACL prompt as "item not found").
type freshKeyProvider struct{ key []byte }

func (p *freshKeyProvider) LoadOrCreate() ([]byte, error) {
	return append([]byte(nil), p.key...), nil
}

func (p *freshKeyProvider) LoadOrCreateDetailed() (LoadedKey, error) {
	return LoadedKey{Key: append([]byte(nil), p.key...), Fresh: true}, nil
}

func withFreshKey(key []byte) LedgerOption {
	return func(cfg *ledgerConfig) error {
		cfg.keyProvider = &freshKeyProvider{key: key}
		return nil
	}
}

func testKey(t *testing.T, seed byte) []byte {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = seed + byte(i)
	}
	return key
}

// seedSealedSnapshot opens (or creates) a ledger and stores one sealed
// workspace snapshot so the file contains verifiable key-bound data.
func seedSealedSnapshot(t *testing.T, path string, key []byte) {
	t.Helper()
	ledger, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	blob, err := ledger.sealRaw("workspace_snapshots", "src/inst/1", "payload", []byte(`{"v":1}`))
	if err != nil {
		t.Fatalf("seal snapshot: %v", err)
	}
	if _, err := ledger.db.Exec(`INSERT INTO workspace_snapshots(source_id, source_instance_id, revision, content_hash, captured_at, payload) VALUES('src','inst',1,'h',1,?)`, blob); err != nil {
		t.Fatalf("insert snapshot: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}
}

func TestOpenRejectsRekeyOfExistingLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	keyA := testKey(t, 1)
	seedSealedSnapshot(t, path, keyA)

	_, err := Open(path, withFreshKey(testKey(t, 2)))
	if err == nil {
		t.Fatal("expected re-key refusal, got nil error")
	}
	if !errors.Is(err, ErrLedgerLocked) {
		t.Fatalf("expected ErrLedgerLocked, got %v", err)
	}
	if !strings.Contains(err.Error(), "refusing to re-key") {
		t.Fatalf("expected actionable refusal message, got %v", err)
	}

	// The file must be untouched: the original key still opens it.
	ledger, err := Open(path, WithKey(keyA))
	if err != nil {
		t.Fatalf("original key no longer opens the ledger: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}
}

func TestOpenDetectsFingerprintMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	keyA := testKey(t, 3)
	seedSealedSnapshot(t, path, keyA)

	_, err := Open(path, WithKey(testKey(t, 4)))
	if err == nil {
		t.Fatal("expected fingerprint mismatch, got nil error")
	}
	if !errors.Is(err, ErrLedgerLocked) {
		t.Fatalf("expected ErrLedgerLocked, got %v", err)
	}
	if !strings.Contains(err.Error(), "different key") {
		t.Fatalf("expected mismatch message, got %v", err)
	}
}

func TestOpenReusesFingerprintOnHappyPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	key := testKey(t, 5)
	seedSealedSnapshot(t, path, key)

	ledger, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatalf("reopen with same key: %v", err)
	}
	var stored string
	if err := ledger.db.QueryRow(`SELECT value FROM ledger_meta WHERE key = ?`, ledgerMetaKeyFingerprint).Scan(&stored); err != nil {
		t.Fatalf("read fingerprint: %v", err)
	}
	if stored != keyFingerprint(key) {
		t.Fatalf("fingerprint mismatch: stored %s", stored)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}
}

func TestOpenAdoptsLegacyLedgerAfterSampleDecrypt(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	key := testKey(t, 6)
	seedSealedSnapshot(t, path, key)

	// Simulate a ledger created before fingerprints existed.
	ledger, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	if _, err := ledger.db.Exec(`DELETE FROM ledger_meta WHERE key = ?`, ledgerMetaKeyFingerprint); err != nil {
		t.Fatalf("delete fingerprint: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}

	ledger, err = Open(path, WithKey(key))
	if err != nil {
		t.Fatalf("legacy adoption with matching key failed: %v", err)
	}
	var stored string
	if err := ledger.db.QueryRow(`SELECT value FROM ledger_meta WHERE key = ?`, ledgerMetaKeyFingerprint).Scan(&stored); err != nil {
		t.Fatalf("fingerprint not re-written: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}
}

func TestOpenRejectsLegacyLedgerWhenSampleDecryptFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	seedSealedSnapshot(t, path, testKey(t, 7))

	// Simulate a legacy ledger whose fingerprint is absent while its rows were
	// re-keyed behind the app's back: reopen with the ORIGINAL key to strip the
	// fingerprint, so the next open has to rely on sample decryption.
	ledger, err := Open(path, WithKey(testKey(t, 7)))
	if err != nil {
		t.Fatalf("open ledger with original key: %v", err)
	}
	if _, err := ledger.db.Exec(`DELETE FROM ledger_meta WHERE key = ?`, ledgerMetaKeyFingerprint); err != nil {
		t.Fatalf("delete fingerprint: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}

	_, err = Open(path, WithKey(testKey(t, 8)))
	if err == nil {
		t.Fatal("expected sample decrypt failure, got nil error")
	}
	if !errors.Is(err, ErrLedgerLocked) {
		t.Fatalf("expected ErrLedgerLocked, got %v", err)
	}
	if !strings.Contains(err.Error(), "sample workspace snapshot decrypt failed") {
		t.Fatalf("expected sample decrypt failure message, got %v", err)
	}
}

func TestFreshLedgerStillOpensWithFreshKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	ledger, err := Open(path, withFreshKey(testKey(t, 10)))
	if err != nil {
		t.Fatalf("fresh ledger with fresh key must open: %v", err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatalf("close ledger: %v", err)
	}
}

// immediateTurnModel completes a turn without touching channels, keeping the
// fallback regression test synchronous.
type immediateTurnModel struct{}

func (m *immediateTurnModel) Execute(_ context.Context, _ ModelTurnRequest, sink ModelDeltaSink) (ModelTurnResult, error) {
	if err := sink(context.Background(), ModelDelta{Text: "ok"}); err != nil {
		return ModelTurnResult{}, err
	}
	return ModelTurnResult{Text: "ok", Completed: true}, nil
}

// TestSubmitInputFallsBackWhenBoundSessionMissing covers panel state that
// outlived the ledger: a session-bound input whose session row is absent must
// start a fresh conversation instead of failing the send.
func TestSubmitInputFallsBackWhenBoundSessionMissing(t *testing.T) {
	harness, ledger := newContractHarness(t, &immediateTurnModel{}, nil, nil)
	const staleSessionID = "session-removed-from-ledger"

	receipt, err := harness.SubmitInput(context.Background(), AgentInputRequest{
		RequestID:        "stale-session-fallback",
		SessionID:        staleSessionID,
		ExpectedRevision: 4,
		Content:          "hello after ledger reset",
	})
	if err != nil {
		t.Fatalf("submit with missing session must fall back, got: %v", err)
	}
	if receipt.SessionID == "" || receipt.SessionID == staleSessionID {
		t.Fatalf("receipt must reference a fresh session, got %q", receipt.SessionID)
	}

	projection, err := ledger.GetSession(context.Background(), receipt.SessionID, true)
	if err != nil {
		t.Fatalf("fresh session not readable: %v", err)
	}
	if len(projection.Messages) == 0 {
		t.Fatal("fallback run must record the user message in the fresh session")
	}
}

// TestDeniedKeychainPromptDoesNotRekeyExistingLedger is the release-blocking
// regression for the 0.9.5 data-loss incident: denying the Keychain ACL prompt
// must never lead to the stored key being overwritten, and a retry after
// granting access must fully recover the existing ledger.
func TestDeniedKeychainPromptDoesNotRekeyExistingLedger(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	realKey := testKey(t, 20)
	seedSealedSnapshot(t, path, realKey)

	store := &flakyKeyringStore{items: map[string][]byte{}}
	ref, err := secretstore.BuildRef("ai-ledger", "default")
	if err != nil {
		t.Fatalf("build ref: %v", err)
	}
	store.items[ref] = append([]byte(nil), realKey...)

	// The next read is denied; macOS reports the existing item as not found.
	store.denyReads = 1
	_, err = Open(path, WithKeyring(ref, store))
	if err == nil {
		t.Fatal("open with denied keychain access must fail, got nil error")
	}
	if !errors.Is(err, ErrLedgerLocked) {
		t.Fatalf("expected ErrLedgerLocked, got %v", err)
	}
	if !strings.Contains(err.Error(), "no matching encryption key") {
		t.Fatalf("expected key-missing refusal message, got %v", err)
	}
	if store.puts != 0 {
		t.Fatalf("denied prompt must not write to the key store (puts=%d) — the original key would be destroyed", store.puts)
	}

	// The user retries and grants access: the original key must open the
	// ledger and decrypt the stored rows.
	ledger, err := Open(path, WithKeyring(ref, store))
	if err != nil {
		t.Fatalf("retry after granting access failed: %v", err)
	}
	defer ledger.Close()
	var payload []byte
	if err := ledger.db.QueryRow(`SELECT payload FROM workspace_snapshots WHERE source_id = 'src'`).Scan(&payload); err != nil {
		t.Fatalf("read sealed snapshot: %v", err)
	}
	plain, err := ledger.openRaw("workspace_snapshots", "src/inst/1", "payload", payload)
	if err != nil {
		t.Fatalf("stored data must decrypt with the preserved key: %v", err)
	}
	if !strings.Contains(string(plain), `"v":1`) {
		t.Fatalf("unexpected plaintext %q", plain)
	}
}
