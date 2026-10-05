package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ControlCancelCommandResult is the durable outcome of attempting to apply a
// claimed cancel command.  A stale command is consumed without being applied;
// when the run is still mutable Event contains the revision_conflict that was
// committed in the same transaction as that tombstone.
type ControlCancelCommandResult struct {
	Run     RunSnapshot
	Event   *RunEvent
	Applied bool
	Stale   bool
}

type claimedControlCommandState struct {
	command ControlCommand
	run     RunSnapshot
}

// loadClaimedControlCommandTx verifies the control-command claim and the run
// owner fence together.  A command claim is intentionally distinct from the
// run lease: an unleased queued run may still be processed by a local
// supervisor, while a leased run requires the command claimant to be its
// current owner.
func (l *Ledger) loadClaimedControlCommandTx(ctx context.Context, tx *sql.Tx, commandID, ownerToken string, now time.Time) (claimedControlCommandState, bool, error) {
	var state claimedControlCommandState
	var action, claimedBy string
	var expectedRevision, createdAt, claimedAt, claimExpiresAt, appliedAt, consumedAt int64
	err := tx.QueryRowContext(ctx, `SELECT run_id,action,expected_revision,created_at,
		COALESCE(claimed_by,''),claimed_at,claim_expires_at,applied_at,consumed_at
		FROM control_commands WHERE id=?`, commandID).
		Scan(&state.command.RunID, &action, &expectedRevision, &createdAt,
			&claimedBy, &claimedAt, &claimExpiresAt, &appliedAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return claimedControlCommandState{}, false, ErrNotFound
	}
	if err != nil {
		return claimedControlCommandState{}, false, err
	}
	state.command.ID = commandID
	state.command.Action = RunControlAction(action)
	state.command.ExpectedRevision = expectedRevision
	state.command.CreatedAt = fromNano(createdAt)
	state.command.ClaimedBy = claimedBy
	state.command.ClaimedAt = fromNano(claimedAt)
	state.command.ClaimExpiresAt = fromNano(claimExpiresAt)
	state.command.AppliedAt = fromNano(appliedAt)
	state.command.ConsumedAt = fromNano(consumedAt)
	run, err := l.getRunTx(ctx, tx, state.command.RunID)
	if err != nil {
		return claimedControlCommandState{}, false, err
	}
	state.run = run
	if appliedAt != 0 || consumedAt != 0 {
		return state, true, nil
	}
	if claimedBy != ownerToken || claimExpiresAt <= toNano(now) {
		return claimedControlCommandState{}, false, ErrControlCommandClaimLost
	}
	// A control claim by itself never authorizes mutation of a leased run.
	// For unleased runs a local durable-command owner is allowed to resolve the
	// command, and ownerCAS below prevents a lease acquired concurrently from
	// being overwritten.
	if strings.TrimSpace(run.ownerToken) != "" &&
		(!ConstantTimeEqual([]byte(run.ownerToken), []byte(ownerToken)) || !run.OwnerExpiresAt.After(now)) {
		return claimedControlCommandState{}, false, ErrLeaseLost
	}
	return state, false, nil
}

func staleControlCommandRevision(command ControlCommand, run RunSnapshot) bool {
	return command.ExpectedRevision <= 0 || command.ExpectedRevision != run.Revision
}

func (l *Ledger) tombstoneClaimedControlCommandTx(ctx context.Context, tx *sql.Tx, command ControlCommand, ownerToken string, now time.Time) error {
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND run_id=? AND applied_at=0 AND consumed_at=0
		AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), command.ID, command.RunID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrControlCommandClaimLost
	}
	return nil
}

func (l *Ledger) markClaimedControlCommandAppliedTx(ctx context.Context, tx *sql.Tx, command ControlCommand, ownerToken string, now time.Time) error {
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET applied_at=?,consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND run_id=? AND applied_at=0 AND consumed_at=0
		AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), toNano(now), command.ID, command.RunID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return ErrControlCommandClaimLost
	}
	return nil
}

// rejectStaleControlCommandTx tombstones a command whose expected revision no
// longer matches the run.  The error event and tombstone share one transaction
// so a late AckCommand cannot convert the rejected action into an applied one.
func (l *Ledger) rejectStaleControlCommandTx(ctx context.Context, tx *sql.Tx, state claimedControlCommandState, ownerToken string, now time.Time) (RunSnapshot, *RunEvent, error) {
	run := state.run
	if run.State.Terminal() {
		if err := l.tombstoneClaimedControlCommandTx(ctx, tx, state.command, ownerToken, now); err != nil {
			return RunSnapshot{}, nil, err
		}
		return run, nil, nil
	}
	sequence := run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	payload, err := json.Marshal(RunErrorEvent{
		Code:      "revision_conflict",
		Message:   fmt.Sprintf("control command revision conflict: expected %d, got %d", state.command.ExpectedRevision, run.Revision),
		Retryable: true,
	})
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	sealed, err := l.sealRaw("events", run.ID, fmt.Sprintf("payload/%d", sequence), payload)
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	if err := l.tombstoneClaimedControlCommandTx(ctx, tx, state.command, ownerToken, now); err != nil {
		return RunSnapshot{}, nil, err
	}
	newRevision := run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(run, ownerToken, now)
	args := []any{newRevision, sequence + 1, toNano(now), run.ID, run.Revision, sequence}
	args = append(args, ownerArgs...)
	updated, err := tx.ExecContext(ctx, `UPDATE runs SET revision=?,next_sequence=?,updated_at=?
		WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, args...)
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	affected, err := updated.RowsAffected()
	if err != nil {
		return RunSnapshot{}, nil, err
	}
	if affected != 1 {
		return RunSnapshot{}, nil, ErrRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`,
		run.ID, sequence, CurrentSchemaVersion, EventRunError, run.State, newRevision, run.Attempt, toNano(now), sealed); err != nil {
		return RunSnapshot{}, nil, err
	}
	run.Revision = newRevision
	run.NextSequence = sequence + 1
	run.UpdatedAt = now
	event := RunEvent{
		SchemaVersion: CurrentSchemaVersion, RunID: run.ID, SessionID: run.SessionID,
		SessionGeneration: run.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: run.Attempt, Timestamp: now, Kind: EventRunError, ResultingState: run.State,
		Payload: append(json.RawMessage(nil), payload...),
	}
	return run, &event, nil
}

// RejectStaleControlCommand checks a claimed command at the consumption
// boundary.  It returns stale=false when the command still targets the exact
// current run revision.  Stale commands are consumed without applying their
// action and produce one typed revision_conflict event while the run remains
// non-terminal.
func (l *Ledger) RejectStaleControlCommand(ctx context.Context, commandID, ownerToken string) (RunEvent, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunEvent{}, false, err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return RunEvent{}, false, errors.New("commandId is required")
	}
	if ownerToken == "" {
		return RunEvent{}, false, errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunEvent{}, false, err
	}
	defer tx.Rollback()
	now := nowUTC()
	state, settled, err := l.loadClaimedControlCommandTx(ctx, tx, commandID, ownerToken, now)
	if err != nil {
		return RunEvent{}, false, err
	}
	if settled || !staleControlCommandRevision(state.command, state.run) {
		if err := tx.Commit(); err != nil {
			return RunEvent{}, false, err
		}
		return RunEvent{}, false, nil
	}
	_, event, err := l.rejectStaleControlCommandTx(ctx, tx, state, ownerToken, now)
	if err != nil {
		return RunEvent{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return RunEvent{}, false, err
	}
	if event == nil {
		return RunEvent{}, true, nil
	}
	return *event, true, nil
}

// ApplyCancelControlCommand transitions a claimed, current-revision cancel
// command to canceling and marks that exact command applied in the same
// transaction.  A caller cancels in-memory work only after this method commits.
func (l *Ledger) ApplyCancelControlCommand(ctx context.Context, commandID, ownerToken string) (ControlCancelCommandResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ControlCancelCommandResult{}, err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return ControlCancelCommandResult{}, errors.New("commandId is required")
	}
	if ownerToken == "" {
		return ControlCancelCommandResult{}, errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	defer tx.Rollback()
	now := nowUTC()
	state, settled, err := l.loadClaimedControlCommandTx(ctx, tx, commandID, ownerToken, now)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	if settled {
		if err := tx.Commit(); err != nil {
			return ControlCancelCommandResult{}, err
		}
		return ControlCancelCommandResult{Run: state.run}, nil
	}
	if state.command.Action != ControlCancel {
		return ControlCancelCommandResult{}, fmt.Errorf("control command %q is not a cancel", state.command.Action)
	}
	if staleControlCommandRevision(state.command, state.run) || state.run.State.Terminal() {
		updated, event, rejectErr := l.rejectStaleControlCommandTx(ctx, tx, state, ownerToken, now)
		if rejectErr != nil {
			return ControlCancelCommandResult{}, rejectErr
		}
		if err := tx.Commit(); err != nil {
			return ControlCancelCommandResult{}, err
		}
		return ControlCancelCommandResult{Run: updated, Event: event, Stale: true}, nil
	}
	if state.run.State == RunStateCanceling {
		if err := l.markClaimedControlCommandAppliedTx(ctx, tx, state.command, ownerToken, now); err != nil {
			return ControlCancelCommandResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return ControlCancelCommandResult{}, err
		}
		return ControlCancelCommandResult{Run: state.run, Applied: true}, nil
	}
	if err := ValidateTransition(state.run.State, RunStateCanceling); err != nil {
		return ControlCancelCommandResult{}, err
	}
	sequence := state.run.NextSequence
	if sequence < 1 {
		sequence = 1
	}
	payload, err := json.Marshal(CheckpointEvent{Sequence: sequence - 1})
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	payload, err = l.enrichCheckpointEventPayloadTx(ctx, tx, state.run, payload)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	sealed, err := l.sealRaw("events", state.run.ID, fmt.Sprintf("payload/%d", sequence), payload)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	newRevision := state.run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(state.run, ownerToken, now)
	args := []any{RunStateCanceling, newRevision, sequence + 1, toNano(now), state.run.ID, state.run.Revision, sequence}
	args = append(args, ownerArgs...)
	updated, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,next_sequence=?,updated_at=?
		WHERE id=? AND revision=? AND next_sequence=?`+ownerPredicate, args...)
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	affected, err := updated.RowsAffected()
	if err != nil {
		return ControlCancelCommandResult{}, err
	}
	if affected != 1 {
		return ControlCancelCommandResult{}, ErrRevisionConflict
	}
	if err := l.markClaimedControlCommandAppliedTx(ctx, tx, state.command, ownerToken, now); err != nil {
		return ControlCancelCommandResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`,
		state.run.ID, sequence, CurrentSchemaVersion, EventCheckpoint, RunStateCanceling, newRevision, state.run.Attempt, toNano(now), sealed); err != nil {
		return ControlCancelCommandResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ControlCancelCommandResult{}, err
	}
	state.run.State = RunStateCanceling
	state.run.Revision = newRevision
	state.run.NextSequence = sequence + 1
	state.run.UpdatedAt = now
	event := RunEvent{
		SchemaVersion: CurrentSchemaVersion, RunID: state.run.ID, SessionID: state.run.SessionID,
		SessionGeneration: state.run.SessionGeneration, Sequence: sequence, RunRevision: newRevision,
		Attempt: state.run.Attempt, Timestamp: now, Kind: EventCheckpoint, ResultingState: RunStateCanceling,
		Payload: append(json.RawMessage(nil), payload...),
	}
	return ControlCancelCommandResult{Run: state.run, Event: &event, Applied: true}, nil
}
