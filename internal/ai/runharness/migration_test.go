package runharness

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func writeLegacySession(t *testing.T, dir, name string, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal legacy session: %v", err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write legacy session: %v", err)
	}
	return path
}

func readLedgerFiles(t *testing.T, path string) []byte {
	t.Helper()
	entries, err := filepath.Glob(path + "*")
	if err != nil {
		t.Fatalf("glob ledger files: %v", err)
	}
	var all []byte
	for _, entry := range entries {
		data, err := os.ReadFile(entry)
		if err != nil {
			continue
		}
		all = append(all, data...)
	}
	return all
}

func TestMigrateLegacySessionsImportsEncryptsAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	ledgerPath := filepath.Join(root, "agent_runs.sqlite")
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	l, err := Open(ledgerPath, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })

	updated := "2026-08-31T12:34:56.123Z"
	path := writeLegacySession(t, sessionsDir, "legacy-1.json", map[string]any{
		"id":        "legacy-1",
		"title":     "Imported secret title",
		"updatedAt": updated,
		"messages": []any{
			map[string]any{
				"id":                "legacy-message-1",
				"role":              "user",
				"content":           "legacy secret prompt",
				"timestamp":         updated,
				"images":            []string{"data:image/png;base64,secret-image"},
				"attachments":       []any{map[string]any{"name": "secret.txt", "mediaType": "text/plain", "data": "secret attachment"}},
				"reasoning_content": "secret reasoning",
				"tool_call_id":      "call-1",
				"tool_calls":        []any{map[string]any{"id": "call-1", "type": "function"}},
				"metadata":          map[string]any{"sensitive": "secret metadata"},
			},
			map[string]any{
				"id":      "legacy-message-2",
				"role":    "assistant",
				"content": "legacy secret answer",
			},
		},
		"providerKey":      "secret-provider-key",
		"providerState":    map[string]any{"opaque": "secret-provider-state"},
		"providerMessages": []any{map[string]any{"role": "user", "content": "secret-provider-message"}},
	})

	result, err := l.MigrateLegacySessions(context.Background(), sessionsDir)
	if err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	if result != (LegacyMigrationResult{Scanned: 1, Imported: 1}) {
		t.Fatalf("migration result = %#v", result)
	}
	session, err := l.GetSession(context.Background(), "legacy-1", true)
	if err != nil {
		t.Fatalf("read imported session: %v", err)
	}
	if session.Title != "Imported secret title" || len(session.Messages) != 2 {
		t.Fatalf("session projection = %#v", session)
	}
	message := session.Messages[0]
	if message.Content != "legacy secret prompt" || message.Role != "user" || message.ToolCallID != "call-1" || message.Reasoning != "secret reasoning" {
		t.Fatalf("message projection = %#v", message)
	}
	if len(message.Attachments) != 1 || message.Attachments[0].Data != "secret attachment" || len(message.Images) != 1 {
		t.Fatalf("message metadata = %#v", message)
	}
	var providerBlob []byte
	if err := l.db.QueryRow(`SELECT payload FROM migration_records WHERE source_path=?`, path).Scan(&providerBlob); err != nil {
		t.Fatalf("read migration record: %v", err)
	}
	if len(providerBlob) == 0 {
		t.Fatal("provider payload was not persisted")
	}
	plain, err := l.openRaw("migration_records", path, "provider_state", providerBlob)
	if err != nil {
		t.Fatalf("decrypt provider payload: %v", err)
	}
	var envelope legacyProviderEnvelope
	if err := json.Unmarshal(plain, &envelope); err != nil {
		t.Fatalf("decode provider payload: %v", err)
	}
	if envelope.ProviderKey != "secret-provider-key" || string(envelope.ProviderState) != `{"opaque":"secret-provider-state"}` {
		t.Fatalf("provider envelope = %#v", envelope)
	}
	if got := readLedgerFiles(t, ledgerPath); containsBytes(got, []byte("legacy secret")) || containsBytes(got, []byte("secret-provider")) {
		t.Fatal("legacy sensitive values appear in SQLite files")
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o400 {
			t.Fatalf("migrated source permissions = %o, want 0400", info.Mode().Perm())
		}
	}

	second, err := l.MigrateLegacySessions(context.Background(), sessionsDir)
	if err != nil {
		t.Fatalf("idempotent migration failed: %v", err)
	}
	if second != (LegacyMigrationResult{Scanned: 1, Skipped: 1}) {
		t.Fatalf("idempotent result = %#v", second)
	}
	session, err = l.GetSession(context.Background(), "legacy-1", true)
	if err != nil || len(session.Messages) != 2 {
		t.Fatalf("idempotent session = %#v, %v", session, err)
	}

	modified := map[string]any{"id": "legacy-1", "title": "changed", "messages": []any{}}
	data, err := json.Marshal(modified)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o600); err != nil && runtime.GOOS != "windows" {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.MigrateLegacySessions(context.Background(), sessionsDir); !errors.Is(err, ErrMigrationConflict) {
		t.Fatalf("modified source error = %v", err)
	}
}

func TestOpenAutomaticallyMigratesSiblingSessions(t *testing.T) {
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeLegacySession(t, sessionsDir, "auto.json", map[string]any{
		"id": "auto-session", "title": "auto imported", "updatedAt": time.Now().UTC().Format(time.RFC3339Nano),
		"messages": []any{map[string]any{"role": "user", "content": "auto secret"}},
	})
	path := filepath.Join(root, "agent_runs.sqlite")
	l, err := Open(path, WithKey(make([]byte, 32)))
	if err != nil {
		t.Fatalf("Open auto migration failed: %v", err)
	}
	defer l.Close()
	session, err := l.GetSession(context.Background(), "auto-session", true)
	if err != nil || session.Title != "auto imported" || len(session.Messages) != 1 {
		t.Fatalf("auto imported session = %#v, %v", session, err)
	}
}

func TestMigrateLegacySessionsValidatesBeforeWriting(t *testing.T) {
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	l := testLedger(t)
	writeLegacySession(t, sessionsDir, "01-valid.json", map[string]any{
		"id": "valid", "title": "valid", "messages": []any{map[string]any{"role": "user", "content": "secret"}},
	})
	if err := os.WriteFile(filepath.Join(sessionsDir, "02-corrupt.json"), []byte(`{"id":`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := l.MigrateLegacySessions(context.Background(), sessionsDir); !errors.Is(err, ErrMigrationCorrupt) {
		t.Fatalf("corrupt migration error = %v", err)
	}
	var sessions, records int
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM migration_records`).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 || records != 0 {
		t.Fatalf("partial migration left rows: sessions=%d records=%d", sessions, records)
	}
}

func TestMigrateLegacySessionsRollsBackOnConflict(t *testing.T) {
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	l := testLedger(t)
	for _, name := range []string{"01-first.json", "02-second.json"} {
		writeLegacySession(t, sessionsDir, name, map[string]any{
			"id": "same-session", "title": name, "messages": []any{map[string]any{"role": "user", "content": name}},
		})
	}
	if _, err := l.MigrateLegacySessions(context.Background(), sessionsDir); !errors.Is(err, ErrMigrationConflict) {
		t.Fatalf("conflicting migration error = %v", err)
	}
	var sessions, records, messages int
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM migration_records`).Scan(&records); err != nil {
		t.Fatal(err)
	}
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&messages); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 || records != 0 || messages != 0 {
		t.Fatalf("conflict migration was not rolled back: sessions=%d records=%d messages=%d", sessions, records, messages)
	}
}

func TestOpenSkipsLegacyMigrationForURIAndMemoryDSNs(t *testing.T) {
	sessionsDir := filepath.Join(t.TempDir(), "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeLegacySession(t, sessionsDir, "ignored.json", map[string]any{"id": "ignored", "title": "ignored"})
	for _, path := range []string{":memory:", "file::memory:?cache=shared"} {
		l, err := Open(path, WithKey(make([]byte, 32)))
		if err != nil {
			t.Fatalf("Open(%q): %v", path, err)
		}
		if _, err := l.GetSession(context.Background(), "ignored", false); !errors.Is(err, ErrNotFound) {
			t.Fatalf("URI %q unexpectedly migrated session: %v", path, err)
		}
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestLegacyMigrationHashUsesRawSource(t *testing.T) {
	root := t.TempDir()
	sessionsDir := filepath.Join(root, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	l := testLedger(t)
	path := writeLegacySession(t, sessionsDir, "hash.json", map[string]any{"id": "hash", "title": "hash"})
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	want := sha256.Sum256(raw)
	result, err := l.MigrateLegacySessions(context.Background(), sessionsDir)
	if err != nil || result.Imported != 1 {
		t.Fatalf("migration = %#v, %v", result, err)
	}
	var got string
	if err := l.db.QueryRow(`SELECT source_sha256 FROM migration_records WHERE source_path=?`, path).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != hex.EncodeToString(want[:]) {
		t.Fatalf("source hash = %q, want %q", got, hex.EncodeToString(want[:]))
	}
}
