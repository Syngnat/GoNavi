package nativewindow

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

func (m *Manager) processSpecLocked(request OpenRequest) processSpec {
	env := filterDetachedChildEnvironment(os.Environ())
	values := map[string]string{
		envParentURL: m.endpoint,
		envParentPID: strconv.Itoa(os.Getpid()),
		envToken:     m.token,
		envWindowID:  request.ID,
		envKind:      request.Kind,
		envTitle:     request.Title,
		envX:         fmt.Sprintf("%d", request.X),
		envY:         fmt.Sprintf("%d", request.Y),
		envWidth:     fmt.Sprintf("%d", request.Width),
		envHeight:    fmt.Sprintf("%d", request.Height),
	}
	for name, value := range values {
		env = setEnvironmentValue(env, name, value)
	}
	return processSpec{Executable: m.executable, Env: env}
}

func setEnvironmentValue(environment []string, name string, value string) []string {
	prefix := name + "="
	filtered := environment[:0]
	for _, item := range environment {
		if !strings.HasPrefix(item, prefix) {
			filtered = append(filtered, item)
		}
	}
	return append(filtered, prefix+value)
}

func (m *Manager) watchProcess(id string, process childProcess) {
	err := process.Wait()
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists || entry.process != process {
		m.mu.Unlock()
		return
	}
	delete(m.windows, id)
	reason := entry.exitReason
	if reason == "" {
		if err != nil {
			reason = ExitReasonProcessError
		} else {
			reason = ExitReasonWindowClosed
		}
	}
	info := entry.info
	ownerID := entry.ownerID
	acknowledged := entry.acknowledged
	entry.doneOnce.Do(func() {
		if entry.done != nil {
			entry.done <- processExit{err: err}
			close(entry.done)
		}
	})
	m.mu.Unlock()
	publishDetachedDockMenuSnapshot(m)
	if !acknowledged {
		return
	}

	payload := map[string]any{
		"reason": reason,
		"exited": true,
	}
	if err != nil && reason == ExitReasonProcessError {
		payload["error"] = err.Error()
	}
	m.emitDetached(Event{
		ID:      info.ID,
		Kind:    info.Kind,
		Action:  "close",
		Payload: withOwnerWindowID(payload, ownerID),
	})
}

func (m *Manager) emitDetached(event Event) {
	if m == nil {
		return
	}
	m.mu.RLock()
	ctx := m.runtimeCtx
	emitToWails := m.emitToWails
	emitToChild := m.emitToChild
	shared := m.shared
	m.mu.RUnlock()
	if ctx != nil && emitToWails != nil {
		emitToWails(ctx, MainEventName, event)
	}
	// Only child-owned window lifecycle must cross back into a child process.
	// Top-level child sync can contain large result/history snapshots and must
	// never be broadcast to every detached SSE subscriber.
	ownerID := ownerWindowIDFromPayload(event.Payload)
	if ownerID == "" {
		return
	}
	if emitToChild != nil {
		emitToChild(ownerID, MainEventName, event)
	} else if shared != nil {
		shared.EmitTo(ownerID, MainEventName, event)
	}
}

func ownerWindowIDFromPayload(payload any) string {
	record, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	ownerID, ok := record["ownerWindowId"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(ownerID)
}

func operationFailure(message string) OperationResult {
	return OperationResult{Success: false, Message: message}
}

func windowEntryIsTerminating(entry *windowEntry) bool {
	return entry != nil && (entry.info.CloseSent || entry.exitReason != "")
}

func closingWindowRetryFailure(id string) OperationResult {
	return OperationResult{
		Success: false,
		ID:      strings.TrimSpace(id),
		Message: "native window is closing; retry after it exits",
	}
}

func validateOpenRequest(request OpenRequest) error {
	if len(request.ID) > 256 || strings.ContainsAny(request.ID, "\r\n\x00") {
		return fmt.Errorf("native window id is invalid")
	}
	if strings.ContainsRune(request.Kind, '\x00') || strings.ContainsRune(request.Title, '\x00') {
		return fmt.Errorf("native window kind or title is invalid")
	}
	if request.Kind != "workbench" && request.Kind != "query-result" && request.Kind != "ai-chat" {
		return fmt.Errorf("native window kind is unsupported")
	}
	return nil
}
