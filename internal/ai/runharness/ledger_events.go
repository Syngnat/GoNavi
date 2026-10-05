package runharness

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// TransitionRun performs a compare-and-swap non-terminal state transition.
// Terminal state changes must use AppendEvent with EventTerminal so every run
// has one durable terminal event written in the same transaction.
func (l *Ledger) TransitionRun(ctx context.Context, runID string, from, to RunState, expectedRevision int64, ownerToken string) (RunSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	if err := ValidateTransition(from, to); err != nil {
		return RunSnapshot{}, err
	}
	if to.Terminal() {
		return RunSnapshot{}, fmt.Errorf("%w: terminal state %s requires %s", ErrInvalidTransition, to, EventTerminal)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunSnapshot{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return RunSnapshot{}, err
	}
	if run.State != from {
		return RunSnapshot{}, fmt.Errorf("%w: expected state %s, got %s", ErrRevisionConflict, from, run.State)
	}
	if expectedRevision > 0 && run.Revision != expectedRevision {
		return RunSnapshot{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, expectedRevision, run.Revision)
	}
	if err := verifyOwner(run, ownerToken); err != nil {
		return RunSnapshot{}, err
	}
	nextRevision := run.Revision + 1
	now := nowUTC()
	ownerPredicate, ownerArgs := ownerCAS(run, ownerToken, now)
	args := []any{to, nextRevision, nil, toNano(now), runID, from, run.Revision}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,terminal_reason=?,updated_at=? WHERE id=? AND state=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return RunSnapshot{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return RunSnapshot{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, runID)
}

func verifyOwner(run RunSnapshot, token string) error {
	// An unleased run can be manipulated by a single-process caller without a
	// token. Once a lease exists, however, *every* mutating operation must carry
	// the current fencing token, including an empty-token attempt. This prevents
	// a stale owner or a second process from writing after ownership changes.
	if strings.TrimSpace(run.ownerToken) == "" {
		if strings.TrimSpace(token) != "" {
			return ErrLeaseLost
		}
		return nil
	}
	if strings.TrimSpace(token) == "" ||
		!ConstantTimeEqual([]byte(run.ownerToken), []byte(token)) ||
		(!run.OwnerExpiresAt.IsZero() && !run.OwnerExpiresAt.After(nowUTC())) {
		return ErrLeaseLost
	}
	return nil
}

// ownerCAS adds the lease fence to a mutating UPDATE.  verifyOwner performs
// the friendly error check, but that check alone is not sufficient across
// processes: another supervisor can replace the lease between the read and
// the UPDATE.  Keeping the owner predicate in the same SQLite CAS closes that
// race.  Unleased runs deliberately require an empty owner token so a caller
// cannot accidentally mutate a run after a lease was acquired.
func ownerCAS(run RunSnapshot, token string, now time.Time) (string, []any) {
	if strings.TrimSpace(run.ownerToken) == "" {
		return " AND (owner_token IS NULL OR owner_token='')", nil
	}
	return " AND owner_token=? AND owner_expires_at>?", []any{token, toNano(now)}
}

// AppendEvent persists an event before returning it to the caller for
// publication. Sequence and run revision are allocated transactionally.
func (l *Ledger) AppendEvent(ctx context.Context, request AppendEventRequest) (RunEvent, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunEvent{}, err
	}
	if strings.TrimSpace(request.RunID) == "" {
		return RunEvent{}, errors.New("runId is required")
	}
	if !validEventKind(request.Kind) {
		return RunEvent{}, fmt.Errorf("unknown event kind %q", request.Kind)
	}
	if !request.ResultingState.Valid() {
		return RunEvent{}, fmt.Errorf("unknown resulting state %q", request.ResultingState)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunEvent{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return RunEvent{}, err
	}
	if run.State.Terminal() {
		return RunEvent{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return RunEvent{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return RunEvent{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	sequence := run.NextSequence
	if request.ExpectedSequence > 0 && request.ExpectedSequence != sequence {
		return RunEvent{}, fmt.Errorf("%w: expected %d, got %d", ErrSequenceConflict, request.ExpectedSequence, sequence)
	}
	state := request.ResultingState
	if state == "" {
		state = run.State
	}
	if state != run.State {
		if err := ValidateTransition(run.State, state); err != nil {
			return RunEvent{}, err
		}
	}
	if request.Kind == EventTerminal && !state.Terminal() {
		return RunEvent{}, errors.New("terminal event must result in a terminal state")
	}
	if request.Kind != EventTerminal && state.Terminal() {
		return RunEvent{}, errors.New("non-terminal event cannot result in a terminal state")
	}
	attempt := request.Attempt
	if attempt <= 0 {
		attempt = run.Attempt
	}
	payload := request.PayloadJSON
	if len(payload) == 0 {
		if request.Payload == nil {
			payload = []byte(`{}`)
		} else {
			payload, err = json.Marshal(request.Payload)
			if err != nil {
				return RunEvent{}, fmt.Errorf("marshal event payload: %w", err)
			}
		}
	}
	if !json.Valid(payload) {
		return RunEvent{}, errors.New("event payload must be valid JSON")
	}
	if request.Kind == EventCheckpoint {
		payload, err = l.enrichCheckpointEventPayloadTx(ctx, tx, run, payload)
		if err != nil {
			return RunEvent{}, err
		}
	}
	newRevision := run.Revision + 1
	sealed, err := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), payload)
	if err != nil {
		return RunEvent{}, err
	}
	now := nowUTC()
	terminalReason := any(nil)
	if state.Terminal() {
		reason := strings.TrimSpace(request.TerminalReason)
		if reason == "" {
			reason = run.TerminalReason
		}
		if reason != "" {
			terminalReason, err = l.seal("runs", request.RunID, "terminal_reason", reason)
			if err != nil {
				return RunEvent{}, err
			}
		}
	}
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	args := []any{state, newRevision, sequence + 1, attempt, terminalReason, toNano(now), request.RunID, run.Revision, sequence}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,attempt=?,terminal_reason=?,updated_at=? WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, args...)
	if err != nil {
		return RunEvent{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return RunEvent{}, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, sequence, CurrentSchemaVersion, request.Kind, state, newRevision, attempt, toNano(now), sealed); err != nil {
		return RunEvent{}, err
	}
	if state.Terminal() {
		if err := l.markTerminalControlCommandAppliedTx(ctx, tx, request.RunID, request.AppliedControlCommandID, toNano(now)); err != nil {
			return RunEvent{}, err
		}
		if err := l.discardPendingControlCommandsTx(ctx, tx, request.RunID, toNano(now)); err != nil {
			return RunEvent{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return RunEvent{}, err
	}
	return RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: run.ID, SessionID: run.SessionID,
		SessionGeneration: run.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: attempt, Timestamp: now, Kind: request.Kind, ResultingState: state,
		Payload: append(json.RawMessage(nil), payload...)}, nil
}

// discardPendingControlCommandsTx makes commands that lost a terminal race
// non-replayable without claiming that their actions executed. It runs in the
// same transaction as the terminal state/event, so an enqueue either lands
// before this boundary and is discarded or observes the terminal run and is
// rejected.
func (l *Ledger) discardPendingControlCommandsTx(ctx context.Context, tx *sql.Tx, runID string, consumedAt int64) error {
	_, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE run_id=? AND consumed_at=0 AND applied_at=0`, consumedAt, runID)
	return err
}

// markTerminalControlCommandAppliedTx records a synchronous control action
// together with the terminal state it caused. Unlike a delayed command that
// loses the terminal race, this command did execute and must remain auditable
// as such. The run/action boundary is fenced by the surrounding transaction.
func (l *Ledger) markTerminalControlCommandAppliedTx(ctx context.Context, tx *sql.Tx, runID, commandID string, appliedAt int64) error {
	commandID = strings.TrimSpace(commandID)
	if commandID == "" {
		return nil
	}
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET applied_at=?,consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND run_id=? AND applied_at=0 AND consumed_at=0`, appliedAt, appliedAt, commandID, runID)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return fmt.Errorf("%w: control command %q cannot be applied with terminal run", ErrControlCommandClaimLost, commandID)
	}
	return nil
}

// enrichCheckpointEventPayloadTx carries the last durable workspace
// reference onto state-only checkpoint events (interrupt, workspace wait,
// cancel, and recovery transitions). Atomic model/tool commits provide their
// own reference explicitly; this helper keeps the generic AppendEvent seam
// consistent for all other checkpoint events.
func (l *Ledger) enrichCheckpointEventPayloadTx(ctx context.Context, tx *sql.Tx, run RunSnapshot, payload []byte) ([]byte, error) {
	var event CheckpointEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return payload, nil
	}
	if event.WorkspaceSnapshot != nil {
		if !event.WorkspaceSnapshot.valid() {
			return nil, errors.New("workspace snapshot reference is incomplete")
		}
		return payload, nil
	}
	if strings.TrimSpace(run.CheckpointID) == "" {
		return payload, nil
	}
	var sealed []byte
	err := tx.QueryRowContext(ctx, `SELECT workspace_snapshot FROM checkpoints WHERE id=?`, run.CheckpointID).Scan(&sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return payload, nil
	}
	if err != nil {
		return nil, err
	}
	workspace, err := l.openWorkspaceSnapshotReference(run.CheckpointID, sealed)
	if err != nil {
		return nil, err
	}
	if workspace == nil {
		return payload, nil
	}
	event.WorkspaceSnapshot = workspace
	enriched, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	return enriched, nil
}

func (l *Ledger) ReadRun(ctx context.Context, request RunReadRequest) (RunReadResult, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunReadResult{}, err
	}
	run, err := l.getRunDB(ctx, request.RunID)
	if err != nil {
		return RunReadResult{}, err
	}
	limit := request.Limit
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := l.db.QueryContext(ctx, `SELECT sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?`, request.RunID, request.AfterSequence, limit+1)
	if err != nil {
		return RunReadResult{}, err
	}
	defer rows.Close()
	result := RunReadResult{Run: run}
	for rows.Next() {
		if len(result.Events) >= limit {
			result.HasMore = true
			break
		}
		var sequence int64
		var schema, revision, attempt, timestamp int64
		var kind, state string
		var sealed []byte
		if err := rows.Scan(&sequence, &schema, &kind, &state, &revision, &attempt, &timestamp, &sealed); err != nil {
			return RunReadResult{}, err
		}
		payload, err := l.openRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), sealed)
		if err != nil {
			return RunReadResult{}, err
		}
		result.Events = append(result.Events, RunEvent{SchemaVersion: int(schema), RunID: request.RunID, SessionID: run.SessionID,
			SessionGeneration: run.SessionGeneration, Sequence: sequence, RunRevision: revision, Attempt: int(attempt), Timestamp: fromNano(timestamp), Kind: EventKind(kind), ResultingState: RunState(state), Payload: payload})
	}
	if err := rows.Err(); err != nil {
		return RunReadResult{}, err
	}
	result.NextSequence = run.NextSequence
	return result, nil
}

func (l *Ledger) ListEvents(ctx context.Context, runID string, afterSequence int64, limit int) ([]RunEvent, error) {
	result, err := l.ReadRun(ctx, RunReadRequest{RunID: runID, AfterSequence: afterSequence, Limit: limit})
	return result.Events, err
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
