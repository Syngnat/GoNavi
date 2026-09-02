package runharness

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// LoadRunResumeContext reads the durable execution boundary for a run. It is
// intentionally one read transaction so the run projection, checkpoint and
// in-flight tool/approval records describe the same ledger revision.
func (l *Ledger) LoadRunResumeContext(ctx context.Context, runID string) (RunResumeContext, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunResumeContext{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return RunResumeContext{}, errors.New("runId is required")
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunResumeContext{}, err
	}
	defer tx.Rollback()
	run, err := l.getRunTx(ctx, tx, runID)
	if err != nil {
		return RunResumeContext{}, err
	}
	return l.loadRunResumeContextTx(ctx, tx, run)
}

func (l *Ledger) loadRunResumeContextTx(ctx context.Context, tx *sql.Tx, run RunSnapshot) (RunResumeContext, error) {
	checkpoint, latestCheckpoint, err := l.resumeCheckpointTx(ctx, tx, run)
	if err != nil {
		return RunResumeContext{}, err
	}
	pendingTool, pendingUnknown, err := l.pendingToolTx(ctx, tx, run.ID)
	if err != nil {
		return RunResumeContext{}, err
	}
	pendingApproval, err := l.pendingApprovalTx(ctx, tx, run)
	if err != nil {
		return RunResumeContext{}, err
	}

	// Prefer the exact unresolved side effect over every other possible resume
	// hint. Replaying a provider turn while an external operation is unknown is
	// unsafe, even when an older checkpoint says running_model.
	if pendingUnknown != nil {
		// An explicit recovery retry advances run.Attempt while retaining the
		// previous unknown side-effect record for audit. That old record must not
		// force the freshly retried model turn back into recovery_required. Before
		// the retry (interrupted/recovery_required, or the same attempt) it remains
		// the authoritative recovery seam.
		if run.State == RunStateInterrupted || run.State == RunStateRecoveryRequired || pendingUnknown.Attempt >= run.Attempt {
			pendingTool = pendingUnknown
		}
	}
	resumeState := run.State
	if run.State == RunStateInterrupted || run.State == RunStateRecoveryRequired {
		resumeState = RunStateRunningModel
		if checkpoint != nil {
			if state := resumableCheckpointState(checkpoint.State); state != "" {
				resumeState = state
			}
		}
	} else if run.State == RunStateRunningTool && pendingTool == nil {
		// A running_tool projection without a started call is an incomplete
		// boundary. Rebuild from the last provider checkpoint instead of issuing a
		// phantom tool call.
		resumeState = RunStateRunningModel
		if checkpoint != nil {
			if state := resumableCheckpointState(checkpoint.State); state != "" {
				resumeState = state
			}
		}
	}
	if pendingApproval != nil {
		resumeState = RunStateAwaitingApproval
	}
	if run.State == RunStateAwaitingWorkspace {
		// A workspace wait may still have a started safe tool behind it. Keep the
		// durable wait state until the exact referenced snapshot becomes available;
		// blindly changing it to running_tool would make observers think execution
		// resumed before its context source recovered.
		resumeState = RunStateAwaitingWorkspace
	} else if pendingTool != nil {
		if toolHasUnknownSideEffect(*pendingTool) {
			resumeState = RunStateRecoveryRequired
		} else if pendingTool.Status == "started" {
			resumeState = RunStateRunningTool
		}
	}
	if resumeState == "" || !resumeState.Valid() {
		resumeState = RunStateRunningModel
	}
	if checkpoint == nil {
		checkpoint = latestCheckpoint
	}
	return RunResumeContext{Run: run, Checkpoint: checkpoint, PendingTool: pendingTool, PendingUnknownTool: pendingUnknown, PendingApproval: pendingApproval, ResumeState: resumeState}, nil
}

// resumeCheckpointTx returns the newest executable checkpoint and, separately,
// the newest checkpoint row. Recovery writes an interrupted/recovery marker;
// callers need the preceding executable row for provider state and cursor.
func (l *Ledger) resumeCheckpointTx(ctx context.Context, tx *sql.Tx, run RunSnapshot) (*Checkpoint, *Checkpoint, error) {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM checkpoints WHERE run_id=? ORDER BY sequence DESC,created_at DESC,id DESC`, run.ID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var latest, executable *Checkpoint
	for _, id := range ids {
		checkpoint, err := l.getCheckpointTx(ctx, tx, id)
		if err != nil {
			return nil, nil, err
		}
		if latest == nil {
			copy := checkpoint
			latest = &copy
		}
		if executable == nil && resumableCheckpointState(checkpoint.State) != "" {
			copy := checkpoint
			executable = &copy
		}
	}
	return executable, latest, nil
}

func (l *Ledger) getCheckpointTx(ctx context.Context, tx *sql.Tx, checkpointID string) (Checkpoint, error) {
	checkpointID = strings.TrimSpace(checkpointID)
	if checkpointID == "" {
		return Checkpoint{}, ErrNotFound
	}
	var id, runID, state string
	var sequence, created int64
	var cursorBlob, providerBlob, workspaceBlob []byte
	err := tx.QueryRowContext(ctx, `SELECT id,run_id,sequence,state,conversation_cursor,provider_state,workspace_snapshot,created_at FROM checkpoints WHERE id=?`, checkpointID).
		Scan(&id, &runID, &sequence, &state, &cursorBlob, &providerBlob, &workspaceBlob, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Checkpoint{}, ErrNotFound
	}
	if err != nil {
		return Checkpoint{}, err
	}
	var cursor string
	if len(cursorBlob) > 0 {
		if err := l.openJSON(`checkpoints`, id, `conversation_cursor`, cursorBlob, &cursor); err != nil {
			return Checkpoint{}, err
		}
	}
	var provider []byte
	if len(providerBlob) > 0 {
		var err error
		provider, err = l.openRaw(`checkpoints`, id, `provider_state`, providerBlob)
		if err != nil {
			return Checkpoint{}, err
		}
	}
	workspace, err := l.openWorkspaceSnapshotReference(id, workspaceBlob)
	if err != nil {
		return Checkpoint{}, err
	}
	return Checkpoint{ID: id, RunID: runID, Sequence: sequence, State: RunState(state), ConversationCursor: cursor,
		ProviderState: append([]byte(nil), provider...), WorkspaceSnapshot: workspace, CreatedAt: fromNano(created)}, nil
}

type pendingToolRow struct {
	callID, toolName, effect, status, argsHash string
	attempt                                    int
	args, result, workspace                    []byte
	resultHash, errorCode                      sql.NullString
	unknown, resultTruncated                   int
	resultOriginalBytes                        int64
	started, completed                         int64
}

// pendingToolTx returns a safe in-flight tool and an unresolved side effect
// separately. The latter wins during resume, but keeping both makes the
// conflict explicit to callers and tests.
func (l *Ledger) pendingToolTx(ctx context.Context, tx *sql.Tx, runID string) (*ToolCallRecord, *ToolCallRecord, error) {
	rows, err := tx.QueryContext(ctx, `SELECT call_id,attempt,tool_name,effect,status,args_hash,arguments,result,workspace_snapshot,result_hash,error_code,unknown_outcome,result_original_bytes,result_truncated,started_at,completed_at
		FROM tool_calls WHERE run_id=? AND (status IN ('started','unknown') OR unknown_outcome<>0)
		ORDER BY attempt DESC,started_at DESC,call_id DESC`, runID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var safe, unknown *ToolCallRecord
	for rows.Next() {
		var row pendingToolRow
		if err := rows.Scan(&row.callID, &row.attempt, &row.toolName, &row.effect, &row.status, &row.argsHash, &row.args, &row.result, &row.workspace, &row.resultHash, &row.errorCode, &row.unknown, &row.resultOriginalBytes, &row.resultTruncated, &row.started, &row.completed); err != nil {
			return nil, nil, err
		}
		record, err := l.decodeToolCallRecord(runID, row.callID, row.attempt, row.toolName, ToolEffect(row.effect), row.status, row.argsHash, row.args, row.result, row.workspace, row.resultHash, row.errorCode, row.unknown, row.resultTruncated, row.resultOriginalBytes, row.started, row.completed)
		if err != nil {
			return nil, nil, err
		}
		if toolHasUnknownSideEffect(record) {
			if unknown == nil {
				copy := record
				unknown = &copy
			}
			continue
		}
		if record.Status == `started` && safe == nil {
			copy := record
			safe = &copy
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return safe, unknown, nil
}

func toolHasUnknownSideEffect(tool ToolCallRecord) bool {
	if tool.Effect != ToolEffectSideEffect && tool.Effect != ToolEffectSideEffectUnknown {
		return false
	}
	return tool.Status == `started` || tool.Status == `unknown` || tool.UnknownOutcome
}

func (l *Ledger) pendingApprovalTx(ctx context.Context, tx *sql.Tx, run RunSnapshot) (*ApprovalRecord, error) {
	var approvalID, callID, toolName, effect, argsHash, status string
	var runRevision, created, decided int64
	var argsBlob []byte
	err := tx.QueryRowContext(ctx, `SELECT id,call_id,tool_name,effect,args_hash,status,run_revision,created_at,decided_at,arguments
		FROM approvals WHERE run_id=? AND status='pending' ORDER BY created_at DESC,id DESC LIMIT 1`, run.ID).
		Scan(&approvalID, &callID, &toolName, &effect, &argsHash, &status, &runRevision, &created, &decided, &argsBlob)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if run.State != RunStateAwaitingApproval || runRevision != run.Revision {
		return nil, nil
	}
	args, err := l.openRaw(`approvals`, approvalID, `arguments`, argsBlob)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(callID) == `` || strings.TrimSpace(toolName) == `` || !ToolEffect(effect).Valid() {
		return nil, fmt.Errorf(`invalid pending approval %s`, approvalID)
	}
	approval := &ApprovalRecord{ApprovalID: approvalID, RunID: run.ID, CallID: callID, ToolName: toolName,
		Effect: ToolEffect(effect), ArgsHash: argsHash, Arguments: args, Status: status,
		RunRevision: runRevision, CreatedAt: fromNano(created), DecidedAt: fromNano(decided)}
	return approval, nil
}
