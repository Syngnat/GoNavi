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

// EnqueueCommand persists a cross-process control command. The owner consumes
// it using DequeueCommands, which atomically marks each command consumed.
func (l *Ledger) EnqueueCommand(ctx context.Context, command ControlCommand) (ControlCommand, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return ControlCommand{}, err
	}
	command.ID = strings.TrimSpace(command.ID)
	command.RunID = strings.TrimSpace(command.RunID)
	command.Action = RunControlAction(strings.TrimSpace(string(command.Action)))
	if command.RunID == "" {
		return ControlCommand{}, errors.New("runId is required")
	}
	if command.Action == "" {
		return ControlCommand{}, errors.New("action is required")
	}
	if command.ID == "" {
		command.ID = uuid.NewString()
	}
	if command.CreatedAt.IsZero() {
		command.CreatedAt = nowUTC()
	}
	payload := command.Payload
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	if !json.Valid(payload) {
		return ControlCommand{}, errors.New("command payload must be valid JSON")
	}
	sealed, err := l.sealRaw("control_commands", command.ID, "payload", payload)
	if err != nil {
		return ControlCommand{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return ControlCommand{}, err
	}
	defer tx.Rollback()
	// Resolve an existing idempotency key before checking the mutable run
	// revision. A retry must return the original command even if the run has
	// advanced since it was first accepted; a different payload/action must be
	// rejected rather than silently swallowed as a SQLite UNIQUE error.
	var existingRunID, existingAction string
	var existingPayload []byte
	var existingExpected, existingCreated, existingConsumed int64
	existingErr := tx.QueryRowContext(ctx, `SELECT run_id,action,payload,expected_revision,created_at,consumed_at FROM control_commands WHERE id=?`, command.ID).
		Scan(&existingRunID, &existingAction, &existingPayload, &existingExpected, &existingCreated, &existingConsumed)
	if existingErr == nil {
		plain, openErr := l.openRaw("control_commands", command.ID, "payload", existingPayload)
		if openErr != nil {
			return ControlCommand{}, openErr
		}
		existing := ControlCommand{ID: command.ID, RunID: existingRunID, Action: RunControlAction(existingAction),
			Payload: plain, ExpectedRevision: existingExpected, CreatedAt: fromNano(existingCreated), ConsumedAt: fromNano(existingConsumed)}
		if existing.RunID == command.RunID && existing.Action == command.Action && existing.ExpectedRevision == command.ExpectedRevision &&
			bytes.Equal(bytes.TrimSpace(existing.Payload), bytes.TrimSpace(payload)) {
			return existing, nil
		}
		return ControlCommand{}, fmt.Errorf("%w: id %q is already bound to run %q/action %q", ErrControlCommandConflict, command.ID, existing.RunID, existing.Action)
	} else if !errors.Is(existingErr, sql.ErrNoRows) {
		return ControlCommand{}, existingErr
	}
	if command.ExpectedRevision <= 0 {
		return ControlCommand{}, fmt.Errorf("%w: expectedRevision must be positive", ErrRevisionConflict)
	}
	var currentRevision int64
	var currentState string
	err = tx.QueryRowContext(ctx, `SELECT revision,state FROM runs WHERE id=?`, command.RunID).Scan(&currentRevision, &currentState)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlCommand{}, ErrNotFound
	}
	if err != nil {
		return ControlCommand{}, err
	}
	if currentRevision != command.ExpectedRevision {
		return ControlCommand{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, command.ExpectedRevision, currentRevision)
	}
	if RunState(currentState).Terminal() {
		return ControlCommand{}, fmt.Errorf("%w: run %q", ErrTerminalRun, command.RunID)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO control_commands(id,run_id,action,payload,expected_revision,created_at) VALUES(?,?,?,?,?,?)`, command.ID, command.RunID, command.Action, sealed, command.ExpectedRevision, toNano(command.CreatedAt)); err != nil {
		return ControlCommand{}, err
	}
	if err := tx.Commit(); err != nil {
		return ControlCommand{}, err
	}
	command.Payload = append(json.RawMessage(nil), payload...)
	return command, nil
}

func (l *Ledger) DequeueCommands(ctx context.Context, runID string, limit int) ([]ControlCommand, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,action,payload,expected_revision,created_at FROM control_commands WHERE run_id=? AND consumed_at=0 ORDER BY created_at LIMIT ?`, runID, limit)
	if err != nil {
		return nil, err
	}
	type item struct {
		id, action        string
		payload           []byte
		expected, created int64
	}
	var items []item
	for rows.Next() {
		var x item
		if err := rows.Scan(&x.id, &x.action, &x.payload, &x.expected, &x.created); err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, x)
	}
	rows.Close()
	now := toNano(nowUTC())
	out := make([]ControlCommand, 0, len(items))
	for _, x := range items {
		payload, err := l.openRaw("control_commands", x.id, "payload", x.payload)
		if err != nil {
			return nil, err
		}
		result, err := tx.ExecContext(ctx, `UPDATE control_commands SET consumed_at=? WHERE id=? AND consumed_at=0`, now, x.id)
		if err != nil {
			return nil, err
		}
		// A second supervisor may have selected the same row before the write
		// lock was acquired (for example when using a legacy/non-immediate
		// SQLite DSN). Only return commands this transaction actually claimed.
		if affected, err := result.RowsAffected(); err != nil {
			return nil, err
		} else if affected != 1 {
			continue
		}
		out = append(out, ControlCommand{ID: x.id, RunID: runID, Action: RunControlAction(x.action), Payload: payload, ExpectedRevision: x.expected, CreatedAt: fromNano(x.created), ConsumedAt: fromNano(now)})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// ClaimCommands leases control commands to one supervisor without marking
// them consumed. The lease is deliberately separate from application: if a
// worker crashes after this method returns, a later owner can reclaim the row
// once the claim expires and safely decide whether the durable action already
// happened. Commands claimed by the same owner are returned again (with a
// renewed lease), which lets a long-running action survive a polling cycle.
func (l *Ledger) ClaimCommands(ctx context.Context, runID, ownerToken string, limit int, leaseTTL time.Duration) ([]ControlCommand, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	runID = strings.TrimSpace(runID)
	ownerToken = strings.TrimSpace(ownerToken)
	if runID == "" {
		return nil, errors.New("runId is required")
	}
	if ownerToken == "" {
		return nil, errors.New("ownerToken is required")
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	if leaseTTL <= 0 {
		leaseTTL = defaultLeaseDuration
	}
	now := nowUTC()
	nowNS := toNano(now)
	expires := now.Add(leaseTTL)
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT id,action,payload,expected_revision,created_at,
		COALESCE(claimed_by,''),claimed_at,claim_expires_at,applied_at,consumed_at
		FROM control_commands
		WHERE run_id=? AND consumed_at=0 AND applied_at=0
		AND (COALESCE(claimed_by,'')='' OR claim_expires_at<=? OR claimed_by=?)
		ORDER BY created_at,id LIMIT ?`, runID, nowNS, ownerToken, limit)
	if err != nil {
		return nil, err
	}
	type commandRow struct {
		id, action, claimedBy string
		payload               []byte
		expected, created     int64
		claimedAt, expires    int64
		applied, consumed     int64
	}
	rowsData := make([]commandRow, 0, limit)
	for rows.Next() {
		var row commandRow
		if err := rows.Scan(&row.id, &row.action, &row.payload, &row.expected, &row.created,
			&row.claimedBy, &row.claimedAt, &row.expires, &row.applied, &row.consumed); err != nil {
			rows.Close()
			return nil, err
		}
		rowsData = append(rowsData, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := make([]ControlCommand, 0, len(rowsData))
	for _, row := range rowsData {
		// The conditional update is the fencing point. It protects against a
		// second supervisor that selected the same expired row before this
		// transaction acquired SQLite's write lock.
		result, err := tx.ExecContext(ctx, `UPDATE control_commands
			SET claimed_by=?,claimed_at=?,claim_expires_at=?
			WHERE id=? AND consumed_at=0 AND applied_at=0
			AND (COALESCE(claimed_by,'')='' OR claim_expires_at<=? OR claimed_by=?)`,
			ownerToken, nowNS, toNano(expires), row.id, nowNS, ownerToken)
		if err != nil {
			return nil, err
		}
		affected, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		if affected != 1 {
			continue
		}
		payload, err := l.openRaw("control_commands", row.id, "payload", row.payload)
		if err != nil {
			return nil, err
		}
		out = append(out, ControlCommand{
			ID: row.id, RunID: runID, Action: RunControlAction(row.action), Payload: payload,
			ExpectedRevision: row.expected, CreatedAt: fromNano(row.created),
			ClaimedBy: ownerToken, ClaimedAt: now, ClaimExpiresAt: expires,
			AppliedAt: fromNano(row.applied), ConsumedAt: fromNano(row.consumed),
		})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// AckCommand durably marks a claimed command as applied. Only the current
// claim owner may acknowledge an unapplied row; an expired/fenced owner gets a
// stable claim-loss error and must not report the command as completed.
func (l *Ledger) AckCommand(ctx context.Context, commandID, ownerToken string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return errors.New("commandId is required")
	}
	if ownerToken == "" {
		return errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var claimedBy string
	var claimExpires, applied, consumed int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(claimed_by,''),claim_expires_at,applied_at,consumed_at FROM control_commands WHERE id=?`, commandID).
		Scan(&claimedBy, &claimExpires, &applied, &consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	// A duplicate acknowledgement is intentionally idempotent, even if it is
	// received by a process that no longer owns the (already applied) claim.
	if applied != 0 {
		return nil
	}
	// A terminal transition can consume a previously claimed command before its
	// worker reaches this acknowledgement. Leave applied_at at zero: the action
	// was superseded by the terminal boundary and must not be recorded as having
	// executed merely because a delayed callback arrived.
	if consumed != 0 {
		return nil
	}
	now := nowUTC()
	if claimedBy != ownerToken || claimExpires <= toNano(now) {
		return ErrControlCommandClaimLost
	}
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET applied_at=?,consumed_at=?
		WHERE id=? AND applied_at=0 AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), toNano(now), commandID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		// If another owner applied it between the read and update, the operation
		// is still an idempotent success. Otherwise the fence was lost.
		var appliedAfter int64
		if scanErr := tx.QueryRowContext(ctx, `SELECT applied_at FROM control_commands WHERE id=?`, commandID).Scan(&appliedAfter); scanErr == nil && appliedAfter != 0 {
			if commitErr := tx.Commit(); commitErr != nil {
				return commitErr
			}
			return nil
		}
		return ErrControlCommandClaimLost
	}
	return tx.Commit()
}

// TombstoneCommand consumes a claimed command without recording it as applied.
// This is used when its expected revision lost a durable race, so the audit
// trail distinguishes a rejected stale request from an executed action.
func (l *Ledger) TombstoneCommand(ctx context.Context, commandID, ownerToken string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	commandID = strings.TrimSpace(commandID)
	ownerToken = strings.TrimSpace(ownerToken)
	if commandID == "" {
		return errors.New("commandId is required")
	}
	if ownerToken == "" {
		return errors.New("ownerToken is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var claimedBy string
	var claimExpires, applied, consumed int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(claimed_by,''),claim_expires_at,applied_at,consumed_at FROM control_commands WHERE id=?`, commandID).
		Scan(&claimedBy, &claimExpires, &applied, &consumed)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if consumed != 0 || applied != 0 {
		return nil
	}
	now := nowUTC()
	if claimedBy != ownerToken || claimExpires <= toNano(now) {
		return ErrControlCommandClaimLost
	}
	result, err := tx.ExecContext(ctx, `UPDATE control_commands
		SET consumed_at=?,claimed_by=NULL,claimed_at=0,claim_expires_at=0
		WHERE id=? AND applied_at=0 AND consumed_at=0 AND claimed_by=? AND claim_expires_at>?`,
		toNano(now), commandID, ownerToken, toNano(now))
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return err
	} else if affected != 1 {
		return ErrControlCommandClaimLost
	}
	return tx.Commit()
}
