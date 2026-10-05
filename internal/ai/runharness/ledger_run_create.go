package runharness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
)

// CreateRun creates a queued run and atomically records its initial user
// message, if provided. A duplicate requestId is idempotent.
func (l *Ledger) CreateRun(ctx context.Context, request CreateRunRequest) (RunSnapshot, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return RunSnapshot{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return RunSnapshot{}, err
	}
	defer tx.Rollback()
	run, err := l.createRunTx(ctx, tx, request)
	if err != nil {
		return RunSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return RunSnapshot{}, err
	}
	return l.getRunDB(ctx, run.ID)
}

// createRunTx is the transaction-scoped implementation shared by ordinary
// queue submissions and the steer/terminal race boundary. The caller owns the
// transaction and must commit it after this function returns.
func (l *Ledger) createRunTx(ctx context.Context, tx *sql.Tx, request CreateRunRequest) (RunSnapshot, error) {
	request.SessionID = strings.TrimSpace(request.SessionID)
	request.Provider = strings.TrimSpace(request.Provider)
	if request.SessionID == "" {
		return RunSnapshot{}, errors.New("sessionId is required")
	}
	if request.Provider != "" && request.ProviderBinding == nil {
		return RunSnapshot{}, ErrProviderBindingUnbound
	}
	if request.Provider == "" && request.ProviderBinding != nil {
		return RunSnapshot{}, ErrProviderBindingUnbound
	}
	var validatedProviderBinding *ProviderBinding
	if request.ProviderBinding != nil {
		binding, bindingErr := request.ProviderBinding.Validate()
		if bindingErr != nil {
			return RunSnapshot{}, fmt.Errorf("%w: %v", ErrProviderBindingCorrupt, bindingErr)
		}
		if !strings.EqualFold(request.Provider, binding.ProviderID) {
			return RunSnapshot{}, fmt.Errorf("%w: provider %q does not match binding %q", ErrProviderBindingCorrupt, request.Provider, binding.ProviderID)
		}
		validatedProviderBinding = &binding
		request.Provider = binding.ProviderID
	}
	policy := request.Policy.Normalize()
	if err := policy.Validate(); err != nil {
		return RunSnapshot{}, err
	}
	taskKind := request.TaskKind.Normalize()
	if !taskKind.Valid() {
		return RunSnapshot{}, fmt.Errorf("invalid taskKind %q", request.TaskKind)
	}
	allowTools := true
	if request.AllowTools != nil {
		allowTools = *request.AllowTools
	}
	runID := strings.TrimSpace(request.RunID)
	if runID == "" {
		runID = uuid.NewString()
	}
	if request.RequestID != "" {
		var existing string
		if err := tx.QueryRowContext(ctx, `SELECT id FROM runs WHERE request_id=?`, request.RequestID).Scan(&existing); err == nil {
			return l.getRunTx(ctx, tx, existing)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return RunSnapshot{}, err
		}
	}
	if _, err := l.ensureSessionTx(ctx, tx, request.SessionID, sessionTitleFromMessage(request.InitialMessage)); err != nil {
		return RunSnapshot{}, err
	}
	var generation int64
	if err := tx.QueryRowContext(ctx, `SELECT generation FROM sessions WHERE id=?`, request.SessionID).Scan(&generation); err != nil {
		return RunSnapshot{}, err
	}
	if request.ExpectedSessionRevision > 0 {
		var sessionRevision int64
		if err := tx.QueryRowContext(ctx, `SELECT revision FROM sessions WHERE id=?`, request.SessionID).Scan(&sessionRevision); err != nil {
			return RunSnapshot{}, err
		}
		if sessionRevision != request.ExpectedSessionRevision {
			return RunSnapshot{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, request.ExpectedSessionRevision, sessionRevision)
		}
	}
	// A session may have one executing owner but an arbitrary durable FIFO
	// backlog.  The worker's ordering gate and lease CAS ensure that only the
	// oldest non-terminal run executes; rejecting here would make queue mode
	// unusable whenever a previous run is still active.
	now := nowUTC()
	policyBlob, err := l.seal("runs", runID, "policy", policy)
	if err != nil {
		return RunSnapshot{}, err
	}
	var providerBindingBlob []byte
	if validatedProviderBinding != nil {
		binding := *validatedProviderBinding
		providerBindingBlob, err = l.seal("runs", runID, "provider_binding", binding)
		if err != nil {
			return RunSnapshot{}, err
		}
	}
	var toolCatalogBindingBlob []byte
	var toolCatalogHash any
	var toolCatalogRevision int64
	if request.ToolCatalogBinding != nil {
		binding, bindingErr := request.ToolCatalogBinding.Validate()
		if bindingErr != nil {
			return RunSnapshot{}, bindingErr
		}
		toolCatalogBindingBlob, err = l.seal("runs", runID, "tool_catalog_binding", binding)
		if err != nil {
			return RunSnapshot{}, err
		}
		toolCatalogHash = binding.Hash
		toolCatalogRevision = binding.Revision
	}
	var temperature any
	if request.Temperature != nil {
		temperature = *request.Temperature
	}
	var maxTokens any
	if request.MaxTokens != nil {
		maxTokens = *request.MaxTokens
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO runs(id,session_id,request_id,task_kind,allow_tools,session_generation,state,revision,attempt,next_sequence,policy,provider,model,thinking,temperature,max_tokens,provider_binding,context_source_id,context_source_instance_id,tool_catalog_binding,tool_catalog_hash,tool_catalog_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, runID, request.SessionID, nullString(request.RequestID), taskKind, boolInt(allowTools), generation, RunStateQueued, 1, 1, 1, policyBlob, request.Provider, request.Model, request.Thinking, temperature, maxTokens, providerBindingBlob, request.ContextSourceID, request.ContextSourceInstanceID, toolCatalogBindingBlob, toolCatalogHash, toolCatalogRevision, toNano(now), toNano(now)); err != nil {
		return RunSnapshot{}, err
	}
	if request.InitialMessage != nil {
		message := *request.InitialMessage
		message.SessionID = request.SessionID
		message.RunID = runID
		if err := l.appendMessageTx(ctx, tx, message); err != nil {
			return RunSnapshot{}, err
		}
	}
	return l.getRunTx(ctx, tx, runID)
}

// EnqueueSteerOrCreateRun closes the small but important race between finding
// an active run and persisting a steer command. The target run and the command
// are inspected in the same SQLite transaction. If the target has reached a
// terminal/non-steerable state, the exact request id is instead used to create
// one queued run, so callers never receive a "steered" receipt for a command
// that can no longer be consumed.
func (l *Ledger) EnqueueSteerOrCreateRun(ctx context.Context, request SteerOrQueueRequest) (SteerOrQueueResult, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureOpen(); err != nil {
		return SteerOrQueueResult{}, err
	}
	command := request.Command
	command.ID = strings.TrimSpace(command.ID)
	command.RunID = strings.TrimSpace(command.RunID)
	command.Action = RunControlAction(strings.TrimSpace(string(command.Action)))
	if command.ID == "" {
		return SteerOrQueueResult{}, errors.New("commandId is required")
	}
	if command.RunID == "" {
		return SteerOrQueueResult{}, errors.New("runId is required")
	}
	if command.Action != ControlSteer {
		return SteerOrQueueResult{}, fmt.Errorf("unsupported steer action %q", command.Action)
	}
	if command.CreatedAt.IsZero() {
		command.CreatedAt = nowUTC()
	}
	payload := command.Payload
	if len(payload) == 0 {
		payload = []byte(`{}`)
	}
	if !json.Valid(payload) {
		return SteerOrQueueResult{}, errors.New("command payload must be valid JSON")
	}
	create := request.CreateRun
	if strings.TrimSpace(create.RequestID) == "" {
		create.RequestID = command.ID
	}
	if create.RequestID != command.ID {
		return SteerOrQueueResult{}, fmt.Errorf("steer and queued request ids must match")
	}
	if strings.TrimSpace(create.SessionID) == "" {
		return SteerOrQueueResult{}, errors.New("sessionId is required for queued fallback")
	}
	sealed, err := l.sealRaw("control_commands", command.ID, "payload", payload)
	if err != nil {
		return SteerOrQueueResult{}, err
	}
	tx, err := beginTx(ctx, l.db)
	if err != nil {
		return SteerOrQueueResult{}, err
	}
	defer tx.Rollback()

	// Resolve either durable idempotency representation before reading mutable
	// run state. A retry after the command was applied may observe a terminal
	// target, but it must still return the original steered run.
	var existingRunID, existingAction string
	var existingPayload []byte
	var existingExpected, existingCreated int64
	existingErr := tx.QueryRowContext(ctx, `SELECT run_id,action,payload,expected_revision,created_at FROM control_commands WHERE id=?`, command.ID).
		Scan(&existingRunID, &existingAction, &existingPayload, &existingExpected, &existingCreated)
	if existingErr == nil {
		plain, openErr := l.openRaw("control_commands", command.ID, "payload", existingPayload)
		if openErr != nil {
			return SteerOrQueueResult{}, openErr
		}
		if existingRunID != command.RunID || RunControlAction(existingAction) != command.Action || existingExpected != command.ExpectedRevision ||
			!bytes.Equal(bytes.TrimSpace(plain), bytes.TrimSpace(payload)) {
			return SteerOrQueueResult{}, fmt.Errorf("%w: id %q is already bound to another steer", ErrControlCommandConflict, command.ID)
		}
		run, runErr := l.getRunTx(ctx, tx, existingRunID)
		if runErr != nil {
			return SteerOrQueueResult{}, runErr
		}
		if err := tx.Commit(); err != nil {
			return SteerOrQueueResult{}, err
		}
		return SteerOrQueueResult{Run: run, Disposition: "steered"}, nil
	} else if !errors.Is(existingErr, sql.ErrNoRows) {
		return SteerOrQueueResult{}, existingErr
	}
	// A prior terminal-race fallback is represented by the ordinary run
	// request_id rather than a control command.
	var existingQueuedID string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM runs WHERE request_id=?`, command.ID).Scan(&existingQueuedID); err == nil {
		run, runErr := l.getRunTx(ctx, tx, existingQueuedID)
		if runErr != nil {
			return SteerOrQueueResult{}, runErr
		}
		if err := tx.Commit(); err != nil {
			return SteerOrQueueResult{}, err
		}
		return SteerOrQueueResult{Run: run, Disposition: "queued"}, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return SteerOrQueueResult{}, err
	}

	target, targetErr := l.getRunTx(ctx, tx, command.RunID)
	if targetErr == nil {
		steerable := false
		switch target.State {
		case RunStateQueued, RunStateRunningModel, RunStateRunningTool,
			RunStateAwaitingApproval, RunStateAwaitingWorkspace:
			steerable = true
		}
		if steerable {
			if command.ExpectedRevision > 0 && command.ExpectedRevision != target.Revision {
				return SteerOrQueueResult{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, command.ExpectedRevision, target.Revision)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO control_commands(id,run_id,action,payload,expected_revision,created_at) VALUES(?,?,?,?,?,?)`, command.ID, command.RunID, command.Action, sealed, command.ExpectedRevision, toNano(command.CreatedAt)); err != nil {
				return SteerOrQueueResult{}, err
			}
			if err := tx.Commit(); err != nil {
				return SteerOrQueueResult{}, err
			}
			command.Payload = append(json.RawMessage(nil), payload...)
			return SteerOrQueueResult{Run: target, Disposition: "steered"}, nil
		}
	} else if !errors.Is(targetErr, ErrNotFound) {
		return SteerOrQueueResult{}, targetErr
	}

	// The target was terminal (or disappeared). Do not persist a command that
	// no worker can consume; createRunTx records the same request id atomically.
	create.InitialMessage = cloneMessagePointer(create.InitialMessage)
	run, createErr := l.createRunTx(ctx, tx, create)
	if createErr != nil {
		return SteerOrQueueResult{}, createErr
	}
	if err := tx.Commit(); err != nil {
		return SteerOrQueueResult{}, err
	}
	return SteerOrQueueResult{Run: run, Disposition: "queued"}, nil
}
