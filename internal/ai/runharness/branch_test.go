package runharness

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

func newBranchLedger(t *testing.T) *Ledger {
	t.Helper()
	ledger, err := OpenWithKey(":memory:", bytes.Repeat([]byte{0x51}, 32))
	if err != nil {
		t.Fatalf("open ledger: %v", err)
	}
	t.Cleanup(func() { _ = ledger.Close() })
	return ledger
}

func appendBranchMessage(t *testing.T, ledger *Ledger, sessionID, role, content string) Message {
	t.Helper()
	message, err := ledger.AppendMessage(context.Background(), Message{
		SessionID: sessionID,
		Role:      role,
		Content:   content,
		CreatedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("append %s message: %v", role, err)
	}
	return message
}

type branchCompleteModel struct{}

func (branchCompleteModel) Execute(context.Context, ModelTurnRequest, ModelDeltaSink) (ModelTurnResult, error) {
	return ModelTurnResult{Text: "done", Completed: true}, nil
}

func TestCreateSessionBranchCopiesOnlyPrefixAndPreservesSource(t *testing.T) {
	ctx := context.Background()
	ledger := newBranchLedger(t)
	source, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "source", Title: "Original title"})
	if err != nil {
		t.Fatalf("create source session: %v", err)
	}
	firstUser := appendBranchMessage(t, ledger, source.ID, "user", "first request")
	firstAnswer := appendBranchMessage(t, ledger, source.ID, "assistant", "first answer")
	cursor := appendBranchMessage(t, ledger, source.ID, "user", "replace this request")
	sourceBefore, err := ledger.GetSession(ctx, source.ID, true)
	if err != nil {
		t.Fatalf("read source session: %v", err)
	}

	branch, err := ledger.CreateSessionBranch(ctx, CreateSessionBranchRequest{
		SessionID:              "branch-1",
		SourceSessionID:        source.ID,
		BranchFromMessageID:    cursor.ID,
		ExpectedSourceRevision: sourceBefore.Revision,
		Title:                  "Edited request",
	})
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}
	if branch.ParentSessionID != source.ID || branch.BranchFromMessageID != cursor.ID || branch.BranchFromSequence != cursor.Sequence {
		t.Fatalf("branch provenance = %+v", branch)
	}
	if branch.Generation != sourceBefore.Generation+1 {
		t.Fatalf("branch generation = %d, want %d", branch.Generation, sourceBefore.Generation+1)
	}
	if len(branch.Messages) != 2 {
		t.Fatalf("branch message count = %d, want 2", len(branch.Messages))
	}
	if branch.Messages[0].Content != firstUser.Content || branch.Messages[1].Content != firstAnswer.Content {
		t.Fatalf("branch prefix content = %#v", branch.Messages)
	}
	if branch.Messages[0].ID == firstUser.ID || branch.Messages[1].ID == firstAnswer.ID {
		t.Fatalf("branch must re-encrypt copies with new message IDs")
	}
	if branch.Messages[0].RunID != "" || branch.Messages[1].RunID != "" {
		t.Fatalf("branch copies must not retain source run ownership: %#v", branch.Messages)
	}

	sourceAfter, err := ledger.GetSession(ctx, source.ID, true)
	if err != nil {
		t.Fatalf("read source after branch: %v", err)
	}
	if sourceAfter.Revision != sourceBefore.Revision || len(sourceAfter.Messages) != len(sourceBefore.Messages) {
		t.Fatalf("source session changed during branch: before=%+v after=%+v", sourceBefore, sourceAfter)
	}

	idempotent, err := ledger.CreateSessionBranch(ctx, CreateSessionBranchRequest{
		SessionID:           "branch-1",
		SourceSessionID:     source.ID,
		BranchFromMessageID: cursor.ID,
	})
	if err != nil {
		t.Fatalf("replay branch creation: %v", err)
	}
	if idempotent.ID != branch.ID || len(idempotent.Messages) != len(branch.Messages) {
		t.Fatalf("branch replay returned different projection: %+v", idempotent)
	}
}

func TestCreateSessionBranchRejectsUnsafeOrStaleCursor(t *testing.T) {
	ctx := context.Background()
	ledger := newBranchLedger(t)
	source, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "source"})
	if err != nil {
		t.Fatalf("create source session: %v", err)
	}
	_ = appendBranchMessage(t, ledger, source.ID, "user", "question")
	assistant := appendBranchMessage(t, ledger, source.ID, "assistant", "answer")
	current, err := ledger.GetSession(ctx, source.ID, false)
	if err != nil {
		t.Fatalf("read source: %v", err)
	}

	_, err = ledger.CreateSessionBranch(ctx, CreateSessionBranchRequest{
		SessionID:              "unsafe-branch",
		SourceSessionID:        source.ID,
		BranchFromMessageID:    assistant.ID,
		ExpectedSourceRevision: current.Revision,
	})
	if !errors.Is(err, ErrInvalidBranchCursor) {
		t.Fatalf("assistant cursor error = %v, want ErrInvalidBranchCursor", err)
	}

	_, err = ledger.CreateSessionBranch(ctx, CreateSessionBranchRequest{
		SessionID:              "stale-branch",
		SourceSessionID:        source.ID,
		BranchFromMessageID:    assistant.ID,
		ExpectedSourceRevision: current.Revision - 1,
	})
	if !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale branch error = %v, want ErrRevisionConflict", err)
	}
}

func TestHarnessSubmitInputCreatesDeterministicConversationBranch(t *testing.T) {
	ctx := context.Background()
	model := branchCompleteModel{}
	harness, ledger := newContractHarness(t, model, nil, nil)
	source, err := ledger.CreateSession(ctx, CreateSessionRequest{SessionID: "source", Title: "Original"})
	if err != nil {
		t.Fatalf("create source session: %v", err)
	}
	_ = appendBranchMessage(t, ledger, source.ID, "user", "first request")
	_ = appendBranchMessage(t, ledger, source.ID, "assistant", "first answer")
	cursor := appendBranchMessage(t, ledger, source.ID, "user", "old request")
	current, err := ledger.GetSession(ctx, source.ID, false)
	if err != nil {
		t.Fatalf("read source session: %v", err)
	}

	request := AgentInputRequest{
		RequestID:           "branch-submit-idempotency-key",
		SessionID:           source.ID,
		BranchFromMessageID: cursor.ID,
		Content:             "edited request",
		DispatchMode:        DispatchSteer, // branching must never steer source.
		ExpectedRevision:    current.Revision,
	}
	receipt, err := harness.SubmitInput(ctx, request)
	if err != nil {
		t.Fatalf("submit branch input: %v", err)
	}
	if receipt.SessionID == source.ID || receipt.Disposition == "steered" {
		t.Fatalf("branch receipt = %+v", receipt)
	}
	if receipt.SessionID != deterministicBranchSessionID(request.RequestID) {
		t.Fatalf("branch session id = %q", receipt.SessionID)
	}
	read := waitContractRun(t, harness, receipt.RunID, func(run RunSnapshot) bool { return run.State.Terminal() })
	if read.Run.State != RunStateCompleted {
		t.Fatalf("branch run state = %s", read.Run.State)
	}
	branch, err := ledger.GetSession(ctx, receipt.SessionID, true)
	if err != nil {
		t.Fatalf("read branch session: %v", err)
	}
	if branch.ParentSessionID != source.ID || branch.BranchFromMessageID != cursor.ID {
		t.Fatalf("branch provenance = %+v", branch)
	}
	foundEdited := false
	for _, message := range branch.Messages {
		if message.Role == "user" && message.Content == "edited request" {
			foundEdited = true
		}
	}
	if !foundEdited {
		t.Fatalf("branch does not contain submitted replacement: %#v", branch.Messages)
	}
}
