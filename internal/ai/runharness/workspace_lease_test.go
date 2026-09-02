package runharness

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestWorkspaceSnapshotLeaseDurationIsConfigured(t *testing.T) {
	key := bytes.Repeat([]byte{0x7a}, 32)
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	ledger, err := Open(path, WithKey(key), WithWorkspaceSnapshotLeaseDuration(90*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ledger.Close() })

	snapshot, err := ledger.PutWorkspaceSnapshot(context.Background(), WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "lease-source", SourceInstanceID: "instance-1", Revision: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	var expiry int64
	if err := ledger.db.QueryRow(`SELECT lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? AND revision=?`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	remaining := time.Until(fromNano(expiry))
	if remaining < 89*time.Second || remaining > 91*time.Second {
		t.Fatalf("configured snapshot lease remaining = %s, want about 90s", remaining)
	}
}

func TestWorkspaceSnapshotHeartbeatUsesConfiguredDuration(t *testing.T) {
	ledger := testLedger(t)
	ctx := context.Background()
	snapshot, err := ledger.PutWorkspaceSnapshotWithTTL(ctx, WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "heartbeat-source", SourceInstanceID: "instance-1", Revision: 1,
	}, 40*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	var first int64
	if err := ledger.db.QueryRow(`SELECT lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? AND revision=?`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision).Scan(&first); err != nil {
		t.Fatal(err)
	}
	time.Sleep(10 * time.Millisecond)
	if _, err := ledger.PutWorkspaceSnapshotWithLeaseDuration(ctx, snapshot, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	var renewed int64
	if err := ledger.db.QueryRow(`SELECT lease_expires_at FROM workspace_snapshots WHERE source_id=? AND source_instance_id=? AND revision=?`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision).Scan(&renewed); err != nil {
		t.Fatal(err)
	}
	if renewed <= first || time.Until(fromNano(renewed)) < time.Second {
		t.Fatalf("heartbeat expiry = %s (raw %d), first raw %d; expected configured renewal", fromNano(renewed), renewed, first)
	}
}

func TestWorkspaceSnapshotLeaseConfigurationValidation(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "invalid.sqlite"), WithKey(bytes.Repeat([]byte{1}, 32)), WithWorkspaceSnapshotLeaseDuration(-time.Second)); !errors.Is(err, ErrSnapshotLeaseConfig) {
		t.Fatalf("negative lease option error = %v, want ErrSnapshotLeaseConfig", err)
	}
	if err := (WorkspaceSnapshotLeaseConfig{LeaseDuration: 5 * time.Second, RenewInterval: 5 * time.Second}).Validate(); err == nil {
		t.Fatal("renew interval equal to lease duration was accepted")
	}
}

func TestHarnessWorkspaceSnapshotLeaseConfig(t *testing.T) {
	ledger, err := OpenWithKey(":memory:", bytes.Repeat([]byte{2}, 32))
	if err != nil {
		t.Fatal(err)
	}
	harness, err := NewAgentRunHarness(HarnessConfig{
		Ledger: ledger, RootContext: context.Background(), WorkspaceSnapshotLeaseDuration: 2 * time.Second, WorkspaceSnapshotRenewInterval: 500 * time.Millisecond,
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = harness.Close(); _ = ledger.Close() })
	got := harness.WorkspaceSnapshotLeaseConfig()
	if got.LeaseDuration != 2*time.Second || got.RenewInterval != 500*time.Millisecond {
		t.Fatalf("harness workspace lease config = %+v", got)
	}
}
