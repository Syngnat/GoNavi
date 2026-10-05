package runharness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SubmitInput durably accepts a user input and starts or queues exactly one
// run. A requestId is idempotent even when the worker is already running.
func (h *AgentRunHarness) SubmitInput(ctx context.Context, request AgentInputRequest) (AgentInputReceipt, error) {
	if err := h.ensureOpen(); err != nil {
		return AgentInputReceipt{}, err
	}
	if err := request.Validate(); err != nil {
		return AgentInputReceipt{}, err
	}
	if ctx == nil {
		ctx = h.root
	}
	// requestId is the idempotency boundary. Resolve an already durable run
	// before consulting mutable catalogs or provider configuration so a retry
	// remains successful even if the host is temporarily reconfiguring tools.
	if existing, existingErr := h.ledger.GetRunByRequestID(ctx, request.RequestID); existingErr == nil {
		if !existing.State.Terminal() {
			h.startWorker(existing)
		}
		disposition := "started"
		if existing.State != RunStateQueued {
			disposition = "queued"
		}
		return AgentInputReceipt{RequestID: request.RequestID, SessionID: existing.SessionID, RunID: existing.ID, Disposition: disposition, Revision: existing.Revision, State: existing.State}, nil
	} else if !errors.Is(existingErr, ErrNotFound) {
		return AgentInputReceipt{}, existingErr
	}
	if receipt, replayed, replayErr := h.replayExistingSteer(ctx, request); replayed || replayErr != nil {
		return receipt, replayErr
	}
	originalRequest := request
	if h.inputBinder != nil {
		if err := h.inputBinder(ctx, &request); err != nil {
			// A second supervisor can accept the same steer while this host is
			// resolving mutable provider settings. Recheck its durable command
			// before surfacing a stale configuration failure to a retry.
			if receipt, replayed, replayErr := h.replayExistingSteer(ctx, originalRequest); replayed || replayErr != nil {
				return receipt, replayErr
			}
			return AgentInputReceipt{}, err
		}
	}
	policy := h.DefaultPolicy()
	mode := request.DispatchMode
	if mode == "" {
		mode = policy.DefaultDispatchMode
	}
	if !mode.Valid() {
		return AgentInputReceipt{}, fmt.Errorf("invalid dispatchMode %q", mode)
	}
	sessionID := strings.TrimSpace(request.SessionID)
	implicitSession := sessionID == ""
	branchFromMessageID := strings.TrimSpace(request.BranchFromMessageID)
	branched := branchFromMessageID != ""
	// An explicit session is an update to an existing conversation projection.
	// Keep the idempotency lookup above this guard so a transport retry can
	// still return its original receipt after that projection has advanced.
	if !implicitSession && request.ExpectedRevision <= 0 {
		return AgentInputReceipt{}, fmt.Errorf("%w: expectedRevision must be positive for a session-bound input", ErrRevisionConflict)
	}
	if branched {
		// A branch is always a new queued/run-able conversation. In particular it
		// must never steer an active run in the source session: doing that would
		// mutate the original transcript instead of preserving it for audit.
		branchSessionID := deterministicBranchSessionID(request.RequestID)
		branch, err := h.ledger.CreateSessionBranch(ctx, CreateSessionBranchRequest{
			SessionID:              branchSessionID,
			SourceSessionID:        sessionID,
			BranchFromMessageID:    branchFromMessageID,
			ExpectedSourceRevision: request.ExpectedRevision,
			Title:                  firstLine(request.Content),
		})
		if err != nil {
			return AgentInputReceipt{}, err
		}
		sessionID = branch.ID
		mode = DispatchQueue
	} else if sessionID == "" {
		// Keep the implicit conversation identity stable across transport
		// retries.  Creating a random session before CreateRun used to leave an
		// orphan session whenever two submissions raced (or a retry arrived
		// after the first run had already been persisted).  CreateRun now creates
		// this deterministic session in the same SQLite transaction as the run.
		sessionID = deterministicInputSessionID(request.RequestID)
	}
	active, err := h.findActiveRun(ctx, sessionID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return AgentInputReceipt{}, err
	}
	// Do not persist a steer until the message/catalog envelope is ready. The
	// final decision (steer versus queued fallback) is made atomically by the
	// Ledger after that envelope is built, closing the terminal-race window.
	steerTarget := active

	var expectedSessionRevision int64
	if request.ExpectedRevision > 0 && !branched && steerTarget.ID == "" {
		expectedSessionRevision = request.ExpectedRevision
		if implicitSession {
			// CreateRun performs this check after it has provisionally created the
			// implicit session, inside the same transaction. A failed CAS therefore
			// rolls the session back instead of returning a stray empty session.
			goto revisionGuardDone
		}
		// SubmitInput's revision guard applies to the session projection when a
		// new queued run is created. The active-run guard for a steer is evaluated
		// atomically with command insertion below.
		projection, projectionErr := h.ledger.GetSession(ctx, sessionID, false)
		if errors.Is(projectionErr, ErrNotFound) {
			// The caller binds the input to a conversation this ledger no longer
			// contains — UI state can outlive the ledger when the data root or
			// the ledger file is replaced. Failing the send would strand the
			// panel on an unfixable error, so fall back to a fresh implicit
			// conversation; the receipt's SessionID lets the adapter rebuild its
			// projection, mirroring the implicit path above.
			sessionID = deterministicInputSessionID(request.RequestID)
			expectedSessionRevision = 0
			goto revisionGuardDone
		}
		if projectionErr != nil {
			return AgentInputReceipt{}, projectionErr
		}
		if projection.Revision != expectedSessionRevision {
			return AgentInputReceipt{}, fmt.Errorf("%w: expected %d, got %d", ErrRevisionConflict, expectedSessionRevision, projection.Revision)
		}
	}

revisionGuardDone:
	var toolCatalogBinding *ToolCatalogBinding
	allowTools := true
	if request.AllowTools != nil {
		allowTools = *request.AllowTools
	}
	if allowTools && h.tools != nil {
		binding, bindingErr := FreezeToolCatalog(ctx, h.tools)
		if bindingErr != nil {
			return AgentInputReceipt{}, fmt.Errorf("freeze tool catalog: %w", bindingErr)
		}
		toolCatalogBinding = &binding
	}
	message := &Message{ID: uuid.NewString(), SessionID: sessionID, Role: "user", Content: request.Content, Attachments: append([]Attachment(nil), request.Attachments...), CreatedAt: time.Now().UTC()}
	createRequest := CreateRunRequest{
		SessionID: sessionID, RequestID: request.RequestID, InitialMessage: message,
		Policy: policy, Provider: request.Provider, Model: request.Model,
		ContextSourceID: request.ContextSourceID, ContextSourceInstanceID: request.ContextSourceInstanceID,
		Thinking: request.Thinking, Temperature: request.Temperature, MaxTokens: request.MaxTokens,
		TaskKind: request.TaskKind, AllowTools: request.AllowTools,
		ProviderBinding:         request.providerBindingCopy(),
		ToolCatalogBinding:      toolCatalogBinding,
		ExpectedSessionRevision: expectedSessionRevision,
	}
	if mode == DispatchSteer && steerTarget.ID != "" {
		payload, payloadErr := marshalSteerInputPayload(request)
		if payloadErr != nil {
			return AgentInputReceipt{}, payloadErr
		}
		atomicResult, atomicErr := h.ledger.EnqueueSteerOrCreateRun(ctx, SteerOrQueueRequest{
			Command:   ControlCommand{ID: request.RequestID, RunID: steerTarget.ID, Action: ControlSteer, Payload: payload, ExpectedRevision: request.ExpectedRevision},
			CreateRun: createRequest,
		})
		if atomicErr != nil {
			return AgentInputReceipt{}, atomicErr
		}
		run := atomicResult.Run
		if atomicResult.Disposition == "steered" {
			h.signalSteer(run.ID)
		} else if !run.State.Terminal() {
			h.startWorker(run)
		}
		return AgentInputReceipt{RequestID: request.RequestID, SessionID: run.SessionID, RunID: run.ID,
			Disposition: atomicResult.Disposition, Revision: run.Revision, State: run.State}, nil
	}
	run, err := h.ledger.CreateRun(ctx, createRequest)
	if err != nil {
		// Two supervisors can pass the initial request lookup concurrently. The
		// unique request_id constraint is the durable winner; recover its run and
		// return the same receipt instead of surfacing a spurious database error.
		if isUniqueConstraint(err) {
			if existing, lookupErr := h.ledger.GetRunByRequestID(ctx, request.RequestID); lookupErr == nil {
				if !existing.State.Terminal() {
					h.startWorker(existing)
				}
				disposition := "started"
				if existing.State == RunStateQueued {
					disposition = "queued"
				}
				return AgentInputReceipt{RequestID: request.RequestID, SessionID: existing.SessionID, RunID: existing.ID,
					Disposition: disposition, Revision: existing.Revision, State: existing.State}, nil
			}
		}
		return AgentInputReceipt{}, err
	}
	// CreateRun is the idempotency boundary.  In particular, a retry may have
	// supplied a stale/different session hint; always return the durable run's
	// session so adapters can rebuild the correct projection.
	sessionID = run.SessionID
	disposition := "started"
	if active.ID != "" {
		disposition = "queued"
	}
	h.startWorker(run)
	return AgentInputReceipt{RequestID: request.RequestID, SessionID: sessionID, RunID: run.ID, Disposition: disposition, Revision: run.Revision, State: run.State}, nil
}

// deterministicBranchSessionID gives an edit/retry submission a stable
// session identifier. A transport retry can therefore replay CreateSession-
// Branch and CreateRun safely without creating duplicate audit branches.
func deterministicBranchSessionID(requestID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("gonavi-agent-branch:"+requestID)).String()
}

// deterministicInputSessionID gives an input without an explicit session a
// stable conversation identity.  It is intentionally distinct from branch
// IDs so a request key cannot accidentally collide with an edit/retry branch.
func deterministicInputSessionID(requestID string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("gonavi-agent-session:"+requestID)).String()
}

func firstLine(content string) string {
	line := strings.TrimSpace(strings.SplitN(strings.ReplaceAll(content, "\r\n", "\n"), "\n", 2)[0])
	if len(line) > 80 {
		line = line[:80]
	}
	if line == "" {
		return "New agent session"
	}
	return line
}

func isUniqueConstraint(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unique") || strings.Contains(message, "constraint")
}

// replayExistingSteer resolves the second durable representation of an input
// idempotency key. Steers live in control_commands rather than runs, so they
// must be replayed before consulting host-owned mutable provider settings.
func (h *AgentRunHarness) replayExistingSteer(ctx context.Context, request AgentInputRequest) (AgentInputReceipt, bool, error) {
	command, err := h.ledger.GetControlCommand(ctx, request.RequestID)
	if errors.Is(err, ErrNotFound) {
		return AgentInputReceipt{}, false, nil
	}
	if err != nil {
		return AgentInputReceipt{}, false, err
	}
	if command.Action != ControlSteer {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to action %q", ErrControlCommandConflict, command.ID, command.Action)
	}
	if request.DispatchMode != "" && request.DispatchMode != DispatchSteer {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to a steer", ErrControlCommandConflict, command.ID)
	}
	if strings.TrimSpace(request.BranchFromMessageID) != "" {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to a steer and cannot create a branch", ErrControlCommandConflict, command.ID)
	}
	run, err := h.ledger.GetRun(ctx, command.RunID)
	if err != nil {
		return AgentInputReceipt{}, true, err
	}
	if sessionID := strings.TrimSpace(request.SessionID); sessionID != "" && sessionID != run.SessionID {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to session %q", ErrControlCommandConflict, command.ID, run.SessionID)
	}
	if request.ExpectedRevision != command.ExpectedRevision {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to revision %d", ErrControlCommandConflict, command.ID, command.ExpectedRevision)
	}
	payload, err := marshalSteerInputPayload(request)
	if err != nil {
		return AgentInputReceipt{}, true, err
	}
	if !bytes.Equal(bytes.TrimSpace(command.Payload), bytes.TrimSpace(payload)) {
		return AgentInputReceipt{}, true, fmt.Errorf("%w: id %q is already bound to another steer", ErrControlCommandConflict, command.ID)
	}
	h.signalSteer(run.ID)
	return AgentInputReceipt{
		RequestID: request.RequestID, SessionID: run.SessionID, RunID: run.ID,
		Disposition: "steered", Revision: run.Revision, State: run.State,
	}, true, nil
}

func marshalSteerInputPayload(request AgentInputRequest) (json.RawMessage, error) {
	payload, err := json.Marshal(map[string]any{
		"content":                 request.Content,
		"contextSourceId":         request.ContextSourceID,
		"contextSourceInstanceId": request.ContextSourceInstanceID,
	})
	if err != nil {
		return nil, err
	}
	return payload, nil
}

func (h *AgentRunHarness) findActiveRun(ctx context.Context, sessionID string) (RunSnapshot, error) {
	projection, err := h.ledger.GetSession(ctx, sessionID, false)
	if err != nil {
		return RunSnapshot{}, err
	}
	var candidate RunSnapshot
	for _, run := range projection.Runs {
		if run.State.Terminal() {
			continue
		}
		if candidate.ID == "" || run.CreatedAt.Before(candidate.CreatedAt) {
			candidate = run
		}
	}
	if candidate.ID == "" {
		return RunSnapshot{}, ErrNotFound
	}
	return candidate, nil
}

func (h *AgentRunHarness) startWorker(run RunSnapshot) {
	if run.ID == "" || run.State.Terminal() || h.closed.Load() {
		return
	}
	h.mu.Lock()
	if h.closed.Load() {
		h.mu.Unlock()
		return
	}
	if _, exists := h.runs[run.ID]; exists {
		h.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(h.root)
	execution := &runExecution{runID: run.ID, sessionID: run.SessionID, ctx: ctx, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1), controlClaims: make(map[string]struct{}), staleWorkspaceCommands: make(map[string]struct{})}
	h.runs[run.ID] = execution
	h.wg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.wg.Done()
		defer close(execution.done)
		defer func() {
			h.mu.Lock()
			delete(h.runs, run.ID)
			h.mu.Unlock()
			cancel()
		}()
		h.run(execution)
	}()
}

func (h *AgentRunHarness) signalSteer(runID string) {
	h.mu.Lock()
	execution := h.runs[runID]
	h.mu.Unlock()
	if execution == nil {
		return
	}
	// Validate and claim the durable command before interrupting a local step.
	// Without this ordering, a canceled read-only tool can commit its result
	// first and make a command that was current at receipt look falsely stale.
	// A remote owner still validates at its own consume boundary; this fast path
	// only exists for the owner that is about to cancel its local context.
	if !execution.sideEffect.Load() {
		h.consumeControlCommands(h.durableContext(), execution)
		if execution.hasSteer() && !execution.sideEffect.Load() {
			execution.cancelStep()
		}
	}
	execution.wakeWorker()
}
