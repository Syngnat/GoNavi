package nativewindow

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Close requests a graceful child shutdown and force-kills it if the WebView is
// no longer responsive.
func (m *Manager) Close(id string) OperationResult {
	if m == nil {
		return operationFailure("native window manager is unavailable")
	}
	return m.requestClose(strings.TrimSpace(id), ExitReasonRequested)
}

func (m *Manager) requestClose(id string, reason string) OperationResult {
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		return operationFailure("native window was not found")
	}
	if entry.info.CloseSent {
		m.mu.Unlock()
		return OperationResult{Success: true, ID: id}
	}
	childAlreadyClosing := entry.exitReason == ExitReasonAttached || entry.exitReason == ExitReasonWindowClosed
	if entry.exitReason == "" {
		entry.exitReason = reason
	}
	entry.info.CloseSent = true
	entry.pendingFocusRevision = 0
	entry.closeGeneration++
	closeGeneration := entry.closeGeneration
	process := entry.process
	shared := m.shared
	emitToChild := m.emitToChild
	delay := m.closeFallbackDelay
	if delay <= 0 {
		delay = defaultGracefulCloseTimeout
	}
	m.mu.Unlock()
	publishDetachedDockMenuSnapshot(m)

	// attach/close actions are emitted before their HTTP response is written.
	// Do not race that response with a second close command: the child will quit
	// itself after receiving the successful terminal-action response.
	if !childAlreadyClosing {
		command := childCommand{ID: id, Action: "close", Reason: reason}
		if emitToChild != nil {
			emitToChild(id, CommandEventName, command)
		} else if shared != nil {
			shared.EmitTo(id, CommandEventName, command)
		}
	}
	if process != nil {
		time.AfterFunc(delay, func() {
			m.mu.Lock()
			defer m.mu.Unlock()
			current, active := m.windows[id]
			if active &&
				current.process == process &&
				current.info.CloseSent &&
				current.closeGeneration == closeGeneration {
				_ = process.Kill()
			}
		})
	}
	return OperationResult{Success: true, ID: id}
}

// CancelClose clears a pending graceful-close request. Incrementing the close
// generation makes an already queued force-kill callback harmless.
func (m *Manager) CancelClose(id string) OperationResult {
	if m == nil {
		return operationFailure("native window manager is unavailable")
	}
	id = strings.TrimSpace(id)
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		return operationFailure("native window was not found")
	}
	if m.closing || entry.exitReason == ExitReasonParentShutdown {
		m.mu.Unlock()
		return operationFailure("native window manager shutdown cannot be cancelled")
	}
	m.cancelCloseLocked(entry)
	m.mu.Unlock()
	publishDetachedDockMenuSnapshot(m)
	return OperationResult{Success: true, ID: id}
}

func (m *Manager) cancelCloseLocked(entry *windowEntry) {
	entry.closeGeneration++
	entry.info.CloseSent = false
	switch entry.exitReason {
	case ExitReasonRequested, ExitReasonAttached, ExitReasonWindowClosed:
		entry.exitReason = ""
	}
}

func (m *Manager) cancelCloseActionLocked(entry *windowEntry, rollbackAction string) bool {
	if m.closing || entry == nil || entry.exitReason == ExitReasonParentShutdown {
		return false
	}
	switch rollbackAction {
	case "attach":
		if entry.info.CloseSent || (entry.exitReason != "" && entry.exitReason != ExitReasonAttached) {
			return false
		}
	case "close":
		validRequestedClose := entry.info.CloseSent && entry.exitReason == ExitReasonRequested
		validWindowClose := !entry.info.CloseSent && entry.exitReason == ExitReasonWindowClosed
		alreadyOpen := !entry.info.CloseSent && entry.exitReason == ""
		if !validRequestedClose && !validWindowClose && !alreadyOpen {
			return false
		}
	case "":
		// Compatibility with children started before rollbackAction was added.
	default:
		return false
	}
	m.cancelCloseLocked(entry)
	return true
}

// CloseAll requests graceful shutdown of every detached child.
func (m *Manager) CloseAll() OperationResult {
	if m == nil {
		return operationFailure("native window manager is unavailable")
	}
	m.mu.RLock()
	ids := make([]string, 0, len(m.windows))
	for id := range m.windows {
		ids = append(ids, id)
	}
	m.mu.RUnlock()
	for _, id := range ids {
		m.requestClose(id, ExitReasonRequested)
	}
	return OperationResult{Success: true}
}

// List returns a snapshot of the current native child registry.
func (m *Manager) List() []WindowInfo {
	if m == nil {
		return nil
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]WindowInfo, 0, len(m.windows))
	for _, entry := range m.windows {
		result = append(result, entry.info)
	}
	return result
}

// SyncHostState retains and invalidates the newest main-window snapshot for one
// active child. It deliberately bypasses the main Wails event bus so host state
// cannot echo back into the window that produced it.
func (m *Manager) SyncHostState(request HostStateRequest) OperationResult {
	if m == nil {
		return operationFailure("native window manager is unavailable")
	}
	request.ID = strings.TrimSpace(request.ID)
	if request.ID == "" {
		return operationFailure("native host-state window id is required")
	}
	if request.Revision <= 0 {
		return operationFailure("native host-state revision must be positive")
	}
	storeState, err := cloneHostStoreState(request.StoreState)
	if err != nil {
		return operationFailure(err.Error())
	}
	request.StoreState = storeState

	m.mu.Lock()
	entry, exists := m.windows[request.ID]
	if !exists {
		m.mu.Unlock()
		return operationFailure("native window was not found")
	}
	if request.Revision <= entry.hostState.Revision {
		m.mu.Unlock()
		return OperationResult{Success: true, ID: request.ID, Message: "stale host state ignored"}
	}
	entry.hostState = request
	emitToChild := m.emitToChild
	shared := m.shared
	m.mu.Unlock()

	command := childCommand{
		ID:      request.ID,
		Action:  "sync-host-state",
		Payload: hostStateInvalidationPayload{Revision: request.Revision},
	}
	if emitToChild != nil {
		emitToChild(request.ID, CommandEventName, command)
	} else if shared != nil {
		shared.EmitTo(request.ID, CommandEventName, command)
	}
	return OperationResult{Success: true, ID: request.ID}
}

type hostStateInvalidationPayload struct {
	Revision int64 `json:"revision"`
}

type visibilityCommandPayload struct {
	VisibilityRevision uint64 `json:"visibilityRevision"`
}

func cloneHostStoreState(storeState map[string]any) (map[string]any, error) {
	if storeState == nil {
		return nil, fmt.Errorf("native host-state storeState is required")
	}
	payload, err := json.Marshal(storeState)
	if err != nil {
		return nil, fmt.Errorf("encode native host state failed: %w", err)
	}
	if int64(len(payload)) > maxDetachedJSONBytes {
		return nil, fmt.Errorf("native host state exceeds the maximum payload size")
	}
	cloned := make(map[string]any)
	if err := json.Unmarshal(payload, &cloned); err != nil {
		return nil, fmt.Errorf("clone native host state failed: %w", err)
	}
	return cloned, nil
}

func (m *Manager) shutdown() {
	unregisterDetachedDockMenuManager(m)
	m.mu.Lock()
	if m.closing {
		m.mu.Unlock()
		return
	}
	m.closing = true
	ids := make([]string, 0, len(m.windows))
	for id, entry := range m.windows {
		ids = append(ids, id)
		entry.exitReason = ExitReasonParentShutdown
		entry.info.CloseSent = true
		entry.pendingFocusRevision = 0
		entry.closeGeneration++
	}
	httpServer := m.httpServer
	shared := m.shared
	emitToChild := m.emitToChild
	gracePeriod := m.shutdownGracePeriod
	if gracePeriod <= 0 {
		gracePeriod = defaultGracefulCloseTimeout
	}
	m.mu.Unlock()

	for _, id := range ids {
		command := childCommand{ID: id, Action: "close", Reason: ExitReasonParentShutdown}
		if emitToChild != nil {
			emitToChild(id, CommandEventName, command)
		} else if shared != nil {
			shared.EmitTo(id, CommandEventName, command)
		}
	}
	m.waitForChildren(gracePeriod)

	m.mu.RLock()
	processes := make([]childProcess, 0, len(m.windows))
	for _, entry := range m.windows {
		if entry.process != nil {
			processes = append(processes, entry.process)
		}
	}
	m.mu.RUnlock()
	for _, process := range processes {
		_ = process.Kill()
	}
	if httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = httpServer.Shutdown(ctx)
		cancel()
	}
	m.mu.Lock()
	m.started = false
	m.httpServer = nil
	m.listener = nil
	m.endpoint = ""
	m.mu.Unlock()
}

func (m *Manager) waitForChildren(timeout time.Duration) {
	if timeout <= 0 {
		return
	}
	pollInterval := 10 * time.Millisecond
	if timeout < pollInterval {
		pollInterval = timeout / 4
		if pollInterval <= 0 {
			pollInterval = time.Millisecond
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		m.mu.RLock()
		remaining := len(m.windows)
		m.mu.RUnlock()
		if remaining == 0 {
			return
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			return
		}
	}
}
