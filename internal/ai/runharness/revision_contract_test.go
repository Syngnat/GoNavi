package runharness

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Public Harness mutations must be guarded by an observed revision. Keeping
// this check above the Ledger API lets low-level setup/migration code retain
// its narrowly scoped internal operations without weakening Wails or CLI.
func TestHarnessRequiresRevisionForExistingSessionInput(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(*testing.T, *Ledger, string) AgentInputRequest
	}{
		{
			name: "queue",
			prepare: func(_ *testing.T, _ *Ledger, sessionID string) AgentInputRequest {
				return AgentInputRequest{RequestID: "missing-revision-queue", SessionID: sessionID, Content: "queue this"}
			},
		},
		{
			name: "steer",
			prepare: func(_ *testing.T, _ *Ledger, sessionID string) AgentInputRequest {
				return AgentInputRequest{RequestID: "missing-revision-steer", SessionID: sessionID, Content: "steer this", DispatchMode: DispatchSteer}
			},
		},
		{
			name: "branch",
			prepare: func(t *testing.T, ledger *Ledger, sessionID string) AgentInputRequest {
				t.Helper()
				cursor, err := ledger.AppendMessage(context.Background(), Message{SessionID: sessionID, Role: "user", Content: "replace this"})
				if err != nil {
					t.Fatalf("append branch cursor: %v", err)
				}
				return AgentInputRequest{
					RequestID: "missing-revision-branch", SessionID: sessionID, BranchFromMessageID: cursor.ID,
					Content: "replacement",
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
			session, err := ledger.CreateSession(context.Background(), CreateSessionRequest{SessionID: "existing-session-" + test.name})
			if err != nil {
				t.Fatalf("create session: %v", err)
			}

			_, err = harness.SubmitInput(context.Background(), test.prepare(t, ledger, session.ID))
			requireStableRevisionConflict(t, err)

			projection, readErr := ledger.GetSession(context.Background(), session.ID, true)
			if readErr != nil {
				t.Fatalf("read session after rejected input: %v", readErr)
			}
			if len(projection.Runs) != 0 {
				t.Fatalf("rejected input created runs: %+v", projection.Runs)
			}
			if test.name == "branch" && len(projection.Messages) != 1 {
				t.Fatalf("rejected branch changed source messages: %+v", projection.Messages)
			}
			list, listErr := ledger.ListSessions(context.Background(), SessionListRequest{Limit: 10})
			if listErr != nil {
				t.Fatalf("list sessions: %v", listErr)
			}
			if list.Total != 1 {
				t.Fatalf("rejected input created another session: %+v", list)
			}
		})
	}
}

func TestHarnessInputIdempotencyPrecedesExistingSessionRevisionGuard(t *testing.T) {
	ctx := context.Background()
	harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
	session, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "idempotent-revision-session", Title: "before"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	request := AgentInputRequest{
		RequestID: "idempotent-revision-request", SessionID: session.ID, Content: "hello",
		ExpectedRevision: session.Revision,
	}
	first, err := harness.SubmitInput(ctx, request)
	if err != nil {
		t.Fatalf("first input: %v", err)
	}
	waitContractRun(t, harness, first.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })

	current, err := ledger.GetSession(ctx, session.ID, false)
	if err != nil {
		t.Fatalf("read session before mutation: %v", err)
	}
	title := "after"
	if _, err := harness.MutateSession(ctx, SessionMutationRequest{SessionID: session.ID, ExpectedRevision: current.Revision, Title: &title}); err != nil {
		t.Fatalf("advance session revision: %v", err)
	}

	second, err := harness.SubmitInput(ctx, request)
	if err != nil {
		t.Fatalf("idempotent retry rejected after revision advanced: %v", err)
	}
	if second.RunID != first.RunID || second.SessionID != first.SessionID {
		t.Fatalf("retry receipt = %+v, want %+v", second, first)
	}
}

func TestHarnessMutateSessionRequiresRevision(t *testing.T) {
	ctx := context.Background()
	harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
	session, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "mutate-revision-session", Title: "original"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	title := "changed"
	_, err = harness.MutateSession(ctx, SessionMutationRequest{SessionID: session.ID, Title: &title})
	requireStableRevisionConflict(t, err)

	projection, err := ledger.GetSession(ctx, session.ID, false)
	if err != nil {
		t.Fatalf("read session after rejected mutation: %v", err)
	}
	if projection.Title != "original" || projection.Revision != session.Revision {
		t.Fatalf("rejected mutation changed session: before=%+v after=%+v", session, projection)
	}
}

func TestHarnessControlRunRequiresRevision(t *testing.T) {
	ctx := context.Background()
	harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
	run, err := ledger.CreateRun(ctx, CreateRunRequest{
		SessionID: "control-revision-session", RequestID: "control-revision-request", Policy: DefaultRunPolicy(),
	})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}

	_, err = harness.ControlRun(ctx, RunControlRequest{RunID: run.ID, Action: ControlCancel})
	requireStableRevisionConflict(t, err)

	current, err := ledger.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("read run after rejected control: %v", err)
	}
	if current.State != run.State || current.Revision != run.Revision {
		t.Fatalf("rejected control changed run: before=%+v after=%+v", run, current)
	}
}

func TestHarnessRejectsStaleSessionMutationAndInputRevision(t *testing.T) {
	ctx := context.Background()
	harness, ledger := newContractHarness(t, branchCompleteModel{}, nil, nil)
	session, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "stale-revision-session", Title: "original"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	title := "advanced"
	advanced, err := harness.MutateSession(ctx, SessionMutationRequest{
		SessionID: session.ID, ExpectedRevision: session.Revision, Title: &title,
	})
	if err != nil {
		t.Fatalf("advance session revision: %v", err)
	}
	if advanced.Revision <= session.Revision {
		t.Fatalf("advanced revision = %d, want > %d", advanced.Revision, session.Revision)
	}

	_, err = harness.SubmitInput(ctx, AgentInputRequest{
		RequestID: "stale-revision-input", SessionID: session.ID, Content: "must not queue",
		ExpectedRevision: session.Revision,
	})
	requireStableRevisionConflict(t, err)

	staleTitle := "must not apply"
	_, err = harness.MutateSession(ctx, SessionMutationRequest{
		SessionID: session.ID, ExpectedRevision: session.Revision, Title: &staleTitle,
	})
	requireStableRevisionConflict(t, err)

	projection, err := ledger.GetSession(ctx, session.ID, false)
	if err != nil {
		t.Fatalf("read session after stale operations: %v", err)
	}
	if projection.Revision != advanced.Revision || projection.Title != title || len(projection.Runs) != 0 {
		t.Fatalf("stale operations changed session: %+v", projection)
	}
}

func requireStableRevisionConflict(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, ErrRevisionConflict) || !strings.Contains(err.Error(), "revision_conflict") {
		t.Fatalf("error = %v, want stable revision_conflict", err)
	}
}
