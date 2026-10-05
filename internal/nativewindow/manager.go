package nativewindow

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai/runharness"
	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/uievents"
	"GoNavi-Wails/internal/webserver"

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
	emitToChildBestEffort := m.emitToChildBestEffort
	shared := m.shared
	m.mu.RUnlock()
	if ctx != nil && emitToWails != nil {
		emitToWails(ctx, name, args...)
	}
	if name == runharness.EventName {
		// Run events are durably sequenced before publication. A detached chat
		// window can replay any dropped best-effort notification through
		// AIReadAgentRun, so the bridge must not preserve the old stream-specific
		// reliability and chunk-coalescing behavior.
		if emitToChildBestEffort != nil {
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
