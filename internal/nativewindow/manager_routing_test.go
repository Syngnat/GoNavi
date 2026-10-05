package nativewindow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

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
