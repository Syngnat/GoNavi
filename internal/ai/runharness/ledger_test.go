package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func testLedger(t *testing.T) *Ledger {
	t.Helper()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}
	l, err := Open(filepath.Join(t.TempDir(), "agent_runs.sqlite"), WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l
}

func TestCipherRoundTripAndAAD(t *testing.T) {
	key := make([]byte, 32)
	c, err := NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := c.Encrypt([]byte("secret"), []byte("table/id/field"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := c.Decrypt(sealed, []byte("table/id/field"))
	if err != nil || string(plain) != "secret" {
		t.Fatalf("decrypt = %q, %v", plain, err)
	}
	if _, err := c.Decrypt(sealed, []byte("other")); !errors.Is(err, ErrInvalidCiphertext) {
		t.Fatalf("wrong AAD error = %v", err)
	}
	sealed[len(sealed)-1] ^= 1
	if _, err := c.Decrypt(sealed, []byte("table/id/field")); !errors.Is(err, ErrInvalidCiphertext) {
		t.Fatalf("tamper error = %v", err)
	}
}

func TestKeyFileProviderPermissionsAndSymlink(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "ledger.key")
	provider, err := NewKeyFileProvider(path)
	if err != nil {
		t.Fatal(err)
	}
	key, err := provider.LoadOrCreate()
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 32 {
		t.Fatalf("key length = %d", len(key))
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("permissions = %o", info.Mode().Perm())
	}
	key2, err := provider.LoadOrCreate()
	if err != nil {
		t.Fatal(err)
	}
	if !ConstantTimeEqual(key, key2) {
		t.Fatal("key changed between loads")
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(path, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	linked, _ := NewKeyFileProvider(link)
	if _, err := linked.LoadOrCreate(); !errors.Is(err, ErrKeyUnavailable) {
		t.Fatalf("symlink error = %v", err)
	}
}

func TestKeyFileProviderRejectsInsecurePermissionsOnUnix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACLs are not represented by os.FileMode")
	}
	path := filepath.Join(t.TempDir(), "ledger.key")
	key := testKey(t, 42)
	if err := os.WriteFile(path, key, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	provider, err := NewKeyFileProvider(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.LoadOrCreate(); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("insecure key file error = %v, want permission rejection", err)
	}
}

func TestRunStateMachine(t *testing.T) {
	valid := [][2]RunState{{RunStateQueued, RunStateRunningModel}, {RunStateRunningModel, RunStateAwaitingApproval}, {RunStateAwaitingApproval, RunStateRunningTool}, {RunStateRunningTool, RunStateRunningModel}, {RunStateRunningModel, RunStateCompleted}, {RunStateCanceling, RunStateCanceled}, {RunStateInterrupted, RunStateRunningModel}}
	for _, edge := range valid {
		if !CanTransition(edge[0], edge[1]) {
			t.Fatalf("expected valid edge %v", edge)
		}
	}
	invalid := [][2]RunState{{RunStateCompleted, RunStateRunningModel}, {RunStateQueued, RunStateCompleted}, {RunStateRunningModel, RunStateQueued}, {RunStateRunningModel, RunStateRunningModel}}
	for _, edge := range invalid {
		if CanTransition(edge[0], edge[1]) {
			t.Fatalf("expected invalid edge %v", edge)
		}
	}
}

func TestLedgerMigratesV5RunCapabilities(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}

	ledger, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	legacyRun, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "legacy-session",
		RequestID: "legacy-request",
		Policy:    DefaultRunPolicy(),
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatal(err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatal(err)
	}

	// Simulate the immediately preceding v5 schema. Existing run rows did not
	// carry a task kind or an explicit tool capability, so the v6 migration must
	// add both fields without changing the historical run identity or defaults.
	dsn, _, err := ledgerDSN(path)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE runs DROP COLUMN task_kind`); err != nil {
		_ = db.Close()
		t.Fatalf("remove v6 task_kind column: %v", err)
	}
	if _, err := db.Exec(`ALTER TABLE runs DROP COLUMN allow_tools`); err != nil {
		_ = db.Close()
		t.Fatalf("remove v6 allow_tools column: %v", err)
	}
	if _, err := db.Exec(`PRAGMA user_version=5`); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = migrated.Close() })

	got, err := migrated.GetRun(ctx, legacyRun.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.TaskKind != AgentTaskKindChat || !got.AllowTools {
		t.Fatalf("migrated run capability = kind=%q allowTools=%v", got.TaskKind, got.AllowTools)
	}
	if got.ID != legacyRun.ID || got.RequestID != legacyRun.RequestID {
		t.Fatalf("migrated run identity changed: %#v", got)
	}

	var version int
	if err := migrated.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != ledgerSchemaVersion {
		t.Fatalf("schema version = %d, want %d", version, ledgerSchemaVersion)
	}
	for _, column := range []string{"task_kind", "allow_tools"} {
		var present int
		if err := migrated.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('runs') WHERE name=?`, column).Scan(&present); err != nil {
			t.Fatal(err)
		}
		if present != 1 {
			t.Fatalf("runs.%s missing after v5 migration", column)
		}
	}
}

func TestLedgerMigratesV6SessionBranchMetadata(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent_runs.sqlite")
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i + 1)
	}

	ledger, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	legacySession, err := ledger.CreateSession(ctx, CreateSessionRequest{
		SessionID: "legacy-session",
		Title:     "session before branch support",
	})
	if err != nil {
		_ = ledger.Close()
		t.Fatal(err)
	}
	if err := ledger.Close(); err != nil {
		t.Fatal(err)
	}

	// Simulate the v6 sessions table, which had no branch provenance columns.
	// This verifies that opening an existing production ledger adds defaults
	// without altering the encrypted title or the session identity.
	dsn, _, err := ledgerDSN(path)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"parent_session_id", "branch_from_message_id", "branch_from_sequence"} {
		if _, err := db.Exec(`ALTER TABLE sessions DROP COLUMN ` + column); err != nil {
			_ = db.Close()
			t.Fatalf("remove v7 sessions.%s column: %v", column, err)
		}
	}
	if _, err := db.Exec(`PRAGMA user_version=6`); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	migrated, err := Open(path, WithKey(key))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = migrated.Close() })
	got, err := migrated.GetSession(ctx, legacySession.ID, false)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != legacySession.ID || got.Title != legacySession.Title {
		t.Fatalf("migrated session identity/title = %#v", got)
	}
	if got.ParentSessionID != "" || got.BranchFromMessageID != "" || got.BranchFromSequence != 0 {
		t.Fatalf("legacy session acquired unexpected branch metadata: %#v", got)
	}
	for _, column := range []string{"parent_session_id", "branch_from_message_id", "branch_from_sequence"} {
		var present int
		if err := migrated.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name=?`, column).Scan(&present); err != nil {
			t.Fatal(err)
		}
		if present != 1 {
			t.Fatalf("sessions.%s missing after v6 migration", column)
		}
	}
	var version int
	if err := migrated.db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != ledgerSchemaVersion {
		t.Fatalf("schema version = %d, want %d", version, ledgerSchemaVersion)
	}
}

func TestLedgerRunEventsAndEncryptedAtRest(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "session-1", RequestID: "request-1", Policy: DefaultRunPolicy(), InitialMessage: &Message{Role: "user", Content: "do secret thing"}})
	if err != nil {
		t.Fatal(err)
	}
	if run.State != RunStateQueued || run.NextSequence != 1 {
		t.Fatalf("run = %#v", run)
	}
	if _, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "session-1", RequestID: "request-1", Policy: DefaultRunPolicy()}); err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	if _, err := l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, ""); err != nil {
		t.Fatal(err)
	}
	run, _ = l.GetRun(ctx, run.ID)
	event, err := l.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedSequence: 1, ExpectedRevision: run.Revision, Kind: EventModelCompleted, ResultingState: RunStateRunningModel, Payload: ModelCompletedEvent{Text: "answer"}})
	if err != nil {
		t.Fatal(err)
	}
	if event.Sequence != 1 {
		t.Fatalf("event sequence = %d", event.Sequence)
	}
	read, err := l.ReadRun(ctx, RunReadRequest{RunID: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Events) != 1 {
		t.Fatalf("events = %#v", read.Events)
	}
	var payload ModelCompletedEvent
	if err := json.Unmarshal(read.Events[0].Payload, &payload); err != nil || payload.Text != "answer" {
		t.Fatalf("payload = %#v, %v", payload, err)
	}
	message, err := l.GetMessages(ctx, "session-1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(message) != 1 || message[0].Content != "do secret thing" {
		t.Fatalf("messages = %#v", message)
	}
	data, err := os.ReadFile(l.Path())
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" || containsBytes(data, []byte("do secret thing")) || containsBytes(data, []byte("answer")) {
		t.Fatal("sensitive ledger data appears in plaintext")
	}
	if _, err := l.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedSequence: 1, Kind: EventUsage, ResultingState: RunStateRunningModel}); !errors.Is(err, ErrSequenceConflict) {
		t.Fatalf("sequence CAS error = %v", err)
	}
	if _, err := l.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedSequence: 2, Kind: EventTerminal, ResultingState: RunStateCompleted, Payload: TerminalEvent{Reason: "done"}, TerminalReason: "done"}); err != nil {
		t.Fatal(err)
	}
	if _, err := l.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, Kind: EventTerminal, ResultingState: RunStateCompleted}); !errors.Is(err, ErrTerminalRun) {
		t.Fatalf("second terminal error = %v", err)
	}
	var terminals int
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id=? AND kind='terminal'`, run.ID).Scan(&terminals); err != nil {
		t.Fatal(err)
	}
	if terminals != 1 {
		t.Fatalf("terminals = %d", terminals)
	}
}

func TestTransitionRunRejectsTerminalStateWithoutTerminalEvent(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "session-1", RequestID: "request-1", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.TransitionRun(ctx, run.ID, RunStateRunningModel, RunStateCompleted, run.Revision, ""); !errors.Is(err, ErrInvalidTransition) {
		t.Fatalf("terminal TransitionRun error = %v, want ErrInvalidTransition", err)
	}

	current, err := l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if current.State != RunStateRunningModel {
		t.Fatalf("run state = %s, want %s", current.State, RunStateRunningModel)
	}
	read, err := l.ReadRun(ctx, RunReadRequest{RunID: run.ID})
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Events) != 0 {
		t.Fatalf("terminal bypass persisted events: %#v", read.Events)
	}
}

func TestCheckpointToolApprovalSnapshotAndLease(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "s", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "owner-a", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.ValidateLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if _, err := l.AcquireLease(ctx, run.ID, "owner-b", time.Minute); !errors.Is(err, ErrLeaseUnavailable) {
		t.Fatalf("other owner = %v", err)
	}
	run, _ = l.GetRun(ctx, run.ID)
	if _, err := l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token); err != nil {
		t.Fatal(err)
	}
	run, _ = l.GetRun(ctx, run.ID)
	checkpoint, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{RunID: run.ID, State: RunStateRunningModel, Sequence: run.NextSequence - 1, ConversationCursor: "cursor", ProviderState: json.RawMessage(`{"cursor":1}`), ExpectedRevision: run.Revision, OwnerToken: lease.Token})
	if err != nil {
		t.Fatal(err)
	}
	got, err := l.GetCheckpoint(ctx, checkpoint.ID)
	if err != nil || got.ConversationCursor != "cursor" {
		t.Fatalf("checkpoint = %#v, %v", got, err)
	}
	run, _ = l.GetRun(ctx, run.ID)
	tool, err := l.StartTool(ctx, StartToolRequest{RunID: run.ID, CallID: "call-1", ToolName: "execute_sql", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{"sql":"INSERT"}`), ExpectedRevision: run.Revision, OwnerToken: lease.Token})
	if err != nil {
		t.Fatal(err)
	}
	if tool.ArgsHash == "" {
		t.Fatal("missing args hash")
	}
	run, _ = l.GetRun(ctx, run.ID)
	approval, err := l.CreateApproval(ctx, PutApprovalRequest{RunID: run.ID, CallID: "call-1", ToolName: "execute_sql", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{"sql":"INSERT"}`), RunRevision: run.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.DecideApproval(ctx, DecideApprovalRequest{
		ApprovalID: approval.ApprovalID, Decision: "approved",
		ExpectedRunID: run.ID, ExpectedCallID: approval.CallID,
		ExpectedArgsHash: approval.ArgsHash, ExpectedRunRevision: approval.RunRevision,
	}); err != nil {
		t.Fatal(err)
	}
	run, _ = l.GetRun(ctx, run.ID)
	if _, err := l.FinishTool(ctx, FinishToolRequest{RunID: run.ID, CallID: "call-1", Status: "completed", Result: map[string]any{"affected": 1}, ExpectedRevision: run.Revision, OwnerToken: lease.Token}); err != nil {
		t.Fatal(err)
	}
	snapshot := WorkspaceSnapshot{SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "instance", Revision: 1, ActiveContext: map[string]any{"secret": "value"}}
	stored, err := l.PutWorkspaceSnapshot(ctx, snapshot)
	if err != nil {
		t.Fatal(err)
	}
	latest, err := l.LatestWorkspaceSnapshot(ctx, "desktop", "instance")
	if err != nil || latest.ContentHash != stored.ContentHash {
		t.Fatalf("snapshot = %#v, %v", latest, err)
	}
	if _, err := l.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "instance", Revision: 1, ActiveContext: map[string]any{"changed": true}}); !errors.Is(err, ErrSnapshotConflict) {
		t.Fatalf("snapshot conflict = %v", err)
	}
	if err := l.ReleaseLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
}

func TestRecoverRunsMarksUnknownSideEffects(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "s", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, ""); err != nil {
		t.Fatal(err)
	}
	run, _ = l.GetRun(ctx, run.ID)
	if _, err := l.StartTool(ctx, StartToolRequest{RunID: run.ID, CallID: "unknown", ToolName: "write", Effect: ToolEffectSideEffect, Arguments: json.RawMessage(`{}`), ExpectedRevision: run.Revision}); err != nil {
		t.Fatal(err)
	}
	recovered, err := l.RecoverRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || recovered[0].State != RunStateRecoveryRequired {
		t.Fatalf("recovered = %#v", recovered)
	}
}

func TestRecoverRunsLeavesQueuedAndIsIdempotent(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	queued, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "queued", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	if recovered, err := l.RecoverRuns(ctx); err != nil || len(recovered) != 0 {
		t.Fatalf("queued recovery = %#v, %v", recovered, err)
	}
	got, err := l.GetRun(ctx, queued.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.State != RunStateQueued || got.Attempt != 1 {
		t.Fatalf("queued run changed = %#v", got)
	}

	active, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "active", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	active, err = l.TransitionRun(ctx, active.ID, RunStateQueued, RunStateRunningModel, active.Revision, "")
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := l.RecoverRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || recovered[0].State != RunStateInterrupted || recovered[0].Attempt != active.Attempt+1 {
		t.Fatalf("active recovery = %#v", recovered)
	}
	first := recovered[0]
	second, err := l.RecoverRuns(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 0 {
		t.Fatalf("second recovery should be empty = %#v", second)
	}
	got, err = l.GetRun(ctx, active.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Attempt != first.Attempt || got.State != RunStateInterrupted {
		t.Fatalf("recovery was not idempotent = %#v", got)
	}
	var checkpointEvents int
	if err := l.db.QueryRow(`SELECT COUNT(*) FROM events WHERE run_id=? AND kind=?`, active.ID, EventCheckpoint).Scan(&checkpointEvents); err != nil {
		t.Fatal(err)
	}
	if checkpointEvents != 1 {
		t.Fatalf("checkpoint events = %d", checkpointEvents)
	}
	if _, err := l.GetCheckpoint(ctx, got.CheckpointID); err != nil {
		t.Fatalf("recovery checkpoint = %v", err)
	}
}

func TestLeaseFenceRejectsStaleOwnerWrites(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "fence", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	leaseA, err := l.AcquireLease(ctx, run.ID, "owner-a", 20*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision+1, leaseA.Token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.db.Exec(`UPDATE runs SET owner_expires_at=0 WHERE id=?`, run.ID); err != nil {
		t.Fatal(err)
	}
	leaseB, err := l.AcquireLease(ctx, run.ID, "owner-b", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if leaseA.Token == leaseB.Token {
		t.Fatal("lease token was not fenced")
	}
	current, err := l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.AppendEvent(ctx, AppendEventRequest{RunID: run.ID, ExpectedRevision: current.Revision, Kind: EventModelDelta, ResultingState: RunStateRunningModel, Payload: ModelDeltaEvent{Text: "stale"}, OwnerToken: leaseA.Token}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale append error = %v", err)
	}
	if _, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{RunID: run.ID, State: RunStateRunningModel, Sequence: 0, ExpectedRevision: current.Revision, OwnerToken: leaseA.Token}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale checkpoint error = %v", err)
	}
	if _, err := l.StartTool(ctx, StartToolRequest{RunID: run.ID, CallID: "stale", ToolName: "read", Effect: ToolEffectReadOnly, Arguments: json.RawMessage(`{}`), ExpectedRevision: current.Revision, OwnerToken: leaseA.Token}); !errors.Is(err, ErrLeaseLost) {
		t.Fatalf("stale tool error = %v", err)
	}
}

func TestWorkspaceSnapshotLeaseAndInstanceIsolation(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	base := WorkspaceSnapshot{SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "instance-a", Revision: 1, ActiveContext: map[string]any{"value": "a"}}
	stored, err := l.PutWorkspaceSnapshot(ctx, base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{SourceKind: WorkspaceDesktop, SourceID: "desktop", SourceInstanceID: "instance-b", Revision: 1, ActiveContext: map[string]any{"value": "b"}}); err != nil {
		t.Fatal(err)
	}
	if got, err := l.LatestWorkspaceSnapshot(ctx, "desktop", "instance-b"); err != nil || got.ActiveContext["value"] != "b" {
		t.Fatalf("instance-b snapshot = %#v, %v", got, err)
	}
	if _, err := l.LatestWorkspaceSnapshot(ctx, "desktop", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing instance error = %v", err)
	}
	if _, err := l.db.Exec(`UPDATE workspace_snapshots SET lease_expires_at=0 WHERE source_id=? AND source_instance_id=? AND revision=?`, stored.SourceID, stored.SourceInstanceID, stored.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := l.LatestWorkspaceSnapshot(ctx, "desktop", "instance-a"); !errors.Is(err, ErrSnapshotExpired) {
		t.Fatalf("expired snapshot error = %v", err)
	}
	if _, err := l.PutWorkspaceSnapshot(ctx, stored); err != nil {
		t.Fatal(err)
	}
	if _, err := l.LatestWorkspaceSnapshot(ctx, "desktop", "instance-a"); err != nil {
		t.Fatalf("heartbeat did not renew snapshot = %v", err)
	}
}

func TestSaveCheckpointInheritsWorkspaceSnapshotReference(t *testing.T) {
	l := testLedger(t)
	ctx := context.Background()
	run, err := l.CreateRun(ctx, CreateRunRequest{SessionID: "checkpoint-snapshot", Policy: DefaultRunPolicy()})
	if err != nil {
		t.Fatal(err)
	}
	lease, err := l.AcquireLease(ctx, run.ID, "checkpoint-owner", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	run, err = l.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := l.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{
		SourceKind: WorkspaceDesktop, SourceID: "checkpoint-source", SourceInstanceID: "checkpoint-instance",
		Revision: 1, ActiveContext: map[string]any{"tab": "orders"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := workspaceSnapshotReference(snapshot)
	first, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 0,
		WorkspaceSnapshot: want, ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sameWorkspaceSnapshotReference(first.WorkspaceSnapshot, want) {
		t.Fatalf("first checkpoint reference = %#v, want %#v", first.WorkspaceSnapshot, want)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := l.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, ExpectedSequence: run.NextSequence,
		Kind: EventModelDelta, ResultingState: RunStateRunningModel,
		Payload: ModelDeltaEvent{Text: "checkpoint boundary"}, OwnerToken: lease.Token,
	}); err != nil {
		t.Fatal(err)
	}
	run, err = l.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := l.SaveCheckpoint(ctx, SaveCheckpointRequest{
		RunID: run.ID, State: RunStateRunningModel, Sequence: 1,
		ExpectedRevision: run.Revision, OwnerToken: lease.Token,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !sameWorkspaceSnapshotReference(second.WorkspaceSnapshot, want) {
		t.Fatalf("inherited checkpoint reference = %#v, want %#v", second.WorkspaceSnapshot, want)
	}
	loaded, err := l.GetCheckpoint(ctx, second.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !sameWorkspaceSnapshotReference(loaded.WorkspaceSnapshot, want) {
		t.Fatalf("loaded checkpoint reference = %#v, want %#v", loaded.WorkspaceSnapshot, want)
	}
}

func containsBytes(haystack, needle []byte) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func TestOpenRejectsInvalidKey(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "x.sqlite"), WithKey(make([]byte, 31))); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("error = %v", err)
	}
}

func TestLedgerPragmas(t *testing.T) {
	l := testLedger(t)
	var journal, synchronous string
	if err := l.db.QueryRow(`PRAGMA journal_mode`).Scan(&journal); err != nil {
		t.Fatal(err)
	}
	if err := l.db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil {
		t.Fatal(err)
	}
	if journal != "wal" {
		t.Fatalf("journal = %s", journal)
	}
	_ = sql.ErrNoRows
}
