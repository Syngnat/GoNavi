package runharness

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

// AcquireLease obtains a fencing token for a run. A live lease owned by a
// different process is never stolen; callers must wait until it expires or
// explicitly recover the run after a restart.
func (l *Ledger) AcquireLease(ctx context.Context, runID, ownerID string, ttl time.Duration) (Lease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Lease{}, err
	}
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return Lease{}, errors.New("ownerId is required")
	}
	if ttl <= 0 {
		ttl = defaultLeaseDuration
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return Lease{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return Lease{}, err
	}
	if run.State.Terminal() {
		return Lease{}, ErrTerminalRun
	}
	now := nowUTC()
	var currentOwner, currentToken string
	var expiry int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(owner_id,''),COALESCE(owner_token,''),owner_expires_at FROM runs WHERE id=?`, runID).Scan(&currentOwner, &currentToken, &expiry); err != nil {
		return Lease{}, err
	}
	if currentOwner != "" && currentOwner != ownerID && expiry > toNano(now) {
		return Lease{}, ErrLeaseUnavailable
	}
	token := currentToken
	if currentOwner != ownerID || expiry <= toNano(now) || token == "" {
		token = uuid.NewString()
	}
	expires := now.Add(ttl)
	newRevision := run.Revision + 1
	result, err := tx.ExecContext(ctx, `UPDATE runs SET owner_id=?,owner_token=?,owner_expires_at=?,revision=?,updated_at=? WHERE id=? AND revision=?`, ownerID, token, toNano(expires), newRevision, toNano(now), runID, run.Revision)
	if err != nil {
		return Lease{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return Lease{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return Lease{}, err
	}
	return Lease{RunID: runID, OwnerID: ownerID, Token: token, ExpiresAt: expires}, nil
}

func (l *Ledger) RenewLease(ctx context.Context, lease Lease, ttl time.Duration) (Lease, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Lease{}, err
	}
	if lease.RunID == "" || lease.OwnerID == "" || lease.Token == "" {
		return Lease{}, errors.New("runId, ownerId and token are required")
	}
	if ttl <= 0 {
		ttl = defaultLeaseDuration
	}
	now := nowUTC()
	expires := now.Add(ttl)
	result, err := l.db.ExecContext(ctx, `UPDATE runs SET owner_expires_at=?,updated_at=? WHERE id=? AND owner_id=? AND owner_token=? AND owner_expires_at>? AND state NOT IN ('completed','failed','canceled','exhausted')`, toNano(expires), toNano(now), lease.RunID, lease.OwnerID, lease.Token, toNano(now))
	if err != nil {
		return Lease{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return Lease{}, ErrLeaseLost
	}
	lease.ExpiresAt = expires
	return lease, nil
}

func (l *Ledger) ReleaseLease(ctx context.Context, lease Lease) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	if lease.RunID == "" || lease.OwnerID == "" || lease.Token == "" {
		return errors.New("runId, ownerId and token are required")
	}
	result, err := l.db.ExecContext(ctx, `UPDATE runs SET owner_id=NULL,owner_token=NULL,owner_expires_at=0,updated_at=? WHERE id=? AND owner_id=? AND owner_token=?`, toNano(nowUTC()), lease.RunID, lease.OwnerID, lease.Token)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (l *Ledger) ValidateLease(ctx context.Context, lease Lease) error {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	var expiry int64
	var state string
	err := l.db.QueryRowContext(ctx, `SELECT owner_expires_at,state FROM runs WHERE id=? AND owner_id=? AND owner_token=?`, lease.RunID, lease.OwnerID, lease.Token).Scan(&expiry, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrLeaseLost
	}
	if err != nil {
		return err
	}
	if RunState(state).Terminal() || expiry <= toNano(nowUTC()) {
		return ErrLeaseLost
	}
	return nil
}
