package nativewindow

import (
	"context"
	"encoding/json"
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

func TestManagerSyncHostStateRetainsNewestRevisionAndOnlyEmitsToChildren(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{ID: "ai-chat", Kind: "ai-chat", Title: "GoNavi AI"},
	}
	type targetedCommand struct {
		targetID string
		command  childCommand
	}
	commands := make(chan targetedCommand, 2)
	manager.emitToChild = func(targetID string, name string, args ...any) {
		if name != CommandEventName || len(args) != 1 {
			t.Fatalf("unexpected child event: %q %#v", name, args)
		}
		commands <- targetedCommand{targetID: targetID, command: args[0].(childCommand)}
	}
	mainEvents := 0
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(context.Context, string, ...any) {
		mainEvents++
	}

	newestState := map[string]any{
		"activeTabId": "query-new",
		"activeContext": map[string]any{
			"connectionId": "conn-new",
			"dbName":       "analytics",
		},
	}
	result := manager.SyncHostState(HostStateRequest{
		ID:         "ai-chat",
		Revision:   2,
		StoreState: newestState,
	})
	if !result.Success {
		t.Fatalf("SyncHostState newest result = %#v", result)
	}
	newestState["activeTabId"] = "mutated-after-sync"

	stale := manager.SyncHostState(HostStateRequest{
		ID:       "ai-chat",
		Revision: 1,
		StoreState: map[string]any{
			"activeTabId": "query-stale",
		},
	})
	if !stale.Success || !strings.Contains(stale.Message, "stale") {
		t.Fatalf("SyncHostState stale result = %#v", stale)
	}

	targeted := <-commands
	if targeted.targetID != "ai-chat" {
		t.Fatalf("host-state target = %q, want ai-chat", targeted.targetID)
	}
	command := targeted.command
	if command.ID != "ai-chat" || command.Action != "sync-host-state" {
		t.Fatalf("unexpected host-state command: %#v", command)
	}
	payload, ok := command.Payload.(hostStateInvalidationPayload)
	if !ok || payload.Revision != 2 {
		t.Fatalf("unexpected host-state payload: %#v", command.Payload)
	}
	select {
	case duplicate := <-commands:
		t.Fatalf("stale revision was emitted: %#v", duplicate)
	default:
	}
	if mainEvents != 0 {
		t.Fatalf("host state echoed to main Wails window %d times", mainEvents)
	}

	manager.mu.RLock()
	retained := manager.windows["ai-chat"].hostState
	manager.mu.RUnlock()
	if retained.Revision != 2 || retained.StoreState["activeTabId"] != "query-new" {
		t.Fatalf("retained host state = %#v", retained)
	}
}

func TestManagerRoutesCommandsAndAIStreamsToOnlyTheirTargetWindow(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["workbench:query-a"] = &windowEntry{
		info: WindowInfo{ID: "workbench:query-a", Kind: "workbench"},
	}
	manager.runtimeCtx = context.Background()

	type emittedEvent struct {
		targetID string
		name     string
		args     []any
	}
	reliable := make(chan emittedEvent, 2)
	bestEffort := make(chan emittedEvent, 2)
	broadcast := make(chan emittedEvent, 2)
	mainEvents := make(chan emittedEvent, 2)
	manager.emitToChild = func(targetID string, name string, args ...any) {
		reliable <- emittedEvent{targetID: targetID, name: name, args: args}
	}
	manager.emitToChildBestEffort = func(targetID string, name string, args ...any) {
		bestEffort <- emittedEvent{targetID: targetID, name: name, args: args}
	}
	manager.emitToChildren = func(name string, args ...any) {
		broadcast <- emittedEvent{name: name, args: args}
	}
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		mainEvents <- emittedEvent{name: name, args: args}
	}

	if result := manager.Focus("workbench:query-a"); !result.Success {
		t.Fatalf("Focus result = %#v", result)
	}
	focus := <-reliable
	if focus.targetID != "workbench:query-a" || focus.name != CommandEventName {
		t.Fatalf("focus event = %#v", focus)
	}
	if command := focus.args[0].(childCommand); command.Action != "focus" {
		t.Fatalf("focus command = %#v", command)
	}

	if result := manager.Close("workbench:query-a"); !result.Success {
		t.Fatalf("Close result = %#v", result)
	}
	closeEvent := <-reliable
	if closeEvent.targetID != "workbench:query-a" || closeEvent.name != CommandEventName {
		t.Fatalf("close event = %#v", closeEvent)
	}
	if command := closeEvent.args[0].(childCommand); command.Action != "close" {
		t.Fatalf("close command = %#v", command)
	}

	manager.emit("ai:run:event", map[string]any{"runId": "run-1", "sequence": 1, "kind": "model_delta"})
	stream := <-bestEffort
	if stream.targetID != "ai-chat" || stream.name != "ai:run:event" {
		t.Fatalf("AI run event = %#v", stream)
	}
	if main := <-mainEvents; main.name != "ai:run:event" {
		t.Fatalf("main AI run event = %#v", main)
	}
	select {
	case leaked := <-broadcast:
		t.Fatalf("AI run event was broadcast to every child: %#v", leaked)
	default:
	}

	manager.emit("sqlfile:progress", map[string]any{"current": 1})
	if normal := <-broadcast; normal.name != "sqlfile:progress" {
		t.Fatalf("normal backend event = %#v", normal)
	}
}

func TestManagerHideIsIdempotentAndFocusAdvancesVisibilityRevision(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{
			ID:     "ai-chat",
			Kind:   "ai-chat",
			X:      10,
			Y:      20,
			Width:  440,
			Height: 720,
		},
	}
	commands := make(chan childCommand, 3)
	events := make(chan Event, 2)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}
	manager.emitToChild = func(targetID string, name string, args ...any) {
		if targetID != "ai-chat" || name != CommandEventName {
			t.Fatalf("unexpected target event %q %q", targetID, name)
		}
		commands <- args[0].(childCommand)
	}

	firstHide := manager.Hide("ai-chat")
	if !firstHide.Success || firstHide.VisibilityRevision != 1 {
		t.Fatalf("first Hide result = %#v", firstHide)
	}
	firstHideCommand := <-commands
	if firstHideCommand.Action != "hide" ||
		firstHideCommand.Payload.(visibilityCommandPayload).VisibilityRevision != 1 {
		t.Fatalf("first hide command = %#v", firstHideCommand)
	}

	secondHide := manager.Hide("ai-chat")
	if !secondHide.Success || secondHide.VisibilityRevision != 1 {
		t.Fatalf("second Hide result = %#v", secondHide)
	}
	secondHideCommand := <-commands
	if secondHideCommand.Action != "hide" ||
		secondHideCommand.Payload.(visibilityCommandPayload).VisibilityRevision != 1 {
		t.Fatalf("second hide command = %#v", secondHideCommand)
	}

	focus := manager.Focus("ai-chat")
	if !focus.Success || focus.VisibilityRevision != 2 {
		t.Fatalf("Focus result = %#v", focus)
	}
	focusCommand := <-commands
	if focusCommand.Action != "focus" ||
		focusCommand.Payload.(visibilityCommandPayload).VisibilityRevision != 2 {
		t.Fatalf("focus command = %#v", focusCommand)
	}
	focusEvent := receiveEvent(t, events)
	if focusEvent.ID != "ai-chat" || focusEvent.Kind != "ai-chat" || focusEvent.Action != "focus" ||
		positiveVisibilityRevision(focusEvent.Payload) != 2 {
		t.Fatalf("focus lifecycle event = %#v", focusEvent)
	}
	manager.mu.RLock()
	hidden := manager.windows["ai-chat"].info.Hidden
	manager.mu.RUnlock()
	if hidden {
		t.Fatal("focused window remained hidden in manager state")
	}
}

func TestManagerReplaysLatestFocusUntilChildAcknowledgesIt(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{
			ID:     "ai-chat",
			Kind:   "ai-chat",
			Hidden: true,
		},
		visibilityRevision: 1,
	}
	// Simulate a disconnected child: reliable SSE has no subscriber and the
	// immediate delivery therefore disappears.
	manager.emitToChild = func(string, string, ...any) {}

	first := manager.Focus("ai-chat")
	second := manager.Focus("ai-chat")
	if !first.Success || first.VisibilityRevision != 2 ||
		!second.Success || second.VisibilityRevision != 3 {
		t.Fatalf("Focus results = %#v %#v", first, second)
	}

	replay := func() (*httptest.ResponseRecorder, childCommand) {
		t.Helper()
		request := authenticatedRequest(manager, http.MethodGet, CommandStatePath, "ai-chat", nil)
		recorder := httptest.NewRecorder()
		manager.authenticatedHandler().ServeHTTP(recorder, request)
		var command childCommand
		if recorder.Code == http.StatusOK {
			if err := json.NewDecoder(recorder.Body).Decode(&command); err != nil {
				t.Fatalf("decode command state: %v", err)
			}
		}
		return recorder, command
	}

	recorder, command := replay()
	if recorder.Code != http.StatusOK || command.Action != "focus" ||
		positiveVisibilityRevision(command.Payload) != 3 {
		t.Fatalf("pending focus replay = status %d command %#v", recorder.Code, command)
	}

	staleAck := strings.NewReader(`{"action":"ack-focus","visibilityRevision":2}`)
	staleRequest := authenticatedRequest(manager, http.MethodPost, CommandStatePath, "ai-chat", staleAck)
	staleRecorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(staleRecorder, staleRequest)
	if staleRecorder.Code != http.StatusOK {
		t.Fatalf("stale focus ack status = %d body=%s", staleRecorder.Code, staleRecorder.Body.String())
	}
	if recorder, command = replay(); recorder.Code != http.StatusOK ||
		command.Action != "focus" || positiveVisibilityRevision(command.Payload) != 3 {
		t.Fatalf("focus after stale ack = status %d command %#v", recorder.Code, command)
	}

	latestAck := strings.NewReader(`{"action":"ack-focus","visibilityRevision":3}`)
	latestRequest := authenticatedRequest(manager, http.MethodPost, CommandStatePath, "ai-chat", latestAck)
	latestRecorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(latestRecorder, latestRequest)
	if latestRecorder.Code != http.StatusOK {
		t.Fatalf("latest focus ack status = %d body=%s", latestRecorder.Code, latestRecorder.Body.String())
	}
	if recorder, _ = replay(); recorder.Code != http.StatusNoContent {
		t.Fatalf("command state after focus ack = %d body=%s, want 204", recorder.Code, recorder.Body.String())
	}
}

func TestManagerCommandStatePrioritizesHideAndCloseOverPendingFocus(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info:               WindowInfo{ID: "ai-chat", Kind: "ai-chat", Hidden: true},
		visibilityRevision: 1,
	}
	manager.emitToChild = func(string, string, ...any) {}

	if result := manager.Focus("ai-chat"); !result.Success {
		t.Fatalf("Focus result = %#v", result)
	}
	if result := manager.Hide("ai-chat"); !result.Success {
		t.Fatalf("Hide result = %#v", result)
	}
	request := authenticatedRequest(manager, http.MethodGet, CommandStatePath, "ai-chat", nil)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	var command childCommand
	if err := json.NewDecoder(recorder.Body).Decode(&command); err != nil {
		t.Fatalf("decode hidden command state: %v", err)
	}
	if recorder.Code != http.StatusOK || command.Action != "hide" {
		t.Fatalf("hidden command state = status %d command %#v", recorder.Code, command)
	}

	if result := manager.Close("ai-chat"); !result.Success {
		t.Fatalf("Close result = %#v", result)
	}
	request = authenticatedRequest(manager, http.MethodGet, CommandStatePath, "ai-chat", nil)
	recorder = httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if err := json.NewDecoder(recorder.Body).Decode(&command); err != nil {
		t.Fatalf("decode closing command state: %v", err)
	}
	if recorder.Code != http.StatusOK || command.Action != "close" {
		t.Fatalf("closing command state = status %d command %#v", recorder.Code, command)
	}
}

func TestManagerFocusAndOpenRejectClosingWindowForRetry(t *testing.T) {
	manager := newHTTPTestManager(t)
	starter := &fakeProcessStarter{}
	manager.started = true
	manager.endpoint = "http://127.0.0.1:43119"
	manager.starter = starter
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{
			ID:        "ai-chat",
			Kind:      "ai-chat",
			Title:     "Existing",
			X:         10,
			Y:         20,
			Width:     440,
			Height:    720,
			Hidden:    true,
			CloseSent: true,
		},
		payload:            map[string]any{"snapshot": "existing"},
		visibilityRevision: 4,
	}

	for name, result := range map[string]OperationResult{
		"focus": manager.Focus("ai-chat"),
		"open": manager.Open(OpenRequest{
			ID:      "ai-chat",
			Kind:    "ai-chat",
			Title:   "Replacement",
			Payload: map[string]any{"snapshot": "replacement"},
			X:       30,
			Y:       40,
			Width:   500,
			Height:  800,
		}),
	} {
		if result.Success || !strings.Contains(result.Message, "closing") ||
			!strings.Contains(result.Message, "retry") {
			t.Fatalf("%s result = %#v, want explicit retry failure", name, result)
		}
	}

	manager.mu.RLock()
	entry := manager.windows["ai-chat"]
	payload := entry.payload.(map[string]any)["snapshot"]
	info := entry.info
	revision := entry.visibilityRevision
	manager.mu.RUnlock()
	if payload != "existing" || info.Title != "Existing" || info.X != 10 || info.Y != 20 ||
		!info.Hidden || revision != 4 {
		t.Fatalf("closing entry was mutated: info=%#v payload=%#v revision=%d", info, payload, revision)
	}
	starter.mu.Lock()
	starts := len(starter.specs)
	starter.mu.Unlock()
	if starts != 0 {
		t.Fatalf("closing entry spawned %d replacement processes, want 0", starts)
	}
}

func TestHideActionParksWithoutCommittingTerminalState(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{ID: "ai-chat", Kind: "ai-chat", Ready: true},
	}
	events := make(chan Event, 2)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	body := strings.NewReader(`{"action":"hide","payload":{"id":"ai-chat","kind":"ai-chat","revision":1}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("hide status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var result OperationResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatalf("decode hide result: %v", err)
	}
	if !result.Success || result.VisibilityRevision != 1 {
		t.Fatalf("hide result = %#v", result)
	}
	event := receiveEvent(t, events)
	if event.Action != "hide" || event.ID != "ai-chat" {
		t.Fatalf("hide event = %#v", event)
	}
	payload := event.Payload.(map[string]any)
	if payload["visibilityRevision"] != uint64(1) {
		t.Fatalf("hide payload = %#v", payload)
	}
	manager.mu.RLock()
	entry := manager.windows["ai-chat"]
	hidden := entry.info.Hidden
	closeSent := entry.info.CloseSent
	exitReason := entry.exitReason
	manager.mu.RUnlock()
	if !hidden || closeSent || exitReason != "" {
		t.Fatalf(
			"parked state = hidden %v closeSent %v reason %q",
			hidden,
			closeSent,
			exitReason,
		)
	}
}

func TestStaleHideActionCannotOverrideNewerFocus(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info:               WindowInfo{ID: "ai-chat", Kind: "ai-chat", Ready: true, Hidden: true},
		visibilityRevision: 1,
		actionRevision:     1,
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	if result := manager.Focus("ai-chat"); !result.Success || result.VisibilityRevision != 2 {
		t.Fatalf("Focus result = %#v", result)
	}
	focusEvent := receiveEvent(t, events)
	if focusEvent.Action != "focus" || positiveVisibilityRevision(focusEvent.Payload) != 2 {
		t.Fatalf("Focus event = %#v", focusEvent)
	}
	body := strings.NewReader(
		`{"action":"hide","payload":{"id":"ai-chat","kind":"ai-chat","revision":2,"visibilityRevision":1}}`,
	)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("stale hide status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	event := receiveEvent(t, events)
	if event.Action != "sync" {
		t.Fatalf("stale hide event = %#v, want sync", event)
	}
	manager.mu.RLock()
	entry := manager.windows["ai-chat"]
	hidden := entry.info.Hidden
	revision := entry.visibilityRevision
	manager.mu.RUnlock()
	if hidden || revision != 2 {
		t.Fatalf("state after stale hide = hidden %v revision %d", hidden, revision)
	}
}

func TestAuthenticatedHostStateEndpointReturnsRetainedSnapshot(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{ID: "ai-chat", Kind: "ai-chat"},
		hostState: HostStateRequest{
			ID:         "ai-chat",
			Revision:   7,
			StoreState: map[string]any{"activeTabId": "query-7"},
		},
	}

	request := authenticatedRequest(manager, http.MethodGet, HostStatePath, "ai-chat", nil)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("host-state status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var snapshot HostStateRequest
	if err := json.NewDecoder(recorder.Body).Decode(&snapshot); err != nil {
		t.Fatalf("decode host-state response: %v", err)
	}
	if snapshot.ID != "ai-chat" || snapshot.Revision != 7 || snapshot.StoreState["activeTabId"] != "query-7" {
		t.Fatalf("unexpected host-state response: %#v", snapshot)
	}

	manager.windows["workbench:query-empty"] = &windowEntry{
		info: WindowInfo{ID: "workbench:query-empty", Kind: "workbench"},
	}
	emptyRequest := authenticatedRequest(manager, http.MethodGet, HostStatePath, "workbench:query-empty", nil)
	emptyRecorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(emptyRecorder, emptyRequest)
	if emptyRecorder.Code != http.StatusNoContent {
		t.Fatalf("empty host-state status = %d, want 204", emptyRecorder.Code)
	}
}

func TestAuthenticatedHandlerRequiresLoopbackTokenAndRegisteredWindow(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["window-1"] = &windowEntry{
		info:           WindowInfo{ID: "window-1", Kind: "query-result", Title: "Result"},
		payload:        map[string]any{"value": "shared"},
		actionRevision: 17,
		ready:          make(chan struct{}),
	}
	handler := manager.authenticatedHandler()

	missingToken := httptest.NewRequest(http.MethodGet, BootstrapPath, nil)
	missingToken.RemoteAddr = "127.0.0.1:51001"
	missingToken.Header.Set(HeaderWindowID, "window-1")
	missingRecorder := httptest.NewRecorder()
	handler.ServeHTTP(missingRecorder, missingToken)
	if missingRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("missing-token status = %d, want 401", missingRecorder.Code)
	}

	remoteRequest := httptest.NewRequest(http.MethodGet, BootstrapPath, nil)
	remoteRequest.RemoteAddr = "192.0.2.10:51002"
	remoteRequest.Header.Set(HeaderToken, manager.token)
	remoteRequest.Header.Set(HeaderWindowID, "window-1")
	remoteRecorder := httptest.NewRecorder()
	handler.ServeHTTP(remoteRecorder, remoteRequest)
	if remoteRecorder.Code != http.StatusForbidden {
		t.Fatalf("non-loopback status = %d, want 403", remoteRecorder.Code)
	}

	unknownRequest := authenticatedRequest(manager, http.MethodGet, BootstrapPath, "window-2", nil)
	unknownRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unknownRecorder, unknownRequest)
	if unknownRecorder.Code != http.StatusForbidden {
		t.Fatalf("unknown-window status = %d, want 403", unknownRecorder.Code)
	}

	validRequest := authenticatedRequest(manager, http.MethodGet, BootstrapPath, "window-1", nil)
	validRecorder := httptest.NewRecorder()
	handler.ServeHTTP(validRecorder, validRequest)
	if validRecorder.Code != http.StatusOK {
		t.Fatalf("valid bootstrap status = %d body=%s", validRecorder.Code, validRecorder.Body.String())
	}
	if !strings.Contains(validRecorder.Body.String(), `"id":"window-1"`) ||
		!strings.Contains(validRecorder.Body.String(), `"value":"shared"`) ||
		!strings.Contains(validRecorder.Body.String(), `"actionRevision":17`) {
		t.Fatalf("unexpected bootstrap body: %s", validRecorder.Body.String())
	}
	select {
	case <-manager.windows["window-1"].ready:
		t.Fatal("bootstrap read acknowledged the window before frontend mount")
	default:
	}

	readyBody := strings.NewReader(`{"action":"ready","payload":{"id":"window-1","kind":"query-result"}}`)
	readyRequest := authenticatedRequest(manager, http.MethodPost, ActionPath, "window-1", readyBody)
	readyRecorder := httptest.NewRecorder()
	handler.ServeHTTP(readyRecorder, readyRequest)
	if readyRecorder.Code != http.StatusOK {
		t.Fatalf("ready status = %d body=%s", readyRecorder.Code, readyRecorder.Body.String())
	}
	select {
	case <-manager.windows["window-1"].ready:
	case <-time.After(time.Second):
		t.Fatal("ready action did not acknowledge the native window")
	}
}

func TestOpenAISettingsActionIsForwardedWithoutClosingTheChild(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info:               WindowInfo{ID: "ai-chat", Kind: "ai-chat", Title: "GoNavi AI", Hidden: true},
		ready:              make(chan struct{}),
		visibilityRevision: 7,
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	body := strings.NewReader(`{"action":"open-ai-settings","payload":{"id":"ai-chat","kind":"ai-chat","visibilityRevision":7}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("open-ai-settings status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	event := receiveEvent(t, events)
	if event.ID != "ai-chat" || event.Kind != "ai-chat" || event.Action != "open-ai-settings" {
		t.Fatalf("unexpected open-ai-settings event: %#v", event)
	}
	manager.mu.RLock()
	exitReason := manager.windows["ai-chat"].exitReason
	manager.mu.RUnlock()
	if exitReason != "" {
		t.Fatalf("open-ai-settings marked child terminal: %q", exitReason)
	}
}

func TestOpenAISettingsActionIsIgnoredAfterANewerFocus(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info:               WindowInfo{ID: "ai-chat", Kind: "ai-chat", Hidden: true},
		ready:              make(chan struct{}),
		visibilityRevision: 7,
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	focusResult := manager.Focus("ai-chat")
	if !focusResult.Success || focusResult.VisibilityRevision != 8 {
		t.Fatalf("Focus result = %#v", focusResult)
	}
	focusEvent := receiveEvent(t, events)
	if focusEvent.Action != "focus" || positiveVisibilityRevision(focusEvent.Payload) != 8 {
		t.Fatalf("Focus event = %#v", focusEvent)
	}
	body := strings.NewReader(`{"action":"open-ai-settings","payload":{"id":"ai-chat","kind":"ai-chat","visibilityRevision":7}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("stale open-ai-settings status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var result OperationResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatalf("decode stale open-ai-settings result: %v", err)
	}
	if !result.Success || result.Applied == nil || *result.Applied {
		t.Fatalf("stale open-ai-settings result = %#v", result)
	}
	select {
	case event := <-events:
		t.Fatalf("stale open-ai-settings emitted event: %#v", event)
	default:
	}
}

func TestChildControlOpensAndRoutesAnOwnedNativeWindow(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.started = true
	manager.endpoint = "http://127.0.0.1:43119"
	manager.executable = "/tmp/GoNavi"
	manager.openTimeout = time.Second
	requestedBounds := WindowBounds{X: 2100, Y: -120, Width: 900, Height: 620}
	correctedBounds := WindowBounds{X: 96, Y: 80, Width: 800, Height: 500}
	manager.resolveBounds = func(bounds WindowBounds) WindowBounds {
		if bounds != requestedBounds {
			t.Fatalf("bounds resolver input = %#v, want %#v", bounds, requestedBounds)
		}
		return correctedBounds
	}
	manager.windows["workbench:query-a"] = &windowEntry{
		info: WindowInfo{ID: "workbench:query-a", Kind: "workbench", Title: "SQL"},
	}

	starter := &fakeProcessStarter{nextPID: 500}
	manager.starter = starter
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

	events := make(chan Event, 4)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	body := strings.NewReader(`{
        "action":"open",
        "request":{
          "id":"query-result:query-a:r1",
          "kind":"query-result",
          "title":"Result 1",
          "x":2100,
          "y":-120,
          "width":900,
          "height":620,
          "payload":{
            "storeState":{},
            "resultWindow":{
              "id":"query-result:query-a:r1",
              "sourceQueryTabId":"query-a",
              "x":2100,
              "y":-120,
              "width":900,
              "height":620
            }
          }
        }
      }`)
	request := authenticatedRequest(manager, http.MethodPost, ControlPath, "workbench:query-a", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("owned open status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	manager.mu.RLock()
	ownedEntry := manager.windows["query-result:query-a:r1"]
	manager.mu.RUnlock()
	if ownedEntry == nil || ownedEntry.ownerID != "workbench:query-a" {
		t.Fatalf("owned entry = %#v, want owner workbench:query-a", ownedEntry)
	}
	opened := receiveEvent(t, events)
	if opened.ID != "query-result:query-a:r1" || opened.Action != "opened" {
		t.Fatalf("unexpected opened event: %#v", opened)
	}
	payload, ok := opened.Payload.(map[string]any)
	if !ok || payload["ownerWindowId"] != "workbench:query-a" {
		t.Fatalf("opened event owner metadata = %#v", opened.Payload)
	}
	resultWindow, ok := payload["resultWindow"].(map[string]any)
	if !ok {
		t.Fatalf("opened event result window = %#v, want structured payload", payload["resultWindow"])
	}
	if resultWindow["sourceQueryTabId"] != "query-a" {
		t.Fatalf("opened event result window lost source metadata: %#v", resultWindow)
	}
	if resultWindow["x"] != correctedBounds.X ||
		resultWindow["y"] != correctedBounds.Y ||
		resultWindow["width"] != correctedBounds.Width ||
		resultWindow["height"] != correctedBounds.Height {
		t.Fatalf("opened event result bounds = %#v, want %#v", resultWindow, correctedBounds)
	}

	manager.windows["foreign-window"] = &windowEntry{
		info:    WindowInfo{ID: "foreign-window", Kind: "query-result"},
		ownerID: "workbench:query-b",
	}
	foreignBody := strings.NewReader(`{"action":"close","id":"foreign-window"}`)
	foreignRequest := authenticatedRequest(manager, http.MethodPost, ControlPath, "workbench:query-a", foreignBody)
	foreignRecorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(foreignRecorder, foreignRequest)
	if foreignRecorder.Code != http.StatusBadRequest {
		t.Fatalf("foreign close status = %d, want 400", foreignRecorder.Code)
	}

	starter.mu.Lock()
	process := starter.processes[0]
	starter.mu.Unlock()
	process.finish(nil)
	waitForRegistrySize(t, manager, 2)
}

func TestActionAndProcessExitEmitStableMainEventPayload(t *testing.T) {
	manager := newHTTPTestManager(t)
	events := make(chan Event, 4)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			if event, ok := args[0].(Event); ok {
				events <- event
			}
		}
	}
	process := &fakeChildProcess{pid: 42, done: make(chan error, 1), killed: make(chan struct{})}
	manager.windows["window-1"] = &windowEntry{
		info:         WindowInfo{ID: "window-1", Kind: "workbench", Title: "SQL"},
		ownerID:      "workbench:source",
		process:      process,
		acknowledged: true,
	}

	actionBody := strings.NewReader(`{"action":"sync","payload":{"id":"window-1","storeState":{"activeTab":"sql"}}}`)
	actionRequest := authenticatedRequest(manager, http.MethodPost, ActionPath, "window-1", actionBody)
	actionRecorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(actionRecorder, actionRequest)
	if actionRecorder.Code != http.StatusOK {
		t.Fatalf("action status = %d body=%s", actionRecorder.Code, actionRecorder.Body.String())
	}
	syncEvent := receiveEvent(t, events)
	if syncEvent.ID != "window-1" || syncEvent.Kind != "workbench" || syncEvent.Action != "sync" {
		t.Fatalf("unexpected sync event: %#v", syncEvent)
	}
	if payload, ok := syncEvent.Payload.(map[string]any); !ok || payload["ownerWindowId"] != "workbench:source" {
		t.Fatalf("sync event is missing owner metadata: %#v", syncEvent.Payload)
	}

	go manager.watchProcess("window-1", process)
	process.finish(errors.New("exit status 9"))
	exitEvent := receiveEvent(t, events)
	if exitEvent.ID != "window-1" || exitEvent.Action != "close" {
		t.Fatalf("unexpected exit event: %#v", exitEvent)
	}
	payload, ok := exitEvent.Payload.(map[string]any)
	if !ok || payload["reason"] != ExitReasonProcessError || payload["exited"] != true {
		t.Fatalf("unexpected exit payload: %#v", exitEvent.Payload)
	}
	if payload["ownerWindowId"] != "workbench:source" {
		t.Fatalf("exit event is missing owner metadata: %#v", exitEvent.Payload)
	}
}

func TestRequestedCloseReasonSurvivesForcedProcessExit(t *testing.T) {
	manager := newHTTPTestManager(t)
	events := make(chan Event, 2)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}
	process := &fakeChildProcess{pid: 43, done: make(chan error, 1), killed: make(chan struct{})}
	manager.windows["window-2"] = &windowEntry{
		info:         WindowInfo{ID: "window-2", Kind: "query-result"},
		process:      process,
		exitReason:   ExitReasonRequested,
		acknowledged: true,
	}
	go manager.watchProcess("window-2", process)
	process.finish(errors.New("signal: killed"))
	event := receiveEvent(t, events)
	payload := event.Payload.(map[string]any)
	if payload["reason"] != ExitReasonRequested {
		t.Fatalf("exit reason = %#v, want %q", payload["reason"], ExitReasonRequested)
	}
}

func TestManagerCancelCloseInvalidatesForcedKill(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.closeFallbackDelay = 20 * time.Millisecond
	process := &fakeChildProcess{pid: 44, done: make(chan error, 1), killed: make(chan struct{})}
	manager.windows["ai-chat"] = &windowEntry{
		info:    WindowInfo{ID: "ai-chat", Kind: "ai-chat"},
		process: process,
	}

	if result := manager.Close("ai-chat"); !result.Success {
		t.Fatalf("Close result = %#v", result)
	}
	manager.mu.RLock()
	entry := manager.windows["ai-chat"]
	closeSent := entry.info.CloseSent
	exitReason := entry.exitReason
	manager.mu.RUnlock()
	if !closeSent || exitReason != ExitReasonRequested {
		t.Fatalf("pending close state = closeSent %v reason %q", closeSent, exitReason)
	}

	if result := manager.CancelClose("ai-chat"); !result.Success {
		t.Fatalf("CancelClose result = %#v", result)
	}
	manager.mu.RLock()
	closeSent = entry.info.CloseSent
	exitReason = entry.exitReason
	manager.mu.RUnlock()
	if closeSent || exitReason != "" {
		t.Fatalf("cancelled close state = closeSent %v reason %q", closeSent, exitReason)
	}
	select {
	case <-process.killed:
		t.Fatal("cancelled parent close still killed the child")
	case <-time.After(60 * time.Millisecond):
	}
	if result := manager.Close("ai-chat"); !result.Success {
		t.Fatalf("close retry result = %#v", result)
	}
	select {
	case <-process.killed:
	case <-time.After(time.Second):
		t.Fatal("close retry did not schedule a fresh force-kill fallback")
	}
}

func TestManagerCancelCloseRollsBackAcceptedTerminalReason(t *testing.T) {
	for _, terminalReason := range []string{ExitReasonAttached, ExitReasonWindowClosed} {
		t.Run(terminalReason, func(t *testing.T) {
			manager := newHTTPTestManager(t)
			events := make(chan Event, 1)
			manager.runtimeCtx = context.Background()
			manager.emitToWails = func(_ context.Context, name string, args ...any) {
				if name == MainEventName && len(args) == 1 {
					events <- args[0].(Event)
				}
			}
			process := &fakeChildProcess{
				pid:    45,
				done:   make(chan error, 1),
				killed: make(chan struct{}),
			}
			manager.windows["workbench:query-1"] = &windowEntry{
				info: WindowInfo{
					ID:        "workbench:query-1",
					Kind:      "workbench",
					CloseSent: true,
				},
				process:         process,
				exitReason:      terminalReason,
				acknowledged:    true,
				closeGeneration: 1,
			}

			if result := manager.CancelClose("workbench:query-1"); !result.Success {
				t.Fatalf("CancelClose result = %#v", result)
			}
			manager.mu.RLock()
			entry := manager.windows["workbench:query-1"]
			closeSent := entry.info.CloseSent
			exitReason := entry.exitReason
			manager.mu.RUnlock()
			if closeSent || exitReason != "" {
				t.Fatalf("cancelled terminal state = closeSent %v reason %q", closeSent, exitReason)
			}

			go manager.watchProcess("workbench:query-1", process)
			process.finish(errors.New("exit status 9"))
			event := receiveEvent(t, events)
			payload := event.Payload.(map[string]any)
			if payload["reason"] != ExitReasonProcessError {
				t.Fatalf("exit reason after rollback = %#v, want %q", payload["reason"], ExitReasonProcessError)
			}
		})
	}
}

func TestCancelCloseActionClearsPendingStateAndNotifiesMainWindow(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info:       WindowInfo{ID: "ai-chat", Kind: "ai-chat", CloseSent: true},
		exitReason: ExitReasonRequested,
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	body := strings.NewReader(`{"action":"cancel-close","payload":{"id":"ai-chat","revision":9}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("cancel-close status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	manager.mu.RLock()
	entry := manager.windows["ai-chat"]
	closeSent := entry.info.CloseSent
	exitReason := entry.exitReason
	manager.mu.RUnlock()
	if closeSent || exitReason != "" {
		t.Fatalf("cancel-close state = closeSent %v reason %q", closeSent, exitReason)
	}
	event := receiveEvent(t, events)
	if event.Action != "cancel-close" || event.ID != "ai-chat" {
		t.Fatalf("unexpected cancel-close event: %#v", event)
	}
}

func TestCancelCloseActionCannotRollbackNewerTerminalState(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["workbench:query-1"] = &windowEntry{
		info:            WindowInfo{ID: "workbench:query-1", Kind: "workbench", CloseSent: true},
		exitReason:      ExitReasonRequested,
		actionRevision:  12,
		closeGeneration: 4,
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	body := strings.NewReader(`{"action":"cancel-close","payload":{"id":"workbench:query-1","revision":11,"rollbackAction":"attach"}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "workbench:query-1", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("stale cancel-close status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var result OperationResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatalf("decode stale cancel-close result: %v", err)
	}
	if !result.Success || result.Applied == nil || *result.Applied {
		t.Fatalf("stale cancel-close result = %#v, want ignored success", result)
	}
	manager.mu.RLock()
	entry := manager.windows["workbench:query-1"]
	closeSent := entry.info.CloseSent
	exitReason := entry.exitReason
	revision := entry.actionRevision
	closeGeneration := entry.closeGeneration
	manager.mu.RUnlock()
	if !closeSent || exitReason != ExitReasonRequested || revision != 12 || closeGeneration != 4 {
		t.Fatalf(
			"stale cancel changed state: closeSent=%v reason=%q revision=%d generation=%d",
			closeSent,
			exitReason,
			revision,
			closeGeneration,
		)
	}
	select {
	case event := <-events:
		t.Fatalf("stale cancel emitted event: %#v", event)
	case <-time.After(25 * time.Millisecond):
	}
}

func TestCancelCloseActionCannotCancelParentShutdown(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.closing = true
	manager.windows["ai-chat"] = &windowEntry{
		info:            WindowInfo{ID: "ai-chat", Kind: "ai-chat", CloseSent: true},
		exitReason:      ExitReasonParentShutdown,
		actionRevision:  8,
		closeGeneration: 5,
	}

	body := strings.NewReader(`{"action":"cancel-close","payload":{"id":"ai-chat","revision":9,"rollbackAction":"close"}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("shutdown cancel-close status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	var result OperationResult
	if err := json.NewDecoder(recorder.Body).Decode(&result); err != nil {
		t.Fatalf("decode shutdown cancel-close result: %v", err)
	}
	if !result.Success || result.Applied == nil || *result.Applied {
		t.Fatalf("shutdown cancel-close result = %#v, want ignored success", result)
	}
	entry := manager.windows["ai-chat"]
	if !entry.info.CloseSent || entry.exitReason != ExitReasonParentShutdown ||
		entry.actionRevision != 8 || entry.closeGeneration != 5 {
		t.Fatalf("shutdown cancellation changed entry: %#v", entry)
	}
}

func TestHostEventActionIsForwardedWithoutChangingTerminalState(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["ai-chat"] = &windowEntry{
		info: WindowInfo{ID: "ai-chat", Kind: "ai-chat"},
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	body := strings.NewReader(`{"action":"host-event","payload":{"name":"gonavi:insert-sql","detail":{"sql":"select 1"}}}`)
	request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
	recorder := httptest.NewRecorder()
	manager.authenticatedHandler().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("host-event status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	event := receiveEvent(t, events)
	if event.ID != "ai-chat" || event.Action != "host-event" {
		t.Fatalf("unexpected host-event: %#v", event)
	}
	manager.mu.RLock()
	exitReason := manager.windows["ai-chat"].exitReason
	manager.mu.RUnlock()
	if exitReason != "" {
		t.Fatalf("host-event marked child terminal: %q", exitReason)
	}
}

func TestDetachedEventsOnlyBroadcastChildOwnedLifecycle(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.runtimeCtx = context.Background()
	mainEvents := make(chan Event, 2)
	type targetedEvent struct {
		targetID string
		event    Event
	}
	childEvents := make(chan targetedEvent, 2)
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			mainEvents <- args[0].(Event)
		}
	}
	manager.emitToChild = func(targetID string, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			childEvents <- targetedEvent{targetID: targetID, event: args[0].(Event)}
		}
	}

	manager.emitDetached(Event{
		ID:      "ai-chat",
		Kind:    "ai-chat",
		Action:  "sync",
		Payload: map[string]any{"storeState": map[string]any{"history": "large"}},
	})
	_ = receiveEvent(t, mainEvents)
	select {
	case event := <-childEvents:
		t.Fatalf("top-level sync leaked to children: %#v", event)
	case <-time.After(25 * time.Millisecond):
	}

	manager.emitDetached(Event{
		ID:     "query-result:query-1:r1",
		Kind:   "query-result",
		Action: "opened",
		Payload: map[string]any{
			"ownerWindowId": "workbench:query-1",
		},
	})
	_ = receiveEvent(t, mainEvents)
	owned := <-childEvents
	if owned.targetID != "workbench:query-1" || owned.event.ID != "query-result:query-1:r1" {
		t.Fatalf("unexpected child-owned event: %#v", owned)
	}
}

func TestActionRevisionRejectsOutOfOrderSyncWithoutEmitting(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["window-1"] = &windowEntry{
		info: WindowInfo{ID: "window-1", Kind: "workbench"},
	}
	events := make(chan Event, 2)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	postAction := func(body string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		request := authenticatedRequest(manager, http.MethodPost, ActionPath, "window-1", strings.NewReader(body))
		manager.authenticatedHandler().ServeHTTP(recorder, request)
		return recorder
	}
	if recorder := postAction(`{"action":"sync","payload":{"revision":7,"storeState":{"value":"new"}}}`); recorder.Code != http.StatusOK {
		t.Fatalf("new sync status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if recorder := postAction(`{"action":"sync","payload":{"revision":6,"storeState":{"value":"old"}}}`); recorder.Code != http.StatusOK {
		t.Fatalf("stale sync status = %d body=%s", recorder.Code, recorder.Body.String())
	}

	event := receiveEvent(t, events)
	payload := event.Payload.(map[string]any)
	if event.Action != "sync" || payload["revision"] != float64(7) {
		t.Fatalf("unexpected newest sync event: %#v", event)
	}
	select {
	case stale := <-events:
		t.Fatalf("stale sync emitted an event: %#v", stale)
	case <-time.After(25 * time.Millisecond):
	}
	manager.mu.RLock()
	revision := manager.windows["window-1"].actionRevision
	manager.mu.RUnlock()
	if revision != 7 {
		t.Fatalf("action revision = %d, want 7", revision)
	}
}

func TestActionRevisionPreventsStaleTerminalTransition(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.windows["window-1"] = &windowEntry{
		info: WindowInfo{ID: "window-1", Kind: "workbench"},
	}
	events := make(chan Event, 2)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName && len(args) == 1 {
			events <- args[0].(Event)
		}
	}

	postAction := func(body string) {
		recorder := httptest.NewRecorder()
		request := authenticatedRequest(manager, http.MethodPost, ActionPath, "window-1", strings.NewReader(body))
		manager.authenticatedHandler().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("action status = %d body=%s", recorder.Code, recorder.Body.String())
		}
	}
	postAction(`{"action":"attach","payload":{"revision":12}}`)
	postAction(`{"action":"close","payload":{"revision":11}}`)

	event := receiveEvent(t, events)
	if event.Action != "attach" {
		t.Fatalf("terminal event = %#v, want attach", event)
	}
	select {
	case stale := <-events:
		t.Fatalf("stale terminal action emitted an event: %#v", stale)
	case <-time.After(25 * time.Millisecond):
	}
	manager.mu.RLock()
	entry := manager.windows["window-1"]
	exitReason := entry.exitReason
	revision := entry.actionRevision
	manager.mu.RUnlock()
	if exitReason != ExitReasonAttached || revision != 12 {
		t.Fatalf("terminal state = reason %q revision %d", exitReason, revision)
	}
}

func TestManagerDoesNotReuseChildAfterTerminalActionIsAccepted(t *testing.T) {
	for _, action := range []string{"attach", "close"} {
		t.Run(action, func(t *testing.T) {
			manager := newHTTPTestManager(t)
			manager.started = true
			manager.endpoint = "http://127.0.0.1:43119"
			manager.windows["ai-chat"] = &windowEntry{
				info: WindowInfo{ID: "ai-chat", Kind: "ai-chat", Title: "GoNavi AI"},
			}

			body := strings.NewReader(fmt.Sprintf(
				`{"action":%q,"payload":{"revision":1}}`,
				action,
			))
			request := authenticatedRequest(manager, http.MethodPost, ActionPath, "ai-chat", body)
			recorder := httptest.NewRecorder()
			manager.authenticatedHandler().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				t.Fatalf("%s action status = %d body=%s", action, recorder.Code, recorder.Body.String())
			}

			if result := manager.Focus("ai-chat"); result.Success || !strings.Contains(result.Message, "retry") {
				t.Errorf("Focus after %s result = %#v, want retry failure", action, result)
			}
			if result := manager.Open(OpenRequest{ID: "ai-chat", Kind: "ai-chat", Title: "GoNavi AI"}); result.Success || !strings.Contains(result.Message, "retry") {
				t.Errorf("Open after %s result = %#v, want retry failure", action, result)
			}
		})
	}
}

func TestManagerShutdownAllowsGracefulChildExitBeforeKilling(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.shutdownGracePeriod = 250 * time.Millisecond
	process := &fakeChildProcess{pid: 45, done: make(chan error, 1), killed: make(chan struct{})}
	manager.windows["ai-chat"] = &windowEntry{
		info:         WindowInfo{ID: "ai-chat", Kind: "ai-chat"},
		process:      process,
		acknowledged: true,
	}
	commands := make(chan childCommand, 1)
	manager.emitToChild = func(targetID string, name string, args ...any) {
		if targetID != "ai-chat" {
			t.Fatalf("shutdown target = %q, want ai-chat", targetID)
		}
		if name == CommandEventName && len(args) == 1 {
			commands <- args[0].(childCommand)
		}
	}
	go manager.watchProcess("ai-chat", process)
	done := make(chan struct{})
	go func() {
		manager.shutdown()
		close(done)
	}()

	select {
	case command := <-commands:
		if command.ID != "ai-chat" || command.Action != "close" || command.Reason != ExitReasonParentShutdown {
			t.Fatalf("unexpected shutdown command: %#v", command)
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not request graceful child close")
	}
	select {
	case <-process.killed:
		t.Fatal("shutdown killed child before its grace period")
	case <-time.After(30 * time.Millisecond):
	}
	process.finish(nil)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish after child exited")
	}
	select {
	case <-process.killed:
		t.Fatal("cooperative child was killed during shutdown")
	default:
	}
}

func TestManagerShutdownKillsChildAfterGracePeriod(t *testing.T) {
	manager := newHTTPTestManager(t)
	manager.shutdownGracePeriod = 20 * time.Millisecond
	process := &fakeChildProcess{pid: 46, done: make(chan error, 1), killed: make(chan struct{})}
	manager.windows["ai-chat"] = &windowEntry{
		info:    WindowInfo{ID: "ai-chat", Kind: "ai-chat"},
		process: process,
	}
	commands := make(chan childCommand, 1)
	manager.emitToChild = func(targetID string, name string, args ...any) {
		if targetID != "ai-chat" {
			t.Fatalf("shutdown target = %q, want ai-chat", targetID)
		}
		if name == CommandEventName && len(args) == 1 {
			commands <- args[0].(childCommand)
		}
	}
	go manager.watchProcess("ai-chat", process)

	manager.shutdown()
	select {
	case command := <-commands:
		if command.Reason != ExitReasonParentShutdown {
			t.Fatalf("shutdown reason = %q", command.Reason)
		}
	default:
		t.Fatal("shutdown did not broadcast graceful close")
	}
	select {
	case <-process.killed:
	case <-time.After(time.Second):
		t.Fatal("unresponsive child was not killed after grace period")
	}
}

func TestManagerOpenFailureBeforeBootstrapKeepsWindowUnacknowledged(t *testing.T) {
	starter := &fakeProcessStarter{nextPID: 200}
	manager := &Manager{
		token:       "test-token",
		endpoint:    "http://127.0.0.1:43119",
		started:     true,
		windows:     make(map[string]*windowEntry),
		starter:     starter,
		executable:  "/tmp/GoNavi",
		openTimeout: 25 * time.Millisecond,
	}

	result := manager.Open(OpenRequest{ID: "never-ready", Kind: "workbench"})
	if result.Success || !strings.Contains(result.Message, "did not become ready") {
		t.Fatalf("Open result = %#v, want readiness failure", result)
	}
	if len(manager.List()) != 0 {
		t.Fatalf("timed-out child remained registered: %#v", manager.List())
	}
	starter.mu.Lock()
	process := starter.processes[0]
	starter.mu.Unlock()
	select {
	case <-process.killed:
	case <-time.After(time.Second):
		t.Fatal("timed-out child was not killed")
	}
}

func TestManagerOpenReportsChildExitBeforeBootstrapWithoutClosingMainTab(t *testing.T) {
	starter := &fakeProcessStarter{nextPID: 300}
	manager := &Manager{
		token:       "test-token",
		endpoint:    "http://127.0.0.1:43119",
		started:     true,
		windows:     make(map[string]*windowEntry),
		starter:     starter,
		executable:  "/tmp/GoNavi",
		openTimeout: time.Second,
	}
	events := make(chan Event, 1)
	manager.runtimeCtx = context.Background()
	manager.emitToWails = func(_ context.Context, name string, args ...any) {
		if name == MainEventName {
			events <- args[0].(Event)
		}
	}
	starter.onStart = func(_ processSpec, process *fakeChildProcess) {
		process.finish(errors.New("child startup failed"))
	}

	result := manager.Open(OpenRequest{ID: "startup-failure", Kind: "workbench"})
	if result.Success || !strings.Contains(result.Message, "child startup failed") {
		t.Fatalf("Open result = %#v, want child startup failure", result)
	}
	if len(manager.List()) != 0 {
		t.Fatalf("failed child remained registered: %#v", manager.List())
	}
	select {
	case event := <-events:
		t.Fatalf("unacknowledged child emitted a main close event: %#v", event)
	case <-time.After(25 * time.Millisecond):
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
