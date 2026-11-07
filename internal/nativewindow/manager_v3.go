//go:build wails3

package nativewindow

import (
	"fmt"
	"net/url"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
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
	id      string
	kind    string
	title   string
	window  *application.WebviewWindow
	payload any

	ready              bool
	hidden             bool
	closing            bool
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
		URL:             "/__gonavi/detached/window/" + url.PathEscape(request.ID),
	})
	entry := &v3Window{
		id:      request.ID,
		kind:    request.Kind,
		title:   request.Title,
		window:  window,
		payload: request.Payload,
		hidden:  true,
	}
	window.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		m.handleWindowClosing(entry)
	})

	m.mu.Lock()
	m.windows[request.ID] = entry
	m.mu.Unlock()

	return OperationResult{
		Success: true,
		ID:      request.ID,
		Bounds: &WindowBounds{
			X:      request.X,
			Y:      request.Y,
			Width:  request.Width,
			Height: request.Height,
		},
	}
}

func (m *V3Manager) handleWindowClosing(entry *v3Window) {
	m.mu.Lock()
	if entry.closing {
		delete(m.windows, entry.id)
		m.mu.Unlock()
		return
	}
	entry.closing = true
	delete(m.windows, entry.id)
	m.mu.Unlock()

	m.emitMain(Event{
		ID:     entry.id,
		Kind:   entry.kind,
		Action: "close",
		Payload: map[string]any{
			"reason": ExitReasonWindowClosed,
			"exited": true,
		},
	})
}

func (m *V3Manager) Focus(id string) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if ok {
		entry.visibilityRevision++
		entry.hidden = false
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: false, Message: "unknown detached window", ID: id}
	}
	entry.window.Show()
	entry.window.Focus()
	m.emitChildCommand(entry, "focus", entry.visibilityRevision)
	return OperationResult{
		Success:            true,
		ID:                 id,
		Bounds:             windowBounds(entry.window),
		VisibilityRevision: entry.visibilityRevision,
	}
}

func (m *V3Manager) presentWindow(entry *v3Window) OperationResult {
	return m.Focus(entry.id)
}

func (m *V3Manager) Hide(id string) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if ok {
		entry.visibilityRevision++
		entry.hidden = true
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: false, Message: "unknown detached window", ID: id}
	}
	entry.window.Hide()
	m.emitChildCommand(entry, "hide", entry.visibilityRevision)
	return OperationResult{Success: true, ID: id, VisibilityRevision: entry.visibilityRevision}
}

func (m *V3Manager) Close(id string) OperationResult {
	m.mu.Lock()
	entry, ok := m.windows[id]
	if ok {
		entry.closing = true
		delete(m.windows, id)
	}
	m.mu.Unlock()
	if !ok {
		return OperationResult{Success: true, ID: id}
	}
	m.emitMain(Event{
		ID:     entry.id,
		Kind:   entry.kind,
		Action: "close",
		Payload: map[string]any{
			"reason": ExitReasonRequested,
			"exited": true,
		},
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

// Bootstrap returns the payload captured when the window was opened.
func (m *V3Manager) Bootstrap(id string) (Bootstrap, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	entry, ok := m.windows[id]
	if !ok {
		return Bootstrap{}, fmt.Errorf("unknown detached window")
	}
	return Bootstrap{
		ID:      entry.id,
		Kind:    entry.kind,
		Title:   entry.title,
		Payload: entry.payload,
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
	if action == "ready" {
		entry.ready = true
	}
	if action == "hide" {
		entry.hidden = true
		if requested := positiveVisibilityRevision(payload); requested > entry.visibilityRevision {
			entry.visibilityRevision = requested
		} else {
			entry.visibilityRevision++
		}
	}
	visibility := entry.visibilityRevision
	kind := entry.kind
	m.mu.Unlock()

	event := Event{ID: id, Kind: kind, Action: action, Payload: payload}
	if action == "hide" {
		if record, ok := payload.(map[string]any); ok {
			record["visibilityRevision"] = visibility
		} else {
			event.Payload = map[string]any{"revision": revision, "visibilityRevision": visibility}
		}
	}
	m.emitMain(event)

	switch action {
	case "attach", "close":
		m.Close(id)
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
// child through the v3 event bus.
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
