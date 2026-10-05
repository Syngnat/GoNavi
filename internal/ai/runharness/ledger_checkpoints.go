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

// SaveCheckpoint durably records the provider/conversation cursor and points
// the run at it in the same transaction. It is safe to call after every
// completed model/tool turn.
func (l *Ledger) SaveCheckpoint(ctx context.Context, request SaveCheckpointRequest) (Checkpoint, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	request.RunID = strings.TrimSpace(request.RunID)
	if request.RunID == "" {
		return Checkpoint{}, errors.New("runId is required")
	}
	if request.State == "" || !request.State.Valid() {
		return Checkpoint{}, errors.New("valid checkpoint state is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return Checkpoint{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, request.RunID)
	if err != nil {
		return Checkpoint{}, err
	}
	if run.State.Terminal() {
		return Checkpoint{}, ErrTerminalRun
	}
	if err := verifyOwner(run, request.OwnerToken); err != nil {
		return Checkpoint{}, err
	}
	if request.ExpectedRevision > 0 && request.ExpectedRevision != run.Revision {
		return Checkpoint{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedRevision, run.Revision)
	}
	// A checkpoint is a snapshot of an event boundary, never an independent
	// state mutation.  Keep recovery marker states out of this API: those rows
	// are created only by the atomic recovery transaction below.  This prevents
	// a caller from making an interrupted run appear resumable by writing a
	// synthetic checkpoint.
	switch request.State {
	case RunStateQueued, RunStateInterrupted, RunStateRecoveryRequired,
		RunStateCanceling:
		return Checkpoint{}, fmt.Errorf("checkpoint state %s is not executable", request.State)
	}
	if request.State.Terminal() {
		return Checkpoint{}, fmt.Errorf("checkpoint state %s must be non-terminal", request.State)
	}
	if request.State != run.State {
		if err := ValidateTransition(run.State, request.State); err != nil {
			return Checkpoint{}, err
		}
	}
	boundary := run.NextSequence - 1
	if boundary < 0 {
		boundary = 0
	}
	if request.Sequence != boundary {
		return Checkpoint{}, fmt.Errorf("%w: checkpoint sequence %d must equal current boundary %d", ErrSequenceConflict, request.Sequence, boundary)
	}
	var latestSequence sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT MAX(sequence) FROM checkpoints WHERE run_id=?`, request.RunID).Scan(&latestSequence); err != nil {
		return Checkpoint{}, err
	}
	if latestSequence.Valid && request.Sequence <= latestSequence.Int64 {
		return Checkpoint{}, fmt.Errorf("%w: checkpoint sequence %d is not newer than %d", ErrSequenceConflict, request.Sequence, latestSequence.Int64)
	}
	workspace := cloneWorkspaceSnapshotReference(request.WorkspaceSnapshot)
	if workspace == nil {
		// State-only checkpoints (for example an interrupt or lease recovery)
		// still belong to the last workspace view used by the run. Carrying the
		// reference forward keeps the audit chain intact when callers do not have
		// to rebuild the full snapshot context themselves.
		_, _, inherited, previousErr := l.previousCheckpointDataTx(ctx, tx, run)
		if previousErr != nil {
			return Checkpoint{}, previousErr
		}
		workspace = inherited
	}
	id := uuid.NewString()
	now := nowUTC()
	cursorBlob, err := l.seal("checkpoints", id, "conversation_cursor", request.ConversationCursor)
	if err != nil {
		return Checkpoint{}, err
	}
	providerBlob, err := l.sealRaw("checkpoints", id, "provider_state", request.ProviderState)
	if err != nil {
		return Checkpoint{}, err
	}
	workspaceBlob, err := l.sealWorkspaceSnapshotReference(id, workspace)
	if err != nil {
		return Checkpoint{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, id, request.RunID, request.Sequence, request.State, cursorBlob, providerBlob, workspaceBlob, toNano(now)); err != nil {
		return Checkpoint{}, err
	}
	newRevision := run.Revision + 1
	ownerPredicate, ownerArgs := ownerCAS(run, request.OwnerToken, now)
	args := []any{id, newRevision, toNano(now), request.RunID, run.Revision}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET checkpoint_id=?,revision=?,updated_at=? WHERE id=? AND revision=?`+ownerPredicate, args...)
	if err != nil {
		return Checkpoint{}, err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return Checkpoint{}, err
		}
		return Checkpoint{}, ErrRevisionConflict
	}
	if err := tx.Commit(); err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: request.RunID, Sequence: request.Sequence, State: request.State, ConversationCursor: request.ConversationCursor, ProviderState: append(json.RawMessage(nil), request.ProviderState...), WorkspaceSnapshot: cloneWorkspaceSnapshotReference(workspace), CreatedAt: now}, nil
}

func (l *Ledger) GetCheckpoint(ctx context.Context, checkpointID string) (Checkpoint, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	var id, runID, state string
	var sequence, created int64
	var cursorBlob, providerBlob, workspaceBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at FROM checkpoints WHERE id=?`, checkpointID).Scan(&id, &runID, &sequence, &state, &cursorBlob, &providerBlob, &workspaceBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	var cursor string
	if len(cursorBlob) > 0 {
		if err := l.openJSON("checkpoints", id, "conversation_cursor", cursorBlob, &cursor); err != nil {
			return Checkpoint{}, err
		}
	}
	providerState, err := l.openRaw("checkpoints", id, "provider_state", providerBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	workspace, err := l.openWorkspaceSnapshotReference(id, workspaceBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: runID, Sequence: sequence, State: RunState(state), ConversationCursor: cursor, ProviderState: providerState, WorkspaceSnapshot: workspace, CreatedAt: fromNano(created)}, nil
}

func (l *Ledger) LatestCheckpoint(ctx context.Context, runID string) (Checkpoint, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return Checkpoint{}, err
	}
	var id string
	err := l.db.QueryRowContext(ctx, `SELECT id FROM checkpoints WHERE run_id=? ORDER BY sequence DESC,created_at DESC LIMIT 1`, runID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	return l.getCheckpointDB(ctx, id)
}

func (l *Ledger) getCheckpointDB(ctx context.Context, id string) (Checkpoint, error) {
	var runID, state string
	var sequence, created int64
	var cursorBlob, providerBlob, workspaceBlob []byte
	err := l.db.QueryRowContext(ctx, `SELECT run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at FROM checkpoints WHERE id=?`, id).Scan(&runID, &sequence, &state, &cursorBlob, &providerBlob, &workspaceBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	var cursor string
	if len(cursorBlob) > 0 {
		if err := l.openJSON("checkpoints", id, "conversation_cursor", cursorBlob, &cursor); err != nil {
			return Checkpoint{}, err
		}
	}
	provider, err := l.openRaw("checkpoints", id, "provider_state", providerBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	workspace, err := l.openWorkspaceSnapshotReference(id, workspaceBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: runID, Sequence: sequence, State: RunState(state), ConversationCursor: cursor, ProviderState: provider, WorkspaceSnapshot: workspace, CreatedAt: fromNano(created)}, nil
}

func (l *Ledger) sealWorkspaceSnapshotReference(checkpointID string, reference *WorkspaceSnapshotReference) ([]byte, error) {
	return l.sealWorkspaceSnapshotReferenceFor("checkpoints", checkpointID, reference)
}

func (l *Ledger) sealWorkspaceSnapshotReferenceFor(table, id string, reference *WorkspaceSnapshotReference) ([]byte, error) {
	if reference == nil {
		return nil, nil
	}
	if !reference.valid() {
		return nil, errors.New("workspace snapshot reference is incomplete")
	}
	return l.seal(table, id, "workspace_snapshot", reference)
}

func (l *Ledger) openWorkspaceSnapshotReference(checkpointID string, sealed []byte) (*WorkspaceSnapshotReference, error) {
	return l.openWorkspaceSnapshotReferenceFor("checkpoints", checkpointID, sealed)
}

func (l *Ledger) openWorkspaceSnapshotReferenceFor(table, id string, sealed []byte) (*WorkspaceSnapshotReference, error) {
	if len(sealed) == 0 {
		return nil, nil
	}
	var reference WorkspaceSnapshotReference
	if err := l.openJSON(table, id, "workspace_snapshot", sealed, &reference); err != nil {
		return nil, err
	}
	if !reference.valid() {
		return nil, errors.New("stored workspace snapshot reference is incomplete")
	}
	return &reference, nil
}
