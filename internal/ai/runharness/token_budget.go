package runharness

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// ReserveTokens durably reserves capacity for one model turn. The reservation
// ID is an idempotency key: retrying the same request never increments the
// run's reserved counter twice.
func (l *Ledger) ReserveTokens(ctx context.Context, request ReserveTokensRequest) (TokenReservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return TokenReservation{}, err
	}
	request.RunID = strings.TrimSpace(request.RunID)
	if request.RunID == "" {
		return TokenReservation{}, errors.New("runId is required")
	}
	if request.Tokens < 0 {
		return TokenReservation{}, errors.New("token reservation cannot be negative")
	}
	if request.ReservationID == "" {
		request.ReservationID = uuid.NewString()
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return TokenReservation{}, err
	}
	defer tx.Rollback()
	// Resolve an existing id before loading the run so a lost response can be
	// retried even after the original caller's revision has advanced.
	if existing, found, lookupErr := l.tokenReservationTx(ctx, tx, request.ReservationID); lookupErr != nil {
		return TokenReservation{}, lookupErr
	} else if found {
		if existing.RunID != request.RunID || (request.Tokens > 0 && existing.ReservedTokens != request.Tokens) {
			return TokenReservation{}, fmt.Errorf("%w: reservation identity conflict", ErrTokenReservation)
		}
		return existing, nil
	}
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return TokenReservation{}, err
	}
	if run.State.Terminal() {
		return TokenReservation{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return TokenReservation{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return TokenReservation{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	if exceedsTokenBudget(run, request.Tokens, 0) {
		return TokenReservation{}, ErrTokenBudgetExceeded
	}
	now := nowUTC()
	if _, err := tx.ExecContext(ctx, `INSERT INTO token_reservations(id,run_id,reserved_tokens,status,created_at) VALUES(?,?,?,?,?)`, request.ReservationID, request.RunID, request.Tokens, "reserved", toNano(now)); err != nil {
		return TokenReservation{}, err
	}
	newRevision := run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	args := []any{run.ReservedTokens + request.Tokens, newRevision, toNano(now), request.RunID, run.Revision}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET reserved_tokens=?,revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return TokenReservation{}, err
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr != nil || affected != 1 {
		if rowsErr != nil {
			return TokenReservation{}, rowsErr
		}
		return TokenReservation{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return TokenReservation{}, err
	}
	return TokenReservation{ID: request.ReservationID, RunID: request.RunID, ReservedTokens: request.Tokens, Status: "reserved", CreatedAt: now, RunRevision: newRevision}, nil
}

// ReserveToken is the singular spelling retained for adapters that model one
// model turn at a time.
func (l *Ledger) ReserveToken(ctx context.Context, request ReserveTokensRequest) (TokenReservation, error) {
	return l.ReserveTokens(ctx, request)
}

// ReconcileTokens replaces a reservation with actual provider usage. The
// reservation is marked reconciled in the same transaction as the run totals;
// duplicate callbacks therefore become no-ops and cannot double-count usage.
func (l *Ledger) ReconcileTokens(ctx context.Context, request ReconcileTokensRequest) (TokenReservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return TokenReservation{}, err
	}
	request.RunID = strings.TrimSpace(request.RunID)
	request.ReservationID = strings.TrimSpace(request.ReservationID)
	if request.RunID == "" || request.ReservationID == "" {
		return TokenReservation{}, errors.New("runId and reservationId are required")
	}
	usage, err := normalizeUsage(request.Usage)
	if err != nil {
		return TokenReservation{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return TokenReservation{}, err
	}
	defer tx.Rollback()
	reservation, found, err := l.tokenReservationTx(ctx, tx, request.ReservationID)
	if err != nil {
		return TokenReservation{}, err
	}
	if !found || reservation.RunID != request.RunID {
		return TokenReservation{}, fmt.Errorf("%w: reservation not found for run", ErrTokenReservation)
	}
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return TokenReservation{}, err
	}
	if reservation.Status != "reserved" {
		// Idempotent replay: return the committed reservation even if the
		// caller retained an old expected revision.
		return reservation, nil
	}
	if run.State.Terminal() {
		return TokenReservation{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return TokenReservation{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return TokenReservation{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	if exceedsTokenBudget(run, -reservation.ReservedTokens, usage.TotalTokens) {
		return TokenReservation{}, ErrTokenBudgetExceeded
	}
	now := nowUTC()
	if _, err := tx.ExecContext(ctx, `UPDATE token_reservations SET prompt_tokens=?,completion_tokens=?,total_tokens=?,status='reconciled',reconciled_at=? WHERE id=? AND status='reserved'`, usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens, toNano(now), request.ReservationID); err != nil {
		return TokenReservation{}, err
	}
	newRevision := run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	args := []any{run.ReservedTokens - reservation.ReservedTokens, run.PromptTokens + usage.PromptTokens, run.CompletionTokens + usage.CompletionTokens, run.TotalTokens + usage.TotalTokens, newRevision, toNano(now), request.RunID, run.Revision}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET reserved_tokens=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return TokenReservation{}, err
	}
	if affected, rowsErr := result.RowsAffected(); rowsErr != nil || affected != 1 {
		if rowsErr != nil {
			return TokenReservation{}, rowsErr
		}
		return TokenReservation{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return TokenReservation{}, err
	}
	reservation.PromptTokens = usage.PromptTokens
	reservation.CompletionTokens = usage.CompletionTokens
	reservation.TotalTokens = usage.TotalTokens
	reservation.Status = "reconciled"
	reservation.ReconciledAt = now
	reservation.RunRevision = newRevision
	return reservation, nil
}

// ReconcileToken is the singular spelling retained for adapters.
func (l *Ledger) ReconcileToken(ctx context.Context, request ReconcileTokensRequest) (TokenReservation, error) {
	return l.ReconcileTokens(ctx, request)
}

func (l *Ledger) GetTokenReservation(ctx context.Context, reservationID string) (TokenReservation, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return TokenReservation{}, err
	}
	reservationID = strings.TrimSpace(reservationID)
	if reservationID == "" {
		return TokenReservation{}, errors.New("reservationId is required")
	}
	reservation, found, err := l.tokenReservationDB(ctx, reservationID)
	if err != nil {
		return TokenReservation{}, err
	}
	if !found {
		return TokenReservation{}, ErrNotFound
	}
	return reservation, nil
}

func (l *Ledger) tokenReservationDB(ctx context.Context, id string) (TokenReservation, bool, error) {
	var runID, status string
	var reserved, prompt, completion, total int
	var committedSequence, committedRevision int64
	var createdAt, reconciledAt int64
	err := l.db.QueryRowContext(ctx, `SELECT run_id,reserved_tokens,prompt_tokens,completion_tokens,total_tokens,status,committed_sequence,committed_revision,created_at,reconciled_at FROM token_reservations WHERE id=?`, id).Scan(&runID, &reserved, &prompt, &completion, &total, &status, &committedSequence, &committedRevision, &createdAt, &reconciledAt)
	if errors.Is(err, sql.ErrNoRows) {
		return TokenReservation{}, false, nil
	}
	if err != nil {
		return TokenReservation{}, false, err
	}
	return TokenReservation{ID: id, RunID: runID, ReservedTokens: reserved, PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, Status: status, CommittedSequence: committedSequence, CommittedRevision: committedRevision, CreatedAt: fromNano(createdAt), ReconciledAt: fromNano(reconciledAt)}, true, nil
}

func (l *Ledger) tokenReservationTx(ctx context.Context, tx *sql.Tx, id string) (TokenReservation, bool, error) {
	var runID, status string
	var reserved, prompt, completion, total int
	var committedSequence, committedRevision int64
	var createdAt, reconciledAt int64
	err := tx.QueryRowContext(ctx, `SELECT run_id,reserved_tokens,prompt_tokens,completion_tokens,total_tokens,status,committed_sequence,committed_revision,created_at,reconciled_at FROM token_reservations WHERE id=?`, id).Scan(&runID, &reserved, &prompt, &completion, &total, &status, &committedSequence, &committedRevision, &createdAt, &reconciledAt)
	if errors.Is(err, sql.ErrNoRows) {
		return TokenReservation{}, false, nil
	}
	if err != nil {
		return TokenReservation{}, false, err
	}
	return TokenReservation{ID: id, RunID: runID, ReservedTokens: reserved, PromptTokens: prompt, CompletionTokens: completion, TotalTokens: total, Status: status, CommittedSequence: committedSequence, CommittedRevision: committedRevision, CreatedAt: fromNano(createdAt), ReconciledAt: fromNano(reconciledAt)}, true, nil
}

func normalizeUsage(usage Usage) (Usage, error) {
	if usage.PromptTokens < 0 || usage.CompletionTokens < 0 || usage.TotalTokens < 0 {
		return Usage{}, errors.New("token usage cannot be negative")
	}
	maxInt := int(^uint(0) >> 1)
	if usage.PromptTokens > maxInt-usage.CompletionTokens {
		return Usage{}, errors.New("token usage overflows integer range")
	}
	minimum := usage.PromptTokens + usage.CompletionTokens
	if usage.TotalTokens == 0 {
		usage.TotalTokens = minimum
	}
	if usage.TotalTokens < minimum {
		return Usage{}, errors.New("total token usage is below prompt plus completion")
	}
	return usage, nil
}

// exceedsTokenBudget checks the post-operation total plus still-held
// reservations. reservedDelta may be negative when a reservation is released.
func exceedsTokenBudget(run RunSnapshot, reservedDelta, usageDelta int) bool {
	if run.Policy.MaxTotalTokens <= 0 {
		return false
	}
	maxInt := int(^uint(0) >> 1)
	if reservedDelta > 0 && run.ReservedTokens > maxInt-reservedDelta {
		return true
	}
	reserved := run.ReservedTokens + reservedDelta
	if reserved < 0 {
		return true
	}
	if usageDelta > 0 && run.TotalTokens > maxInt-usageDelta {
		return true
	}
	total := run.TotalTokens + usageDelta
	if total < 0 || total > run.Policy.MaxTotalTokens {
		return true
	}
	// Avoid total+reserved integer overflow while checking the combined cap.
	return reserved > run.Policy.MaxTotalTokens-total
}
