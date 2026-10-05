package nativewindow

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
)

type fakeProcessStarter struct {
	mu        sync.Mutex
	nextPID   int
	specs     []processSpec
	processes []*fakeChildProcess
	onStart   func(processSpec, *fakeChildProcess)
}

func (s *fakeProcessStarter) Start(spec processSpec) (childProcess, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nextPID++
	process := &fakeChildProcess{pid: s.nextPID, done: make(chan error, 1), killed: make(chan struct{})}
	s.specs = append(s.specs, spec)
	s.processes = append(s.processes, process)
	onStart := s.onStart
	if onStart != nil {
		go onStart(spec, process)
	}
	return process, nil
}

type fakeChildProcess struct {
	pid      int
	done     chan error
	killed   chan struct{}
	killOnce sync.Once
}

type readyBeforeReturnStarter struct {
	manager         *Manager
	mu              sync.Mutex
	nextPID         int
	started         []*fakeChildProcess
	skipReadySignal bool
}

func (s *readyBeforeReturnStarter) Start(spec processSpec) (childProcess, error) {
	s.mu.Lock()
	s.nextPID++
	process := &fakeChildProcess{
		pid:    s.nextPID,
		done:   make(chan error, 1),
		killed: make(chan struct{}),
	}
	s.started = append(s.started, process)
	s.mu.Unlock()

	id := environmentValue(spec.Env, envWindowID)
	s.manager.mu.Lock()
	entry := s.manager.windows[id]
	if entry != nil {
		entry.info.Ready = true
		if !s.skipReadySignal {
			entry.readyOnce.Do(func() { close(entry.ready) })
		}
	}
	s.manager.mu.Unlock()
	return process, nil
}

func (p *fakeChildProcess) PID() int { return p.pid }
func (p *fakeChildProcess) Wait() error {
	return <-p.done
}
func (p *fakeChildProcess) Kill() error {
	p.killOnce.Do(func() {
		close(p.killed)
		p.done <- errors.New("killed")
	})
	return nil
}
func (p *fakeChildProcess) finish(err error) {
	p.killOnce.Do(func() { p.done <- err })
}

func TestParseChildOptionsPreservesNegativeVirtualDesktopCoordinates(t *testing.T) {
	t.Setenv(envParentURL, "")
	t.Setenv(envToken, "")
	t.Setenv(envWindowID, "")

	options, err := ParseChildOptions([]string{
		"--parent-url=http://127.0.0.1:43119",
		"--parent-pid=4242",
		"--token=test-token",
		"--id=window-1",
		"--x=-2560",
		"--y=-180",
		"--width=1400",
		"--height=900",
	})
	if err != nil {
		t.Fatalf("ParseChildOptions returned error: %v", err)
	}
	if options.X != -2560 || options.Y != -180 {
		t.Fatalf("virtual desktop coordinates were clamped: x=%d y=%d", options.X, options.Y)
	}
	if options.ParentPID != 4242 {
		t.Fatalf("parent process ID = %d, want 4242", options.ParentPID)
	}
	if options.Width != 1400 || options.Height != 900 {
		t.Fatalf("unexpected child size: %dx%d", options.Width, options.Height)
	}
}

func TestParseChildOptionsFallsBackToCurrentParentPID(t *testing.T) {
	t.Setenv(envParentURL, "")
	t.Setenv(envParentPID, "")
	t.Setenv(envToken, "")
	t.Setenv(envWindowID, "")

	options, err := ParseChildOptions([]string{
		"--parent-url=http://127.0.0.1:43119",
		"--token=test-token",
		"--id=window-1",
	})
	if err != nil {
		t.Fatalf("ParseChildOptions returned error: %v", err)
	}
	if options.ParentPID != os.Getppid() {
		t.Fatalf("fallback parent process ID = %d, want %d", options.ParentPID, os.Getppid())
	}
}

func TestDetachedWindowMinimumSizeMatchesFrontendPresets(t *testing.T) {
	if width, height := detachedWindowMinimumSize("ai-chat"); width != 360 || height != 420 {
		t.Fatalf("AI minimum size = %dx%d, want 360x420", width, height)
	}
	if width, height := detachedWindowMinimumSize("workbench"); width != 480 || height != 320 {
		t.Fatalf("workbench minimum size = %dx%d, want 480x320", width, height)
	}
}

func TestDefaultGracefulCloseTimeoutLeavesTerminalGuardHeadroom(t *testing.T) {
	const terminalGuardTimeout = 3 * time.Second
	if defaultGracefulCloseTimeout != 10*time.Second {
		t.Fatalf("default graceful close timeout = %s, want 10s", defaultGracefulCloseTimeout)
	}
	if defaultGracefulCloseTimeout <= terminalGuardTimeout {
		t.Fatalf(
			"default graceful close timeout %s must exceed terminal guard timeout %s",
			defaultGracefulCloseTimeout,
			terminalGuardTimeout,
		)
	}

	manager := newHTTPTestManager(t)
	if manager.closeFallbackDelay != defaultGracefulCloseTimeout {
		t.Fatalf("manager close fallback = %s, want %s", manager.closeFallbackDelay, defaultGracefulCloseTimeout)
	}
	if manager.shutdownGracePeriod != defaultGracefulCloseTimeout {
		t.Fatalf("manager shutdown grace = %s, want %s", manager.shutdownGracePeriod, defaultGracefulCloseTimeout)
	}
	control := newControl(nil)
	if control.closeFallbackDelay != defaultGracefulCloseTimeout {
		t.Fatalf("child close fallback = %s, want %s", control.closeFallbackDelay, defaultGracefulCloseTimeout)
	}
}

func TestValidateOpenRequestSupportsEveryDetachedWindowKind(t *testing.T) {
	for _, kind := range []string{"workbench", "query-result", "ai-chat"} {
		if err := validateOpenRequest(OpenRequest{ID: "window-1", Kind: kind}); err != nil {
			t.Fatalf("validateOpenRequest(%q) returned error: %v", kind, err)
		}
	}
	if err := validateOpenRequest(OpenRequest{ID: "window-1", Kind: "unsupported"}); err == nil {
		t.Fatal("validateOpenRequest accepted an unsupported kind")
	}
}

func TestManagerOpenGeneratesUniqueIDsAndRegistersMultipleWindows(t *testing.T) {
	starter := &fakeProcessStarter{nextPID: 100}
	manager := &Manager{
		token:       "test-token",
		endpoint:    "http://127.0.0.1:43119",
		started:     true,
		windows:     make(map[string]*windowEntry),
		starter:     starter,
		executable:  "/tmp/GoNavi",
		openTimeout: time.Second,
	}
	starter.onStart = func(spec processSpec, _ *fakeChildProcess) {
		id := environmentValue(spec.Env, envWindowID)
		manager.mu.Lock()
		entry := manager.windows[id]
		if entry != nil {
			entry.info.Ready = true
			entry.readyOnce.Do(func() { close(entry.ready) })
		}
		manager.mu.Unlock()
	}

	first := manager.Open(OpenRequest{Kind: "workbench", X: -1920, Y: 40, Width: 1100, Height: 760})
	second := manager.Open(OpenRequest{Kind: "query-result", X: 1720, Y: -20, Width: 900, Height: 680})
	if !first.Success || !second.Success {
		t.Fatalf("Open results = %#v %#v", first, second)
	}
	if first.ID == "" || second.ID == "" || first.ID == second.ID {
		t.Fatalf("expected unique generated IDs, got %q and %q", first.ID, second.ID)
	}
	windows := manager.List()
	if len(windows) != 2 {
		t.Fatalf("registry size = %d, want 2", len(windows))
	}
	firstBounds := WindowBounds{X: -1920, Y: 40, Width: 1100, Height: 760}
	if first.Bounds == nil || *first.Bounds != firstBounds {
		t.Fatalf("first Open bounds = %#v, want %#v", first.Bounds, firstBounds)
	}
	var firstInfo *WindowInfo
	for index := range windows {
		if windows[index].ID == first.ID {
			firstInfo = &windows[index]
			break
		}
	}
	if firstInfo == nil {
		t.Fatalf("first window %q is missing from registry: %#v", first.ID, windows)
	}
	if got := *windowBoundsFromInfo(*firstInfo); got != firstBounds {
		t.Fatalf("first registry bounds = %#v, want %#v", got, firstBounds)
	}

	starter.mu.Lock()
	firstSpec := starter.specs[0]
	processes := append([]*fakeChildProcess(nil), starter.processes...)
	starter.mu.Unlock()
	if value := environmentValue(firstSpec.Env, envX); value != "-1920" {
		t.Fatalf("child x environment = %q, want -1920", value)
	}
	if value := environmentValue(firstSpec.Env, envY); value != "40" {
		t.Fatalf("child y environment = %q, want 40", value)
	}
	for _, process := range processes {
		process.finish(nil)
	}
	waitForRegistrySize(t, manager, 0)
}

func TestManagerOpenUsesResolvedBoundsForChildRegistryAndResponse(t *testing.T) {
	starter := &fakeProcessStarter{nextPID: 300}
	corrected := WindowBounds{X: 563, Y: 182, Width: 921, Height: 812}
	manager := &Manager{
		token:         "test-token",
		endpoint:      "http://127.0.0.1:43119",
		started:       true,
		windows:       make(map[string]*windowEntry),
		starter:       starter,
		executable:    "/tmp/GoNavi",
		openTimeout:   time.Second,
		resolveBounds: func(WindowBounds) WindowBounds { return corrected },
	}
	starter.onStart = func(spec processSpec, _ *fakeChildProcess) {
		id := environmentValue(spec.Env, envWindowID)
		manager.mu.Lock()
		entry := manager.windows[id]
		if entry != nil {
			entry.info.Ready = true
			entry.readyOnce.Do(func() { close(entry.ready) })
		}
		manager.mu.Unlock()
	}

	result := manager.Open(OpenRequest{
		ID: "ai-chat", Kind: "ai-chat", X: 0, Y: 1152, Width: 921, Height: 812,
	})
	if !result.Success || result.Bounds == nil || *result.Bounds != corrected {
		t.Fatalf("Open result = %#v, want corrected bounds %#v", result, corrected)
	}

	starter.mu.Lock()
	spec := starter.specs[0]
	process := starter.processes[0]
	starter.mu.Unlock()
	if value := environmentValue(spec.Env, envX); value != "563" {
		t.Fatalf("child x environment = %q, want 563", value)
	}
	if value := environmentValue(spec.Env, envY); value != "182" {
		t.Fatalf("child y environment = %q, want 182", value)
	}
	if value := environmentValue(spec.Env, envWidth); value != "921" {
		t.Fatalf("child width environment = %q, want 921", value)
	}
	if value := environmentValue(spec.Env, envHeight); value != "812" {
		t.Fatalf("child height environment = %q, want 812", value)
	}
	windows := manager.List()
	if len(windows) != 1 || windowBoundsFromInfo(windows[0]) == nil || *windowBoundsFromInfo(windows[0]) != corrected {
		t.Fatalf("registered windows = %#v, want corrected bounds %#v", windows, corrected)
	}

	process.finish(nil)
	waitForRegistrySize(t, manager, 0)
}

func TestManagerOpenAcceptsReadyAtTimeoutBoundary(t *testing.T) {
	corrected := WindowBounds{X: -1520, Y: 80, Width: 920, Height: 700}
	manager := &Manager{
		token:         "test-token",
		endpoint:      "http://127.0.0.1:43119",
		started:       true,
		windows:       make(map[string]*windowEntry),
		executable:    "/tmp/GoNavi",
		openTimeout:   time.Nanosecond,
		resolveBounds: func(WindowBounds) WindowBounds { return corrected },
	}
	starter := &readyBeforeReturnStarter{
		manager: manager, nextPID: 400, skipReadySignal: true,
	}
	manager.starter = starter

	for attempt := 0; attempt < 64; attempt++ {
		id := fmt.Sprintf("ready-at-timeout-%d", attempt)
		result := manager.Open(OpenRequest{ID: id, Kind: "workbench"})
		if !result.Success {
			t.Fatalf("Open attempt %d rejected an already-ready child: %#v", attempt, result)
		}
		if result.Bounds == nil || *result.Bounds != corrected {
			t.Fatalf("Open attempt %d bounds = %#v, want %#v", attempt, result.Bounds, corrected)
		}

		starter.mu.Lock()
		process := starter.started[len(starter.started)-1]
		starter.mu.Unlock()
		process.finish(nil)
		waitForRegistrySize(t, manager, 0)
	}
}

func newHTTPTestManager(t *testing.T) *Manager {
	t.Helper()
	assets := fstest.MapFS{
		"frontend/dist/index.html": &fstest.MapFile{Data: []byte("<html><head></head><body></body></html>")},
	}
	manager, err := NewManager(fs.FS(assets), appcore.NewWebApp(), aiservice.NewService())
	if err != nil {
		t.Fatalf("NewManager returned error: %v", err)
	}
	return manager
}

func authenticatedRequest(manager *Manager, method string, target string, id string, body *strings.Reader) *http.Request {
	var request *http.Request
	if body == nil {
		request = httptest.NewRequest(method, target, nil)
	} else {
		request = httptest.NewRequest(method, target, body)
	}
	request.RemoteAddr = "127.0.0.1:51003"
	request.Header.Set(HeaderToken, manager.token)
	request.Header.Set(HeaderWindowID, id)
	request.Header.Set("Content-Type", "application/json")
	return request
}

func environmentValue(environment []string, name string) string {
	prefix := name + "="
	for _, item := range environment {
		if strings.HasPrefix(item, prefix) {
			return strings.TrimPrefix(item, prefix)
		}
	}
	return ""
}

func TestDetachedChildProcessUsesPositionalModeAndFiltersWailsDevEnvironment(t *testing.T) {
	if argument := detachedWindowProcessArgument(); argument != "detached-window" || strings.HasPrefix(argument, "-") {
		t.Fatalf("detached child argument = %q, want positional detached-window", argument)
	}
	environment := filterDetachedChildEnvironment([]string{
		"PATH=/usr/bin",
		"assetdir=frontend/dist",
		"devserver=127.0.0.1:34115",
		"frontenddevserverurl=http://127.0.0.1:5173",
		"loglevel=debug",
	})
	for _, name := range []string{"assetdir", "devserver", "frontenddevserverurl"} {
		if value := environmentValue(environment, name); value != "" {
			t.Fatalf("filtered environment retained %s=%q", name, value)
		}
	}
	if value := environmentValue(environment, "PATH"); value != "/usr/bin" {
		t.Fatalf("PATH = %q, want /usr/bin", value)
	}
	if value := environmentValue(environment, "loglevel"); value != "debug" {
		t.Fatalf("loglevel = %q, want debug", value)
	}
}

func waitForRegistrySize(t *testing.T, manager *Manager, size int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(manager.List()) == size {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("registry size = %d, want %d", len(manager.List()), size)
}

func receiveEvent(t *testing.T, events <-chan Event) Event {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for detached event")
		return Event{}
	}
}
