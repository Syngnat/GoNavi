//go:build wails3

package nativewindow

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const (
	// v3DetachedReadyTimeout mirrors the v2 child-process open barrier: a window
	// that never reports ready is closed and Open fails so the host can restore
	// the tab instead of leaving an invisible orphan.
	v3DetachedReadyTimeout = 10 * time.Second
	// v3CloseFallbackDelay gives the mounted frontend one chance to flush its
	// terminal state before the native window is destroyed.
	v3CloseFallbackDelay = 10 * time.Second
)

// V3Manager is the native multi-window manager used by the Wails v3 build.
// It replaces the v2 child-process bridge: each detached window is a real
// WebviewWindow in the same process, so bindings and services are shared and
// the loopback HTTP transport disappears.
type V3Manager struct {
	app *application.App

	mu      sync.Mutex
	windows map[string]*v3Window
}

type v3Window struct {
	id            string
	kind          string
	title         string
	window        *application.WebviewWindow
	payload       any
	ownerWindowID string

	ready         bool
	readySignaled bool
	readyCh       chan struct{}
	readyErr      string
	hidden        bool
	closing       bool
	// closeIntercepted is set when a native close was vetoed so the child can
	// flush its terminal state. A second native close (user insists) or the
	// fallback timer bypasses the gate.
	closeIntercepted bool
	closeFallback    *time.Timer
	pendingFocus     bool

	visibilityRevision uint64
	actionRevision     int64
	hostState          map[string]any
	hostRevision       int64
}

func NewV3Manager(app *application.App) *V3Manager {
	return &V3Manager{app: app, windows: make(map[string]*v3Window)}
}

func (m *V3Manager) Open(request OpenRequest) OperationResult {
	request = normalizeOpenRequest(request)
	request = m.normalizeBounds(request)
	if strings.TrimSpace(request.ID) == "" {
		return OperationResult{Success: false, Message: "window id is required"}
	}

	m.mu.Lock()
	if existing, ok := m.windows[request.ID]; ok {
		m.mu.Unlock()
		return m.presentWindow(existing)
	}
	m.mu.Unlock()

	minWidth, minHeight := detachedWindowMinimumSize(request.Kind)
	window := m.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:            request.ID,
		Title:           request.Title,
		Width:           request.Width,
		Height:          request.Height,
		MinWidth:        minWidth,
		MinHeight:       minHeight,
		X:               request.X,
		Y:               request.Y,
		InitialPosition: application.WindowXY,
		Frameless:       true,
		Hidden:          true,
		// Detached editors accept .sql drops even though only the main window
		// registers the host-wide drop handler.
		EnableFileDrop: true,
		URL:            "/__gonavi/detached/window/" + url.PathEscape(request.ID),
	})
	entry := &v3Window{
		id:            request.ID,
		kind:          request.Kind,
		title:         request.Title,
		window:        window,
		payload:       request.Payload,
		ownerWindowID: strings.TrimSpace(request.OwnerWindowID),
		hidden:        true,
		readyCh:       make(chan struct{}),
	}
	window.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		m.handleWindowClosing(entry, event)
	})
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		m.forwardFileDrop(entry, event)
	})

	m.mu.Lock()
	m.windows[request.ID] = entry
	m.mu.Unlock()

	readyTimer := time.NewTimer(v3DetachedReadyTimeout)
	defer readyTimer.Stop()
	select {
	case <-entry.readyCh:
	case <-readyTimer.C:
		m.mu.Lock()
		if !entry.ready {
			entry.closing = true
			entry.readyErr = "native window did not become ready in time"
			readyErr := entry.readyErr
			m.signalReadyLocked(entry)
			m.markClosedLocked(entry)
			m.stopCloseFallbackLocked(entry)
			m.mu.Unlock()
			window.Close()
			return OperationResult{Success: false, Message: readyErr, ID: request.ID}
		}
		m.mu.Unlock()
	}

	m.mu.Lock()
	ready := entry.ready
	readyErr := entry.readyErr
	closing := entry.closing
	m.mu.Unlock()
	if !ready || closing {
		if readyErr == "" {
			readyErr = "native window closed before it became ready"
		}
		return OperationResult{Success: false, Message: readyErr, ID: request.ID}
	}

	bounds := windowBounds(window)
	m.emitMain(Event{
		ID:      entry.id,
		Kind:    entry.kind,
		Action:  "opened",
		Payload: withOwnerWindowID(openEventPayload(request.Payload, bounds), entry.ownerWindowID),
	})
	return OperationResult{
		Success: true,
		ID:      request.ID,
		Bounds:  bounds,
	}
}

// normalizeBounds clamps a detached window into a visible work area. The
// frontend remembers global DIP bounds; after a monitor is unplugged those can
// point off-screen.
func (m *V3Manager) normalizeBounds(request OpenRequest) OpenRequest {
	if m == nil || m.app == nil {
		return request
	}
	screens := m.app.Screen.GetAll()
	if len(screens) == 0 {
		return request
	}
	width := max(request.Width, 320)
	height := max(request.Height, 240)
	centerX := request.X + width/2
	centerY := request.Y + height/2
	var target *application.Screen
	for _, screen := range screens {
		if screen == nil {
			continue
		}
		work := screen.WorkArea
		if centerX >= work.X && centerX < work.X+work.Width && centerY >= work.Y && centerY < work.Y+work.Height {
			target = screen
			break
		}
	}
	if target == nil {
		target = m.app.Screen.GetPrimary()
	}
	if target == nil {
		target = screens[0]
	}
	work := target.WorkArea
	if work.Width <= 0 || work.Height <= 0 {
		return request
	}
	width = min(width, work.Width)
	height = min(height, work.Height)
	x, y := request.X, request.Y
	if x < work.X || x+width > work.X+work.Width {
		x = work.X + max(0, (work.Width-width)/2)
	}
	if y < work.Y || y+height > work.Y+work.Height {
		y = work.Y + max(0, (work.Height-height)/2)
	}
	request.X, request.Y, request.Width, request.Height = x, y, width, height
	return request
}

// handleWindowClosing is the synchronous close hook. The first native close is
// vetoed so the child can send its final snapshot; a second close or the
// fallback timer lets the window go.
func (m *V3Manager) handleWindowClosing(entry *v3Window, event *application.WindowEvent) {
	m.mu.Lock()
	if entry.closing {
		m.markClosedLocked(entry)
		m.mu.Unlock()
		return
	}
	if !entry.ready {
		// Nothing was mounted, so there is no terminal payload worth waiting for.
		entry.closing = true
		entry.readyErr = "native window closed before it became ready"
		m.signalReadyLocked(entry)
		m.markClosedLocked(entry)
		m.stopCloseFallbackLocked(entry)
		m.mu.Unlock()
		m.emitClose(entry, ExitReasonWindowClosed)
		return
	}
	if entry.closeIntercepted {
		// The user closed the window again while the terminal flush was pending.
		entry.closing = true
		m.markClosedLocked(entry)
		m.stopCloseFallbackLocked(entry)
		m.mu.Unlock()
		m.emitClose(entry, ExitReasonWindowClosed)
		return
	}
	entry.closeIntercepted = true
	revision := entry.visibilityRevision
	m.mu.Unlock()

	event.Cancel()
	go m.requestFrontendClose(entry, revision)
}

func (m *V3Manager) requestFrontendClose(entry *v3Window, revision uint64) {
	m.mu.Lock()
	if entry.closing || !entry.closeIntercepted {
		m.mu.Unlock()
		return
	}
	if entry.closeFallback == nil {
		entry.closeFallback = time.AfterFunc(v3CloseFallbackDelay, func() {
			m.forceClose(entry)
		})
	}
	m.mu.Unlock()

	entry.window.EmitEvent(CommandEventName, map[string]any{
		"id":     entry.id,
		"action": "close",
		"payload": map[string]any{
			"reason":             ExitReasonWindowClosed,
			"visibilityRevision": revision,
		},
	})
}

func (m *V3Manager) forceClose(entry *v3Window) {
	m.mu.Lock()
	if entry.closing || !entry.closeIntercepted {
		entry.closeFallback = nil
		m.mu.Unlock()
		return
	}
	entry.closing = true
	entry.closeFallback = nil
	m.markClosedLocked(entry)
	m.mu.Unlock()

	m.emitClose(entry, ExitReasonWindowClosed)
	entry.window.Close()
}

func (m *V3Manager) signalReadyLocked(entry *v3Window) {
	if entry.readySignaled {
		return
	}
	entry.readySignaled = true
	close(entry.readyCh)
}

func (m *V3Manager) markClosedLocked(entry *v3Window) {
	if m.windows[entry.id] == entry {
		delete(m.windows, entry.id)
	}
	m.signalReadyLocked(entry)
}

func (m *V3Manager) stopCloseFallbackLocked(entry *v3Window) {
	if entry.closeFallback != nil {
		entry.closeFallback.Stop()
		entry.closeFallback = nil
	}
}

func (m *V3Manager) emitClose(entry *v3Window, reason string) {
	m.emitMain(Event{
		ID:     entry.id,
		Kind:   entry.kind,
		Action: "close",
		Payload: withOwnerWindowID(map[string]any{
			"reason": reason,
			"exited": true,
		}, entry.ownerWindowID),
	})
}

func (m *V3Manager) Focus(id string) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if ok {
		if entry.closing {
			m.mu.Unlock()
			return OperationResult{Success: false, Message: "native window close is already committed", ID: id}
		}
		entry.visibilityRevision++
		entry.hidden = false
		if !entry.ready {
			// Showing now would paint an empty WebView; the pending focus is
			// consumed once the child reports its first frame.
			entry.pendingFocus = true
		}
	}
	revision := uint64(0)
	ready := false
	if ok {
		revision = entry.visibilityRevision
		ready = entry.ready
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: false, Message: "unknown detached window", ID: id}
	}
	if ready {
		entry.window.Show()
		entry.window.Focus()
		m.emitChildCommand(entry, "focus", revision)
	}
	return OperationResult{
		Success:            true,
		ID:                 id,
		Bounds:             windowBounds(entry.window),
		VisibilityRevision: revision,
	}
}

func (m *V3Manager) presentWindow(entry *v3Window) OperationResult {
	return m.Focus(entry.id)
}

func (m *V3Manager) Hide(id string) OperationResult {
	return m.HideWithRevision(id, 0)
}

// HideWithRevision parks a detached window. A revision older than the last
// focus is ignored so a delayed terminal hide cannot win over a newer host
// focus.
func (m *V3Manager) HideWithRevision(id string, revision int64) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if !ok {
		m.mu.Unlock()
		return OperationResult{Success: false, Message: "unknown detached window", ID: id}
	}
	if entry.closing {
		m.mu.Unlock()
		return OperationResult{Success: false, Message: "native window close is already committed", ID: id}
	}
	requested := uint64(0)
	if revision > 0 {
		requested = uint64(revision)
	}
	switch {
	case requested == 0:
		if !entry.hidden {
			entry.visibilityRevision++
			entry.hidden = true
		}
	case requested < entry.visibilityRevision:
		current := entry.visibilityRevision
		m.mu.Unlock()
		return OperationResult{
			Success:            true,
			Message:            "stale native window hide ignored",
			ID:                 id,
			VisibilityRevision: current,
		}
	default:
		entry.visibilityRevision = requested
		entry.hidden = true
	}
	visibility := entry.visibilityRevision
	m.mu.Unlock()

	entry.window.Hide()
	m.emitChildCommand(entry, "hide", visibility)
	return OperationResult{Success: true, ID: id, VisibilityRevision: visibility}
}

func (m *V3Manager) Close(id string) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if ok {
		entry.closing = true
		m.markClosedLocked(entry)
		m.stopCloseFallbackLocked(entry)
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: true, ID: id}
	}
	m.emitMain(Event{
		ID:     entry.id,
		Kind:   entry.kind,
		Action: "close",
		Payload: withOwnerWindowID(map[string]any{
			"reason": ExitReasonRequested,
			"exited": true,
		}, entry.ownerWindowID),
	})
	entry.window.Close()
	return OperationResult{Success: true, ID: id}
}

func (m *V3Manager) CloseAll() OperationResult {
	m.mu.Lock()
	ids := make([]string, 0, len(m.windows))
	for id := range m.windows {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Close(id)
	}
	return OperationResult{Success: true}
}

// Bootstrap returns the payload captured when the window was opened plus the
// action revision the frontend needs to survive a page reload.
func (m *V3Manager) Bootstrap(id string) (Bootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.windows[id]
	if !ok {
		return Bootstrap{}, fmt.Errorf("unknown detached window")
	}
	return Bootstrap{
		ID:             entry.id,
		Kind:           entry.kind,
		Title:          entry.title,
		Payload:        entry.payload,
		ActionRevision: entry.actionRevision,
	}, nil
}

// Action accepts the detached frontend's lifecycle messages. It forwards them
// to the main window in the same shape the v2 manager used.
func (m *V3Manager) Action(id string, action string, payload any) (OperationResult, error) {
	action = strings.ToLower(strings.TrimSpace(action))
	switch action {
	case "ready", "sync", "attach", "close", "hide", "cancel-close", "host-event", "open-ai-settings":
	default:
		return OperationResult{}, fmt.Errorf("unsupported detached action")
	}

	m.mu.Lock()
	entry, ok := m.windows[id]
	if !ok {
		m.mu.Unlock()
		return OperationResult{}, fmt.Errorf("unknown detached window")
	}
	revision := positiveActionRevision(payload)
	applied := (*bool)(nil)
	if actionUsesRevision(action) && revision > 0 {
		if revision <= entry.actionRevision {
			visibility := entry.visibilityRevision
			m.mu.Unlock()
			return OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            staleDetachedActionMessage,
				VisibilityRevision: visibility,
			}, nil
		}
		entry.actionRevision = revision
		applied = operationApplied(true)
	}

	eventAction := action
	visibility := entry.visibilityRevision
	showFocus := false
	closeWindow := false
	hideWindow := false
	stampVisibility := false

	switch action {
	case "ready":
		entry.ready = true
		m.signalReadyLocked(entry)
		if entry.pendingFocus {
			entry.pendingFocus = false
			showFocus = true
			visibility = entry.visibilityRevision
		}
	case "attach":
		entry.closing = true
		m.stopCloseFallbackLocked(entry)
		m.markClosedLocked(entry)
		closeWindow = true
	case "close":
		entry.closing = true
		m.stopCloseFallbackLocked(entry)
		m.markClosedLocked(entry)
		closeWindow = true
	case "hide":
		requested := positiveVisibilityRevision(payload)
		switch {
		case requested == 0:
			if !entry.hidden {
				entry.visibilityRevision++
				entry.hidden = true
			}
			visibility = entry.visibilityRevision
		case requested < entry.visibilityRevision:
			// Preserve the final child snapshot, but do not let an old hide
			// close a window that the host has already focused again.
			visibility = requested
			eventAction = "sync"
		default:
			entry.visibilityRevision = requested
			entry.hidden = true
			visibility = requested
		}
		stampVisibility = true
	case "cancel-close":
		if !entry.closeIntercepted {
			current := entry.visibilityRevision
			m.mu.Unlock()
			return OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            "detached close cancellation no longer matches the active close",
				VisibilityRevision: current,
			}, nil
		}
		entry.closeIntercepted = false
		m.stopCloseFallbackLocked(entry)
	case "open-ai-settings":
		requested := positiveVisibilityRevision(payload)
		if requested == 0 || requested != entry.visibilityRevision || !entry.hidden {
			current := entry.visibilityRevision
			m.mu.Unlock()
			return OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            "open AI settings ignored after a newer visibility action",
				VisibilityRevision: current,
			}, nil
		}
		entry.hidden = true
		hideWindow = true
		stampVisibility = true
		visibility = requested
	}
	kind := entry.kind
	ownerID := entry.ownerWindowID
	m.mu.Unlock()

	if action == "ready" {
		if showFocus {
			entry.window.Show()
			entry.window.Focus()
			m.emitChildCommand(entry, "focus", visibility)
		}
		return OperationResult{Success: true, Applied: applied, ID: id, VisibilityRevision: visibility}, nil
	}

	eventPayload := payload
	if stampVisibility {
		eventPayload = withVisibilityRevision(payload, visibility)
	}
	m.emitMain(Event{
		ID:      id,
		Kind:    kind,
		Action:  eventAction,
		Payload: withOwnerWindowID(eventPayload, ownerID),
	})

	if hideWindow {
		entry.window.Hide()
	}
	if closeWindow {
		entry.window.Close()
	}
	if action == "open-ai-settings" {
		applied = operationApplied(true)
	}
	return OperationResult{
		Success:            true,
		Applied:            applied,
		ID:                 id,
		VisibilityRevision: visibility,
	}, nil
}

// Present shows a detached window after its first paint.
func (m *V3Manager) Present(id string) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if ok {
		if entry.closing {
			m.mu.Unlock()
			return OperationResult{Success: false, Message: "native window close is already committed", ID: id}
		}
		entry.hidden = false
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: false, Message: "unknown detached window", ID: id}
	}
	entry.window.Show()
	entry.window.Focus()
	return OperationResult{Success: true, ID: id}
}

// SyncHostState pushes the main window's latest store snapshot to a detached
// child through the v3 event bus. The host only calls this after Open has
// returned (which now waits for the child's ready handshake), so the child's
// command listener is already registered.
func (m *V3Manager) SyncHostState(request HostStateRequest) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[request.ID]
	if ok && request.Revision >= entry.hostRevision {
		entry.hostRevision = request.Revision
		entry.hostState = request.StoreState
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: false, Message: "unknown detached window", ID: request.ID}
	}
	entry.window.EmitEvent(CommandEventName, map[string]any{
		"id":     entry.id,
		"action": "sync-host-state",
		"payload": map[string]any{
			"revision":   request.Revision,
			"storeState": request.StoreState,
		},
	})
	return OperationResult{Success: true, ID: request.ID}
}

// HostState returns the latest cached host snapshot. The detached frontend
// calls it after its command listener is registered, so a sync sent while the
// page was still loading is never lost.
func (m *V3Manager) HostState(id string) (HostStateSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.windows[id]
	if !ok {
		return HostStateSnapshot{}, fmt.Errorf("unknown detached window")
	}
	return HostStateSnapshot{
		Revision:   entry.hostRevision,
		StoreState: entry.hostState,
	}, nil
}

func (m *V3Manager) emitMain(event Event) {
	if m == nil || m.app == nil {
		return
	}
	m.app.Event.Emit(MainEventName, event)
}

func (m *V3Manager) emitChildCommand(entry *v3Window, action string, visibilityRevision uint64) {
	if entry == nil || entry.window == nil {
		return
	}
	entry.window.EmitEvent(CommandEventName, map[string]any{
		"id":     entry.id,
		"action": action,
		"payload": map[string]any{
			"visibilityRevision": visibilityRevision,
		},
	})
}

// forwardFileDrop delivers a drop to the window that received it. Broadcasting
// through app.Event would make every detached workbench open the same file.
func (m *V3Manager) forwardFileDrop(entry *v3Window, event *application.WindowEvent) {
	if entry == nil || entry.window == nil {
		return
	}
	context := event.Context()
	payload := map[string]any{
		"x":     0,
		"y":     0,
		"paths": context.DroppedFiles(),
	}
	if details := context.DropTargetDetails(); details != nil {
		payload["x"] = details.X
		payload["y"] = details.Y
		payload["dropTarget"] = details
	}
	entry.window.EmitEvent("gonavi:file-drop", payload)
}

func windowBounds(window *application.WebviewWindow) *WindowBounds {
	if window == nil {
		return nil
	}
	bounds := window.Bounds()
	return &WindowBounds{
		X:      int(bounds.X),
		Y:      int(bounds.Y),
		Width:  int(bounds.Width),
		Height: int(bounds.Height),
	}
}
