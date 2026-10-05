package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrToolAlreadyStarted = errors.New("tool call already started")

func validToolStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "started", "completed", "failed", "canceled", "unknown":
		return true
	default:
		return false
	}
}

func (l *Ledger) decodeToolCallRecord(runID, callID string, attempt int, toolName string, effect ToolEffect, status, argsHash string, argsBlob, resultBlob, workspaceBlob []byte, resultHash, errorCode sql.NullString, unknown, resultTruncated int, resultOriginalBytes, started, completed int64) (ToolCallRecord, error) {
	args, err := l.openRaw("tool_calls", runID, fmt.Sprintf("arguments/%s/%d", callID, attempt), argsBlob)
	if err != nil {
		return ToolCallRecord{}, err
	}
	var result json.RawMessage
	if len(resultBlob) > 0 {
		result, err = l.openRaw("tool_calls", runID, fmt.Sprintf("result/%s/%d", callID, attempt), resultBlob)
		if err != nil {
			return ToolCallRecord{}, err
		}
	}
	workspace, err := l.openWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(runID, callID, attempt), workspaceBlob)
	if err != nil {
		return ToolCallRecord{}, err
	}
	return ToolCallRecord{RunID: runID, CallID: callID, Attempt: attempt, ToolName: toolName,
		Effect: effect, Status: status, ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...),
		Result: append(json.RawMessage(nil), result...), ResultHash: resultHash.String, ErrorCode: errorCode.String,
		UnknownOutcome: unknown != 0, Truncated: resultTruncated != 0, OriginalBytes: resultOriginalBytes,
		WorkspaceSnapshot: workspace, StartedAt: fromNano(started), CompletedAt: fromNano(completed)}, nil
}

func toolCallRecordID(runID, callID string, attempt int) string {
	return fmt.Sprintf("%s/%s/%d", runID, callID, attempt)
}

func (l *Ledger) StartTool(ctx context.Context, request StartToolRequest) (ToolCallRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ToolCallRecord{}, err
	}
	if strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.CallID) == "" || strings.TrimSpace(request.ToolName) == "" {
		return ToolCallRecord{}, errors.New("runId, callId and toolName are required")
	}
	if !request.Effect.Valid() {
		return ToolCallRecord{}, fmt.Errorf("invalid tool effect %q", request.Effect)
	}
	args := request.Arguments
	if len(args) == 0 {
		args = []byte(`{}`)
	}
	if !json.Valid(args) {
		return ToolCallRecord{}, errors.New("tool arguments must be valid JSON")
	}
	attempt := request.Attempt
	if attempt < 0 {
		return ToolCallRecord{}, errors.New("tool attempt cannot be negative")
	}
	if attempt == 0 {
		attempt = 1
	}
	argsHash := hashBytes(args)
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ToolCallRecord{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if run.State.Terminal() {
		return ToolCallRecord{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return ToolCallRecord{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return ToolCallRecord{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	var existingToolName, existingEffect, existingStatus, existingArgsHash string
	var existingArgs, existingResult, existingWorkspace []byte
	var existingResultHash, existingErrorCode sql.NullString
	var existingUnknown, existingTruncated int
	var existingOriginalBytes, existingStarted, existingCompleted int64
	err = tx.QueryRowContext(ctx, `SELECT tool_name,effect,status,args_hash,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at FROM tool_calls WHERE run_id=? AND call_id=? AND attempt=?`, request.RunID, request.CallID, attempt).
		Scan(&existingToolName, &existingEffect, &existingStatus, &existingArgsHash, &existingArgs, &existingResult, &existingWorkspace, &existingResultHash, &existingErrorCode, &existingUnknown, &existingOriginalBytes, &existingTruncated, &existingStarted, &existingCompleted)
	if err == nil {
		if existingToolName != request.ToolName || ToolEffect(existingEffect) != request.Effect || existingArgsHash != argsHash {
			return ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: existingToolName, Effect: ToolEffect(existingEffect), Status: existingStatus, ArgsHash: existingArgsHash}, fmt.Errorf("%w: run=%s call=%s attempt=%d", ErrToolConflict, request.RunID, request.CallID, attempt)
		}
		record, decodeErr := l.decodeToolCallRecord(request.RunID, request.CallID, attempt, existingToolName, ToolEffect(existingEffect), existingStatus, existingArgsHash, existingArgs, existingResult, existingWorkspace, existingResultHash, existingErrorCode, existingUnknown, existingTruncated, existingOriginalBytes, existingStarted, existingCompleted)
		if decodeErr != nil {
			return ToolCallRecord{}, decodeErr
		}
		return record, ErrToolAlreadyStarted
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ToolCallRecord{}, err
	}

	sealedArgs, err := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("arguments/%s/%d", request.CallID, attempt), args)
	if err != nil {
		return ToolCallRecord{}, err
	}
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	workspaceBlob, err := l.sealWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(request.RunID, request.CallID, attempt), workspace)
	if err != nil {
		return ToolCallRecord{}, err
	}
	target := run.State
	if run.State == RunStateRunningModel || run.State == RunStateAwaitingApproval {
		target = RunStateRunningTool
	}
	if target != run.State {
		if err := ValidateTransition(run.State, target); err != nil {
			return ToolCallRecord{}, err
		}
	}
	newRevision := run.Revision + 1
	if _, err := tx.ExecContext(ctx, `INSERT INTO tool_calls(run_id,call_id,attempt,tool_name,effect,status,args_hash,arguments,workspace_snapshot,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, request.RunID, request.CallID, attempt, request.ToolName, request.Effect, "started", argsHash, sealedArgs, workspaceBlob, toNano(now)); err != nil {
		return ToolCallRecord{}, err
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	runArgs := []any{target, newRevision, toNano(now), request.RunID, run.Revision}
	runArgs = append(runArgs, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, runArgs...)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if affected, err := runUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return ToolCallRecord{}, err
		}
		return ToolCallRecord{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return ToolCallRecord{}, err
	}
	return ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: request.ToolName,
		Effect: request.Effect, Status: "started", ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...),
		WorkspaceSnapshot: workspace, StartedAt: now}, nil
}

func (l *Ledger) FinishTool(ctx context.Context, request FinishToolRequest) (ToolCallRecord, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ToolCallRecord{}, err
	}
	if strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.CallID) == "" {
		return ToolCallRecord{}, errors.New("runId and callId are required")
	}
	if strings.TrimSpace(request.Status) == "" {
		return ToolCallRecord{}, errors.New("tool status is required")
	}
	if request.Attempt < 0 {
		return ToolCallRecord{}, errors.New("tool attempt cannot be negative")
	}
	request.Status = strings.ToLower(strings.TrimSpace(request.Status))
	if !validToolStatus(request.Status) || request.Status == "started" {
		return ToolCallRecord{}, fmt.Errorf("%w: %q", ErrToolStatus, request.Status)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ToolCallRecord{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if run.State.Terminal() {
		return ToolCallRecord{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return ToolCallRecord{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return ToolCallRecord{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	var toolName, effect, status, argsHash string
	var attempt int
	var started, completed int64
	var argsBlob, resultBlob, workspaceBlob []byte
	var resultHash, errorCode sql.NullString
	var unknownOutcome, resultTruncated int
	var resultOriginalBytes int64
	query := `SELECT tool_name,effect,status,args_hash,attempt,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at FROM tool_calls WHERE run_id=? AND call_id=?`
	queryArgs := []any{request.RunID, request.CallID}
	if request.Attempt > 0 {
		query += ` AND attempt=?`
		queryArgs = append(queryArgs, request.Attempt)
	}
	query += ` ORDER BY attempt DESC LIMIT 1`
	err = tx.QueryRowContext(ctx, query, queryArgs...).Scan(&toolName, &effect, &status, &argsHash, &attempt, &argsBlob, &resultBlob, &workspaceBlob, &resultHash, &errorCode, &unknownOutcome, &resultOriginalBytes, &resultTruncated, &started, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return ToolCallRecord{}, ErrNotFound
	}
	if err != nil {
		return ToolCallRecord{}, err
	}
	if !validToolStatus(status) {
		return ToolCallRecord{}, fmt.Errorf("%w: persisted status %q", ErrToolStatus, status)
	}
	if request.Attempt > 0 && attempt != request.Attempt {
		return ToolCallRecord{}, fmt.Errorf("%w: requested attempt %d, got %d", ErrToolConflict, request.Attempt, attempt)
	}
	if status != "started" {
		record, decodeErr := l.decodeToolCallRecord(request.RunID, request.CallID, attempt, toolName, ToolEffect(effect), status, argsHash, argsBlob, resultBlob, workspaceBlob, resultHash, errorCode, unknownOutcome, resultTruncated, resultOriginalBytes, started, completed)
		if decodeErr != nil {
			return ToolCallRecord{}, decodeErr
		}
		return record, nil
	}
	encodedResult, encodeErr := normalizedFinishResult(request)
	if encodeErr != nil {
		return ToolCallRecord{}, encodeErr
	}
	raw := encodedResult.JSON
	resultHashValue := hashBytes(raw)
	sealedResult, err := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("result/%s/%d", request.CallID, attempt), raw)
	if err != nil {
		return ToolCallRecord{}, err
	}
	completedAt := nowUTC()
	newRevision := run.Revision + 1
	resultUpdate, err := tx.ExecContext(ctx, `UPDATE tool_calls SET status=?,result=?,result_hash=?,error_code=?,unknown_outcome=?,result_original_bytes=?,result_truncated=?,completed_at=? WHERE run_id=? AND call_id=? AND attempt=? AND status='started'`, request.Status, sealedResult, nullString(resultHashValue), nullString(request.ErrorCode), boolInt(request.UnknownOutcome || request.Status == "unknown"), encodedResult.OriginalBytes, boolInt(encodedResult.Truncated), toNano(completedAt), request.RunID, request.CallID, attempt)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if affected, err := resultUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return ToolCallRecord{}, err
		}
		return ToolCallRecord{}, ErrToolAlreadyStarted
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, completedAt)
	args := []any{newRevision, toNano(completedAt), request.RunID, run.Revision}
	args = append(args, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return ToolCallRecord{}, err
	}
	if affected, err := runUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return ToolCallRecord{}, err
		}
		return ToolCallRecord{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return ToolCallRecord{}, err
	}
	workspace, err := l.openWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(request.RunID, request.CallID, attempt), workspaceBlob)
	if err != nil {
		return ToolCallRecord{}, err
	}
	return ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: toolName, Effect: ToolEffect(effect), Status: request.Status, ArgsHash: argsHash, Result: cloneRaw(raw), ResultHash: resultHashValue, ErrorCode: request.ErrorCode, UnknownOutcome: request.UnknownOutcome || request.Status == "unknown", Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes, WorkspaceSnapshot: workspace, StartedAt: fromNano(started), CompletedAt: completedAt}, nil
}

func mustMarshal(value any) json.RawMessage {
	if value == nil {
		return nil
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return raw
}
