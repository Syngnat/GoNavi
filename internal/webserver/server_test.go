package webserver

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
)

type webserverTestReceiver struct{}

func (webserverTestReceiver) Echo(value string) (map[string]any, error) {
	return map[string]any{"value": value}, nil
}

func (webserverTestReceiver) Sum(left int, right int) int {
	return left + right
}

func (webserverTestReceiver) OpenSQLFile() string {
	return "desktop-method-reached"
}

func TestInjectRuntimeBridgeAddsScriptOnce(t *testing.T) {
	indexHTML := "<html><head><title>GoNavi</title></head><body></body></html>"

	injected := injectRuntimeBridge(indexHTML)
	if !strings.Contains(injected, internalRoutePrefix+"/web-runtime.js") {
		t.Fatalf("expected injected HTML to contain runtime bridge script, got: %s", injected)
	}

	reinjected := injectRuntimeBridge(injected)
	if strings.Count(reinjected, internalRoutePrefix+"/web-runtime.js") != 1 {
		t.Fatalf("expected runtime bridge script to be injected once, got: %s", reinjected)
	}
}

func TestMethodInvokerInvokeDecodesArgumentsAndReturnsResult(t *testing.T) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"test.receiver": reflect.ValueOf(webserverTestReceiver{}),
		},
	}

	rawLeft, _ := json.Marshal(2)
	rawRight, _ := json.Marshal(5)
	result, err := invoker.Invoke(invokeRequest{
		Namespace: "test",
		Receiver:  "receiver",
		Method:    "Sum",
		Args:      []json.RawMessage{rawLeft, rawRight},
	})
	if err != nil {
		t.Fatalf("expected invoke success, got error: %v", err)
	}
	if result != 7 {
		t.Fatalf("expected sum result 7, got %#v", result)
	}
}

func TestMethodInvokerInvokeSupportsStructuredReturnValues(t *testing.T) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"test.receiver": reflect.ValueOf(webserverTestReceiver{}),
		},
	}

	rawValue, _ := json.Marshal("hello")
	result, err := invoker.Invoke(invokeRequest{
		Namespace: "test",
		Receiver:  "receiver",
		Method:    "Echo",
		Args:      []json.RawMessage{rawValue},
	})
	if err != nil {
		t.Fatalf("expected invoke success, got error: %v", err)
	}
	payload, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected structured result map, got %#v", result)
	}
	if payload["value"] != "hello" {
		t.Fatalf("expected echoed value hello, got %#v", payload["value"])
	}
}

func TestMethodInvokerRejectsDesktopOnlyAppMethodsBeforeReflection(t *testing.T) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"app.app": reflect.ValueOf(webserverTestReceiver{}),
		},
	}

	for _, method := range []string{
		"Shutdown", "ExportSQLAuditFile", "OpenSQLFile", "ExecuteSQLFile", "ReadSQLFile",
		"PreviewImportFile", "ImportDatabaseSQL", "ImportDataWithProgress", "ImportDataWithProgressOptions", "GetDataRootDirectoryInfo",
		"ExportDatabaseSQLWithOptions", "ExportSchemaSQLWithOptions",
		"ApplyDataRootDirectory", "OpenDataRootDirectory", "SelectLogDirectory", "ApplyLogDirectory", "OpenLogDirectory",
		"SelectSavedQueryDirectory", "ApplySavedQueryDirectory", "OpenSavedQueryDirectory", "RevealSavedQueryInFolder", "SetApplicationBrandIcon",
		"RefreshWebViewBounds",
	} {
		_, err := invoker.Invoke(invokeRequest{Namespace: "app", Receiver: "app", Method: method})
		if err == nil || !strings.Contains(err.Error(), "unavailable in web runtime") {
			t.Fatalf("desktop-only method %s error = %v, want web runtime rejection", method, err)
		}
	}
}

func TestSharedMethodInvokerAllowsDesktopMethods(t *testing.T) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"app.app": reflect.ValueOf(webserverTestReceiver{}),
		},
		allowDesktopMethods: true,
	}
	result, err := invoker.Invoke(invokeRequest{Namespace: "app", Receiver: "app", Method: "OpenSQLFile"})
	if err != nil {
		t.Fatalf("shared desktop method was rejected: %v", err)
	}
	if result != "desktop-method-reached" {
		t.Fatalf("unexpected shared desktop result: %#v", result)
	}
}

func TestSQLAuditHeavyInvokeIncludesExportAndIntegrityVerification(t *testing.T) {
	for _, method := range []string{"BuildSQLAuditExport", "VerifySQLAuditIntegrity"} {
		if !isSQLAuditHeavyInvoke(invokeRequest{Namespace: "app", Receiver: "app", Method: method}) {
			t.Fatalf("%s must share the SQL audit heavy-operation semaphore", method)
		}
	}
	if isSQLAuditHeavyInvoke(invokeRequest{Namespace: "app", Receiver: "app", Method: "GetSQLAuditEvents"}) {
		t.Fatal("ordinary paged audit reads must not use the heavy-operation semaphore")
	}
}

func TestSharedRuntimeInjectsRequestedBridgeWithoutBrowserAuthentication(t *testing.T) {
	assets := fstest.MapFS{
		"frontend/dist/index.html": &fstest.MapFile{Data: []byte(`<html><head><script src="/wails/runtime.js"></script><title>GoNavi</title><script type="module" src="/assets/index.js"></script></head><body><div id="root"></div></body></html>`)},
	}
	shared, err := NewSharedRuntime(fs.FS(assets), appcore.NewWebApp(), aiservice.NewService(), SharedRuntimeOptions{
		RuntimeBridgePath:   "/__gonavi/detached-runtime.js",
		RuntimeBridgeScript: "window.detachedRuntime = true;",
	})
	if err != nil {
		t.Fatalf("NewSharedRuntime returned error: %v", err)
	}

	indexRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	indexRecorder := httptest.NewRecorder()
	shared.Handler().ServeHTTP(indexRecorder, indexRequest)
	if indexRecorder.Code != http.StatusOK {
		t.Fatalf("shared index status = %d", indexRecorder.Code)
	}
	if !strings.Contains(indexRecorder.Body.String(), "/__gonavi/detached-runtime.js") {
		t.Fatalf("shared index is missing detached bridge: %s", indexRecorder.Body.String())
	}
	html := indexRecorder.Body.String()
	bodyIndex := strings.Index(html, "<body>")
	runtimeIndex := strings.Index(html, "/wails/runtime.js")
	bridgeIndex := strings.Index(html, "/__gonavi/detached-runtime.js")
	bodyCloseIndex := strings.Index(html, "</body>")
	if runtimeIndex < 0 || bridgeIndex <= runtimeIndex || bodyIndex < 0 || bridgeIndex <= bodyIndex || bodyCloseIndex <= bridgeIndex {
		t.Fatalf("detached bridge must run after Wails runtime as the final body script, got: %s", html)
	}

	bridgeRequest := httptest.NewRequest(http.MethodGet, "/__gonavi/detached-runtime.js", nil)
	bridgeRecorder := httptest.NewRecorder()
	shared.Handler().ServeHTTP(bridgeRecorder, bridgeRequest)
	if bridgeRecorder.Code != http.StatusOK || !strings.Contains(bridgeRecorder.Body.String(), "detachedRuntime") {
		t.Fatalf("unexpected bridge response: status=%d body=%s", bridgeRecorder.Code, bridgeRecorder.Body.String())
	}
}

func TestEventHubEmitToOnlyQueuesForMatchingDetachedWindow(t *testing.T) {
	hub := newEventHub()
	first := hub.subscribe(" window-1 ")
	second := hub.subscribe("window-2")
	browser := hub.subscribe("")
	t.Cleanup(func() {
		hub.unsubscribe(first)
		hub.unsubscribe(second)
		hub.unsubscribe(browser)
	})

	hub.EmitTo("window-1", "gonavi:command", map[string]any{"action": "focus"})

	message, ok := first.dequeue()
	if !ok || message.Name != "gonavi:command" {
		t.Fatalf("matching subscriber message = %#v, %v", message, ok)
	}
	if _, ok := second.dequeue(); ok {
		t.Fatal("non-matching detached window received a targeted event")
	}
	if _, ok := browser.dequeue(); ok {
		t.Fatal("untargeted browser subscriber received a targeted event")
	}

	hub.Emit("gonavi:broadcast", "payload")
	for name, subscriber := range map[string]*eventSubscriber{
		"first": first, "second": second, "browser": browser,
	} {
		message, ok := subscriber.dequeue()
		if !ok || message.Name != "gonavi:broadcast" {
			t.Fatalf("%s subscriber broadcast = %#v, %v", name, message, ok)
		}
	}
}

func TestEventHubEmitToSurvivesFullBroadcastQueue(t *testing.T) {
	hub := newEventHub()
	subscriber := hub.subscribe("window-1")
	t.Cleanup(func() { hub.unsubscribe(subscriber) })

	for index := 0; index < eventSubscriberQueueLimit; index++ {
		hub.Emit("gonavi:progress", index)
	}
	hub.Emit("gonavi:dropped-broadcast")
	hub.EmitTo("window-1", "gonavi:critical-command", "close")

	for index := 0; index < eventSubscriberQueueLimit; index++ {
		message, ok := subscriber.dequeue()
		if !ok || message.Name != "gonavi:progress" {
			t.Fatalf("broadcast %d = %#v, %v", index, message, ok)
		}
	}
	message, ok := subscriber.dequeue()
	if !ok || message.Name != "gonavi:critical-command" {
		t.Fatalf("critical targeted event = %#v, %v", message, ok)
	}
	if _, ok := subscriber.dequeue(); ok {
		t.Fatal("broadcast emitted after the queue limit should have been dropped")
	}
}

func TestEventHubAIStreamCoalescesWithoutLosingChunksOrTerminalEvents(t *testing.T) {
	hub := newEventHub()
	target := hub.subscribe("window-1")
	t.Cleanup(func() { hub.unsubscribe(target) })

	// Fill the queue with unrelated broadcasts, leaving one slot for this AI
	// session. Every later token must merge into that slot instead of dropping.
	for index := 0; index < eventSubscriberQueueLimit-1; index++ {
		hub.Emit("gonavi:progress", index)
	}
	var expectedContent strings.Builder
	var expectedThinking strings.Builder
	for index := 0; index < eventSubscriberQueueLimit+8; index++ {
		content := fmt.Sprintf("<%d>", index)
		thinking := fmt.Sprintf("[%d]", index)
		expectedContent.WriteString(content)
		expectedThinking.WriteString(thinking)
		hub.EmitToBestEffort("window-1", "ai:stream:session-1", map[string]any{
			"content":  content,
			"thinking": thinking,
			"done":     false,
		})
	}
	hub.EmitToBestEffort("window-1", "ai:stream:session-1", map[string]any{
		"tool_calls": []map[string]any{{"id": "tool-1"}},
	})
	hub.EmitToBestEffort("window-1", "ai:stream:session-1", map[string]any{"done": true})
	hub.EmitToBestEffort("window-1", "ai:stream:session-1", map[string]any{
		"error": "upstream closed",
		"done":  true,
	})

	for index := 0; index < eventSubscriberQueueLimit-1; index++ {
		message, ok := target.dequeue()
		if !ok || message.Name != "gonavi:progress" {
			t.Fatalf("broadcast %d = %#v, %v", index, message, ok)
		}
	}

	var actualContent strings.Builder
	var actualThinking strings.Builder
	var sawToolCalls bool
	var sawDone bool
	var sawError bool
	for {
		message, ok := target.dequeue()
		if !ok {
			break
		}
		if message.Name != "ai:stream:session-1" || len(message.Args) != 1 {
			t.Fatalf("unexpected AI event: %#v", message)
		}
		payload, ok := message.Args[0].(map[string]any)
		if !ok {
			t.Fatalf("AI payload = %#v", message.Args[0])
		}
		actualContent.WriteString(stringValue(payload["content"]))
		actualThinking.WriteString(stringValue(payload["thinking"]))
		if toolCalls := reflect.ValueOf(payload["tool_calls"]); toolCalls.IsValid() && toolCalls.Kind() == reflect.Slice && toolCalls.Len() > 0 {
			sawToolCalls = true
		}
		if done, _ := payload["done"].(bool); done {
			sawDone = true
		}
		if stringValue(payload["error"]) == "upstream closed" {
			sawError = true
		}
	}
	if actualContent.String() != expectedContent.String() {
		t.Fatalf("coalesced content length = %d, want %d", actualContent.Len(), expectedContent.Len())
	}
	if actualThinking.String() != expectedThinking.String() {
		t.Fatalf("coalesced thinking length = %d, want %d", actualThinking.Len(), expectedThinking.Len())
	}
	if !sawToolCalls || !sawDone || !sawError {
		t.Fatalf("terminal delivery tool=%v done=%v error=%v", sawToolCalls, sawDone, sawError)
	}
}

type detachedSyncTestEvent struct {
	ID       string
	Action   string
	Revision int
}

func TestEventHubKeepsOnlyLatestDetachedResultSync(t *testing.T) {
	hub := newEventHub()
	subscriber := hub.subscribe("workbench:query-1")
	t.Cleanup(func() { hub.unsubscribe(subscriber) })

	for revision := 1; revision <= 20; revision++ {
		hub.EmitTo("workbench:query-1", "gonavi:native-detached-event", detachedSyncTestEvent{
			ID:       "query-result:query-1:r1",
			Action:   "sync",
			Revision: revision,
		})
	}

	message, ok := subscriber.dequeue()
	if !ok || len(message.Args) != 1 {
		t.Fatalf("latest sync = %#v, %v", message, ok)
	}
	event, ok := message.Args[0].(detachedSyncTestEvent)
	if !ok || event.Revision != 20 {
		t.Fatalf("latest sync payload = %#v", message.Args[0])
	}
	if _, ok := subscriber.dequeue(); ok {
		t.Fatal("stale detached result sync remained queued")
	}
}

func TestWriteEventStreamMessageFragmentsDetachedLargePayloadWithoutChangingJSON(t *testing.T) {
	message := eventMessage{
		Name: "gonavi:native-detached-event",
		Args: []any{map[string]any{
			"content": strings.Repeat(" value with spaces ", (5<<20)/19),
		}},
	}
	want, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal expected event: %v", err)
	}

	var detached strings.Builder
	if err := writeEventStreamMessage(&detached, message, true); err != nil {
		t.Fatalf("write detached event: %v", err)
	}
	dataLines := make([]string, 0)
	for _, line := range strings.Split(detached.String(), "\n") {
		if strings.HasPrefix(line, "data: ") {
			dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
		}
	}
	if len(dataLines) <= 1 {
		t.Fatalf("detached data lines = %d, want multiple", len(dataLines))
	}
	if got := strings.Join(dataLines, ""); got != string(want) {
		t.Fatalf("fragmented payload changed: got %d bytes want %d", len(got), len(want))
	}

	var browser strings.Builder
	if err := writeEventStreamMessage(&browser, message, false); err != nil {
		t.Fatalf("write browser event: %v", err)
	}
	if count := strings.Count(browser.String(), "data: "); count != 1 {
		t.Fatalf("browser data lines = %d, want 1", count)
	}
}

func TestHandleEventsRegistersDetachedWindowHeader(t *testing.T) {
	events := newEventHub()
	server := &Server{events: events}
	requestContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, internalRoutePrefix+"/events", nil).WithContext(requestContext)
	request.Header.Set(detachedWindowIDHeader, " window-42 ")
	writer := newEventStreamTestWriter()
	done := make(chan struct{})
	go func() {
		defer close(done)
		server.handleEvents(writer, request)
	}()

	select {
	case <-writer.flushed:
	case <-time.After(time.Second):
		t.Fatal("event stream did not connect")
	}

	events.mu.RLock()
	var registeredTarget string
	for subscriber := range events.subscribers {
		registeredTarget = subscriber.targetID
	}
	events.mu.RUnlock()
	if registeredTarget != "window-42" {
		t.Fatalf("registered target ID = %q, want window-42", registeredTarget)
	}

	events.EmitTo("window-42", "gonavi:targeted")
	select {
	case <-writer.flushed:
	case <-time.After(time.Second):
		t.Fatal("targeted event was not flushed to the matching stream")
	}
	if !strings.Contains(writer.String(), `"name":"gonavi:targeted"`) {
		t.Fatalf("event stream did not receive targeted event: %s", writer.String())
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("event stream did not stop after cancellation")
	}
}

type eventStreamTestWriter struct {
	mu      sync.Mutex
	header  http.Header
	body    strings.Builder
	flushed chan struct{}
}

func newEventStreamTestWriter() *eventStreamTestWriter {
	return &eventStreamTestWriter{
		header:  make(http.Header),
		flushed: make(chan struct{}, 8),
	}
}

func (w *eventStreamTestWriter) Header() http.Header {
	return w.header
}

func (w *eventStreamTestWriter) Write(payload []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.body.Write(payload)
}

func (w *eventStreamTestWriter) WriteHeader(_ int) {}

func (w *eventStreamTestWriter) Flush() {
	select {
	case w.flushed <- struct{}{}:
	default:
	}
}

func (w *eventStreamTestWriter) String() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.body.String()
}
