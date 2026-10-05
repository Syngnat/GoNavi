package nativewindow

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Open launches one native Wails child process. Existing IDs are focused
// instead of duplicated.
func (m *Manager) Open(request OpenRequest) OperationResult {
	return m.open(request, "")
}

func (m *Manager) open(request OpenRequest, ownerID string) OperationResult {
	if m == nil {
		return operationFailure("native window manager is unavailable")
	}
	request = normalizeOpenRequest(request)
	if m.resolveBounds != nil {
		bounds := m.resolveBounds(WindowBounds{
			X: request.X, Y: request.Y, Width: request.Width, Height: request.Height,
		})
		request.X = bounds.X
		request.Y = bounds.Y
		request.Width = bounds.Width
		request.Height = bounds.Height
	}
	request.ID = strings.TrimSpace(request.ID)
	if request.ID == "" {
		request.ID = uuid.NewString()
	}
	if err := validateOpenRequest(request); err != nil {
		return operationFailure(err.Error())
	}

	m.mu.Lock()
	if !m.started || m.closing || m.endpoint == "" {
		m.mu.Unlock()
		return operationFailure("native window manager is not running")
	}
	if existing, exists := m.windows[request.ID]; exists {
		if windowEntryIsTerminating(existing) {
			m.mu.Unlock()
			return closingWindowRetryFailure(request.ID)
		}
		// A parked child keeps its WebView and React tree alive. Refresh the
		// bootstrap snapshot and remembered geometry before raising it so a
		// subsequent frontend resume can hydrate from the newest host state.
		existing.payload = request.Payload
		existing.info.Title = request.Title
		existing.info.X = request.X
		existing.info.Y = request.Y
		existing.info.Width = request.Width
		existing.info.Height = request.Height
		m.mu.Unlock()
		result := m.Focus(request.ID)
		result.ID = request.ID
		return result
	}
	entry := &windowEntry{
		info: WindowInfo{
			ID:       request.ID,
			Kind:     request.Kind,
			Title:    request.Title,
			X:        request.X,
			Y:        request.Y,
			Width:    request.Width,
			Height:   request.Height,
			OpenedAt: time.Now().UnixMilli(),
		},
		payload: request.Payload,
		ownerID: strings.TrimSpace(ownerID),
		ready:   make(chan struct{}),
		done:    make(chan processExit, 1),
	}
	m.windows[request.ID] = entry
	spec := m.processSpecLocked(request)
	starter := m.starter
	m.mu.Unlock()

	process, err := starter.Start(spec)
	if err != nil {
		m.mu.Lock()
		delete(m.windows, request.ID)
		m.mu.Unlock()
		return operationFailure(fmt.Sprintf("open native window failed: %v", err))
	}

	m.mu.Lock()
	current, exists := m.windows[request.ID]
	if !exists {
		m.mu.Unlock()
		_ = process.Kill()
		return operationFailure("native window was closed while starting")
	}
	current.process = process
	current.info.PID = process.PID()
	m.mu.Unlock()
	// A very fast child can acknowledge readiness before Start returns. Republish
	// after recording its PID so the Dock menu can identify the frontmost child.
	publishDetachedDockMenuSnapshot(m)

	go m.watchProcess(request.ID, process)
	timeout := m.openTimeout
	if timeout <= 0 {
		timeout = defaultOpenReadyTimeout
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-entry.ready:
		m.mu.Lock()
		current, active := m.windows[request.ID]
		if active && current == entry {
			entry.acknowledged = true
		}
		m.mu.Unlock()
		if !active {
			return operationFailure("native window exited before it became ready")
		}
		return OperationResult{Success: true, ID: request.ID, Bounds: windowBoundsFromRequest(request)}
	case exit := <-entry.done:
		message := "native window exited before it became ready"
		if exit.err != nil {
			message = fmt.Sprintf("%s: %v", message, exit.err)
		}
		return operationFailure(message)
	case <-timer.C:
		m.mu.Lock()
		current, active := m.windows[request.ID]
		if active && current == entry && entry.info.Ready {
			entry.acknowledged = true
			m.mu.Unlock()
			return OperationResult{Success: true, ID: request.ID, Bounds: windowBoundsFromRequest(request)}
		}
		registered := active && current == entry
		if registered {
			delete(m.windows, request.ID)
		}
		m.mu.Unlock()
		if registered {
			_ = process.Kill()
		}
		return operationFailure("native window did not become ready in time")
	}
}

// OpenResult is a convenience binding for the separately detachable result
// surface.
func (m *Manager) OpenResult(request OpenRequest) OperationResult {
	if strings.TrimSpace(request.Kind) == "" {
		request.Kind = "query-result"
	}
	return m.Open(request)
}

// Focus restores and raises an existing native child window.
func (m *Manager) Focus(id string) OperationResult {
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
	if windowEntryIsTerminating(entry) {
		m.mu.Unlock()
		return closingWindowRetryFailure(id)
	}
	wasHidden := entry.info.Hidden
	// Every explicit focus is a separately acknowledged visibility intent.
	// Advancing even while already visible prevents an acknowledgement for an
	// older focus from clearing a newer request that arrived during an SSE gap.
	entry.visibilityRevision++
	entry.info.Hidden = false
	entry.pendingFocusRevision = entry.visibilityRevision
	visibilityRevision := entry.visibilityRevision
	kind := entry.info.Kind
	bounds := windowBoundsFromInfo(entry.info)
	emitToChild := m.emitToChild
	shared := m.shared
	m.mu.Unlock()
	command := childCommand{
		ID:      id,
		Action:  "focus",
		Payload: visibilityCommandPayload{VisibilityRevision: visibilityRevision},
	}
	if emitToChild != nil {
		emitToChild(id, CommandEventName, command)
	} else if shared != nil {
		shared.EmitTo(id, CommandEventName, command)
	}
	if wasHidden {
		m.emitDetached(Event{
			ID:     id,
			Kind:   kind,
			Action: "focus",
			Payload: visibilityCommandPayload{
				VisibilityRevision: visibilityRevision,
			},
		})
		publishDetachedDockMenuSnapshot(m)
	}
	return OperationResult{
		Success:            true,
		ID:                 id,
		Bounds:             bounds,
		VisibilityRevision: visibilityRevision,
	}
}

// Hide parks a detached child without terminating its process. Repeated hides
// reuse the same visibility revision, while the next Focus advances it so a
// delayed child-side hide cannot conceal a newly focused window.
func (m *Manager) Hide(id string) OperationResult {
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
	if entry.info.CloseSent {
		m.mu.Unlock()
		return operationFailure("native window is closing")
	}
	if !entry.info.Hidden {
		entry.visibilityRevision++
		entry.info.Hidden = true
	}
	entry.pendingFocusRevision = 0
	visibilityRevision := entry.visibilityRevision
	emitToChild := m.emitToChild
	shared := m.shared
	m.mu.Unlock()

	command := childCommand{
		ID:      id,
		Action:  "hide",
		Payload: visibilityCommandPayload{VisibilityRevision: visibilityRevision},
	}
	if emitToChild != nil {
		emitToChild(id, CommandEventName, command)
	} else if shared != nil {
		shared.EmitTo(id, CommandEventName, command)
	}
	publishDetachedDockMenuSnapshot(m)
	return OperationResult{
		Success:            true,
		ID:                 id,
		VisibilityRevision: visibilityRevision,
	}
}

func windowBoundsFromRequest(request OpenRequest) *WindowBounds {
	return &WindowBounds{X: request.X, Y: request.Y, Width: request.Width, Height: request.Height}
}

func windowBoundsFromInfo(info WindowInfo) *WindowBounds {
	return &WindowBounds{X: info.X, Y: info.Y, Width: info.Width, Height: info.Height}
}
