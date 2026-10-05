package nativewindow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
