package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// RecoverRuns marks runs that were actively executing when an owner vanished.
// The recovery transition, checkpoint and event are committed atomically. Runs
// that are queued (or already waiting for an explicit user recovery decision)
// are deliberately left untouched so startup cannot break FIFO or repeatedly
// advance attempts. A live lease is also left alone; another supervisor may
// still be executing the run.
func (l *Ledger) RecoverRuns(ctx context.Context) ([]RunSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return nil, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := nowUTC()
	nowNS := toNano(now)
	rows, err := tx.QueryContext(ctx, `SELECT id FROM runs
		WHERE state IN ('running_model','running_tool','awaiting_workspace','canceling')
		AND (owner_token IS NULL OR owner_token='' OR owner_expires_at<=?)
		ORDER BY created_at`, nowNS)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for _, id := range ids {
		run, err := l.getRunTx(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		// The selector above is intentionally repeated here because this method
		// may be called by more than one supervisor after the initial read.
		if run.State == RunStateQueued || run.State.Terminal() ||
			run.State == RunStateInterrupted || run.State == RunStateRecoveryRequired ||
			(!run.OwnerExpiresAt.IsZero() && run.OwnerExpiresAt.After(now)) {
			continue
		}
		target := RunStateInterrupted
		var unknown int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM tool_calls
			WHERE run_id=? AND effect IN ('side_effect','side_effect_unknown')
			AND (status IN ('started','unknown') OR unknown_outcome<>0)`, id).Scan(&unknown); err != nil {
			return nil, err
		}
		if unknown > 0 {
			target = RunStateRecoveryRequired
		}
		if err := ValidateTransition(run.State, target); err != nil {
			return nil, err
		}
		// Any approval was bound to the pre-crash run revision. Invalidate it
		// while the recovery transition is still in the same transaction; a
		// resumed worker must create a fresh approval for a fresh attempt.
		if _, err := tx.ExecContext(ctx, `UPDATE approvals SET status='expired',decided_at=? WHERE run_id=? AND status='pending'`, nowNS, id); err != nil {
			return nil, err
		}
		// A reserved model turn has no committed usage/message/checkpoint after
		// the owner disappears. Reconcile it with zero usage in the same recovery
		// transaction so the resumed run is not permanently blocked by leaked
		// capacity; usage from completed turns remains in the run counters.
		if _, err := tx.ExecContext(ctx, `UPDATE token_reservations SET prompt_tokens=0,completion_tokens=0,total_tokens=0,status='reconciled',reconciled_at=? WHERE run_id=? AND status='reserved'`, nowNS, id); err != nil {
			return nil, err
		}

		// Carry forward the last provider cursor when one exists. The new
		// checkpoint is still encrypted under a fresh record id, so recovery
		// metadata cannot be confused with the previous checkpoint.
		var cursor string
		var providerState json.RawMessage
		var workspace *WorkspaceSnapshotReference
		if strings.TrimSpace(run.CheckpointID) != "" {
			var cursorBlob, providerBlob, workspaceSnapshotBlob []byte
			checkpointErr := tx.QueryRowContext(ctx, `SELECT conversation_cursor,provider_state,workspace_snapshot FROM checkpoints WHERE id=?`, run.CheckpointID).Scan(&cursorBlob, &providerBlob, &workspaceSnapshotBlob)
			if checkpointErr != nil && !errors.Is(checkpointErr, sql.ErrNoRows) {
				return nil, checkpointErr
			}
			if checkpointErr == nil {
				if len(cursorBlob) > 0 {
					if err := l.openJSON("checkpoints", run.CheckpointID, "conversation_cursor", cursorBlob, &cursor); err != nil {
						return nil, err
					}
				}
				if len(providerBlob) > 0 {
					providerState, err = l.openRaw("checkpoints", run.CheckpointID, "provider_state", providerBlob)
					if err != nil {
						return nil, err
					}
				}
				workspace, err = l.openWorkspaceSnapshotReference(run.CheckpointID, workspaceSnapshotBlob)
				if err != nil {
					return nil, err
				}
			}
		}
		checkpointID := uuid.NewString()
		cursorBlob, err := l.seal("checkpoints", checkpointID, "conversation_cursor", cursor)
		if err != nil {
			return nil, err
		}
		providerBlob, err := l.sealRaw("checkpoints", checkpointID, "provider_state", providerState)
		if err != nil {
			return nil, err
		}
		workspaceBlob, err := l.sealWorkspaceSnapshotReference(checkpointID, workspace)
		if err != nil {
			return nil, err
		}
		sequence := run.NextSequence
		if sequence < 1 {
			sequence = 1
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints(id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)`, checkpointID, id, sequence, target, cursorBlob, providerBlob, workspaceBlob, nowNS); err != nil {
			return nil, err
		}

		payload := CheckpointEvent{CheckpointID: checkpointID, Sequence: sequence, WorkspaceSnapshot: workspace}
		payloadJSON, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		sealedEvent, err := l.sealRaw("events", id, fmt.Sprintf("payload/%d", sequence), payloadJSON)
		if err != nil {
			return nil, err
		}
		newRevision := run.Revision + 1
		newAttempt := run.Attempt + 1
		result, err := tx.ExecContext(ctx, `UPDATE runs SET state=?,revision=?,attempt=?,next_sequence=?,checkpoint_id=?,reserved_tokens=0,owner_id=NULL,owner_token=NULL,owner_expires_at=0,updated_at=?
			WHERE id=? AND state=? AND revision=? AND next_sequence=?
			AND (owner_token IS NULL OR owner_token='' OR owner_expires_at<=?)`, target, newRevision, newAttempt, sequence+1, checkpointID, nowNS, id, run.State, run.Revision, run.NextSequence, nowNS)
		if err != nil {
			return nil, err
		}
		if affected, err := result.RowsAffected(); err != nil || affected != 1 {
			if err != nil {
				return nil, err
			}
			return nil, ErrRevisionConflict
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO events(run_id,sequence,schema_version,kind,resulting_state,run_revision,attempt,timestamp,payload) VALUES(?,?,?,?,?,?,?,?,?)`, id, sequence, CurrentSchemaVersion, EventCheckpoint, target, newRevision, newAttempt, nowNS, sealedEvent); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	result := make([]RunSnapshot, 0, len(ids))
	for _, id := range ids {
		run, err := l.getRunDB(ctx, id)
		if err != nil {
			return nil, err
		}
		if run.State == RunStateInterrupted || run.State == RunStateRecoveryRequired {
			result = append(result, run)
		}
	}
	return result, nil
}

func (l *Ledger) EnqueueInput(ctx context.Context, request QueueInputRequest) (QueueInputRequest, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return QueueInputRequest{}, err
	}
	if request.RequestID == "" || request.RunID == "" || request.SessionID == "" {
		return QueueInputRequest{}, errors.New("requestId, runId and sessionId are required")
	}
	if request.DispatchMode == "" {
		request.DispatchMode = DispatchQueue
	}
	if !request.DispatchMode.Valid() {
		return QueueInputRequest{}, errors.New("invalid dispatch mode")
	}
	id := uuid.NewString()
	sealed, err := l.seal("queued_inputs", id, "content", request.Content)
	if err != nil {
		return QueueInputRequest{}, err
	}
	_, err = l.db.ExecContext(ctx, `INSERT INTO queued_inputs(id,request_id,run_id,session_id,content,dispatch_mode,context_source_id,context_source_instance_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, id, request.RequestID, request.RunID, request.SessionID, sealed, request.DispatchMode, request.ContextSourceID, request.ContextSourceInstanceID, toNano(nowUTC()))
	if err != nil {
		return QueueInputRequest{}, err
	}
	return request, nil
}

func (l *Ledger) DequeueInputs(ctx context.Context, runID string, limit int) ([]QueueInputRequest, error) {
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
	rows, err := tx.QueryContext(ctx, `SELECT id,request_id,session_id,content,dispatch_mode,COALESCE(context_source_id,''),COALESCE(context_source_instance_id,''),created_at FROM queued_inputs WHERE run_id=? AND consumed_at=0 ORDER BY created_at LIMIT ?`, runID, limit)
	if err != nil {
		return nil, err
	}
	type rowData struct {
		id, requestID, sessionID     string
		content                      []byte
		mode, source, sourceInstance string
		created                      int64
	}
	var pending []rowData
	for rows.Next() {
		var x rowData
		if err := rows.Scan(&x.id, &x.requestID, &x.sessionID, &x.content, &x.mode, &x.source, &x.sourceInstance, &x.created); err != nil {
			rows.Close()
			return nil, err
		}
		pending = append(pending, x)
	}
	rows.Close()
	now := toNano(nowUTC())
	out := make([]QueueInputRequest, 0, len(pending))
	for _, x := range pending {
		var content string
		if err := l.openJSON("queued_inputs", x.id, "content", x.content, &content); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE queued_inputs SET consumed_at=? WHERE id=? AND consumed_at=0`, now, x.id); err != nil {
			return nil, err
		}
		out = append(out, QueueInputRequest{RequestID: x.requestID, RunID: runID, SessionID: x.sessionID, Content: content, DispatchMode: DispatchMode(x.mode), ContextSourceID: x.source, ContextSourceInstanceID: x.sourceInstance})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// AddActiveDuration reconciles model/tool execution time into the run budget.
// It is deliberately a small CAS update so an owner heartbeat or another
// metadata revision cannot overwrite the accumulated duration.
func (l *Ledger) AddActiveDuration(ctx context.Context, runID string, duration time.Duration, ownerToken string) error {
	if duration <= 0 {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return err
	}
	if run.State.Terminal() {
		return ErrTerminalRun
	}
	if err := verifyOwner(run, ownerToken); err != nil {
		return err
	}
	now := nowUTC()
	ownerPredicate, ownerArgs := ownerCAS(run, ownerToken, now)
	args := []any{duration.Nanoseconds(), toNano(now), runID}
	args = append(args, ownerArgs...)
	result, err := tx.ExecContext(ctx, `UPDATE runs SET active_duration_ns=active_duration_ns+?,revision=revision+1,updated_at=? WHERE id=? AND state NOT IN ('completed','failed','canceled','exhausted')`+ownerPredicate, args...)
	if err != nil {
		return err
	}
	if affected, err := result.RowsAffected(); err != nil || affected != 1 {
		if err != nil {
			return err
		}
		return ErrRevisionConflict
	}
	return tx.Commit()
}
