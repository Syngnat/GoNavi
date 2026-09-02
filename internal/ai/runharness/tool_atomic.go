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

// StartToolAndEventRequest describes the durable boundary before an executor
// is allowed to make an external call. The started tool record, state change,
// checkpoint and typed event are committed together; callers publish Event
// only after this method succeeds.
type StartToolAndEventRequest struct {
	StartToolRequest
	ToolEvent          ToolEvent
	ConversationCursor string
	ProviderState      json.RawMessage
}

type StartToolAndEventResult struct {
	Tool       ToolCallRecord
	Event      RunEvent
	Checkpoint Checkpoint
	// AlreadyStarted is true when this exact call attempt already crossed the
	// durable start boundary. Event is zero-valued in that case so callers do
	// not publish duplicate UI/CLI events.
	AlreadyStarted bool
}

// StartToolAndEvent writes the durable start boundary for one tool invocation.
// A process crash before commit leaves no started call behind; a crash after
// commit leaves a replayable started event and checkpoint before any executor
// side effect can begin.
func (l *Ledger) StartToolAndEvent(ctx context.Context, request StartToolAndEventRequest) (StartToolAndEventResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return StartToolAndEventResult{}, err
	}
	if strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.CallID) == "" || strings.TrimSpace(request.ToolName) == "" {
		return StartToolAndEventResult{}, errors.New("runId, callId and toolName are required")
	}
	if !request.Effect.Valid() {
		return StartToolAndEventResult{}, fmt.Errorf("invalid tool effect %q", request.Effect)
	}
	args := request.Arguments
	if len(args) == 0 {
		args = []byte(`{}`)
	}
	if !json.Valid(args) {
		return StartToolAndEventResult{}, errors.New("tool arguments must be valid JSON")
	}
	argsHash := hashBytes(args)
	attempt := request.Attempt
	if attempt < 0 {
		return StartToolAndEventResult{}, errors.New("tool attempt cannot be negative")
	}
	if attempt == 0 {
		attempt = 1
	}
	now := nowUTC()
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	if run.State.Terminal() {
		return StartToolAndEventResult{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return StartToolAndEventResult{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return StartToolAndEventResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	var existingToolName, existingEffect, existingStatus, existingArgsHash string
	var existingArgs, existingResult, existingWorkspace []byte
	var existingResultHash, existingErrorCode sql.NullString
	var existingUnknown, existingTruncated int
	var existingOriginalBytes int64
	var existingStarted, existingCompleted int64
	err = tx.QueryRowContext(ctx, `SELECT tool_name,effect,status,args_hash,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at FROM tool_calls WHERE run_id=? AND call_id=? AND attempt=?`, request.RunID, request.CallID, attempt).
		Scan(&existingToolName, &existingEffect, &existingStatus, &existingArgsHash, &existingArgs, &existingResult, &existingWorkspace, &existingResultHash, &existingErrorCode, &existingUnknown, &existingOriginalBytes, &existingTruncated, &existingStarted, &existingCompleted)
	if err == nil {
		if existingToolName != request.ToolName || ToolEffect(existingEffect) != request.Effect || existingArgsHash != argsHash {
			return StartToolAndEventResult{Tool: ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: existingToolName, Effect: ToolEffect(existingEffect), Status: existingStatus, ArgsHash: existingArgsHash}}, fmt.Errorf("%w: run=%s call=%s attempt=%d", ErrToolConflict, request.RunID, request.CallID, attempt)
		}
		record, decodeErr := l.decodeToolCallRecord(request.RunID, request.CallID, attempt, existingToolName, ToolEffect(existingEffect), existingStatus, existingArgsHash, existingArgs, existingResult, existingWorkspace, existingResultHash, existingErrorCode, existingUnknown, existingTruncated, existingOriginalBytes, existingStarted, existingCompleted)
		if decodeErr != nil {
			return StartToolAndEventResult{}, decodeErr
		}
		return StartToolAndEventResult{Tool: record, AlreadyStarted: true}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return StartToolAndEventResult{}, err
	}

	sealedArgs, err := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("arguments/%s/%d", request.CallID, attempt), args)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	workspaceBlob, err := l.sealWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(request.RunID, request.CallID, attempt), workspace)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	target := run.State
	if run.State == RunStateRunningModel || run.State == RunStateAwaitingApproval {
		target = RunStateRunningTool
	}
	if target != run.State {
		if err := ValidateTransition(run.State, target); err != nil {
			return StartToolAndEventResult{}, err
		}
	}
	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	checkpointID := uuid.NewString()
	cursor := request.ConversationCursor
	providerState := append(json.RawMessage(nil), request.ProviderState...)
	if cursor == "" && len(providerState) == 0 {
		previousCursor, previousProvider, previousErr := l.previousCheckpointTx(ctx, tx, run)
		if previousErr != nil {
			return StartToolAndEventResult{}, previousErr
		}
		cursor = previousCursor
		providerState = previousProvider
	}
	cursorBlob, err := l.seal("checkpoints", checkpointID, "conversation_cursor", cursor)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	providerBlob, err := l.sealRaw("checkpoints", checkpointID, "provider_state", providerState)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	checkpointWorkspaceBlob, err := l.sealWorkspaceSnapshotReference(checkpointID, workspace)
	if err != nil {
		return StartToolAndEventResult{}, err
	}

	toolEvent := request.ToolEvent
	toolEvent.CallID = request.CallID
	toolEvent.ToolName = request.ToolName
	toolEvent.Effect = request.Effect
	toolEvent.Status = "started"
	toolEvent.ArgsHash = argsHash
	toolEvent.Result = nil
	toolEvent.ResultHash = ""
	toolEvent.ErrorCode = ""
	toolEvent.Truncated = false
	toolEvent.OriginalBytes = 0
	toolEvent.WorkspaceSnapshot = cloneWorkspaceSnapshotReference(workspace)
	eventPayload, err := json.Marshal(toolEvent)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	sealedEvent, err := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), eventPayload)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	newRevision := run.Revision + 1
	if _, err := tx.ExecContext(ctx, `INSERT INTO tool_calls(run_id,call_id,attempt,tool_name,effect,status,args_hash,arguments,workspace_snapshot,started_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, request.RunID, request.CallID, attempt, request.ToolName, request.Effect, "started", argsHash, sealedArgs, workspaceBlob, toNano(now)); err != nil {
		return StartToolAndEventResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, request.RunID, sequence, target, cursorBlob, providerBlob, checkpointWorkspaceBlob, toNano(now)); err != nil {
		return StartToolAndEventResult{}, err
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	runArgs := []any{target, newRevision, sequence + 1, checkpointID, toNano(now), request.RunID, run.Revision, run.NextSequence}
	runArgs = append(runArgs, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,checkpoint_id=?,updated_at=? WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, runArgs...)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	if affected, err := runUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return StartToolAndEventResult{}, err
		}
		return StartToolAndEventResult{}, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, sequence, CurrentSchemaVersion, EventTool, target, newRevision, run.Attempt, toNano(now), sealedEvent); err != nil {
		return StartToolAndEventResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return StartToolAndEventResult{}, err
	}
	latest, err := l.getRunDB(ctx, request.RunID)
	if err != nil {
		return StartToolAndEventResult{}, err
	}
	event := RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: latest.ID, SessionID: latest.SessionID,
		SessionGeneration: latest.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: run.Attempt, Timestamp: now, Kind: EventTool, ResultingState: target,
		Payload: append(json.RawMessage(nil), eventPayload...)}
	checkpoint := Checkpoint{ID: checkpointID, RunID: request.RunID, Sequence: sequence, State: target,
		ConversationCursor: cursor, ProviderState: append(json.RawMessage(nil), providerState...), WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), CreatedAt: now}
	tool := ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt, ToolName: request.ToolName,
		Effect: request.Effect, Status: "started", ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), args...),
		WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), StartedAt: now}
	return StartToolAndEventResult{Tool: tool, Event: event, Checkpoint: checkpoint}, nil
}

// FinishToolAndEventRequest describes the single durable boundary after an
// executor returns. The tool result, typed tool event, checkpoint and run CAS
// are committed together; callers publish Event only after this method
// succeeds.
type FinishToolAndEventRequest struct {
	FinishToolRequest
	ResultingState     RunState
	ToolEvent          ToolEvent
	WorkspaceSnapshot  *WorkspaceSnapshotReference
	ConversationCursor string
	ProviderState      json.RawMessage
	// ToolMessage is written in the same transaction as the tool result and
	// event. When nil, a minimal result message is generated from Result.
	ToolMessage *Message
}

type FinishToolAndEventResult struct {
	Tool       ToolCallRecord
	Event      RunEvent
	Checkpoint Checkpoint
	Message    Message
	// AlreadyFinished is true when the same call was closed by an earlier
	// attempt. Callers must not append another tool message in that case.
	AlreadyFinished bool
}

// FinishToolAndEvent closes the newest started attempt for a call and records
// its event/checkpoint in one transaction. If the call was already closed, the
// existing record is returned as an idempotent no-op and Event is zero-valued.
func (l *Ledger) FinishToolAndEvent(ctx context.Context, request FinishToolAndEventRequest) (FinishToolAndEventResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return FinishToolAndEventResult{}, err
	}
	if strings.TrimSpace(request.RunID) == "" || strings.TrimSpace(request.CallID) == "" {
		return FinishToolAndEventResult{}, errors.New("runId and callId are required")
	}
	if request.Attempt < 0 {
		return FinishToolAndEventResult{}, errors.New("tool attempt cannot be negative")
	}
	status := strings.ToLower(strings.TrimSpace(request.Status))
	if status == "" {
		return FinishToolAndEventResult{}, errors.New("tool status is required")
	}
	if !validToolStatus(status) || status == "started" {
		return FinishToolAndEventResult{}, fmt.Errorf("%w: %q", ErrToolStatus, status)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	if run.State.Terminal() {
		return FinishToolAndEventResult{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return FinishToolAndEventResult{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return FinishToolAndEventResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	var toolName, effect, persistedStatus, argsHash string
	var attempt int
	var started, completed int64
	var argsBlob, resultBlob, workspaceBlob []byte
	var resultHash, errorCode sql.NullString
	var unknownOutcome, resultTruncated int
	var resultOriginalBytes int64
	query := `SELECT tool_name,effect,status,args_hash,attempt,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at
		FROM tool_calls WHERE run_id=? AND call_id=?`
	queryArgs := []any{request.RunID, request.CallID}
	if request.Attempt > 0 {
		query += ` AND attempt=?`
		queryArgs = append(queryArgs, request.Attempt)
	}
	query += ` ORDER BY attempt DESC LIMIT 1`
	err = tx.QueryRowContext(ctx, query, queryArgs...).
		Scan(&toolName, &effect, &persistedStatus, &argsHash, &attempt, &argsBlob, &resultBlob, &workspaceBlob, &resultHash, &errorCode, &unknownOutcome, &resultOriginalBytes, &resultTruncated, &started, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return FinishToolAndEventResult{}, ErrNotFound
	}
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	if !validToolStatus(persistedStatus) {
		return FinishToolAndEventResult{}, fmt.Errorf("%w: persisted status %q", ErrToolStatus, persistedStatus)
	}
	if request.Attempt > 0 && attempt != request.Attempt {
		return FinishToolAndEventResult{}, fmt.Errorf("%w: requested attempt %d, got %d", ErrToolConflict, request.Attempt, attempt)
	}
	if persistedStatus != "started" {
		record, decodeErr := l.decodeToolCallRecord(request.RunID, request.CallID, attempt, toolName, ToolEffect(effect), persistedStatus, argsHash, argsBlob, resultBlob, workspaceBlob, resultHash, errorCode, unknownOutcome, resultTruncated, resultOriginalBytes, started, completed)
		if decodeErr != nil {
			return FinishToolAndEventResult{}, decodeErr
		}
		return FinishToolAndEventResult{Tool: record, AlreadyFinished: true}, nil
	}

	effectiveStatus := status
	if (ToolEffect(effect) == ToolEffectSideEffect || ToolEffect(effect) == ToolEffectSideEffectUnknown) && request.UnknownOutcome {
		effectiveStatus = "unknown"
	}
	encodedResult, encodeErr := normalizedFinishResult(request.FinishToolRequest)
	if encodeErr != nil {
		return FinishToolAndEventResult{}, encodeErr
	}
	raw := encodedResult.JSON
	resultHashValue := hashBytes(raw)
	sealedResult, err := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("result/%s/%d", request.CallID, attempt), raw)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	now := nowUTC()
	// A tool outcome is authoritative even when the caller supplied a stale
	// target state. Unknown side effects always fence the run in recovery.
	target := request.ResultingState
	if target == "" {
		target = RunStateRunningModel
	}
	if effectiveStatus == "unknown" && (ToolEffect(effect) == ToolEffectSideEffect || ToolEffect(effect) == ToolEffectSideEffectUnknown) {
		target = RunStateRecoveryRequired
	}
	if target != run.State {
		if err := ValidateTransition(run.State, target); err != nil {
			return FinishToolAndEventResult{}, err
		}
	}
	persistedWorkspace, err := l.openWorkspaceSnapshotReferenceFor("tool_calls", toolCallRecordID(request.RunID, request.CallID, attempt), workspaceBlob)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	workspace := persistedWorkspace
	if request.WorkspaceSnapshot != nil {
		if persistedWorkspace != nil && !sameWorkspaceSnapshotReference(persistedWorkspace, request.WorkspaceSnapshot) {
			return FinishToolAndEventResult{}, fmt.Errorf("%w: tool workspace snapshot changed after start", ErrSnapshotConflict)
		}
		if workspace == nil {
			workspace = cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
		}
	}

	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	checkpointID := uuid.NewString()
	cursor := request.ConversationCursor
	providerState := append(json.RawMessage(nil), request.ProviderState...)
	if cursor == "" && len(providerState) == 0 {
		previousCursor, previousProvider, previousErr := l.previousCheckpointTx(ctx, tx, run)
		if previousErr != nil {
			return FinishToolAndEventResult{}, previousErr
		}
		cursor = previousCursor
		providerState = previousProvider
	}
	cursorBlob, err := l.seal("checkpoints", checkpointID, "conversation_cursor", cursor)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	providerBlob, err := l.sealRaw("checkpoints", checkpointID, "provider_state", providerState)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	checkpointWorkspaceBlob, err := l.sealWorkspaceSnapshotReference(checkpointID, workspace)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, request.RunID, sequence, target, cursorBlob, providerBlob, checkpointWorkspaceBlob, toNano(now)); err != nil {
		return FinishToolAndEventResult{}, err
	}

	toolEvent := request.ToolEvent
	toolEvent.CallID = request.CallID
	toolEvent.ToolName = toolName
	toolEvent.Effect = ToolEffect(effect)
	toolEvent.Status = effectiveStatus
	toolEvent.ArgsHash = argsHash
	toolEvent.Result = append(json.RawMessage(nil), raw...)
	toolEvent.ResultHash = resultHashValue
	toolEvent.Truncated = encodedResult.Truncated
	toolEvent.OriginalBytes = encodedResult.OriginalBytes
	toolEvent.WorkspaceSnapshot = cloneWorkspaceSnapshotReference(workspace)
	if request.ErrorCode != "" {
		toolEvent.ErrorCode = request.ErrorCode
	}
	eventPayload, err := json.Marshal(toolEvent)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	sealedEvent, err := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), eventPayload)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	newRevision := run.Revision + 1
	resultUpdate, err := tx.ExecContext(ctx, `UPDATE tool_calls SET status=?,result=?,result_hash=?,error_code=?,unknown_outcome=?,result_original_bytes=?,result_truncated=?,completed_at=?
		WHERE run_id=? AND call_id=? AND attempt=? AND status='started'`, effectiveStatus, sealedResult, nullString(resultHashValue), nullString(request.ErrorCode), boolInt(request.UnknownOutcome || effectiveStatus == "unknown"), encodedResult.OriginalBytes, boolInt(encodedResult.Truncated), toNano(now), request.RunID, request.CallID, attempt)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	if affected, err := resultUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return FinishToolAndEventResult{}, err
		}
		return FinishToolAndEventResult{}, ErrToolAlreadyStarted
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	runArgs := []any{target, newRevision, sequence + 1, checkpointID, toNano(now), request.RunID, run.Revision, run.NextSequence}
	runArgs = append(runArgs, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,checkpoint_id=?,updated_at=? WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, runArgs...)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	if affected, err := runUpdate.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return FinishToolAndEventResult{}, err
		}
		return FinishToolAndEventResult{}, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, sequence, CurrentSchemaVersion, EventTool, target, newRevision, run.Attempt, toNano(now), sealedEvent); err != nil {
		return FinishToolAndEventResult{}, err
	}
	message := Message{}
	if request.ToolMessage != nil {
		message = *request.ToolMessage
	} else {
		message = Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: request.CallID, Content: atomicToolResultMessage(request.Result), CreatedAt: now}
	}
	if message.ID == "" {
		message.ID = uuid.NewString()
	}
	message.SessionID = run.SessionID
	message.RunID = run.ID
	message.Role = "tool"
	message.ToolCallID = request.CallID
	if message.CreatedAt.IsZero() {
		message.CreatedAt = now
	}
	// The canonical result is authoritative even when a low-level caller
	// supplied a stale or differently formatted message body.
	message.Content = string(raw)
	if err := l.appendMessageTx(ctx, tx, message); err != nil {
		return FinishToolAndEventResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return FinishToolAndEventResult{}, err
	}
	args, err := l.openRaw("tool_calls", request.RunID, fmt.Sprintf("arguments/%s/%d", request.CallID, attempt), argsBlob)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	tool := ToolCallRecord{RunID: request.RunID, CallID: request.CallID, Attempt: attempt,
		ToolName: toolName, Effect: ToolEffect(effect), Status: effectiveStatus, ArgsHash: argsHash,
		Arguments: args, Result: cloneRaw(raw), ResultHash: resultHashValue,
		ErrorCode: request.ErrorCode, UnknownOutcome: request.UnknownOutcome || effectiveStatus == "unknown", WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace),
		Truncated: encodedResult.Truncated, OriginalBytes: encodedResult.OriginalBytes,
		StartedAt: fromNano(started), CompletedAt: now}
	latest, err := l.getRunDB(ctx, request.RunID)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	event := RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: latest.ID, SessionID: latest.SessionID,
		SessionGeneration: latest.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: run.Attempt, Timestamp: now, Kind: EventTool, ResultingState: target,
		Payload: append(json.RawMessage(nil), eventPayload...)}
	checkpoint := Checkpoint{ID: checkpointID, RunID: request.RunID, Sequence: sequence, State: target,
		ConversationCursor: cursor, ProviderState: append(json.RawMessage(nil), providerState...), WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), CreatedAt: now}
	storedMessage, err := l.getMessageDB(ctx, message.ID)
	if err != nil {
		return FinishToolAndEventResult{}, err
	}
	return FinishToolAndEventResult{Tool: tool, Event: event, Checkpoint: checkpoint, Message: storedMessage}, nil
}

func atomicToolResultMessage(value any) string {
	if value == nil {
		return "null"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return `{"error":"tool_result_encode_failed"}`
	}
	return string(encoded)
}
