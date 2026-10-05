package runharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

// messagesForRun selects the provider transcript boundary for the durable
// task kind. Chat is conversational and keeps the session history; query
// editor generation is a one-shot draft operation and must not inherit other
// editor requests or chat turns from a shared session.
func (h *AgentRunHarness) messagesForRun(ctx context.Context, run RunSnapshot) ([]Message, error) {
	const pageSize = 10000
	messages := make([]Message, 0)
	afterSequence := int64(0)
	for {
		var (
			page []Message
			err  error
		)
		if run.TaskKind.Normalize() == AgentTaskKindQueryEditorGeneration {
			page, err = h.ledger.GetRunMessages(ctx, run.ID, afterSequence, pageSize)
		} else {
			page, err = h.ledger.GetMessages(ctx, run.SessionID, afterSequence, pageSize)
		}
		if err != nil {
			return nil, err
		}
		messages = append(messages, page...)
		if len(page) < pageSize {
			return messages, nil
		}
		lastSequence := page[len(page)-1].Sequence
		if lastSequence <= afterSequence {
			return nil, fmt.Errorf("durable message pagination did not advance past sequence %d", afterSequence)
		}
		afterSequence = lastSequence
	}
}

// resumeAwaitingApproval consumes a decided approval after a process boundary.
// It returns false for a still-pending approval so callers can release their
// lease without changing the durable awaiting_approval state.
func (h *AgentRunHarness) resumeAwaitingApproval(ctx context.Context, run *RunSnapshot, messages *[]Message, execution *runExecution) (bool, error) {
	if h == nil || run == nil || messages == nil || execution == nil {
		return false, errors.New("approval resume requires a run owner")
	}
	approval, err := h.ledger.LatestApprovalForRun(ctx, run.ID)
	if errors.Is(err, ErrNotFound) {
		return false, errors.New("awaiting approval has no durable approval record")
	}
	if err != nil {
		return false, err
	}
	if approval.Status == "pending" {
		return false, nil
	}
	if approval.Status != "approved" && approval.Status != "denied" && approval.Status != "expired" {
		return false, fmt.Errorf("invalid approval status %q", approval.Status)
	}
	current, err := h.ledger.GetRun(ctx, run.ID)
	if err != nil {
		return false, err
	}
	if current.State != RunStateAwaitingApproval {
		*run = current
		return current.State != RunStateAwaitingApproval && !current.State.Terminal(), nil
	}
	decision := strings.ToLower(strings.TrimSpace(approval.Status))
	nextState := RunStateRunningModel
	if decision == "approved" {
		nextState = RunStateRunningTool
	}
	if _, err := h.appendState(ctx, current, EventApproval, nextState, newApprovalEvent(approval.ApprovalID, approval.CallID, approval.ToolName, approval.Effect, approval.ArgsHash, decision), execution, ""); err != nil {
		return false, err
	}
	*run, err = h.refreshRun(ctx, run.ID)
	if err != nil {
		return false, err
	}
	if decision != "approved" {
		denied := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: approval.CallID, Content: `{"error":"approval_denied"}`, CreatedAt: time.Now().UTC()}
		appended, appendErr := h.ledger.AppendMessage(h.durableContext(), denied)
		if appendErr != nil {
			return false, appendErr
		}
		*messages = append(*messages, appended)
		return true, nil
	}
	intent := ToolIntent{CallID: approval.CallID, ToolName: approval.ToolName, Arguments: append(json.RawMessage(nil), approval.Arguments...), Effect: approval.Effect, ArgsHash: approval.ArgsHash}
	execution.sideEffect.Store(intent.Effect == ToolEffectSideEffect || intent.Effect == ToolEffectSideEffectUnknown)
	startedAt := time.Now()
	toolResult, toolErr := h.executeTool(ctx, *run, intent, execution, execution.ownerToken())
	execution.sideEffect.Store(false)
	h.addActiveDuration(h.durableContext(), run.ID, time.Since(startedAt), execution.ownerToken())
	if appendErr := h.appendToolResultMessage(run, messages, intent.CallID, toolResult, toolErr); appendErr != nil {
		return false, appendErr
	}
	return true, nil
}

func (h *AgentRunHarness) appendToolResultMessage(run *RunSnapshot, messages *[]Message, callID string, result ToolExecutionResult, toolErr error) error {
	if h == nil || run == nil || messages == nil {
		return errors.New("tool result message requires a run")
	}
	if result.Message != nil {
		*messages = append(*messages, *result.Message)
		return nil
	}
	if result.MessagePersisted {
		return nil
	}
	content := marshalToolResult(result, toolErr)
	toolMessage := Message{ID: uuid.NewString(), SessionID: run.SessionID, RunID: run.ID, Role: "tool", ToolCallID: callID, Content: content, CreatedAt: time.Now().UTC()}
	appended, err := h.ledger.AppendMessage(h.durableContext(), toolMessage)
	if err != nil {
		return err
	}
	*messages = append(*messages, appended)
	return nil
}

// acquireLease keeps a queued worker alive while another supervisor owns the
// run. A one-shot lease attempt used to strand queued work permanently after a
// desktop/CLI hand-off.
func (h *AgentRunHarness) acquireLease(ctx context.Context, execution *runExecution, run RunSnapshot) (Lease, error) {
	for {
		if ctx.Err() != nil {
			return Lease{}, ctx.Err()
		}
		lease, err := h.ledger.AcquireLease(ctx, run.ID, h.ownerID, h.leaseTTL)
		if err == nil {
			return lease, nil
		}
		if !errors.Is(err, ErrLeaseUnavailable) {
			return Lease{}, err
		}
		latest, refreshErr := h.ledger.GetRun(ctx, run.ID)
		if refreshErr != nil {
			return Lease{}, refreshErr
		}
		if latest.State.Terminal() {
			return Lease{}, ErrTerminalRun
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return Lease{}, ctx.Err()
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func (h *AgentRunHarness) waitForFIFO(ctx context.Context, execution *runExecution, target RunSnapshot) bool {
	for {
		if ctx.Err() != nil {
			return false
		}
		projection, err := h.ledger.GetSession(ctx, target.SessionID, false)
		if err != nil {
			return false
		}
		blocked := false
		for _, run := range projection.Runs {
			if run.ID == target.ID || run.State.Terminal() || !runPrecedes(run, target) {
				continue
			}
			blocked = true
			break
		}
		if !blocked {
			return true
		}
		timer := time.NewTimer(h.pollInterval())
		select {
		case <-ctx.Done():
			timer.Stop()
			return false
		case <-execution.wake:
			timer.Stop()
		case <-timer.C:
		}
	}
}

func runPrecedes(left, right RunSnapshot) bool {
	if left.CreatedAt.Before(right.CreatedAt) {
		return true
	}
	if left.CreatedAt.After(right.CreatedAt) {
		return false
	}
	// SQLite timestamps have nanosecond precision, but callers can submit
	// externally constructed runs with identical timestamps. A deterministic ID
	// tie-breaker keeps the FIFO gate mutually exclusive in that case.
	return left.ID < right.ID
}

func (h *AgentRunHarness) listTools(ctx context.Context) ([]ToolDescriptor, error) {
	if h.tools == nil {
		return nil, nil
	}
	items, err := h.tools.List(ctx)
	if err != nil {
		return nil, err
	}
	return items, nil
}

func (h *AgentRunHarness) executeModel(ctx context.Context, request ModelTurnRequest, run RunSnapshot, execution *runExecution) (ModelTurnResult, error) {
	if h.model == nil {
		return ModelTurnResult{}, errors.New("model adapter is unavailable")
	}
	if ctx == nil {
		ctx = h.root
	}
	// RunPolicy owns model timing. Provider adapters must not impose a whole
	// response-body timeout (especially for Responses SSE), while the harness
	// can still enforce an optional turn and idle budget.
	modelCtx, cancelModel := context.WithCancel(ctx)
	defer cancelModel()
	var turnTimedOut atomic.Bool
	if request.Policy.ModelTurnTimeout > 0 {
		go func() {
			timer := time.NewTimer(request.Policy.ModelTurnTimeout)
			defer timer.Stop()
			select {
			case <-timer.C:
				if ctx.Err() == nil {
					turnTimedOut.Store(true)
					cancelModel()
				}
			case <-modelCtx.Done():
			}
		}()
	}
	var idleReset chan struct{}
	var idleTimedOut atomic.Bool
	if request.Policy.ModelIdleTimeout > 0 {
		idleReset = make(chan struct{}, 1)
		go func() {
			timer := time.NewTimer(request.Policy.ModelIdleTimeout)
			defer timer.Stop()
			for {
				select {
				case <-timer.C:
					if ctx.Err() == nil {
						idleTimedOut.Store(true)
					}
					cancelModel()
					return
				case <-idleReset:
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					timer.Reset(request.Policy.ModelIdleTimeout)
				case <-modelCtx.Done():
					return
				}
			}
		}()
	}
	var mu sync.Mutex
	accepting := true
	closeSink := func() {
		mu.Lock()
		accepting = false
		mu.Unlock()
	}
	// ModelTurnAdapter is an extension seam. A custom adapter can ignore the
	// supplied context or emit a callback after Execute returns, so close the
	// sink at the cancellation boundary instead of trusting adapter behavior.
	stopCancelGate := context.AfterFunc(modelCtx, closeSink)
	defer stopCancelGate()
	var textBuffer, reasoningBuffer strings.Builder
	var pendingCalls []ToolIntent
	lastFlush := time.Now()
	flushLocked := func(force bool) error {
		if textBuffer.Len() == 0 && reasoningBuffer.Len() == 0 && len(pendingCalls) == 0 {
			return nil
		}
		if !force && textBuffer.Len() < maxEventDeltaBytes && reasoningBuffer.Len() < maxEventDeltaBytes && time.Since(lastFlush) < maxEventDeltaAge {
			return nil
		}
		payload := ModelDeltaEvent{Text: textBuffer.String(), Reasoning: reasoningBuffer.String(), ToolCalls: projectModelDeltaToolIntents(pendingCalls)}
		if len(payload.ToolCalls) > 0 {
			payload.CallID = payload.ToolCalls[0].CallID
		}
		// A canceled model step still needs its already-received delta written
		// before the steer/cancel transition. The durable context preserves the
		// harness lifetime while the owner fence rejects stale callbacks.
		eventCtx := modelCtx
		if eventCtx.Err() != nil {
			eventCtx = h.durableContext()
		}
		ownerToken := ""
		if execution != nil {
			ownerToken = execution.ownerToken()
		}
		event, err := h.ledger.AppendEvent(eventCtx, AppendEventRequest{RunID: run.ID, Kind: EventModelDelta, ResultingState: RunStateRunningModel, Payload: payload, OwnerToken: ownerToken})
		if err != nil {
			return err
		}
		h.publish(event)
		textBuffer.Reset()
		reasoningBuffer.Reset()
		pendingCalls = nil
		lastFlush = time.Now()
		return nil
	}
	flush := func(force bool) error {
		mu.Lock()
		defer mu.Unlock()
		return flushLocked(force)
	}
	// Time-based flushing is independent of provider callback cadence. This
	// prevents a long-thinking provider from leaving all deltas only in memory
	// until the turn completes.
	tickerDone := make(chan struct{})
	tickerStopped := make(chan struct{})
	var stopTickerOnce sync.Once
	stopTicker := func() {
		stopTickerOnce.Do(func() { close(tickerDone) })
		<-tickerStopped
	}
	defer stopTicker()
	go func() {
		ticker := time.NewTicker(maxEventDeltaAge)
		defer ticker.Stop()
		defer close(tickerStopped)
		for {
			select {
			case <-ticker.C:
				if err := flush(false); err != nil {
					// The provider callback will observe the same error on its next
					// delivery; there is no safe way to continue writing events.
				}
			case <-tickerDone:
				return
			}
		}
	}()
	sink := ModelDeltaSink(func(deltaContext context.Context, delta ModelDelta) error {
		if deltaContext != nil && deltaContext.Err() != nil {
			return deltaContext.Err()
		}
		mu.Lock()
		defer mu.Unlock()
		if !accepting {
			return context.Canceled
		}
		if execution != nil && (execution.terminal.Load() || (execution.ctx.Err() != nil && !execution.sideEffect.Load())) {
			return context.Canceled
		}
		if delta.Text != "" {
			textBuffer.WriteString(delta.Text)
		}
		if delta.Reasoning != "" {
			reasoningBuffer.WriteString(delta.Reasoning)
		}
		if len(delta.ToolCalls) > 0 {
			pendingCalls = mergeModelDeltaToolIntents(pendingCalls, delta.ToolCalls)
		}
		if idleReset != nil {
			select {
			case idleReset <- struct{}{}:
			default:
			}
		}
		return flushLocked(false)
	})
	type modelExecutionResult struct {
		result ModelTurnResult
		err    error
	}
	// Do not let an implementation of ModelTurnAdapter that ignores ctx strand
	// the sole worker for this run. The buffered channel permits that adapter to
	// finish later without retaining a sender goroutine, while the closed sink
	// rejects every late delta.
	resultCh := make(chan modelExecutionResult, 1)
	go func() {
		result, err := h.model.Execute(modelCtx, request, sink)
		resultCh <- modelExecutionResult{result: result, err: err}
	}()

	var outcome modelExecutionResult
	select {
	case outcome = <-resultCh:
		closeSink()
	case <-modelCtx.Done():
		closeSink()
		stopTicker()
		// Preserve deltas accepted before cancellation, but never accept them
		// into the following model turn.
		_ = flush(true)
		if idleTimedOut.Load() || turnTimedOut.Load() {
			return ModelTurnResult{}, context.DeadlineExceeded
		}
		return ModelTurnResult{}, context.Canceled
	}
	stopTicker()
	if execution != nil && execution.terminal.Load() {
		_ = flush(true)
		return ModelTurnResult{}, context.Canceled
	}
	if modelCtx.Err() != nil {
		_ = flush(true)
		if idleTimedOut.Load() || turnTimedOut.Load() {
			return ModelTurnResult{}, context.DeadlineExceeded
		}
		return ModelTurnResult{}, context.Canceled
	}
	if outcome.err != nil {
		// Preserve any buffered output before reporting the provider failure.
		_ = flush(true)
		if idleTimedOut.Load() || turnTimedOut.Load() {
			return ModelTurnResult{}, context.DeadlineExceeded
		}
		return ModelTurnResult{}, outcome.err
	}
	if err := flush(true); err != nil {
		return ModelTurnResult{}, err
	}
	return outcome.result, nil
}
