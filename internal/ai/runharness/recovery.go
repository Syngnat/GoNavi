package runharness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// ErrRecoveryUnavailable means that a recovery action cannot be applied to
// the current run (for example, there is no unknown side-effect call to
// resolve, or another owner still holds the run lease).
var ErrRecoveryUnavailable = errors.New("agent run recovery is unavailable")

// RecoveryActionResult contains the durable transition and the event that was
// committed with it. The harness publishes the event after this method
// returns, preserving the ledger-before-transport ordering invariant.
type RecoveryActionResult struct {
	Run    RunSnapshot
	Events []RunEvent
}

// ApplyRecoveryAction resolves an interrupted/recovery-required run in one
// SQLite transaction. In particular, mark_completed updates the unknown tool
// record and the run checkpoint/event atomically; retry advances the attempt so
// a regenerated call ID cannot collide with the old external invocation; abort
// writes a single terminal event with an explicit user decision.
//
// The operation is idempotent for an already terminal run or a run that has
// already reached the action's target state. This matters when a CLI command
// is retried after its response was lost.
func (l *Ledger) ApplyRecoveryAction(ctx context.Context, request RecoveryActionRequest) (RecoveryActionResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RecoveryActionResult{}, err
	}
	if strings.TrimSpace(request.RunID) == "" {
		return RecoveryActionResult{}, errors.New("runId is required")
	}
	if request.Action != ControlResume && request.Action != ControlRecover &&
		request.Action != ControlMarkCompleted && request.Action != ControlAbortRecovery {
		return RecoveryActionResult{}, fmt.Errorf("%w: unsupported action %q", ErrRecoveryUnavailable, request.Action)
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RecoveryActionResult{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return RecoveryActionResult{}, err
	}
	// A public recovery control must be durable together with its transition.
	// Checking the command id before changing the run makes an idempotency-key
	// collision fail closed: it cannot report a conflict after a side-effect
	// recovery decision has already become visible.
	command, priorResult, err := l.prepareRecoveryCommandTx(ctx, tx, request)
	if err != nil {
		return RecoveryActionResult{}, err
	}
	if priorResult != nil {
		if err := tx.Commit(); err != nil {
			return RecoveryActionResult{}, err
		}
		return RecoveryActionResult{Run: *priorResult}, nil
	}
	// A repeated command after a terminal response is a successful no-op. The
	// unique terminal-event index still guarantees that no second terminal can
	// be written by a racing caller.
	if run.State.Terminal() {
		if err := l.insertRecoveryCommandTx(ctx, tx, command, run); err != nil {
			return RecoveryActionResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return RecoveryActionResult{}, err
		}
		return RecoveryActionResult{Run: run}, nil
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return RecoveryActionResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}

	now := nowUTC()
	nowNS := toNano(now)
	// A recovery command may be issued only after the previous owner has
	// released the run. If that owner is still alive, accepting the command here
	// would race its callback and could turn a known result into a duplicate
	// retry. The owner may explicitly act on its own token.
	if strings.TrimSpace(run.ownerToken) != "" && run.OwnerExpiresAt.After(now) {
		if strings.TrimSpace(request.OwnerToken) == "" ||
			!ConstantTimeEqual([]byte(run.ownerToken), []byte(request.OwnerToken)) {
			return RecoveryActionResult{}, ErrLeaseUnavailable
		}
	}

	target := RunStateRunningModel
	newAttempt := run.Attempt
	terminal := false
	switch request.Action {
	case ControlResume:
		if run.State != RunStateInterrupted {
			if run.State == RunStateRunningModel {
				if err := l.insertRecoveryCommandTx(ctx, tx, command, run); err != nil {
					return RecoveryActionResult{}, err
				}
				if err := tx.Commit(); err != nil {
					return RecoveryActionResult{}, err
				}
				return RecoveryActionResult{Run: run}, nil
			}
			return RecoveryActionResult{}, fmt.Errorf("%w: resume requires interrupted, got %s", ErrRecoveryUnavailable, run.State)
		}
		// Resume must return to the state represented by the last durable
		// checkpoint.  Recovery itself writes a marker checkpoint whose state is
		// interrupted/recovery_required; blindly choosing running_model here can
		// skip an awaiting-workspace or running-tool boundary and makes the
		// persisted state machine lie about where execution will continue.
		target, err = l.resumeCheckpointStateTx(ctx, tx, run)
		if err != nil {
			return RecoveryActionResult{}, err
		}
	case ControlRecover:
		if run.State != RunStateRecoveryRequired && run.State != RunStateInterrupted {
			if run.State == RunStateRunningModel {
				if err := l.insertRecoveryCommandTx(ctx, tx, command, run); err != nil {
					return RecoveryActionResult{}, err
				}
				if err := tx.Commit(); err != nil {
					return RecoveryActionResult{}, err
				}
				return RecoveryActionResult{Run: run}, nil
			}
			return RecoveryActionResult{}, fmt.Errorf("%w: retry requires recovery_required or interrupted, got %s", ErrRecoveryUnavailable, run.State)
		}
		newAttempt++
	case ControlMarkCompleted:
		if run.State != RunStateRecoveryRequired {
			if run.State == RunStateRunningModel {
				if err := l.insertRecoveryCommandTx(ctx, tx, command, run); err != nil {
					return RecoveryActionResult{}, err
				}
				if err := tx.Commit(); err != nil {
					return RecoveryActionResult{}, err
				}
				return RecoveryActionResult{Run: run}, nil
			}
			return RecoveryActionResult{}, fmt.Errorf("%w: mark_completed requires recovery_required, got %s", ErrRecoveryUnavailable, run.State)
		}
		if err := markLatestUnknownToolTx(ctx, tx, request.RunID, request.CallID, nowNS); err != nil {
			return RecoveryActionResult{}, err
		}
	case ControlAbortRecovery:
		if run.State != RunStateRecoveryRequired && run.State != RunStateInterrupted {
			if run.State == RunStateFailed || run.State == RunStateCanceled {
				if err := l.insertRecoveryCommandTx(ctx, tx, command, run); err != nil {
					return RecoveryActionResult{}, err
				}
				if err := tx.Commit(); err != nil {
					return RecoveryActionResult{}, err
				}
				return RecoveryActionResult{Run: run}, nil
			}
			return RecoveryActionResult{}, fmt.Errorf("%w: abort requires recovery_required or interrupted, got %s", ErrRecoveryUnavailable, run.State)
		}
		target = RunStateFailed
		terminal = true
	}

	if target != run.State && !CanTransition(run.State, target) {
		return RecoveryActionResult{}, fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, run.State, target)
	}
	// Pending approvals are bound to the previous revision and must not become
	// actionable after any recovery decision.
	if _, err := tx.ExecContext(ctx, `UPDATE approvals SET status='expired',decided_at=? WHERE run_id=? AND status='pending'`, nowNS, request.RunID); err != nil {
		return RecoveryActionResult{}, err
	}

	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	newRevision := run.Revision + 1
	attempt := newAttempt
	if attempt < 1 {
		attempt = 1
	}

	var eventPayload []byte
	checkpointID := run.CheckpointID
	var checkpointBlob, providerBlob, workspaceBlob []byte
	if !terminal {
		checkpointID = uuid.NewString()
		cursor, providerState, workspace, checkpointErr := l.previousCheckpointDataTx(ctx, tx, run)
		if checkpointErr != nil {
			return RecoveryActionResult{}, checkpointErr
		}
		checkpointBlob, err = l.seal("checkpoints", checkpointID, "conversation_cursor", cursor)
		if err != nil {
			return RecoveryActionResult{}, err
		}
		providerBlob, err = l.sealRaw("checkpoints", checkpointID, "provider_state", providerState)
		if err != nil {
			return RecoveryActionResult{}, err
		}
		workspaceBlob, err = l.sealWorkspaceSnapshotReference(checkpointID, workspace)
		if err != nil {
			return RecoveryActionResult{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, request.RunID, sequence, target, checkpointBlob, providerBlob, workspaceBlob, nowNS); err != nil {
			return RecoveryActionResult{}, err
		}
		eventPayload, err = json.Marshal(CheckpointEvent{CheckpointID: checkpointID, Sequence: sequence, RecoveryAction: request.Action, WorkspaceSnapshot: workspace})
		if err != nil {
			return RecoveryActionResult{}, err
		}
	} else {
		eventPayload, err = json.Marshal(TerminalEvent{Reason: "user_aborted_recovery", ErrorCode: "user_aborted_recovery"})
		if err != nil {
			return RecoveryActionResult{}, err
		}
	}
	sealedEvent, err := l.sealRaw("events", request.RunID, fmt.Sprintf("payload/%d", sequence), eventPayload)
	if err != nil {
		return RecoveryActionResult{}, err
	}

	terminalBlob := any(nil)
	terminalReason := ""
	kind := EventCheckpoint
	if terminal {
		terminalReason = "user_aborted_recovery"
		terminalBlob, err = l.seal("runs", request.RunID, "terminal_reason", terminalReason)
		if err != nil {
			return RecoveryActionResult{}, err
		}
		kind = EventTerminal
	}
	ownerPredicate, ownerArgs := recoveryOwnerCAS(run, request.OwnerToken, now)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,attempt=?,terminal_reason=?,checkpoint_id=?,owner_id=NULL,owner_token=NULL,owner_expires_at=0,updated_at=? WHERE id=? AND state=? AND revision=? AND next_sequence=?`+ownerPredicate,
		append([]any{target, newRevision, sequence + 1, attempt, terminalBlob, nullString(checkpointID), toNano(now), request.RunID, run.State, run.Revision, run.NextSequence}, ownerArgs...)...)
	if err != nil {
		return RecoveryActionResult{}, err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return RecoveryActionResult{}, err
		}
		return RecoveryActionResult{}, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, request.RunID, sequence, CurrentSchemaVersion, kind, target, newRevision, attempt, nowNS, sealedEvent); err != nil {
		return RecoveryActionResult{}, err
	}
	if terminal {
		if err := l.discardPendingControlCommandsTx(ctx, tx, request.RunID, nowNS); err != nil {
			return RecoveryActionResult{}, err
		}
	}
	resulting := run
	resulting.State = target
	resulting.Revision = newRevision
	resulting.NextSequence = sequence + 1
	resulting.Attempt = attempt
	resulting.CheckpointID = checkpointID
	resulting.TerminalReason = terminalReason
	resulting.ownerToken = ""
	resulting.OwnerExpiresAt = time.Time{}
	resulting.UpdatedAt = now
	if err := l.insertRecoveryCommandTx(ctx, tx, command, resulting); err != nil {
		return RecoveryActionResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return RecoveryActionResult{}, err
	}
	event := RunEvent{SchemaVersion: CurrentSchemaVersion, RunID: resulting.ID, SessionID: resulting.SessionID,
		SessionGeneration: resulting.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: attempt, Timestamp: now, Kind: kind, ResultingState: target,
		Payload: append(json.RawMessage(nil), eventPayload...)}
	return RecoveryActionResult{Run: resulting, Events: []RunEvent{event}}, nil
}

// RecoveryActionRequest is intentionally separate from RunControlRequest so
// ledger callers cannot accidentally submit arbitrary control commands while
// resolving an unknown side effect.
type RecoveryActionRequest struct {
	RunID            string
	CallID           string
	Action           RunControlAction
	ExpectedRevision int64
	OwnerToken       string `json:"-"`
	// CommandID and CommandPayload are set by the public Harness control path.
	// They bind the audit/wake command to the recovery transition in the same
	// transaction. Direct ledger callers can omit them when no cross-process
	// command needs to be retained.
	CommandID      string
	CommandPayload json.RawMessage `json:"-"`
}

type recoveryCommandMarker struct {
	id      string
	runID   string
	action  RunControlAction
	payload []byte
	sealed  []byte
	created time.Time
}

// prepareRecoveryCommandTx validates an optional public-control marker before
// any run mutation. If the idempotency key is already bound to this exact
// request, the existing transition is authoritative and callers should return
// its immutable receipt without emitting a second event.
func (l *Ledger) prepareRecoveryCommandTx(ctx context.Context, tx *sql.Tx, request RecoveryActionRequest) (*recoveryCommandMarker, *RunSnapshot, error) {
	id := strings.TrimSpace(request.CommandID)
	if id == "" {
		return nil, nil, nil
	}
	payload := bytes.TrimSpace(request.CommandPayload)
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	if !json.Valid(payload) {
		return nil, nil, errors.New("command payload must be valid JSON")
	}

	var existingRunID, existingAction string
	var existingPayload, existingSnapshot []byte
	err := tx.QueryRowContext(ctx, `SELECT run_id,action,payload,result_snapshot FROM control_commands WHERE id=?`, id).
		Scan(&existingRunID, &existingAction, &existingPayload, &existingSnapshot)
	if err == nil {
		plain, openErr := l.openRaw("control_commands", id, "payload", existingPayload)
		if openErr != nil {
			return nil, nil, openErr
		}
		if existingRunID == request.RunID && RunControlAction(existingAction) == request.Action && bytes.Equal(bytes.TrimSpace(plain), payload) {
			if len(existingSnapshot) == 0 {
				// Records produced before result_snapshot was introduced have no
				// immutable receipt. Keep them operable during the additive schema
				// migration, while all newly accepted commands use the stable path.
				latest, getErr := l.getRunTx(ctx, tx, request.RunID)
				if getErr != nil {
					return nil, nil, getErr
				}
				return nil, &latest, nil
			}
			var receipt RunSnapshot
			if openErr := l.openJSON("control_commands", id, "result_snapshot", existingSnapshot, &receipt); openErr != nil {
				return nil, nil, fmt.Errorf("decode recovery control receipt: %w", openErr)
			}
			return nil, &receipt, nil
		}
		return nil, nil, fmt.Errorf("%w: id %q is already bound to run %q/action %q", ErrControlCommandConflict, id, existingRunID, existingAction)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, err
	}
	sealed, err := l.sealRaw("control_commands", id, "payload", payload)
	if err != nil {
		return nil, nil, err
	}
	return &recoveryCommandMarker{id: id, runID: request.RunID, action: request.Action, payload: append([]byte(nil), payload...), sealed: sealed, created: nowUTC()}, nil, nil
}

// insertRecoveryCommandTx persists the public control marker after the target
// run revision is known but before the enclosing recovery transaction commits.
// Its revision intentionally points at the resulting run state. The recovery
// transition itself is the durable action boundary, so the marker is inserted
// already applied/consumed; workers must never replay it as a second state
// transition after a process hand-off.
func (l *Ledger) insertRecoveryCommandTx(ctx context.Context, tx *sql.Tx, command *recoveryCommandMarker, result RunSnapshot) error {
	if command == nil {
		return nil
	}
	// The receipt is encrypted because it carries the complete projection frozen
	// at this command boundary. A retry must never observe a later worker state.
	receipt, err := l.seal("control_commands", command.id, "result_snapshot", result)
	if err != nil {
		return err
	}
	appliedAt := toNano(nowUTC())
	if _, err := tx.ExecContext(ctx, `INSERT INTO control_commands(id,run_id,action,payload,expected_revision,result_snapshot,created_at,consumed_at,claimed_at,claim_expires_at,applied_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, command.id, command.runID, command.action, command.sealed, result.Revision, receipt, toNano(command.created), appliedAt, appliedAt, appliedAt, appliedAt); err != nil {
		return err
	}
	return nil
}

// resumeCheckpointStateTx resolves the execution state represented by the
// checkpoint chain.  RecoverRuns creates a fresh marker checkpoint with state
// interrupted/recovery_required, so walk backwards until the preceding
// executable checkpoint is found.  A missing or malformed chain conservatively
// falls back to running_model, which is the only state that can safely rebuild
// a provider request without replaying a tool.
func (l *Ledger) resumeCheckpointStateTx(ctx context.Context, tx *sql.Tx, run RunSnapshot) (RunState, error) {
	const fallback = RunStateRunningModel
	checkpointID := strings.TrimSpace(run.CheckpointID)
	if checkpointID == "" {
		return fallback, nil
	}
	var currentSequence int64
	var currentState string
	err := tx.QueryRowContext(ctx, `SELECT sequence,state FROM checkpoints WHERE id=?`, checkpointID).Scan(&currentSequence, &currentState)
	if errors.Is(err, sql.ErrNoRows) {
		return fallback, nil
	}
	if err != nil {
		return fallback, err
	}
	if state := resumableCheckpointState(RunState(currentState)); state != "" {
		return state, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT state FROM checkpoints WHERE run_id=? AND sequence<? ORDER BY sequence DESC`, run.ID, currentSequence)
	if err != nil {
		return fallback, err
	}
	defer rows.Close()
	for rows.Next() {
		var state string
		if err := rows.Scan(&state); err != nil {
			return fallback, err
		}
		if resumable := resumableCheckpointState(RunState(state)); resumable != "" {
			return resumable, nil
		}
	}
	if err := rows.Err(); err != nil {
		return fallback, err
	}
	return fallback, nil
}

func resumableCheckpointState(state RunState) RunState {
	switch state {
	case RunStateRunningModel, RunStateRunningTool, RunStateAwaitingApproval, RunStateAwaitingWorkspace:
		return state
	default:
		return ""
	}
}

func recoveryOwnerCAS(run RunSnapshot, token string, now time.Time) (string, []any) {
	if strings.TrimSpace(run.ownerToken) == "" || run.OwnerExpiresAt.IsZero() || !run.OwnerExpiresAt.After(now) {
		return " AND (owner_token IS NULL OR owner_token='' OR owner_expires_at<=?)", []any{toNano(now)}
	}
	return " AND owner_token=? AND owner_expires_at>?", []any{token, toNano(now)}
}

func (l *Ledger) previousCheckpointTx(ctx context.Context, tx *sql.Tx, run RunSnapshot) (string, json.RawMessage, error) {
	cursor, provider, _, err := l.previousCheckpointDataTx(ctx, tx, run)
	return cursor, provider, err
}

func (l *Ledger) previousCheckpointDataTx(ctx context.Context, tx *sql.Tx, run RunSnapshot) (string, json.RawMessage, *WorkspaceSnapshotReference, error) {
	if strings.TrimSpace(run.CheckpointID) == "" {
		return "", nil, nil, nil
	}
	var cursorBlob, providerBlob, workspaceBlob []byte
	err := tx.QueryRowContext(ctx, `SELECT conversation_cursor,provider_state,workspace_snapshot FROM checkpoints WHERE id=?`, run.CheckpointID).Scan(&cursorBlob, &providerBlob, &workspaceBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, nil, nil
	}
	if err != nil {
		return "", nil, nil, err
	}
	var cursor string
	if len(cursorBlob) > 0 {
		if err := l.openJSON("checkpoints", run.CheckpointID, "conversation_cursor", cursorBlob, &cursor); err != nil {
			return "", nil, nil, err
		}
	}
	var provider json.RawMessage
	if len(providerBlob) > 0 {
		var err error
		provider, err = l.openRaw("checkpoints", run.CheckpointID, "provider_state", providerBlob)
		if err != nil {
			return "", nil, nil, err
		}
	}
	workspace, err := l.openWorkspaceSnapshotReference(run.CheckpointID, workspaceBlob)
	if err != nil {
		return "", nil, nil, err
	}
	return cursor, provider, workspace, nil
}

func markLatestUnknownToolTx(ctx context.Context, tx *sql.Tx, runID, requestedCallID string, completedAt int64) error {
	var callID string
	var attempt int
	requestedCallID = strings.TrimSpace(requestedCallID)
	query := `SELECT call_id,attempt FROM tool_calls
		WHERE run_id=? AND effect IN ('side_effect','side_effect_unknown')
		AND (status IN ('started','unknown') OR unknown_outcome<>0)`
	args := []any{runID}
	if requestedCallID != "" {
		query += ` AND call_id=?`
		args = append(args, requestedCallID)
	}
	query += ` ORDER BY attempt DESC,started_at DESC,call_id DESC LIMIT 1`
	err := tx.QueryRowContext(ctx, query, args...).Scan(&callID, &attempt)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: no unknown side-effect tool call", ErrRecoveryUnavailable)
	}
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE tool_calls SET status='completed',unknown_outcome=0,error_code='user_confirmed_completed',completed_at=? WHERE run_id=? AND call_id=? AND attempt=? AND (status IN ('started','unknown') OR unknown_outcome<>0)`, completedAt, runID, callID, attempt)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return fmt.Errorf("%w: unknown tool changed concurrently", ErrRecoveryUnavailable)
	}
	return nil
}
