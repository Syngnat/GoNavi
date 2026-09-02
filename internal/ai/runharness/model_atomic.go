package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// CommitModelTurn atomically commits the durable result of one provider turn.
// Assistant content, typed model/usage/checkpoint events, provider state,
// token reconciliation, and the run revision are all part of one SQLite
// transaction. A failed write therefore cannot leave a tool-call-shaped
// assistant message without its matching model event or checkpoint.
func (l *Ledger) CommitModelTurn(ctx context.Context, request CommitModelTurnRequest) (CommitModelTurnResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return CommitModelTurnResult{}, err
	}
	request.RunID = strings.TrimSpace(request.RunID)
	if request.RunID == "" {
		return CommitModelTurnResult{}, errors.New("runId is required")
	}
	request.ReservationID = strings.TrimSpace(request.ReservationID)
	target := request.ResultingState
	if target == "" {
		target = RunStateRunningModel
	}

	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return CommitModelTurnResult{}, err
	}

	reservation, reservationFound := TokenReservation{}, false
	if request.ReservationID != "" {
		reservation, reservationFound, err = l.tokenReservationTx(ctx, tx, request.ReservationID)
		if err != nil {
			return CommitModelTurnResult{}, err
		}
		if !reservationFound || reservation.RunID != request.RunID {
			return CommitModelTurnResult{}, fmt.Errorf("%w: reservation not found for run", ErrTokenReservation)
		}
		if reservation.Status != "reserved" {
			// A reservation carrying a committed sequence is the idempotency
			// marker for a turn that already crossed this boundary. Do not append
			// another assistant message or event on a retried callback.
			if reservation.CommittedSequence > 0 {
				// This check intentionally precedes terminal, owner, revision, and
				// payload validation. A provider callback can arrive after the
				// worker released its lease or after a later step made the run
				// terminal; the committed reservation is the durable proof that
				// this exact turn already crossed the write boundary.
				return CommitModelTurnResult{Run: run, AlreadyCommitted: true}, nil
			}
			// Reconciliation may have been performed separately (for example
			// when a provider failed after reporting usage). In that case the
			// counters are already reflected in the run and this commit only
			// writes the conversation/event boundary.
		}
	}

	usageInput := request.ModelCompleted.Usage
	if request.Usage.PromptTokens != 0 || request.Usage.CompletionTokens != 0 || request.Usage.TotalTokens != 0 {
		usageInput = request.Usage
	}
	usage, err := normalizeUsage(usageInput)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	request.ModelCompleted.Usage = usage
	if !target.Valid() || target.Terminal() {
		return CommitModelTurnResult{}, fmt.Errorf("model turn resulting state must be non-terminal, got %q", target)
	}
	if run.State.Terminal() {
		return CommitModelTurnResult{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return CommitModelTurnResult{}, err
	}
	if target != run.State {
		if err := ValidateTransition(run.State, target); err != nil {
			return CommitModelTurnResult{}, err
		}
	}
	if !reservationFound && exceedsTokenBudget(run, 0, usage.TotalTokens) {
		return CommitModelTurnResult{}, ErrTokenBudgetExceeded
	}
	// Check the CAS only after the idempotent reservation marker has been
	// inspected. A retried callback may legitimately carry the pre-commit
	// revision; it must still observe AlreadyCommitted rather than append again.
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return CommitModelTurnResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	reservedAfter := run.ReservedTokens
	promptAfter := run.PromptTokens
	completionAfter := run.CompletionTokens
	totalAfter := run.TotalTokens
	if reservationFound && reservation.Status == "reserved" {
		if exceedsTokenBudget(run, -reservation.ReservedTokens, usage.TotalTokens) {
			return CommitModelTurnResult{}, ErrTokenBudgetExceeded
		}
		reservedAfter -= reservation.ReservedTokens
		promptAfter += usage.PromptTokens
		completionAfter += usage.CompletionTokens
		totalAfter += usage.TotalTokens
	} else if !reservationFound || reservation.CommittedSequence == 0 {
		// No reservation, or a separately reconciled reservation: only the
		// former needs a usage increment. The latter already updated counters.
		if !reservationFound {
			promptAfter += usage.PromptTokens
			completionAfter += usage.CompletionTokens
			totalAfter += usage.TotalTokens
		}
	}
	if reservedAfter < 0 || promptAfter < 0 || completionAfter < 0 || totalAfter < 0 {
		return CommitModelTurnResult{}, fmt.Errorf("%w: token counter overflow", ErrTokenBudgetExceeded)
	}
	if run.Policy.MaxTotalTokens > 0 && totalAfter+reservedAfter > run.Policy.MaxTotalTokens {
		return CommitModelTurnResult{}, ErrTokenBudgetExceeded
	}

	now := nowUTC()
	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	newRevision := run.Revision + 1
	events := make([]RunEvent, 0, 3)
	sealedEvents := make([]struct {
		sequence int64
		kind     EventKind
		payload  []byte
		sealed   []byte
	}, 0, 3)
	appendEvent := func(seq int64, kind EventKind, payload any) error {
		raw, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			return marshalErr
		}
		sealed, sealErr := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", seq), raw)
		if sealErr != nil {
			return sealErr
		}
		sealedEvents = append(sealedEvents, struct {
			sequence int64
			kind     EventKind
			payload  []byte
			sealed   []byte
		}{seq, kind, raw, sealed})
		events = append(events, RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: run.ID, SessionID: run.SessionID,
			SessionGeneration: run.SessionGeneration, Sequence: seq, RunRevision: newRevision,
			Attempt: run.Attempt, Timestamp: now, Kind: kind, ResultingState: target,
			Payload: append(json.RawMessage(nil), raw...)})
		return nil
	}
	if err := appendEvent(sequence, EventModelCompleted, request.ModelCompleted); err != nil {
		return CommitModelTurnResult{}, err
	}
	sequence++
	if usage.TotalTokens > 0 {
		if err := appendEvent(sequence, EventUsage, UsageEvent{Usage: usage}); err != nil {
			return CommitModelTurnResult{}, err
		}
		sequence++
	}
	checkpointID := uuid.NewString()
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	if workspace == nil {
		_, _, inherited, previousErr := l.previousCheckpointDataTx(ctx, tx, run)
		if previousErr != nil {
			return CommitModelTurnResult{}, previousErr
		}
		workspace = inherited
	}
	if err := appendEvent(sequence, EventCheckpoint, CheckpointEvent{CheckpointID: checkpointID, Sequence: sequence, WorkspaceSnapshot: workspace}); err != nil {
		return CommitModelTurnResult{}, err
	}
	checkpointSequence := sequence
	checkpointCursor := request.ConversationCursor
	cursorBlob, err := l.seal("checkpoints", checkpointID, "conversation_cursor", checkpointCursor)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	providerBlob, err := l.sealRaw("checkpoints", checkpointID, "provider_state", request.ProviderState)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	workspaceBlob, err := l.sealWorkspaceSnapshotReference(checkpointID, workspace)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, request.RunID, checkpointSequence, target, cursorBlob, providerBlob, workspaceBlob, toNano(now)); err != nil {
		return CommitModelTurnResult{}, err
	}

	var storedMessage *Message
	if request.AssistantMessage != nil {
		message := *request.AssistantMessage
		message.SessionID = run.SessionID
		message.RunID = run.ID
		message.Role = "assistant"
		if message.ID == "" {
			message.ID = uuid.NewString()
		}
		if message.CreatedAt.IsZero() {
			message.CreatedAt = now
		} else {
			message.CreatedAt = message.CreatedAt.UTC()
		}
		if message.Sequence <= 0 {
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence),0)+1 FROM messages WHERE session_id=?`, run.SessionID).Scan(&message.Sequence); err != nil {
				return CommitModelTurnResult{}, err
			}
		}
		if err := l.appendMessageTx(ctx, tx, message); err != nil {
			return CommitModelTurnResult{}, err
		}
		stored := message
		storedMessage = &stored
	}

	// Mark the reservation reconciled only after every encrypted payload has
	// been prepared. Its commit sequence/revision makes a lost response safe to
	// retry without replaying the assistant message.
	if reservationFound && reservation.Status == "reserved" {
		if _, err := tx.ExecContext(ctx, `UPDATE token_reservations SET prompt_tokens=?,completion_tokens=?,total_tokens=?,status='reconciled',committed_sequence=?,committed_revision=?,reconciled_at=? WHERE id=? AND status='reserved'`, usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens, events[0].Sequence, newRevision, toNano(now), reservation.ID); err != nil {
			return CommitModelTurnResult{}, err
		}
	} else if reservationFound && reservation.Status == "reconciled" && reservation.CommittedSequence == 0 {
		// A separate ReconcileTokens call may have recorded usage before the
		// model response was persisted. Promote that row to the commit marker so
		// a later callback cannot create a second conversation turn.
		if _, err := tx.ExecContext(ctx, `UPDATE token_reservations SET committed_sequence=?,committed_revision=? WHERE id=? AND status='reconciled' AND committed_sequence=0`, events[0].Sequence, newRevision, reservation.ID); err != nil {
			return CommitModelTurnResult{}, err
		}
	}

	nextSequence := checkpointSequence + 1
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	runArgs := []any{target, newRevision, nextSequence, checkpointID, promptAfter, completionAfter, totalAfter, reservedAfter, toNano(now), request.RunID, run.Revision, run.NextSequence}
	runArgs = append(runArgs, ownerArgs...)
	runUpdate, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,checkpoint_id=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,reserved_tokens=?,updated_at=? WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, runArgs...)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	if affected, rowsErr := runUpdate.RowsAffected(); rowsErr != nil || affected != 1 {
		if rowsErr != nil {
			return CommitModelTurnResult{}, rowsErr
		}
		return CommitModelTurnResult{}, ErrRevisionConflict
	}
	for _, event := range sealedEvents {
		if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, event.sequence, CurrentSchemaVersion, event.kind, target, newRevision, run.Attempt, toNano(now), event.sealed); err != nil {
			return CommitModelTurnResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return CommitModelTurnResult{}, err
	}
	latest, err := l.getRunDB(ctx, request.RunID)
	if err != nil {
		return CommitModelTurnResult{}, err
	}
	checkpoint := Checkpoint{ID: checkpointID, RunID: request.RunID, Sequence: checkpointSequence, State: target,
		ConversationCursor: checkpointCursor, ProviderState: append(json.RawMessage(nil), request.ProviderState...), WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), CreatedAt: now}
	return CommitModelTurnResult{Run: latest, Events: events, Checkpoint: checkpoint, Message: storedMessage}, nil
}
