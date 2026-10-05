package runharness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

func scanRun(scanner interface{ Scan(...any) error }, l *Ledger) (RunSnapshot, error) {
	var id, sessionID, state, taskKind string
	var requestID, ownerID, ownerToken, checkpointID, provider, model, thinking, contextSource, contextSourceInstance, toolCatalogHash sql.NullString
	var generation, revision, attempt, nextSequence, ownerExpires, activeNS, promptTokens, completionTokens, totalTokens, reservedTokens, created, updated int64
	var toolCatalogRevision int64
	var allowTools int
	var terminalBlob, policyBlob, providerBindingBlob, toolCatalogBindingBlob []byte
	var temperature sql.NullFloat64
	var maxTokens sql.NullInt64
	if err := scanner.Scan(&id, &sessionID, &requestID, &taskKind, &allowTools, &generation, &state, &revision, &attempt, &nextSequence,
		&ownerID, &ownerToken, &ownerExpires, &checkpointID, &terminalBlob, &policyBlob,
		&provider, &model, &thinking, &temperature, &maxTokens, &providerBindingBlob, &contextSource, &contextSourceInstance,
		&toolCatalogBindingBlob, &toolCatalogHash, &toolCatalogRevision,
		&activeNS, &promptTokens, &completionTokens, &totalTokens, &reservedTokens, &created, &updated); err != nil {
		return RunSnapshot{}, err
	}
	snapshot := RunSnapshot{ID: id, SessionID: sessionID, RequestID: requestID.String, TaskKind: AgentTaskKind(taskKind).Normalize(), AllowTools: allowTools != 0, SessionGeneration: generation, State: RunState(state), Revision: revision,
		Attempt: int(attempt), NextSequence: nextSequence, ownerToken: ownerToken.String, OwnerExpiresAt: fromNano(ownerExpires),
		CheckpointID: checkpointID.String, Provider: provider.String, Model: model.String, ContextSourceID: contextSource.String, ContextSourceInstanceID: contextSourceInstance.String,
		ToolCatalogHash: toolCatalogHash.String, ToolCatalogRevision: toolCatalogRevision,
		CreatedAt: fromNano(created), UpdatedAt: fromNano(updated), ActiveDurationMS: activeNS / 1e6,
		PromptTokens: int(promptTokens), CompletionTokens: int(completionTokens), TotalTokens: int(totalTokens), ReservedTokens: int(reservedTokens),
		Thinking: thinking.String}
	if temperature.Valid {
		v := temperature.Float64
		snapshot.Temperature = &v
	}
	if maxTokens.Valid {
		v := int(maxTokens.Int64)
		snapshot.MaxTokens = &v
	}
	if len(terminalBlob) > 0 {
		if err := l.openJSON("runs", id, "terminal_reason", terminalBlob, &snapshot.TerminalReason); err != nil {
			return RunSnapshot{}, err
		}
	}
	if len(policyBlob) > 0 {
		if err := l.openJSON("runs", id, "policy", policyBlob, &snapshot.Policy); err != nil {
			return RunSnapshot{}, err
		}
	}
	return snapshot, nil
}

const runColumns = `id, session_id, request_id, task_kind, allow_tools, session_generation, state, revision, attempt, next_sequence,
 owner_id, owner_token, owner_expires_at, checkpoint_id, terminal_reason, policy,
 provider, model, thinking, temperature, max_tokens, provider_binding, context_source_id, context_source_instance_id,
 tool_catalog_binding, tool_catalog_hash, tool_catalog_revision,
 active_duration_ns, prompt_tokens, completion_tokens, total_tokens, reserved_tokens, created_at, updated_at`

func (l *Ledger) getRunTx(ctx context.Context, tx *sql.Tx, runID string) (RunSnapshot, error) {
	row := tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id=?`, runID)
	snapshot, err := scanRun(row, l)
	if errors.Is(err, sql.ErrNoRows) {
		return RunSnapshot{}, ErrNotFound
	}
	return snapshot, err
}

func (l *Ledger) GetRun(ctx context.Context, runID string) (RunSnapshot, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, runID)
}

// GetRunByRequestID returns the run durably associated with an input
// idempotency key.  Request IDs are unique across the ledger, so looking up
// the existing run before validating mutable provider/tool state lets a
// retried submission return the original receipt even while the host is
// reconfiguring.  Keep this lookup read-only and map SQL's no-row result to
// the ledger's stable ErrNotFound sentinel.
func (l *Ledger) GetRunByRequestID(ctx context.Context, requestID string) (RunSnapshot, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	requestID = strings.TrimSpace(requestID)
	if requestID == "" {
		return RunSnapshot{}, ErrNotFound
	}
	var runID string
	if err := l.db.QueryRowContext(ctx, `SELECT id FROM runs WHERE request_id=?`, requestID).Scan(&runID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return RunSnapshot{}, ErrNotFound
		}
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, runID)
}

// GetControlCommand returns the durable command associated with a control
// idempotency key. Its payload is decrypted only within the Ledger boundary.
func (l *Ledger) GetControlCommand(ctx context.Context, commandID string) (ControlCommand, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ControlCommand{}, err
	}
	commandID = strings.TrimSpace(commandID)
	if commandID == "" {
		return ControlCommand{}, ErrNotFound
	}
	var runID, action string
	var sealedPayload []byte
	var expectedRevision, createdAt, consumedAt int64
	err := l.db.QueryRowContext(ctx, `SELECT run_id,action,payload,expected_revision,created_at,consumed_at FROM control_commands WHERE id=?`, commandID).
		Scan(&runID, &action, &sealedPayload, &expectedRevision, &createdAt, &consumedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ControlCommand{}, ErrNotFound
	}
	if err != nil {
		return ControlCommand{}, err
	}
	payload, err := l.openRaw("control_commands", commandID, "payload", sealedPayload)
	if err != nil {
		return ControlCommand{}, err
	}
	return ControlCommand{
		ID: commandID, RunID: runID, Action: RunControlAction(action),
		Payload: append(json.RawMessage(nil), payload...), ExpectedRevision: expectedRevision,
		CreatedAt: fromNano(createdAt), ConsumedAt: fromNano(consumedAt),
	}, nil
}

// GetProviderBinding returns the immutable provider contract captured when a
// run was accepted. The encrypted payload is decrypted only inside the
// Ledger boundary and is never attached to RunSnapshot projections.
func (l *Ledger) GetProviderBinding(ctx context.Context, runID string) (ProviderBinding, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ProviderBinding{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return ProviderBinding{}, ErrNotFound
	}
	var blob []byte
	var provider sql.NullString
	if err := l.db.QueryRowContext(ctx, `SELECT provider, provider_binding FROM runs WHERE id=?`, runID).Scan(&provider, &blob); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ProviderBinding{}, ErrNotFound
		}
		return ProviderBinding{}, err
	}
	if len(blob) == 0 {
		return ProviderBinding{}, ErrProviderBindingUnbound
	}
	var binding ProviderBinding
	if err := l.openJSON("runs", runID, "provider_binding", blob, &binding); err != nil {
		return ProviderBinding{}, fmt.Errorf("%w: decrypt provider binding: %v", ErrProviderBindingCorrupt, err)
	}
	validated, err := binding.Validate()
	if err != nil {
		return ProviderBinding{}, fmt.Errorf("%w: %v", ErrProviderBindingCorrupt, err)
	}
	indexedProvider := strings.TrimSpace(provider.String)
	if !provider.Valid || indexedProvider == "" {
		return ProviderBinding{}, fmt.Errorf("%w: indexed provider is empty", ErrProviderBindingCorrupt)
	}
	if !strings.EqualFold(indexedProvider, validated.ProviderID) {
		return ProviderBinding{}, fmt.Errorf("%w: provider %q does not match binding %q", ErrProviderBindingCorrupt, provider.String, validated.ProviderID)
	}
	return validated, nil
}

// GetToolCatalogBinding returns the immutable catalog captured for a run. The
// descriptor payload is decrypted only inside the Ledger boundary; callers
// should use it for validation/execution and must not expose it as a run
// snapshot. Runs created by older ledger versions have no binding and return
// ErrToolCatalogUnbound.
func (l *Ledger) GetToolCatalogBinding(ctx context.Context, runID string) (ToolCatalogBinding, error) {
	l.mu.RLock()
	defer l.mu.RUnlock()
	if err := l.ensureOpen(); err != nil {
		return ToolCatalogBinding{}, err
	}
	runID = strings.TrimSpace(runID)
	if runID == "" {
		return ToolCatalogBinding{}, ErrNotFound
	}
	var (
		blob      []byte
		indexHash sql.NullString
		indexRev  sql.NullInt64
	)
	if err := l.db.QueryRowContext(ctx, `SELECT tool_catalog_binding, tool_catalog_hash, tool_catalog_revision FROM runs WHERE id=?`, runID).Scan(&blob, &indexHash, &indexRev); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ToolCatalogBinding{}, ErrNotFound
		}
		return ToolCatalogBinding{}, err
	}
	if len(blob) == 0 {
		// A legacy/unbound run has no indexed identity either.  If only one side
		// exists, fail closed instead of silently treating an incomplete binding
		// as a valid legacy run.
		if strings.TrimSpace(indexHash.String) != "" || (indexRev.Valid && indexRev.Int64 != 0) {
			return ToolCatalogBinding{}, fmt.Errorf("%w: indexed metadata exists without encrypted descriptor", ErrToolCatalogBindingCorrupt)
		}
		return ToolCatalogBinding{}, ErrToolCatalogUnbound
	}
	var binding ToolCatalogBinding
	if err := l.openJSON("runs", runID, "tool_catalog_binding", blob, &binding); err != nil {
		return ToolCatalogBinding{}, err
	}
	validated, err := binding.Validate()
	if err != nil {
		return ToolCatalogBinding{}, err
	}
	// The hash and revision columns are an index/projection of the encrypted
	// binding.  They are not trusted merely because the ciphertext decrypted:
	// compare both values before handing descriptors to the harness.  A missing
	// index is corruption for a bound run, while hash comparison remains
	// case-insensitive to tolerate canonical hex casing from older ledgers.
	if !indexHash.Valid || strings.TrimSpace(indexHash.String) == "" {
		return ToolCatalogBinding{}, fmt.Errorf("%w: encrypted descriptor has no indexed hash", ErrToolCatalogBindingCorrupt)
	}
	if !strings.EqualFold(strings.TrimSpace(indexHash.String), validated.Hash) {
		return ToolCatalogBinding{}, fmt.Errorf("%w: indexed hash %q does not match binding hash %q", ErrToolCatalogBindingCorrupt, indexHash.String, validated.Hash)
	}
	if !indexRev.Valid || indexRev.Int64 != validated.Revision {
		return ToolCatalogBinding{}, fmt.Errorf("%w: indexed revision %d does not match binding revision %d", ErrToolCatalogBindingCorrupt, indexRev.Int64, validated.Revision)
	}
	return validated, nil
}

func (l *Ledger) getRunDB(ctx context.Context, runID string) (RunSnapshot, error) {
	row := l.db.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE id=?`, runID)
	snapshot, err := scanRun(row, l)
	if errors.Is(err, sql.ErrNoRows) {
		return RunSnapshot{}, ErrNotFound
	}
	return snapshot, err
}
