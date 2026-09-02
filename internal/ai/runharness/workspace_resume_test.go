package runharness

import (
	"context"
	"testing"
	"time"
)

func TestWorkspaceAvailabilityRestoresCallingPhase(t *testing.T) {
	for _, tc := range []struct {
		name       string
		allowStale bool
		resume     RunState
		acquire    func(*AgentRunHarness, context.Context, RunSnapshot, *runExecution) (WorkspaceSnapshot, RunSnapshot, error)
	}{
		{
			name:   "model resumes from a live snapshot",
			resume: RunStateRunningModel,
			acquire: func(harness *AgentRunHarness, ctx context.Context, run RunSnapshot, execution *runExecution) (WorkspaceSnapshot, RunSnapshot, error) {
				return harness.workspaceForModel(ctx, run, execution)
			},
		},
		{
			name:       "tool resumes from an explicitly approved stale snapshot",
			allowStale: true,
			resume:     RunStateRunningTool,
			acquire: func(harness *AgentRunHarness, ctx context.Context, run RunSnapshot, execution *runExecution) (WorkspaceSnapshot, RunSnapshot, error) {
				return harness.workspaceForTool(ctx, run, execution)
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			ledger := testLedger(t)
			harness, err := NewAgentRunHarness(HarnessConfig{Ledger: ledger, RootContext: ctx, OwnerID: "workspace-resume-owner"})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = harness.Close() })

			run, lease := waitingWorkspaceRun(t, ledger, "workspace-resume-"+tc.name)
			snapshot, err := ledger.PutWorkspaceSnapshot(ctx, WorkspaceSnapshot{
				SourceKind: WorkspaceDesktop, SourceID: run.ContextSourceID, SourceInstanceID: run.ContextSourceInstanceID,
				Revision: 1, ActiveContext: map[string]any{"tab": "orders"},
			})
			if err != nil {
				t.Fatalf("put workspace snapshot: %v", err)
			}
			if tc.allowStale {
				if _, err := ledger.db.ExecContext(ctx, `UPDATE workspace_snapshots SET lease_expires_at=0 WHERE source_id=? AND source_instance_id=? AND revision=?`, snapshot.SourceID, snapshot.SourceInstanceID, snapshot.Revision); err != nil {
					t.Fatalf("expire workspace snapshot: %v", err)
				}
			}

			execution := &runExecution{runID: run.ID, sessionID: run.SessionID, ctx: ctx, wake: make(chan struct{}, 1)}
			execution.setLease(lease)
			execution.allowStaleWorkspace.Store(tc.allowStale)
			got, resumed, err := tc.acquire(harness, ctx, run, execution)
			if err != nil {
				t.Fatalf("restore workspace: %v", err)
			}
			if got.Revision != snapshot.Revision || got.ContentHash != snapshot.ContentHash {
				t.Fatalf("restored snapshot = %#v, want revision %d hash %q", got, snapshot.Revision, snapshot.ContentHash)
			}
			if resumed.State != tc.resume {
				t.Fatalf("returned state = %s, want %s", resumed.State, tc.resume)
			}
			persisted, err := ledger.GetRun(ctx, run.ID)
			if err != nil {
				t.Fatalf("read resumed run: %v", err)
			}
			if persisted.State != tc.resume {
				t.Fatalf("persisted state = %s, want %s", persisted.State, tc.resume)
			}
		})
	}
}

func waitingWorkspaceRun(t *testing.T, ledger *Ledger, suffix string) (RunSnapshot, Lease) {
	t.Helper()
	ctx := context.Background()
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID:               "workspace-resume-session-" + suffix,
		Policy:                  DefaultRunPolicy(),
		ContextSourceID:         "workspace-resume-source-" + suffix,
		ContextSourceInstanceID: "workspace-resume-instance-" + suffix,
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	lease, err := ledger.AcquireLease(ctx, run.ID, "workspace-resume-owner", time.Minute)
	if err != nil {
		t.Fatalf("acquire lease: %v", err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("read leased run: %v", err)
	}
	run, err = ledger.TransitionRun(ctx, run.ID, RunStateQueued, RunStateRunningModel, run.Revision, lease.Token)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	if _, err := ledger.AppendEvent(ctx, AppendEventRequest{
		RunID: run.ID, ExpectedRevision: run.Revision, Kind: EventCheckpoint,
		ResultingState: RunStateAwaitingWorkspace,
		Payload:        CheckpointEvent{Sequence: run.NextSequence - 1},
		OwnerToken:     lease.Token,
	}); err != nil {
		t.Fatalf("wait for workspace: %v", err)
	}
	run, err = ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("read waiting run: %v", err)
	}
	if run.State != RunStateAwaitingWorkspace {
		t.Fatalf("waiting run state = %s, want %s", run.State, RunStateAwaitingWorkspace)
	}
	return run, lease
}
