package runharness

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOptimizeStorageKeepsNewestWorkspaceSnapshotPerInstance(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	if _, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "active-session", Policy: DefaultRunPolicy(),
		ContextSourceID: "desktop", ContextSourceInstanceID: "window-a",
	}); err != nil {
		t.Fatal(err)
	}
	for revision := int64(1); revision <= 8; revision++ {
		_, err := ledger.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{
			SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "window-a",
			Revision: revision, ActiveContext: map[string]any{"draft": strings.Repeat("x", 32*1024)},
		})
		if err != nil {
			t.Fatalf("put snapshot %d: %v", revision, err)
		}
	}
	if _, err := ledger.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "window-b",
		Revision: 1, ActiveContext: map[string]any{"draft": "other"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.db.ExecContext(ctx, `UPDATE runs SET state='completed' WHERE session_id='active-session'`); err != nil {
		t.Fatal(err)
	}

	result, err := ledger.OptimizeStorage(ctx)
	if err != nil {
		t.Fatalf("OptimizeStorage: %v", err)
	}
	if result.RemovedSnapshots != 7 || result.After.SnapshotCount != 2 {
		t.Fatalf("unexpected optimization result: %+v", result)
	}
	latest, err := ledger.LatestWorkspaceSnapshot(ctx, "desktop", "window-a")
	if err != nil || latest.Revision != 8 {
		t.Fatalf("latest snapshot = %+v, %v", latest, err)
	}
}

func TestPutWorkspaceSnapshotBoundsLegacyHeartbeatRevisionsWithoutActiveRun(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	for revision := int64(1); revision <= 20; revision++ {
		if _, err := ledger.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{
			SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "legacy-window",
			Revision: revision, ActiveContext: map[string]any{"draft": strings.Repeat("x", 16*1024)},
		}); err != nil {
			t.Fatalf("put legacy heartbeat revision %d: %v", revision, err)
		}
	}
	stats, err := ledger.StorageStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stats.SnapshotCount != 1 {
		t.Fatalf("legacy heartbeat retained %d snapshots, want 1", stats.SnapshotCount)
	}
}

func TestClearStorageRemovesAssistantHistoryAndCompacts(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	if _, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "session-a", Title: "private"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "window-a",
		Revision: 1, ActiveContext: map[string]any{"draft": strings.Repeat("x", 64*1024)},
	}); err != nil {
		t.Fatal(err)
	}

	result, err := ledger.ClearStorage(ctx)
	if err != nil {
		t.Fatalf("ClearStorage: %v", err)
	}
	if result.RemovedSessions != 1 || result.RemovedSnapshots != 1 || result.After.SessionCount != 0 || result.After.SnapshotCount != 0 {
		t.Fatalf("unexpected clear result: %+v", result)
	}
}

func TestBackupToCreatesCompactReadableLedger(t *testing.T) {
	key := []byte("01234567890123456789012345678901")
	sourcePath := filepath.Join(t.TempDir(), "source", "agent_runs.sqlite")
	ledger, err := Open(sourcePath, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	if _, err := ledger.CreateSession(context.Background(), CreateSessionRequest{SessionID: "session-a", Title: "kept"}); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "target", "agent_runs.sqlite")
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ledger.BackupTo(context.Background(), target); err != nil {
		t.Fatalf("BackupTo: %v", err)
	}
	copyLedger, err := Open(target, WithKey(key))
	if err != nil {
		t.Fatalf("open backup: %v", err)
	}
	defer copyLedger.Close()
	projection, err := copyLedger.GetSession(context.Background(), "session-a", false)
	if err != nil || projection.Title != "kept" {
		t.Fatalf("backup projection = %+v, %v", projection, err)
	}
}
