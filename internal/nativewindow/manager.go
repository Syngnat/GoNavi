package nativewindow

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"net"
	"net/http"
	"os"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/internal/webserver"

	"github.com/google/uuid"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	envParentURL = "GONAVI_DETACHED_PARENT_URL"
	envParentPID = "GONAVI_DETACHED_PARENT_PID"
	envToken     = "GONAVI_DETACHED_TOKEN"
	envWindowID  = "GONAVI_DETACHED_WINDOW_ID"
	envKind      = "GONAVI_DETACHED_KIND"
	envTitle     = "GONAVI_DETACHED_TITLE"
	envX         = "GONAVI_DETACHED_X"
	envY         = "GONAVI_DETACHED_Y"
	envWidth     = "GONAVI_DETACHED_WIDTH"
	envHeight    = "GONAVI_DETACHED_HEIGHT"
)

const (
	defaultGracefulCloseTimeout = 10 * time.Second
	defaultOpenReadyTimeout     = 10 * time.Second
	staleDetachedActionMessage  = "stale detached action ignored"
)

type processExit struct {
	err error
}

type windowEntry struct {
	info                 WindowInfo
	payload              any
	hostState            HostStateRequest
	ownerID              string
	process              childProcess
	exitReason           string
	closeGeneration      uint64
	visibilityRevision   uint64
	pendingFocusRevision uint64
	actionRevision       int64
	ready                chan struct{}
	done                 chan processExit
	readyOnce            sync.Once
	doneOnce             sync.Once
	acknowledged         bool
}

// Manager owns the loopback bridge and the registry of detached Wails child
// processes. It is intended to be bound to the main Wails window.
type Manager struct {
	mu sync.RWMutex

	shared     *webserver.SharedRuntime
	token      string
	endpoint   string
	listener   net.Listener
	httpServer *http.Server
	runtimeCtx context.Context
	started    bool
	closing    bool
	windows    map[string]*windowEntry

	starter               processStarter
	executable            string
	resolveBounds         func(WindowBounds) WindowBounds
	openTimeout           time.Duration
	closeFallbackDelay    time.Duration
	shutdownGracePeriod   time.Duration
	emitToWails           func(context.Context, string, ...any)
	emitToChildren        func(string, ...any)
	emitToChild           func(string, string, ...any)
	emitToChildBestEffort func(string, string, ...any)
}

// NewManager prepares a detached-window manager around the already-created
// desktop backend instances. InitializeLifecycle starts its random loopback
// listener after Wails provides the runtime context.
func NewManager(assetFS fs.FS, app *appcore.App, ai *aiservice.Service) (*Manager, error) {
	token, err := newBridgeToken()
	if err != nil {
		return nil, fmt.Errorf("create detached-window token failed: %w", err)
	}
	shared, err := webserver.NewSharedRuntime(assetFS, app, ai, webserver.SharedRuntimeOptions{
		RuntimeBridgePath:   RuntimePath,
		RuntimeBridgeScript: detachedRuntimeBridgeScript(),
	})
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve executable failed: %w", err)
	}
	manager := &Manager{
		shared:              shared,
		token:               token,
		windows:             make(map[string]*windowEntry),
		starter:             execProcessStarter{},
		executable:          executable,
		resolveBounds:       normalizeDetachedWindowBounds,
		openTimeout:         defaultOpenReadyTimeout,
		closeFallbackDelay:  defaultGracefulCloseTimeout,
		shutdownGracePeriod: defaultGracefulCloseTimeout,
		emitToWails: func(ctx context.Context, name string, args ...any) {
			wailsRuntime.EventsEmit(ctx, name, args...)
		},
		emitToChildren:        shared.Emit,
		emitToChild:           shared.EmitTo,
		emitToChildBestEffort: shared.EmitToBestEffort,
	}
	installDetachedDockMenu()
	return manager, nil
}

func newBridgeToken() (string, error) {
	payload := make([]byte, 32)
	if _, err := rand.Read(payload); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

// InitializeLifecycle starts the loopback bridge and attaches the main Wails
// runtime. Call it before initialising App and AI lifecycle contexts.
func InitializeLifecycle(manager *Manager, ctx context.Context) error {
	if manager == nil {
		return fmt.Errorf("native window manager is unavailable")
	}
	return manager.initialize(ctx)
}

// WithLifecycleContext makes App/AI events fan out to both the main Wails
// window and every detached child. It does not rerun either backend lifecycle.
func WithLifecycleContext(manager *Manager, ctx context.Context) context.Context {
	if manager == nil {
		return ctx
	}
	return uievents.WithEmitter(ctx, managerEventEmitter{manager: manager})
}

type managerEventEmitter struct {
	manager *Manager
}

func (e managerEventEmitter) Emit(name string, args ...any) {
	e.manager.emit(name, args...)
}

// ShutdownLifecycle closes child processes and the private loopback server.
func ShutdownLifecycle(manager *Manager) {
	if manager != nil {
		manager.shutdown()
	}
}

func (m *Manager) initialize(ctx context.Context) error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start detached-window bridge failed: %w", err)
	}

	m.mu.Lock()
	if m.started {
		m.mu.Unlock()
		_ = listener.Close()
		return nil
	}
	m.runtimeCtx = ctx
	m.listener = listener
	m.endpoint = "http://" + listener.Addr().String()
	m.started = true
	httpServer := &http.Server{
		Handler:           m.authenticatedHandler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	m.httpServer = httpServer
	m.mu.Unlock()
	registerDetachedDockMenuManager(m)

	go func() {
		_ = httpServer.Serve(listener)
	}()
	return nil
}

// emit retains normal main-window delivery and also copies backend events to
// the child-side Go SSE clients.
func (m *Manager) emit(name string, args ...any) {
	if m == nil || strings.TrimSpace(name) == "" {
		return
	}
	m.mu.RLock()
	ctx := m.runtimeCtx
	emitToWails := m.emitToWails
	emitToChildren := m.emitToChildren
	emitToChild := m.emitToChild
	emitToChildBestEffort := m.emitToChildBestEffort
	shared := m.shared
	m.mu.RUnlock()
	if ctx != nil && emitToWails != nil {
		emitToWails(ctx, name, args...)
	}
	if strings.HasPrefix(name, "ai:stream:") {
		if aiStreamEventRequiresReliableDelivery(args) {
			if emitToChild != nil {
				emitToChild("ai-chat", name, args...)
			} else if shared != nil {
				shared.EmitTo("ai-chat", name, args...)
			}
		} else if emitToChildBestEffort != nil {
			emitToChildBestEffort("ai-chat", name, args...)
		} else if shared != nil {
			shared.EmitToBestEffort("ai-chat", name, args...)
		}
		return
	}
	if emitToChildren != nil {
		emitToChildren(name, args...)
	} else if shared != nil {
		shared.Emit(name, args...)
	}
}

func aiStreamEventRequiresReliableDelivery(args []any) bool {
	if len(args) != 1 {
		return true
	}
	payload, ok := args[0].(map[string]any)
	if !ok {
		return true
	}
	if done, _ := payload["done"].(bool); done {
		return true
	}
	if errorText, _ := payload["error"].(string); strings.TrimSpace(errorText) != "" {
		return true
	}
	toolCalls := reflect.ValueOf(payload["tool_calls"])
	return toolCalls.IsValid() &&
		(toolCalls.Kind() == reflect.Array || toolCalls.Kind() == reflect.Slice) &&
		toolCalls.Len() > 0
}

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

func (m *Manager) authenticatedHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc(BootstrapPath, m.handleBootstrap)
	mux.HandleFunc(ActionPath, m.handleAction)
	mux.HandleFunc(ControlPath, m.handleControl)
	mux.HandleFunc(HostStatePath, m.handleHostState)
	mux.HandleFunc(CommandStatePath, m.handleCommandState)
	mux.Handle("/", m.shared.Handler())
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isLoopbackRemote(r.RemoteAddr) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		token := r.Header.Get(HeaderToken)
		if subtle.ConstantTimeCompare([]byte(token), []byte(m.token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
		m.mu.RLock()
		_, exists := m.windows[id]
		m.mu.RUnlock()
		if id == "" || !exists {
			http.Error(w, "unknown detached window", http.StatusForbidden)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func isLoopbackRemote(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(remoteAddr))
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (m *Manager) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	bootstrap := Bootstrap{
		ID:             entry.info.ID,
		Kind:           entry.info.Kind,
		Title:          entry.info.Title,
		Payload:        entry.payload,
		ActionRevision: entry.actionRevision,
	}
	m.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(bootstrap)
}

func (m *Manager) handleHostState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.RLock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.RUnlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	hostState := entry.hostState
	m.mu.RUnlock()
	if hostState.Revision <= 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(hostState)
}

func (m *Manager) handleCommandState(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		m.handleCommandStateAck(w, r)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.RLock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.RUnlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	closeSent := entry.info.CloseSent
	hidden := entry.info.Hidden
	visibilityRevision := entry.visibilityRevision
	pendingFocusRevision := entry.pendingFocusRevision
	reason := entry.exitReason
	m.mu.RUnlock()
	if !closeSent && !hidden && pendingFocusRevision == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if hidden && !closeSent {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(childCommand{
			ID:      id,
			Action:  "hide",
			Payload: visibilityCommandPayload{VisibilityRevision: visibilityRevision},
		})
		return
	}
	if !closeSent {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(childCommand{
			ID:      id,
			Action:  "focus",
			Payload: visibilityCommandPayload{VisibilityRevision: pendingFocusRevision},
		})
		return
	}
	if strings.TrimSpace(reason) == "" {
		reason = ExitReasonRequested
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(childCommand{
		ID:     id,
		Action: "close",
		Reason: reason,
	})
}

type commandStateRequest struct {
	Action             string `json:"action"`
	VisibilityRevision uint64 `json:"visibilityRevision"`
}

func (m *Manager) handleCommandStateAck(w http.ResponseWriter, r *http.Request) {
	defer r.Body.Close()
	var request commandStateRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid detached command acknowledgement", http.StatusBadRequest)
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	if request.Action != "ack-focus" || request.VisibilityRevision == 0 {
		http.Error(w, "invalid detached command acknowledgement", http.StatusBadRequest)
		return
	}

	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	message := ""
	if entry.pendingFocusRevision == request.VisibilityRevision {
		entry.pendingFocusRevision = 0
	} else {
		message = "stale focus acknowledgement ignored"
	}
	visibilityRevision := entry.visibilityRevision
	m.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(OperationResult{
		Success:            true,
		ID:                 id,
		Message:            message,
		VisibilityRevision: visibilityRevision,
	})
}

func (m *Manager) handleAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	var request actionRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDetachedJSONBytes))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid detached action", http.StatusBadRequest)
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	switch request.Action {
	case "ready", "sync", "attach", "close", "hide", "cancel-close", "host-event", "open-ai-settings":
	default:
		http.Error(w, "unsupported detached action", http.StatusBadRequest)
		return
	}

	id := strings.TrimSpace(r.Header.Get(HeaderWindowID))
	revision := positiveActionRevision(request.Payload)
	requestedAISettingsVisibilityRevision := uint64(0)
	m.mu.Lock()
	entry, exists := m.windows[id]
	if !exists {
		m.mu.Unlock()
		http.Error(w, "unknown detached window", http.StatusNotFound)
		return
	}
	if request.Action == "open-ai-settings" {
		requestedAISettingsVisibilityRevision = positiveVisibilityRevision(request.Payload)
		if requestedAISettingsVisibilityRevision == 0 ||
			requestedAISettingsVisibilityRevision != entry.visibilityRevision ||
			!entry.info.Hidden {
			visibilityRevision := entry.visibilityRevision
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            "open AI settings ignored after a newer visibility action",
				VisibilityRevision: visibilityRevision,
			})
			return
		}
	}
	if request.Action == "cancel-close" && (m.closing || entry.exitReason == ExitReasonParentShutdown) {
		visibilityRevision := entry.visibilityRevision
		m.mu.Unlock()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(OperationResult{
			Success:            true,
			Applied:            operationApplied(false),
			ID:                 id,
			Message:            "detached close cancellation ignored while parent is closing",
			VisibilityRevision: visibilityRevision,
		})
		return
	}
	if actionUsesRevision(request.Action) && revision > 0 {
		if revision <= entry.actionRevision {
			visibilityRevision := entry.visibilityRevision
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            staleDetachedActionMessage,
				VisibilityRevision: visibilityRevision,
			})
			return
		}
		entry.actionRevision = revision
	}
	eventAction := request.Action
	visibilityRevision := requestedAISettingsVisibilityRevision
	if request.Action == "ready" {
		entry.info.Ready = true
		entry.readyOnce.Do(func() {
			if entry.ready != nil {
				close(entry.ready)
			}
		})
	} else if request.Action == "attach" {
		if entry.exitReason == "" {
			entry.exitReason = ExitReasonAttached
		}
		entry.pendingFocusRevision = 0
	} else if request.Action == "close" && entry.exitReason == "" {
		entry.exitReason = ExitReasonWindowClosed
		entry.pendingFocusRevision = 0
	} else if request.Action == "hide" {
		requestedVisibilityRevision := positiveVisibilityRevision(request.Payload)
		switch {
		case requestedVisibilityRevision == 0:
			if !entry.info.Hidden {
				entry.visibilityRevision++
				entry.info.Hidden = true
			}
			entry.pendingFocusRevision = 0
			visibilityRevision = entry.visibilityRevision
		case requestedVisibilityRevision < entry.visibilityRevision:
			// Preserve the final child snapshot, but do not let an old hide
			// transition close a window that the host has already focused again.
			visibilityRevision = requestedVisibilityRevision
			eventAction = "sync"
		default:
			entry.visibilityRevision = requestedVisibilityRevision
			entry.info.Hidden = true
			entry.pendingFocusRevision = 0
			visibilityRevision = requestedVisibilityRevision
		}
		request.Payload = withVisibilityRevision(request.Payload, visibilityRevision)
	} else if request.Action == "cancel-close" {
		if !m.cancelCloseActionLocked(entry, rollbackActionFromPayload(request.Payload)) {
			visibilityRevision = entry.visibilityRevision
			m.mu.Unlock()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(OperationResult{
				Success:            true,
				Applied:            operationApplied(false),
				ID:                 id,
				Message:            "detached close cancellation no longer matches the active close",
				VisibilityRevision: visibilityRevision,
			})
			return
		}
	}
	info := entry.info
	ownerID := entry.ownerID
	m.mu.Unlock()
	if request.Action == "ready" || request.Action == "hide" || request.Action == "cancel-close" {
		publishDetachedDockMenuSnapshot(m)
	}

	if request.Action != "ready" {
		m.emitDetached(Event{
			ID:      info.ID,
			Kind:    info.Kind,
			Action:  eventAction,
			Payload: withOwnerWindowID(request.Payload, ownerID),
		})
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	applied := revisionedActionApplied(request.Action, revision)
	if request.Action == "open-ai-settings" {
		applied = operationApplied(true)
	}
	_ = json.NewEncoder(w).Encode(OperationResult{
		Success:            true,
		Applied:            applied,
		ID:                 id,
		VisibilityRevision: visibilityRevision,
	})
}

func actionUsesRevision(action string) bool {
	return action == "sync" || action == "attach" || action == "close" || action == "hide" || action == "cancel-close"
}

func operationApplied(value bool) *bool {
	return &value
}

func revisionedActionApplied(action string, revision int64) *bool {
	if !actionUsesRevision(action) || revision <= 0 {
		return nil
	}
	return operationApplied(true)
}

func rollbackActionFromPayload(payload any) string {
	record, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	rollbackAction, _ := record["rollbackAction"].(string)
	return strings.ToLower(strings.TrimSpace(rollbackAction))
}

func positiveVisibilityRevision(payload any) uint64 {
	switch typed := payload.(type) {
	case visibilityCommandPayload:
		return typed.VisibilityRevision
	case *visibilityCommandPayload:
		if typed != nil {
			return typed.VisibilityRevision
		}
	}
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	return positiveUintRevision(record["visibilityRevision"])
}

func positiveUintRevision(value any) uint64 {
	switch typed := value.(type) {
	case float64:
		if typed > 0 && typed <= 9_007_199_254_740_991 && math.Trunc(typed) == typed {
			return uint64(typed)
		}
	case json.Number:
		revision, err := typed.Int64()
		if err == nil && revision > 0 {
			return uint64(revision)
		}
	case uint64:
		return typed
	case uint:
		return uint64(typed)
	case int64:
		if typed > 0 {
			return uint64(typed)
		}
	case int:
		if typed > 0 {
			return uint64(typed)
		}
	}
	return 0
}

func withVisibilityRevision(payload any, visibilityRevision uint64) any {
	result := make(map[string]any)
	if source, ok := payload.(map[string]any); ok {
		for key, value := range source {
			result[key] = value
		}
	} else if payload != nil {
		result["value"] = payload
	}
	result["visibilityRevision"] = visibilityRevision
	return result
}

func positiveActionRevision(payload any) int64 {
	record, ok := payload.(map[string]any)
	if !ok {
		return 0
	}
	switch value := record["revision"].(type) {
	case float64:
		if value <= 0 || value > 9_007_199_254_740_991 || math.Trunc(value) != value {
			return 0
		}
		return int64(value)
	case json.Number:
		revision, err := value.Int64()
		if err == nil && revision > 0 {
			return revision
		}
	case int64:
		if value > 0 {
			return value
		}
	case int:
		if value > 0 {
			return int64(value)
		}
	}
	return 0
}

func (m *Manager) handleControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var request controlRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxDetachedJSONBytes))
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid detached control request", http.StatusBadRequest)
		return
	}
	request.Action = strings.ToLower(strings.TrimSpace(request.Action))
	ownerID := strings.TrimSpace(r.Header.Get(HeaderWindowID))

	var result OperationResult
	switch request.Action {
	case "open":
		if targetID := strings.TrimSpace(request.Request.ID); targetID != "" && !m.canOpenOwned(targetID, ownerID) {
			result = operationFailure("native window id belongs to another owner")
			break
		}
		result = m.open(request.Request, ownerID)
		if result.Success {
			m.emitDetached(Event{
				ID:     result.ID,
				Kind:   normalizeOpenRequest(request.Request).Kind,
				Action: "opened",
				Payload: withOwnerWindowID(
					openEventPayload(request.Request.Payload, result.Bounds),
					ownerID,
				),
			})
		}
	case "focus":
		if !m.canFocusWindow(request.ID, ownerID) {
			result = operationFailure("native window is not owned by this window")
			break
		}
		result = m.Focus(request.ID)
	case "hide":
		if !m.ownsWindow(request.ID, ownerID) {
			result = operationFailure("native window is not owned by this window")
			break
		}
		result = m.Hide(request.ID)
	case "close":
		if !m.ownsWindow(request.ID, ownerID) {
			result = operationFailure("native window is not owned by this window")
			break
		}
		result = m.Close(request.ID)
	case "close-owned":
		result = m.closeOwned(ownerID)
	default:
		http.Error(w, "unsupported detached control action", http.StatusBadRequest)
		return
	}

	status := http.StatusOK
	if !result.Success {
		status = http.StatusBadRequest
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(result)
}

func openEventPayload(payload any, bounds *WindowBounds) any {
	source, ok := payload.(map[string]any)
	if !ok {
		return nil
	}
	result := make(map[string]any, 2)
	for _, key := range []string{"tab", "resultWindow"} {
		if value, exists := source[key]; exists {
			if key == "resultWindow" && bounds != nil {
				if resultWindow, ok := value.(map[string]any); ok {
					corrected := make(map[string]any, len(resultWindow)+4)
					for field, fieldValue := range resultWindow {
						corrected[field] = fieldValue
					}
					corrected["x"] = bounds.X
					corrected["y"] = bounds.Y
					corrected["width"] = bounds.Width
					corrected["height"] = bounds.Height
					value = corrected
				}
			}
			result[key] = value
		}
	}
	return result
}

func (m *Manager) canOpenOwned(id string, ownerID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, exists := m.windows[strings.TrimSpace(id)]
	return !exists || entry.ownerID == strings.TrimSpace(ownerID)
}

func (m *Manager) ownsWindow(id string, ownerID string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, exists := m.windows[strings.TrimSpace(id)]
	return exists && entry.ownerID == strings.TrimSpace(ownerID)
}

func (m *Manager) canFocusWindow(id string, ownerID string) bool {
	id = strings.TrimSpace(id)
	ownerID = strings.TrimSpace(ownerID)
	if id == "" || ownerID == "" {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, exists := m.windows[id]
	return exists && (id == ownerID || entry.ownerID == ownerID)
}

func (m *Manager) closeOwned(ownerID string) OperationResult {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return operationFailure("native owner window is required")
	}
	m.mu.RLock()
	ids := make([]string, 0)
	for id, entry := range m.windows {
		if entry.ownerID == ownerID {
			ids = append(ids, id)
		}
	}
	m.mu.RUnlock()
	for _, id := range ids {
		m.requestClose(id, ExitReasonRequested)
	}
	return OperationResult{Success: true}
}

func withOwnerWindowID(payload any, ownerID string) any {
	ownerID = strings.TrimSpace(ownerID)
	if ownerID == "" {
		return payload
	}
	result := make(map[string]any)
	if source, ok := payload.(map[string]any); ok {
		for key, value := range source {
			result[key] = value
		}
	} else if payload != nil {
		result["value"] = payload
	}
	result["ownerWindowId"] = ownerID
	return result
}
