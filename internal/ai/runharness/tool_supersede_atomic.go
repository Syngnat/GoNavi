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

// SupersedeToolIntentsRequest describes the durable boundary created when a
// steer interrupts a model turn that returned more than one tool intent. The
// intents have not crossed StartToolAndEvent yet, so they can be represented
// directly as canceled calls without manufacturing a started/recoverable
// operation.
type SupersedeToolIntentsRequest struct {
	RunID              string
	OwnerToken         string `json:"-"`
	ExpectedRevision   int64
	Intents            []ToolIntent
	SteerContent       string
	RequestID          string
	ConversationCursor string
	ProviderState      json.RawMessage
	WorkspaceSnapshot  *WorkspaceSnapshotReference
}

// SupersedeToolIntentsResult contains every event/message written by the
// atomic supersede operation. Callers publish Events only after this method
// returns successfully; the Ledger remains the source of truth if a caller
// crashes before publication.
type SupersedeToolIntentsResult struct {
	Run        RunSnapshot
	Events     []RunEvent
	Messages   []Message
	Checkpoint Checkpoint
	ToolCalls  []ToolCallRecord
}

// SupersedeToolIntentsAndSteer atomically records all not-yet-started tool
// intents as terminal canceled calls, expires their pending approvals, writes
// an interrupted checkpoint, appends the steer input, and returns the run to
// running_model. This prevents a later intent from the same provider response
// from being executed or leaking into the next provider transcript.
func (l *Ledger) SupersedeToolIntentsAndSteer(ctx context.Context, request SupersedeToolIntentsRequest) (SupersedeToolIntentsResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	request.RunID = strings.TrimSpace(request.RunID)
	request.SteerContent = strings.TrimSpace(request.SteerContent)
	request.RequestID = strings.TrimSpace(request.RequestID)
	if request.RunID == "" {
		return SupersedeToolIntentsResult{}, errors.New("runId is required")
	}
	if request.SteerContent == "" {
		return SupersedeToolIntentsResult{}, errors.New("steer content is required")
	}

	// Validate the complete batch before opening any durable write. A malformed
	// intent must never produce a half-written tool/message pairing.
	seenCalls := make(map[string]struct{}, len(request.Intents))
	for index := range request.Intents {
		intent := &request.Intents[index]
		intent.CallID = strings.TrimSpace(intent.CallID)
		intent.ToolName = strings.TrimSpace(intent.ToolName)
		if intent.CallID == "" || intent.ToolName == "" {
			return SupersedeToolIntentsResult{}, fmt.Errorf("tool intent %d requires callId and toolName", index)
		}
		if _, duplicate := seenCalls[intent.CallID]; duplicate {
			return SupersedeToolIntentsResult{}, fmt.Errorf("%w: duplicate call id %q", ErrToolConflict, intent.CallID)
		}
		seenCalls[intent.CallID] = struct{}{}
		if !intent.Effect.Valid() {
			return SupersedeToolIntentsResult{}, fmt.Errorf("invalid tool effect %q for call %q", intent.Effect, intent.CallID)
		}
		if len(intent.Arguments) == 0 {
			intent.Arguments = json.RawMessage(`{}`)
		}
		if !json.Valid(intent.Arguments) {
			return SupersedeToolIntentsResult{}, fmt.Errorf("tool arguments for call %q must be valid JSON", intent.CallID)
		}
	}

	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	// A request id is the durable idempotency boundary for a cross-process
	// steer. Check it before state validation so a retry that arrives after the
	// first operation reached a terminal state still returns the authoritative
	// projection instead of attempting a second transition.
	if request.RequestID != "" {
		var existingRunID, existingHash string
		err := tx.QueryRowContext(ctx, `SELECT run_id,content_hash FROM steer_requests WHERE id=?`, request.RequestID).
			Scan(&existingRunID, &existingHash)
		if err == nil {
			if existingRunID != request.RunID || existingHash != hashString(request.SteerContent) {
				return SupersedeToolIntentsResult{}, fmt.Errorf("%w: steer id %q is already bound to run %q", ErrControlCommandConflict, request.RequestID, existingRunID)
			}
			if err := tx.Commit(); err != nil {
				return SupersedeToolIntentsResult{}, err
			}
			latest, err := l.getRunDB(ctx, request.RunID)
			if err != nil {
				return SupersedeToolIntentsResult{}, err
			}
			return SupersedeToolIntentsResult{Run: latest}, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return SupersedeToolIntentsResult{}, err
		}
	}
	if run.State.Terminal() {
		return SupersedeToolIntentsResult{}, ErrTerminalRun
	}
	switch run.State {
	case RunStateQueued, RunStateRunningModel, RunStateRunningTool,
		RunStateAwaitingApproval, RunStateAwaitingWorkspace:
		// A steer can safely replace work in these non-terminal phases. Recovery
		// and canceling states require their dedicated control action so a steer
		// cannot resurrect a run that is already being finalized.
	default:
		return SupersedeToolIntentsResult{}, fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, run.State, RunStateRunningModel)
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return SupersedeToolIntentsResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	now := nowUTC()
	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	newRevision := run.Revision + 1
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	if workspace == nil {
		_, _, inherited, inheritErr := l.previousCheckpointDataTx(ctx, tx, run)
		if inheritErr != nil {
			return SupersedeToolIntentsResult{}, inheritErr
		}
		workspace = inherited
	}
	cursor := request.ConversationCursor
	providerState := append(json.RawMessage(nil), request.ProviderState...)
	if cursor == "" && len(providerState) == 0 {
		inheritedCursor, inheritedProvider, inheritedWorkspace, inheritErr := l.previousCheckpointDataTx(ctx, tx, run)
		if inheritErr != nil {
			return SupersedeToolIntentsResult{}, inheritErr
		}
		cursor, providerState = inheritedCursor, inheritedProvider
		if workspace == nil {
			workspace = inheritedWorkspace
		}
	}

	result := SupersedeToolIntentsResult{
		Events:    make([]RunEvent, 0, len(request.Intents)+2),
		Messages:  make([]Message, 0, len(request.Intents)+1),
		ToolCalls: make([]ToolCallRecord, 0, len(request.Intents)),
	}
	// Event rows in one atomic operation share the resulting run revision. This
	// mirrors CommitModelTurn: sequence is the event order, revision is the CAS
	// boundary that committed the batch.
	type pendingEvent struct {
		sequence int64
		kind     EventKind
		state    RunState
		payload  []byte
		sealed   []byte
	}
	pendingEvents := make([]pendingEvent, 0, len(request.Intents)+2)
	appendEvent := func(seq int64, kind EventKind, state RunState, payload any) error {
		raw, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return marshalErr
		}
		sealed, sealErr := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", seq), raw)
		if sealErr != nil {
			return sealErr
		}
		pendingEvents = append(pendingEvents, pendingEvent{sequence: seq, kind: kind, state: state, payload: raw, sealed: sealed})
		result.Events = append(result.Events, RunEvent{
			SchemaVersion: CurrentSchemaVersion, RunID: run.ID, SessionID: run.SessionID,
			SessionGeneration: run.SessionGeneration, Sequence: seq, RunRevision: newRevision,
			Attempt: run.Attempt, Timestamp: now, Kind: kind, ResultingState: state,
			Payload: append(json.RawMessage(nil), raw...),
		})
		return nil
	}

	// Existing terminal rows are idempotent and are not duplicated. A started
	// or unknown row is a live external boundary; silently relabeling it would
	// hide an operation whose outcome still needs recovery.
	for _, intent := range request.Intents {
		attempt := run.Attempt
		if attempt < 1 {
			attempt = 1
		}
		argsHash := hashBytes(intent.Arguments)
		var existingName, existingEffect, existingStatus, existingHash string
		err := tx.QueryRowContext(ctx, `SELECT tool_name,effect,status,args_hash FROM tool_calls WHERE run_id=? AND call_id=? AND attempt=?`, request.RunID, intent.CallID, attempt).
			Scan(&existingName, &existingEffect, &existingStatus, &existingHash)
		if err == nil {
			if existingName != intent.ToolName || ToolEffect(existingEffect) != intent.Effect || existingHash != argsHash {
				return SupersedeToolIntentsResult{}, fmt.Errorf("%w: run=%s call=%s attempt=%d", ErrToolConflict, request.RunID, intent.CallID, attempt)
			}
			if !validToolStatus(existingStatus) {
				return SupersedeToolIntentsResult{}, fmt.Errorf("%w: persisted status %q", ErrToolStatus, existingStatus)
			}
			if existingStatus == "started" || existingStatus == "unknown" {
				return SupersedeToolIntentsResult{}, fmt.Errorf("%w: call %s already crossed the start boundary", ErrToolAlreadyStarted, intent.CallID)
			}
			// A prior atomic invocation already produced the terminal row. Do not
			// append a second event or tool message for the same call.
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return SupersedeToolIntentsResult{}, err
		}

		cancelResult := json.RawMessage(`{"error":"superseded_by_steer"}`)
		resultHash := hashBytes(cancelResult)
		sealedArgs, sealErr := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("arguments/%s/%d", intent.CallID, attempt), intent.Arguments)
		if sealErr != nil {
			return SupersedeToolIntentsResult{}, sealErr
		}
		toolRecordID := toolCallRecordID(request.RunID, intent.CallID, attempt)
		workspaceBlob, sealErr := l.sealWorkspaceSnapshotReferenceFor("tool_calls", toolRecordID, workspace)
		if sealErr != nil {
			return SupersedeToolIntentsResult{}, sealErr
		}
		sealedResult, sealErr := l.sealRaw("tool_calls", request.RunID, fmt.Sprintf("result/%s/%d", intent.CallID, attempt), cancelResult)
		if sealErr != nil {
			return SupersedeToolIntentsResult{}, sealErr
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO tool_calls(run_id,call_id,attempt,tool_name,effect,status,args_hash,arguments,result,result_hash,error_code,unknown_outcome,workspace_snapshot,result_original_bytes,result_truncated,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			request.RunID, intent.CallID, attempt, intent.ToolName, intent.Effect, "canceled", argsHash, sealedArgs, sealedResult, resultHash, "superseded_by_steer", 0, workspaceBlob, len(cancelResult), 0, 0, toNano(now)); err != nil {
			return SupersedeToolIntentsResult{}, err
		}
		if err := appendEvent(sequence, EventTool, run.State, ToolEvent{
			CallID: intent.CallID, ToolName: intent.ToolName, Effect: intent.Effect,
			Status: "canceled", ArgsHash: argsHash, Result: cancelResult,
			ResultHash: resultHash, ErrorCode: "superseded_by_steer", WorkspaceSnapshot: workspace,
		}); err != nil {
			return SupersedeToolIntentsResult{}, err
		}
		sequence++
		message := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID,
			Role: "tool", ToolCallID: intent.CallID, Content: string(cancelResult), CreatedAt: now}
		if err := l.appendMessageTx(ctx, tx, message); err != nil {
			return SupersedeToolIntentsResult{}, err
		}
		result.Messages = append(result.Messages, message)
		result.ToolCalls = append(result.ToolCalls, ToolCallRecord{
			RunID: request.RunID, CallID: intent.CallID, Attempt: attempt,
			ToolName: intent.ToolName, Effect: intent.Effect, Status: "canceled",
			ArgsHash: argsHash, Arguments: append(json.RawMessage(nil), intent.Arguments...),
			Result: append(json.RawMessage(nil), cancelResult...), ResultHash: resultHash,
			ErrorCode: "superseded_by_steer", WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace),
			CompletedAt: now,
		})
	}
	// A pending approval can exist even when its tool row was committed by a
	// previous retry (for example, a crash between the two idempotent writes).
	// Expire every matching approval after processing the batch so no stale
	// decision remains consumable when the run resumes.
	for callID := range seenCalls {
		if _, err := tx.ExecContext(ctx, `UPDATE approvals SET status='expired',decided_at=? WHERE run_id=? AND call_id=? AND status='pending'`, toNano(now), request.RunID, callID); err != nil {
			return SupersedeToolIntentsResult{}, err
		}
	}

	checkpointID := uuid.NewString()
	checkpointSequence := sequence
	checkpointEvent := CheckpointEvent{CheckpointID: checkpointID, Sequence: checkpointSequence, WorkspaceSnapshot: workspace}
	checkpointCursorBlob, err := l.seal("checkpoints", checkpointID, "conversation_cursor", cursor)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	checkpointProviderBlob, err := l.sealRaw("checkpoints", checkpointID, "provider_state", providerState)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	checkpointWorkspaceBlob, err := l.sealWorkspaceSnapshotReference(checkpointID, workspace)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, request.RunID, checkpointSequence, RunStateInterrupted, checkpointCursorBlob, checkpointProviderBlob, checkpointWorkspaceBlob, toNano(now)); err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	if err := appendEvent(checkpointSequence, EventCheckpoint, RunStateInterrupted, checkpointEvent); err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	sequence++

	steerMessage := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID,
		Role: "user", Content: request.SteerContent, CreatedAt: now}
	if err := l.appendMessageTx(ctx, tx, steerMessage); err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	result.Messages = append(result.Messages, steerMessage)
	if err := appendEvent(sequence, EventInput, RunStateRunningModel, InputEvent{
		RequestID: request.RequestID, ContentHash: hashString(request.SteerContent), DispatchMode: DispatchSteer,
	}); err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	sequence++

	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	runArgs := []any{RunStateRunningModel, newRevision, sequence, checkpointID, toNano(now), request.RunID, run.Revision}
	runArgs = append(runArgs, ownerArgs...)
	update, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,checkpoint_id=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, runArgs...)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	if affected, rowsErr := update.RowsAffected(); rowsErr != nil || affected != 1 {
		if rowsErr != nil {
			return SupersedeToolIntentsResult{}, rowsErr
		}
		return SupersedeToolIntentsResult{}, ErrRevisionConflict
	}
	if request.RequestID != "" {
		// Persist the idempotency marker in the same transaction as the input,
		// checkpoint, tool cancellations and run CAS. A crash before commit leaves
		// no marker, so a later owner can safely replay the command; a retry after
		// commit is a read-only no-op at the boundary above.
		if _, err := tx.ExecContext(ctx, `INSERT INTO steer_requests(id,run_id,content_hash,resulting_revision,created_at) VALUES(?,?,?,?,?)`,
			request.RequestID, request.RunID, hashString(request.SteerContent), newRevision, toNano(now)); err != nil {
			return SupersedeToolIntentsResult{}, err
		}
	}
	for _, event := range pendingEvents {
		if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, event.sequence, CurrentSchemaVersion, event.kind, event.state, newRevision, run.Attempt, toNano(now), event.sealed); err != nil {
			return SupersedeToolIntentsResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SupersedeToolIntentsResult{}, err
	}

	latest, err := l.getRunDB(ctx, request.RunID)
	if err != nil {
		return SupersedeToolIntentsResult{}, err
	}
	result.Run = latest
	result.Checkpoint = Checkpoint{ID: checkpointID, RunID: request.RunID, Sequence: checkpointSequence,
		State: RunStateInterrupted, ConversationCursor: cursor, ProviderState: append(json.RawMessage(nil), providerState...),
		WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), CreatedAt: now}
	// appendMessageTx assigns session sequence internally. Reload the messages
	// after commit so callers receive the authoritative sequence values and
	// encrypted metadata decoding, while preserving the order returned above.
	for index := range result.Messages {
		stored, messageErr := l.getMessageDB(ctx, result.Messages[index].ID)
		if messageErr != nil {
			return SupersedeToolIntentsResult{}, messageErr
		}
		result.Messages[index] = stored
	}
	return result, nil
}
