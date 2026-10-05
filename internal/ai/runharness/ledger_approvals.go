package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// CreateApproval stores an encrypted, argument-bound approval request. An
// existing identical request is returned idempotently.
func (l *Ledger) CreateApproval(ctx context.Context, request PutApprovalRequest) (ApprovalRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	if request.RunID == "" || request.CallID == "" || request.ToolName == "" {
		return ApprovalRecord{}, errors.New("runId, callId and toolName are required")
	}
	if !request.Effect.Valid() {
		return ApprovalRecord{}, fmt.Errorf("invalid tool effect %q", request.Effect)
	}
	args := request.Arguments
	if len(args) == 0 {
		args = []byte(`{}`)
	}
	if !json.Valid(args) {
		return ApprovalRecord{}, errors.New("approval arguments must be valid JSON")
	}
	argsHash := hashBytes(args)
	id := request.ApprovalID
	if id == "" {
		id = uuid.NewString()
	}
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ApprovalRecord{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return ApprovalRecord{}, err
	}
	if run.State.Terminal() {
		return ApprovalRecord{}, ErrTerminalRun
	}
	if request.OwnerToken != "" {
		if err := verifyOwner(run, request.OwnerToken); err != nil {
			return ApprovalRecord{}, err
		}
	}
	if request.RunRevision == 0 {
		request.RunRevision = run.Revision
	}
	if request.RunRevision != run.Revision {
		return ApprovalRecord{}, fmt.Errorf("%w: expected run revision %d, got %d", ErrApprovalConflict, run.Revision, request.RunRevision)
	}
	var existing ApprovalRecord
	var created, decided int64
	var status string
	var existingArgs []byte
	err = tx.QueryRowContext(ctx, `SELECT id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments FROM approvals WHERE run_id=? AND call_id=? AND args_hash=?`, request.RunID, request.CallID, argsHash).Scan(&existing.ApprovalID, &existing.ToolName, &existing.Effect, &existing.ArgsHash, &status, &existing.RunRevision, &created, &decided, &existingArgs)
	if err == nil {
		existing.RunID = request.RunID
		existing.CallID = request.CallID
		existing.Status = status
		existing.Arguments, err = l.openRaw("approvals", existing.ApprovalID, "arguments", existingArgs)
		if err != nil {
			return ApprovalRecord{}, err
		}
		existing.CreatedAt = fromNano(created)
		existing.DecidedAt = fromNano(decided)
		if existing.RunRevision != run.Revision {
			return ApprovalRecord{}, fmt.Errorf("%w: run revision changed", ErrApprovalConflict)
		}
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, err
	}
	sealed, err := l.sealRaw("approvals", id, "arguments", args)
	if err != nil {
		return ApprovalRecord{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO approvals(id,run_id,call_id,tool_name,effect,args_hash,arguments,status,run_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, id, request.RunID, request.CallID, request.ToolName, request.Effect, argsHash, sealed, "pending", request.RunRevision, toNano(now)); err != nil {
		return ApprovalRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{ApprovalID: id, RunID: request.RunID, CallID: request.CallID, ToolName: request.ToolName, Effect: request.Effect, ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...), Status: "pending", RunRevision: request.RunRevision, CreatedAt: now}, nil
}

func (l *Ledger) DecideApproval(ctx context.Context, request DecideApprovalRequest) (ApprovalRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	decision := strings.ToLower(strings.TrimSpace(request.Decision))
	if decision != "approved" && decision != "denied" && decision != "expired" {
		return ApprovalRecord{}, errors.New("approval decision must be approved, denied, or expired")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ApprovalRecord{}, err
	}
	defer tx.Rollback()
	var runID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err = tx.QueryRowContext(ctx, `SELECT run_id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments FROM approvals WHERE id=?`, request.ApprovalID).Scan(&runID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	}
	if err != nil {
		return ApprovalRecord{}, err
	}
	// Bind the decision to the exact approval card rendered by an adapter. This
	// check must happen before any status/revision handling: a malformed or
	// stale request must never expire or otherwise mutate a pending approval.
	if expectedRunID := strings.TrimSpace(request.ExpectedRunID); expectedRunID == "" || expectedRunID != runID {
		return ApprovalRecord{}, fmt.Errorf("%w: approval run mismatch", ErrApprovalConflict)
	}
	if expectedCallID := strings.TrimSpace(request.ExpectedCallID); expectedCallID == "" || expectedCallID != callID {
		return ApprovalRecord{}, fmt.Errorf("%w: approval call mismatch", ErrApprovalConflict)
	}
	if expectedArgsHash := strings.TrimSpace(request.ExpectedArgsHash); expectedArgsHash == "" || !ConstantTimeEqual([]byte(expectedArgsHash), []byte(argsHash)) {
		return ApprovalRecord{}, fmt.Errorf("%w: approval arguments mismatch", ErrApprovalConflict)
	}
	if request.ExpectedRunRevision <= 0 || request.ExpectedRunRevision != runRevision {
		return ApprovalRecord{}, fmt.Errorf("%w: approval revision mismatch", ErrApprovalConflict)
	}
	if status != "pending" {
		args, openErr := l.openRaw("approvals", request.ApprovalID, "arguments", argsBlob)
		if openErr != nil {
			return ApprovalRecord{}, openErr
		}
		return ApprovalRecord{ApprovalID: request.ApprovalID, RunID: runID, CallID: callID, ToolName: toolName, Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args, Status: status, RunRevision: runRevision, CreatedAt: fromNano(created), DecidedAt: fromNano(decided)}, ErrApprovalConflict
	}
	var currentRevision int64
	var currentState string
	if err := tx.QueryRowContext(ctx, `SELECT revision,state FROM runs WHERE id=?`, runID).Scan(&currentRevision, &currentState); errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	} else if err != nil {
		return ApprovalRecord{}, err
	}
	if RunState(currentState).Terminal() || currentRevision != runRevision || request.ExpectedRunRevision != currentRevision {
		// A revision change invalidates the pending approval. Mark it expired in
		// the same transaction before returning the conflict so stale UI/CLI
		// approval cards cannot remain actionable.
		if status == "pending" {
			_, _ = tx.ExecContext(ctx, `UPDATE approvals SET status='expired',decided_at=? WHERE id=? AND status='pending'`, toNano(nowUTC()), request.ApprovalID)
		}
		return ApprovalRecord{}, fmt.Errorf("%w: run revision changed", ErrApprovalConflict)
	}
	decidedAt := nowUTC()
	if _, err := tx.ExecContext(ctx, `UPDATE approvals SET status=?,decided_at=? WHERE id=? AND status='pending'`, decision, toNano(decidedAt), request.ApprovalID); err != nil {
		return ApprovalRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return ApprovalRecord{}, err
	}
	args, err := l.openRaw("approvals", request.ApprovalID, "arguments", argsBlob)
	if err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{ApprovalID: request.ApprovalID, RunID: runID, CallID: callID, ToolName: toolName, Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args, Status: decision, RunRevision: runRevision, CreatedAt: fromNano(created), DecidedAt: decidedAt}, nil
}

// GetApproval returns the current decision for an approval request. Arguments
// remain encrypted at rest and are only decrypted for the caller that already
// knows the approval ID. It is intentionally read-only so workers can poll it
// while waiting without changing the run revision.
func (l *Ledger) GetApproval(ctx context.Context, approvalID string) (ApprovalRecord, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		return ApprovalRecord{}, errors.New("approvalId is required")
	}
	var runID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT run_id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments FROM approvals WHERE id=?`, approvalID).
		Scan(&runID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	}
	if err != nil {
		return ApprovalRecord{}, err
	}
	args, err := l.openRaw("approvals", approvalID, "arguments", argsBlob)
	if err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{ApprovalID: approvalID, RunID: runID, CallID: callID,
		ToolName: toolName, Effect: ToolEffect(effect), ArgsHash: argsHash,
		Arguments: args, Status: status, RunRevision: runRevision,
		CreatedAt: fromNano(created), DecidedAt: fromNano(decided)}, nil
}

// LatestApprovalForRun returns the most recently created approval for a run.
// A run can have more than one approval over its lifetime (for example after
// a steer or an explicit recovery retry), so callers must use the newest
// record when resuming an awaiting_approval run.
func (l *Ledger) LatestApprovalForRun(ctx context.Context, runID string) (ApprovalRecord, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ApprovalRecord{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return ApprovalRecord{}, errors.New("runId is required")
	}
	var approvalID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments
		FROM approvals WHERE run_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, runID).
		Scan(&approvalID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return ApprovalRecord{}, ErrNotFound
	}
	if err != nil {
		return ApprovalRecord{}, err
	}
	args, err := l.openRaw("approvals", approvalID, "arguments", argsBlob)
	if err != nil {
		return ApprovalRecord{}, err
	}
	return ApprovalRecord{
		ApprovalID: approvalID, RunID: runID, CallID: callID, ToolName: toolName,
		Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args,
		Status: status, RunRevision: runRevision, CreatedAt: fromNano(created),
		DecidedAt: fromNano(decided),
	}, nil
}
