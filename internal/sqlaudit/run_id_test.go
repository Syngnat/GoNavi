package sqlaudit

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunIDPersistsFiltersAndExports(t *testing.T) {
	store := openTestStore(t)
	now := time.Now().UnixMilli()
	first := sampleEvent("run-a-event", now)
	first.RunID = "script-run-a"
	first.Source = "script"
	second := sampleEvent("run-b-event", now+1)
	second.RunID = "script-run-b"
	second.Source = "script"
	if err := store.AppendBatch([]Event{first, second}); err != nil {
		t.Fatalf("append run events: %v", err)
	}
	report, err := store.VerifyIntegrity()
	if err != nil || !report.Valid || report.CheckedRecords != 2 {
		t.Fatalf("run audit integrity report = %#v, err=%v", report, err)
	}

	page, err := store.Query(Filter{RunID: "script-run-a", PageSize: 10})
	if err != nil || page.Total != 1 || len(page.Items) != 1 || page.Items[0].RunID != "script-run-a" {
		t.Fatalf("run filter page = %#v, err=%v", page, err)
	}
	search, err := store.Query(Filter{Search: "script-run-b", PageSize: 10})
	if err != nil || search.Total != 1 || search.Items[0].ID != "run-b-event" {
		t.Fatalf("run search page = %#v, err=%v", search, err)
	}
	exported, err := store.BuildExport(Filter{RunID: "script-run-a"}, "csv")
	if err != nil {
		t.Fatalf("export run events: %v", err)
	}
	csv := string(exported)
	if !strings.Contains(csv, "runId") || !strings.Contains(csv, "script-run-a") || strings.Contains(csv, "script-run-b") {
		t.Fatalf("run CSV export = %q", csv)
	}
}

func TestOpenMigratesRunIDColumnWithoutBreakingExistingHashChain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit", "sql_audit.db")
	store, err := Open(path)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	if err := store.Append(sampleEvent("legacy-without-run", time.Now().UnixMilli())); err != nil {
		t.Fatalf("append legacy event: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	legacy, err := sql.Open("sqlite", sqliteAuditDSN(path))
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	for _, statement := range []string{
		`DROP INDEX IF EXISTS idx_sql_audit_events_run`,
		`ALTER TABLE sql_audit_events DROP COLUMN run_id`,
		`PRAGMA user_version=4`,
	} {
		if _, err := legacy.Exec(statement); err != nil {
			_ = legacy.Close()
			t.Fatalf("prepare v4 database (%s): %v", statement, err)
		}
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	migrated, err := Open(path)
	if err != nil {
		t.Fatalf("migrate run_id column: %v", err)
	}
	t.Cleanup(func() { _ = migrated.Close() })
	report, err := migrated.VerifyIntegrity()
	if err != nil || !report.Valid || report.CheckedRecords != 1 {
		t.Fatalf("migrated integrity report = %#v, err=%v", report, err)
	}
	event := sampleEvent("new-with-run", time.Now().UnixMilli()+1)
	event.RunID = "script-run-migrated"
	if err := migrated.Append(event); err != nil {
		t.Fatalf("append migrated run event: %v", err)
	}
	page, err := migrated.Query(Filter{RunID: event.RunID, PageSize: 10})
	if err != nil || page.Total != 1 || page.Items[0].RunID != event.RunID {
		t.Fatalf("migrated run filter page = %#v, err=%v", page, err)
	}
}
