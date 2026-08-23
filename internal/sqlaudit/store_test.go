package sqlaudit

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "audit", "sql_audit.db"))
	if err != nil {
		t.Fatalf("Open returned error: %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil && !errors.Is(err, ErrClosed) {
			t.Errorf("Close returned error: %v", err)
		}
	})
	return store
}

func sampleEvent(id string, timestamp int64) Event {
	return Event{
		ID:                    id,
		Timestamp:             timestamp,
		EventType:             "query",
		Status:                "success",
		ConnectionID:          "conn-main",
		ConnectionFingerprint: "postgres://admin:raw-secret@db.example/app",
		DBType:                "mysql",
		Database:              "analytics",
		QueryID:               "query-1",
		Source:                "query_editor",
		BoundaryMode:          BoundaryModeDriverAPI,
		SQLText:               "SELECT * FROM users WHERE id = 42 AND token = 'raw-token'",
		DurationMs:            25,
		RowsReturned:          1,
	}
}

func TestOpenConfiguresSQLiteAndDefaultSettings(t *testing.T) {
	store := openTestStore(t)
	settings, err := store.GetSettings()
	if err != nil {
		t.Fatalf("GetSettings returned error: %v", err)
	}
	if settings != DefaultSettings() {
		t.Fatalf("unexpected defaults: %#v", settings)
	}

	var journalMode string
	if err := store.db.QueryRow(`PRAGMA journal_mode`).Scan(&journalMode); err != nil {
		t.Fatalf("read journal mode: %v", err)
	}
	if strings.ToLower(journalMode) != "wal" {
		t.Fatalf("journal mode must be WAL, got %q", journalMode)
	}
	var synchronous int
	if err := store.db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		t.Fatalf("read synchronous mode: %v", err)
	}
	if synchronous != 2 {
		t.Fatalf("synchronous must be FULL (2), got %d", synchronous)
	}
	if got := store.db.Stats().MaxOpenConnections; got != 4 {
		t.Fatalf("MaxOpenConnections=%d, want 4", got)
	}

	connections := make([]interface{ Close() error }, 0, 4)
	for index := 0; index < 4; index++ {
		conn, err := store.db.Conn(context.Background())
		if err != nil {
			t.Fatalf("acquire pooled connection %d: %v", index+1, err)
		}
		connections = append(connections, conn)
		var busyTimeout, foreignKeys, connectionSynchronous int
		var connectionJournal string
		if err := conn.QueryRowContext(context.Background(), `PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
			t.Fatalf("read connection %d busy_timeout: %v", index+1, err)
		}
		if err := conn.QueryRowContext(context.Background(), `PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
			t.Fatalf("read connection %d foreign_keys: %v", index+1, err)
		}
		if err := conn.QueryRowContext(context.Background(), `PRAGMA synchronous`).Scan(&connectionSynchronous); err != nil {
			t.Fatalf("read connection %d synchronous: %v", index+1, err)
		}
		if err := conn.QueryRowContext(context.Background(), `PRAGMA journal_mode`).Scan(&connectionJournal); err != nil {
			t.Fatalf("read connection %d journal_mode: %v", index+1, err)
		}
		if busyTimeout != 5000 || foreignKeys != 1 || connectionSynchronous != 2 || strings.ToLower(connectionJournal) != "wal" {
			t.Fatalf("connection %d PRAGMAs unexpected: busy=%d foreign=%d sync=%d journal=%q",
				index+1, busyTimeout, foreignKeys, connectionSynchronous, connectionJournal)
		}
	}
	for _, conn := range connections {
		if err := conn.Close(); err != nil {
			t.Fatalf("close pooled connection: %v", err)
		}
	}

	if runtime.GOOS != "windows" {
		dirInfo, err := os.Stat(filepath.Dir(store.Path()))
		if err != nil {
			t.Fatalf("stat audit directory: %v", err)
		}
		if got := dirInfo.Mode().Perm(); got != 0o700 {
			t.Fatalf("audit directory mode = %#o, want 0700", got)
		}
		fileInfo, err := os.Stat(store.Path())
		if err != nil {
			t.Fatalf("stat audit database: %v", err)
		}
		if got := fileInfo.Mode().Perm(); got != 0o600 {
			t.Fatalf("audit database mode = %#o, want 0600", got)
		}
	}
}

func TestOpenMigratesV1EventsWithoutBreakingExistingHashChain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "sql_audit.db")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open v2 store: %v", err)
	}
	if err := store.Append(sampleEvent("v1-event", time.Now().UnixMilli())); err != nil {
		t.Fatalf("append v1-compatible event: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close v2 store: %v", err)
	}

	legacyDB, err := sql.Open("sqlite", sqliteAuditDSN(path))
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	for _, column := range []string{"executed_count", "failed_index", "outcome_unknown"} {
		if _, err := legacyDB.Exec("ALTER TABLE sql_audit_events DROP COLUMN " + column); err != nil {
			_ = legacyDB.Close()
			t.Fatalf("drop v2 column %s: %v", column, err)
		}
	}
	if _, err := legacyDB.Exec("PRAGMA user_version=1"); err != nil {
		_ = legacyDB.Close()
		t.Fatalf("set v1 schema version: %v", err)
	}
	if err := legacyDB.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("Open migrated v1 store: %v", err)
	}
	t.Cleanup(func() { _ = migrated.Close() })
	report, err := migrated.VerifyIntegrity()
	if err != nil || !report.Valid || report.CheckedRecords != 1 {
		t.Fatalf("migrated v1 integrity report = %#v, err=%v", report, err)
	}
	page, err := migrated.Query(Filter{PageSize: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].ExecutedCount != 0 || page.Items[0].FailedIndex != 0 || page.Items[0].OutcomeUnknown {
		t.Fatalf("migrated v1 event = %#v, err=%v", page.Items, err)
	}
}

func TestOpenSupportsURIReservedCharactersInPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit space # percent% amp&", "sql audit.db")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("Open reserved-character path returned error: %v", err)
	}
	if err := store.Append(sampleEvent("reserved-path", time.Now().UnixMilli())); err != nil {
		_ = store.Close()
		t.Fatalf("Append reserved-character path returned error: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close reserved-character path returned error: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("SQLite database was not created at literal path %q: %v", path, err)
	}
	if info, err := os.Stat(path + "-wal"); err == nil && info.Size() > 0 {
		t.Fatalf("Close should checkpoint/truncate WAL before migration, size=%d", info.Size())
	} else if err != nil && !os.IsNotExist(err) {
		t.Fatalf("stat WAL after Close: %v", err)
	}
}

func TestAppendSanitizesAndQueryFiltersWithSummary(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	first := sampleEvent("event-1", now-100)
	first.TransactionID = "tx-1"
	if err := store.Append(first); err != nil {
		t.Fatalf("Append first returned error: %v", err)
	}
	second := sampleEvent("event-2", now)
	second.Status = "error"
	second.TransactionID = "tx-2"
	second.Error = "password=driver-secret failed near 'raw-token'"
	if err := store.Append(second); err != nil {
		t.Fatalf("Append second returned error: %v", err)
	}

	page, err := store.Query(Filter{Database: "analytics", Page: 1, PageSize: 1})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}
	if page.Total != 2 || len(page.Items) != 1 || page.Items[0].ID != "event-2" {
		t.Fatalf("unexpected page: %#v", page)
	}
	if page.Summary.TotalEvents != 2 || page.Summary.SuccessCount != 1 ||
		page.Summary.ErrorCount != 1 || page.Summary.TransactionCount != 2 {
		t.Fatalf("unexpected summary: %#v", page.Summary)
	}
	event := page.Items[0]
	for _, secret := range []string{"42", "raw-token", "driver-secret", "admin", "raw-secret", "db.example"} {
		if strings.Contains(event.SQLText+event.Error+event.ConnectionFingerprint, secret) {
			t.Fatalf("stored audit event leaked %q: %#v", secret, event)
		}
	}
	if !event.SQLRedacted || event.SQLFingerprint == "" || len(event.ConnectionFingerprint) != 64 {
		t.Fatalf("event was not safely normalized: %#v", event)
	}

	errorPage, err := store.Query(Filter{Status: "error", Search: "password", PageSize: 10})
	if err != nil || errorPage.Total != 1 || len(errorPage.Items) != 1 {
		t.Fatalf("filtered query failed: page=%#v err=%v", errorPage, err)
	}

	assertAuditStorageFilesDoNotContain(t, store.Path(), []string{"raw-token", "driver-secret", "raw-secret"})
}

func TestQuerySupportsContractFiltersAndEscapesSearchWildcards(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	target := sampleEvent("filter-target", now)
	target.EventType = "TRANSACTION_COMMIT"
	target.Status = "SUCCESS"
	target.TransactionID = "tx-filter"
	target.Source = "SYSTEM"
	target.DBType = "MYSQL"
	if err := store.Append(target); err != nil {
		t.Fatalf("Append target returned error: %v", err)
	}
	other := sampleEvent("filter-other", now+100)
	other.ConnectionID = "conn-other"
	other.Database = "reporting"
	other.TransactionID = "tx-other"
	if err := store.Append(other); err != nil {
		t.Fatalf("Append other returned error: %v", err)
	}

	page, err := store.Query(Filter{
		ConnectionID:  "conn-main",
		Database:      "analytics",
		DBType:        "MYSQL",
		EventType:     "TRANSACTION_COMMIT",
		Status:        "SUCCESS",
		TransactionID: "tx-filter",
		Source:        "SYSTEM",
		FromTimestamp: now - 1,
		ToTimestamp:   now + 1,
		PageSize:      10,
	})
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != "filter-target" {
		t.Fatalf("contract filters did not isolate target: page=%#v err=%v", page, err)
	}

	page, err = store.Query(Filter{Search: `%_' OR 1=1 --`, PageSize: 10})
	if err != nil || page.Total != 0 {
		t.Fatalf("literal wildcard/injection-like search should not broaden results: page=%#v err=%v", page, err)
	}

	all, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(all.Items) == 0 {
		t.Fatalf("load events for fingerprint search: page=%#v err=%v", all, err)
	}
	fingerprintPrefix := all.Items[0].SQLFingerprint[:12]
	page, err = store.Query(Filter{Search: fingerprintPrefix, PageSize: 10})
	if err != nil || page.Total == 0 {
		t.Fatalf("fingerprint search should find matching events: page=%#v err=%v", page, err)
	}
}

func TestQueryExecutionHistoryIncludesEditorRunsWithoutTransactionLifecycleNoise(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	events := []Event{
		{ID: "editor-query", EventType: "query", Status: "success", Source: "query_editor", SQLText: "SELECT 1", Timestamp: now},
		{ID: "editor-query-statement", EventType: "query_statement", Status: "success", Source: "query_editor", SQLText: "SELECT 1", Timestamp: now + 1},
		{ID: "editor-transaction-statement", EventType: "transaction_statement", Status: "error", Source: "query_editor", SQLText: "UPDATE users SET active = 1", Timestamp: now + 2},
		{ID: "editor-transaction-open-failed", EventType: "transaction_begin", Status: "error", Source: "query_editor", SQLText: "UPDATE users SET active = 1", Timestamp: now + 3},
		{ID: "editor-transaction-opened", EventType: "transaction_begin", Status: "success", Source: "query_editor", SQLText: "UPDATE users SET active = 1", Timestamp: now + 4},
		{ID: "editor-transaction-commit", EventType: "transaction_commit", Status: "success", Source: "query_editor", Timestamp: now + 5},
		{ID: "application-query", EventType: "query", Status: "success", Source: "application_api", SQLText: "SELECT 2", Timestamp: now + 6},
	}
	for _, event := range events {
		event.ConnectionID = "conn-main"
		event.ConnectionFingerprint = strings.Repeat("a", 64)
		event.DBType = "postgres"
		event.Database = "analytics"
		if err := store.Append(event); err != nil {
			t.Fatalf("Append %s returned error: %v", event.ID, err)
		}
	}

	page, err := store.Query(Filter{ExecutionHistory: true, PageSize: 10})
	if err != nil {
		t.Fatalf("Query execution history returned error: %v", err)
	}
	if page.Total != 3 || len(page.Items) != 3 {
		t.Fatalf("execution history page = %#v, want three editor executions", page)
	}
	ids := map[string]bool{}
	for _, event := range page.Items {
		ids[event.ID] = true
	}
	for _, id := range []string{"editor-query", "editor-transaction-statement", "editor-transaction-open-failed"} {
		if !ids[id] {
			t.Fatalf("execution history omitted %s: %#v", id, page.Items)
		}
	}
	for _, id := range []string{"editor-query-statement", "editor-transaction-opened", "editor-transaction-commit", "application-query"} {
		if ids[id] {
			t.Fatalf("execution history included non-execution event %s: %#v", id, page.Items)
		}
	}
}

func TestMetadataAndDisabledCaptureModes(t *testing.T) {
	store := openTestStore(t)
	settings := DefaultSettings()
	settings.CaptureMode = CaptureModeMetadata
	if err := store.UpdateSettings(settings); err != nil {
		t.Fatalf("UpdateSettings(metadata) returned error: %v", err)
	}
	if err := store.Append(sampleEvent("metadata-event", time.Now().UnixMilli())); err != nil {
		t.Fatalf("Append metadata event returned error: %v", err)
	}
	page, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("query metadata event: page=%#v err=%v", page, err)
	}
	if page.Items[0].SQLText != "" || page.Items[0].SQLFingerprint == "" || !page.Items[0].SQLRedacted {
		t.Fatalf("metadata capture persisted SQL text: %#v", page.Items[0])
	}

	settings.Enabled = false
	if err := store.UpdateSettings(settings); err != nil {
		t.Fatalf("UpdateSettings(disabled) returned error: %v", err)
	}
	if err := store.Append(sampleEvent("disabled-event", time.Now().UnixMilli())); err != nil {
		t.Fatalf("disabled Append should be a no-op: %v", err)
	}
	page, err = store.Query(Filter{PageSize: 10})
	if err != nil || page.Total != 1 {
		t.Fatalf("disabled capture should not append: page=%#v err=%v", page, err)
	}
}

func TestControlBoundariesAreAtomicAndBypassDisabledCapture(t *testing.T) {
	store := openTestStore(t)
	settings := DefaultSettings()
	settings.Enabled = false
	settings.CaptureMode = CaptureModeMetadata
	control := Event{ID: "settings-control", EventType: "audit_settings_change", Status: "success", Source: "audit_control"}
	if err := store.UpdateSettingsWithControl(settings, control); err != nil {
		t.Fatalf("UpdateSettingsWithControl returned error: %v", err)
	}
	if err := store.Append(sampleEvent("disabled-ordinary", time.Now().UnixMilli())); err != nil {
		t.Fatalf("disabled ordinary append returned error: %v", err)
	}
	page, err := store.Query(Filter{PageSize: 10})
	if err != nil || page.Total != 1 || page.Items[0].ID != "settings-control" {
		t.Fatalf("disabled control boundary was not retained: page=%#v err=%v", page, err)
	}
	if !strings.Contains(page.Items[0].SQLText, "FROM_ENABLED_ON TO_ENABLED_OFF") {
		t.Fatalf("settings control boundary lacks safe old/new metadata: %q", page.Items[0].SQLText)
	}

	deleted, err := store.ClearWithControl(0, Event{ID: "clear-control", EventType: "audit_clear", Status: "success", Source: "audit_control"})
	if err != nil || deleted != 1 {
		t.Fatalf("ClearWithControl deleted=%d err=%v, want 1", deleted, err)
	}
	page, err = store.Query(Filter{PageSize: 10})
	if err != nil || page.Total != 1 || page.Items[0].ID != "clear-control" || page.Items[0].RowsAffected != 1 {
		t.Fatalf("clear control boundary was not atomically retained: page=%#v err=%v", page, err)
	}
	if page.Items[0].SQLText != "AUDIT CLEAR ALL" {
		t.Fatalf("metadata capture erased the clear control descriptor: %q", page.Items[0].SQLText)
	}
}

func TestAppendNeverPersistsRedisOrMessagePayloadSecrets(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	redisEvent := sampleEvent("redis-secret", now)
	redisEvent.DBType = "redis"
	redisEvent.SQLText = `HSET account:42 email private@example.test token redis-token-secret`
	redisEvent.Error = `AUTH failed password=redis-error-secret`
	if err := store.Append(redisEvent); err != nil {
		t.Fatalf("Append Redis event returned error: %v", err)
	}
	mqEvent := sampleEvent("mq-secret", now+1)
	mqEvent.DBType = "rocketmq"
	mqEvent.SQLText = `PUBLISH orders {"token":"mq-payload-secret","card":"4111111111111111"}`
	mqEvent.Error = `publish rejected token=mq-error-secret`
	if err := store.Append(mqEvent); err != nil {
		t.Fatalf("Append MQ event returned error: %v", err)
	}
	mqEventSecond := sampleEvent("mq-secret-second", now+2)
	mqEventSecond.DBType = "rocketmq"
	mqEventSecond.SQLText = `PUBLISH orders {"token":"different-low-entropy-secret"}`
	if err := store.Append(mqEventSecond); err != nil {
		t.Fatalf("Append second MQ event returned error: %v", err)
	}

	page, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(page.Items) != 3 {
		t.Fatalf("query non-SQL audit events: page=%#v err=%v", page, err)
	}
	byID := map[string]Event{}
	for _, event := range page.Items {
		byID[event.ID] = event
	}
	if got := byID["redis-secret"].SQLText; got != "HSET account:42 email ? token ?" {
		t.Fatalf("unexpected Redis audit text: %q", got)
	}
	if got := byID["mq-secret"].SQLText; got != "" {
		t.Fatalf("message payload must be metadata-only, got %q", got)
	}
	if byID["mq-secret"].SQLFingerprint == "" {
		t.Fatal("metadata-only message event still needs a safe fingerprint")
	}
	if byID["mq-secret"].SQLFingerprint != byID["mq-secret-second"].SQLFingerprint {
		t.Fatalf("metadata-only fingerprint must not depend on message payload: first=%s second=%s",
			byID["mq-secret"].SQLFingerprint, byID["mq-secret-second"].SQLFingerprint)
	}

	assertAuditStorageFilesDoNotContain(t, store.Path(), []string{
		"private@example.test", "redis-token-secret", "redis-error-secret",
		"mq-payload-secret", "4111111111111111", "mq-error-secret", "different-low-entropy-secret",
	})
}

func TestIntegrityDetectsTampering(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	for index := 0; index < 2; index++ {
		if err := store.Append(sampleEvent("integrity-"+string(rune('a'+index)), now+int64(index))); err != nil {
			t.Fatalf("Append returned error: %v", err)
		}
	}
	report, err := store.VerifyIntegrity()
	if err != nil || !report.Valid || !report.WeakValidation || report.CheckedRecords != 2 {
		t.Fatalf("unexpected valid integrity report: %#v err=%v", report, err)
	}
	if _, err := store.db.Exec(`UPDATE sql_audit_events SET sql_text='tampered' WHERE sequence=1`); err != nil {
		t.Fatalf("tamper test database: %v", err)
	}
	report, err = store.VerifyIntegrity()
	if err != nil || report.Valid || report.InvalidSequence != 1 {
		t.Fatalf("tampering was not detected: %#v err=%v", report, err)
	}
}

func TestClearAndRecordLimitPreserveRemainingHashes(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	for index := 0; index < 3; index++ {
		if err := store.Append(sampleEvent("clear-"+string(rune('a'+index)), now-3000+int64(index*1000))); err != nil {
			t.Fatalf("Append returned error: %v", err)
		}
	}
	beforeClear, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(beforeClear.Items) != 3 {
		t.Fatalf("query before clear: page=%#v err=%v", beforeClear, err)
	}
	retainedHash := beforeClear.Items[0].Hash
	deleted, err := store.Clear(now - 1500)
	if err != nil || deleted != 2 {
		t.Fatalf("Clear deleted=%d err=%v, want 2", deleted, err)
	}
	page, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].PrevHash == "" {
		t.Fatalf("clear rewrote or lost the retained chain anchor: page=%#v err=%v", page, err)
	}
	if page.Items[0].Hash != retainedHash {
		t.Fatalf("clear must not rewrite retained event hash: before=%s after=%s", retainedHash, page.Items[0].Hash)
	}
	if report, err := store.VerifyIntegrity(); err != nil || !report.Valid || !report.PartialChain || !report.TruncatedPrefix {
		t.Fatalf("chain invalid after clear: report=%#v err=%v", report, err)
	}

	settings := DefaultSettings()
	settings.MaxRecords = 2
	if err := store.UpdateSettings(settings); err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	for index := 0; index < 3; index++ {
		if err := store.Append(sampleEvent("limited-"+string(rune('a'+index)), now+int64(index))); err != nil {
			t.Fatalf("Append limited event returned error: %v", err)
		}
	}
	page, err = store.Query(Filter{PageSize: 10})
	if err != nil || page.Total != 2 {
		t.Fatalf("record limit not enforced: page=%#v err=%v", page, err)
	}
	if report, err := store.VerifyIntegrity(); err != nil || !report.Valid || !report.PartialChain {
		t.Fatalf("chain invalid after record-limit pruning: report=%#v err=%v", report, err)
	}
}

func TestClearDeletesOnlyContiguousPrefixForOutOfOrderTimestamps(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	for _, event := range []Event{
		sampleEvent("prefix-old", now-10_000),
		sampleEvent("prefix-new", now),
		sampleEvent("later-sequence-old-time", now-20_000),
	} {
		if err := store.Append(event); err != nil {
			t.Fatalf("Append returned error: %v", err)
		}
	}
	before, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(before.Items) != 3 {
		t.Fatalf("query before clear: page=%#v err=%v", before, err)
	}
	hashes := map[string]string{}
	for _, event := range before.Items {
		hashes[event.ID] = event.Hash
	}

	deleted, err := store.Clear(now - 5_000)
	if err != nil || deleted != 1 {
		t.Fatalf("Clear should delete only one contiguous prefix event: deleted=%d err=%v", deleted, err)
	}
	after, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(after.Items) != 2 {
		t.Fatalf("query after clear: page=%#v err=%v", after, err)
	}
	for _, event := range after.Items {
		if event.Hash != hashes[event.ID] {
			t.Fatalf("retained event %s hash was rewritten", event.ID)
		}
	}
	if report, err := store.VerifyIntegrity(); err != nil || !report.Valid || !report.PartialChain {
		t.Fatalf("partial chain should remain verifiable: report=%#v err=%v", report, err)
	}
}

func TestConcurrentAppendKeepsUniqueOrderedChain(t *testing.T) {
	store := openTestStore(t)
	const count = 32
	now := time.Now().UnixMilli()
	var wait sync.WaitGroup
	errorsCh := make(chan error, count)
	for index := 0; index < count; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			event := sampleEvent("concurrent-"+time.UnixMilli(int64(index)).Format("150405.000000000"), now+int64(index))
			errorsCh <- store.Append(event)
		}(index)
	}
	wait.Wait()
	close(errorsCh)
	for err := range errorsCh {
		if err != nil {
			t.Fatalf("concurrent Append returned error: %v", err)
		}
	}
	page, err := store.Query(Filter{PageSize: count})
	if err != nil || page.Total != count {
		t.Fatalf("concurrent events missing: total=%d err=%v", page.Total, err)
	}
	seen := make(map[int64]struct{}, count)
	for _, event := range page.Items {
		if _, duplicate := seen[event.Sequence]; duplicate {
			t.Fatalf("duplicate sequence %d", event.Sequence)
		}
		seen[event.Sequence] = struct{}{}
	}
	if report, err := store.VerifyIntegrity(); err != nil || !report.Valid || report.CheckedRecords != count {
		t.Fatalf("concurrent chain invalid: report=%#v err=%v", report, err)
	}
}

func TestWALReaderDoesNotBlockSynchronousAppend(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	if err := store.Append(sampleEvent("wal-seed", now)); err != nil {
		t.Fatalf("Append seed returned error: %v", err)
	}
	reader, err := store.db.Conn(context.Background())
	if err != nil {
		t.Fatalf("acquire reader connection: %v", err)
	}
	defer reader.Close()
	if _, err := reader.ExecContext(context.Background(), `BEGIN`); err != nil {
		t.Fatalf("begin reader transaction: %v", err)
	}
	rows, err := reader.QueryContext(context.Background(), `SELECT id FROM sql_audit_events ORDER BY sequence`)
	if err != nil {
		_, _ = reader.ExecContext(context.Background(), `ROLLBACK`)
		t.Fatalf("open reader cursor: %v", err)
	}
	defer rows.Close()
	if !rows.Next() {
		t.Fatal("reader cursor should expose seed event")
	}
	var seedID string
	if err := rows.Scan(&seedID); err != nil || seedID != "wal-seed" {
		t.Fatalf("scan reader cursor id=%q err=%v", seedID, err)
	}

	done := make(chan error, 1)
	go func() {
		done <- store.Append(sampleEvent("wal-writer", now+1))
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Append while WAL reader active returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("active WAL reader blocked synchronous audit append")
	}
	if err := rows.Close(); err != nil {
		t.Fatalf("close reader rows: %v", err)
	}
	if _, err := reader.ExecContext(context.Background(), `ROLLBACK`); err != nil {
		t.Fatalf("rollback reader transaction: %v", err)
	}
}

func TestAppendBatchIsAtomicAndKeepsOneContinuousChain(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	if err := store.Append(sampleEvent("before-batch", now)); err != nil {
		t.Fatalf("Append before batch returned error: %v", err)
	}
	batch := []Event{
		sampleEvent("batch-1", now+1),
		sampleEvent("batch-2", now+2),
		sampleEvent("batch-3", now+3),
	}
	if err := store.AppendBatch(batch); err != nil {
		t.Fatalf("AppendBatch returned error: %v", err)
	}
	page, err := store.Query(Filter{PageSize: 10})
	if err != nil || page.Total != 4 {
		t.Fatalf("query after batch: page=%#v err=%v", page, err)
	}
	report, err := store.VerifyIntegrity()
	if err != nil || !report.Valid || report.CheckedRecords != 4 {
		t.Fatalf("integrity after batch: report=%#v err=%v", report, err)
	}

	duplicateBatch := []Event{
		sampleEvent("atomic-new", now+4),
		sampleEvent("batch-2", now+5),
	}
	if err := store.AppendBatch(duplicateBatch); err == nil {
		t.Fatal("AppendBatch with duplicate ID should fail")
	}
	page, err = store.Query(Filter{Search: "atomic-new", PageSize: 10})
	if err != nil || page.Total != 0 {
		t.Fatalf("failed batch should roll back every event: page=%#v err=%v", page, err)
	}
}

func TestAppendBatchLargerThanMaxRecordsFailsAtomically(t *testing.T) {
	store := openTestStore(t)
	settings := DefaultSettings()
	settings.MaxRecords = 3
	if err := store.UpdateSettings(settings); err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	now := time.Now().UnixMilli()
	if err := store.Append(sampleEvent("existing-before-large-batch", now)); err != nil {
		t.Fatalf("Append existing event returned error: %v", err)
	}
	batch := make([]Event, 0, 6)
	for index := 0; index < 6; index++ {
		batch = append(batch, sampleEvent(fmt.Sprintf("large-batch-%d", index), now+int64(index+1)))
	}
	if err := store.AppendBatch(batch); !errors.Is(err, ErrBatchExceedsMaxRecords) {
		t.Fatalf("AppendBatch error = %v, want ErrBatchExceedsMaxRecords", err)
	}
	page, err := store.Query(Filter{PageSize: 10})
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].ID != "existing-before-large-batch" {
		t.Fatalf("oversized batch must not modify existing audit records: %#v", page)
	}
	if report, err := store.VerifyIntegrity(); err != nil || !report.Valid || report.CheckedRecords != 1 {
		t.Fatalf("large-batch chain invalid: report=%#v err=%v", report, err)
	}
}

func TestStorePreservesMultiStatementExecutionSummary(t *testing.T) {
	store := openTestStore(t)
	event := sampleEvent("multi-summary", time.Now().UnixMilli())
	event.StatementCount = 3
	event.ExecutedCount = 1
	event.FailedIndex = 2
	event.OutcomeUnknown = true
	if err := store.Append(event); err != nil {
		t.Fatalf("Append returned error: %v", err)
	}
	page, err := store.Query(Filter{PageSize: 10})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("Query returned page=%#v err=%v", page, err)
	}
	got := page.Items[0]
	if got.ExecutedCount != 1 || got.FailedIndex != 2 || !got.OutcomeUnknown {
		t.Fatalf("execution summary = %#v", got)
	}
	if report, err := store.VerifyIntegrity(); err != nil || !report.Valid {
		t.Fatalf("summary audit hash invalid: report=%#v err=%v", report, err)
	}
}

func TestSettingsValidationAndClosedStore(t *testing.T) {
	store := openTestStore(t)
	invalid := DefaultSettings()
	invalid.CaptureMode = "full"
	if err := store.UpdateSettings(invalid); err == nil {
		t.Fatal("full/raw SQL capture mode must be rejected")
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if err := store.Append(sampleEvent("closed", time.Now().UnixMilli())); !errors.Is(err, ErrClosed) {
		t.Fatalf("Append after Close error=%v, want ErrClosed", err)
	}
}

func assertAuditStorageFilesDoNotContain(t *testing.T, databasePath string, secrets []string) {
	t.Helper()
	for _, path := range []string{databasePath, databasePath + "-wal", databasePath + "-shm"} {
		payload, err := os.ReadFile(path)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			t.Fatalf("read SQLite audit storage file %q: %v", path, err)
		}
		for _, secret := range secrets {
			if strings.Contains(string(payload), secret) {
				t.Fatalf("SQLite audit storage file %q contains raw secret %q", path, secret)
			}
		}
	}
}
