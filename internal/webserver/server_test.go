package webserver

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	aiservice "GoNavi-Wails/internal/ai/service"
	appcore "GoNavi-Wails/internal/app"
	httpserverlimits "GoNavi-Wails/internal/httpserver"
)

type webserverTestReceiver struct{}

type countingWebserverTestReceiver struct {
	calls atomic.Int32
}

type contextWebserverTestReceiver struct {
	publicCalls atomic.Int32
}

func (r *contextWebserverTestReceiver) Echo(value string) string {
	r.publicCalls.Add(1)
	return "public:" + value
}

func (r *countingWebserverTestReceiver) Echo(value string) string {
	r.calls.Add(1)
	return value
}

func (webserverTestReceiver) Echo(value string) (map[string]any, error) {
	return map[string]any{"value": value}, nil
}

func (webserverTestReceiver) Sum(left int, right int) int {
	return left + right
}

func (webserverTestReceiver) OpenSQLFile() string {
	return "desktop-method-reached"
}

func (webserverTestReceiver) RevealSavedConnectionPrimaryPassword(id string) (string, error) {
	return "secret-for-" + id, nil
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
	result, err := invoker.Invoke(context.Background(), invokeRequest{
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
	result, err := invoker.Invoke(context.Background(), invokeRequest{
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

func TestMethodInvokerUsesContextHandlerForBothAppAliases(t *testing.T) {
	receiver := &contextWebserverTestReceiver{}
	handlerCalls := atomic.Int32{}
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"app":     reflect.ValueOf(receiver),
			"app.app": reflect.ValueOf(receiver),
		},
		contextHandlers: map[string]map[string]reflect.Value{
			"app": {
				"Echo": reflect.ValueOf(func(ctx context.Context, value string) string {
					handlerCalls.Add(1)
					if ctx.Value("request") != "1098" {
						t.Fatalf("handler received the wrong request context")
					}
					return "context:" + value
				}),
			},
		},
	}
	rawValue, _ := json.Marshal("hello")
	ctx := context.WithValue(context.Background(), "request", "1098")

	for _, request := range []invokeRequest{
		{Namespace: "app", Method: "Echo", Args: []json.RawMessage{rawValue}},
		{Namespace: "app", Receiver: "app", Method: "Echo", Args: []json.RawMessage{rawValue}},
	} {
		result, err := invoker.Invoke(ctx, request)
		if err != nil {
			t.Fatalf("Invoke(%s.%s) error = %v", request.Namespace, request.Receiver, err)
		}
		if result != "context:hello" {
			t.Fatalf("Invoke(%s.%s) result = %#v", request.Namespace, request.Receiver, result)
		}
	}
	if handlerCalls.Load() != 2 || receiver.publicCalls.Load() != 0 {
		t.Fatalf("handler calls = %d, public calls = %d", handlerCalls.Load(), receiver.publicCalls.Load())
	}
}

func TestMethodInvokerCancellationOnlyPrechecksRegisteredMethods(t *testing.T) {
	receiver := &contextWebserverTestReceiver{}
	handlerCalls := atomic.Int32{}
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{"app": reflect.ValueOf(receiver)},
		contextHandlers: map[string]map[string]reflect.Value{
			"app": {
				"Echo": reflect.ValueOf(func(context.Context, string) string {
					handlerCalls.Add(1)
					return "context"
				}),
			},
		},
	}
	rawValue, _ := json.Marshal("hello")
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := invoker.Invoke(cancelled, invokeRequest{
		Namespace: "app", Method: "Echo", Args: []json.RawMessage{rawValue},
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("registered method error = %v, want context.Canceled", err)
	}
	if handlerCalls.Load() != 0 || receiver.publicCalls.Load() != 0 {
		t.Fatalf("cancelled registered call reached business code")
	}

	invoker.contextHandlers = nil
	result, err := invoker.Invoke(cancelled, invokeRequest{
		Namespace: "app", Method: "Echo", Args: []json.RawMessage{rawValue},
	})
	if err != nil || result != "public:hello" || receiver.publicCalls.Load() != 1 {
		t.Fatalf("unregistered cancelled call = (%#v, %v), public calls = %d", result, err, receiver.publicCalls.Load())
	}
}

func TestValidateContextHandlersRejectsSignatureMismatch(t *testing.T) {
	_, err := validateContextHandlers(
		reflect.ValueOf(webserverTestReceiver{}),
		[]string{"Sum"},
		map[string]any{
			"Sum": func(context.Context, int, string) int { return 0 },
		},
	)
	if err == nil || !strings.Contains(err.Error(), "parameter 1 type mismatch") {
		t.Fatalf("validateContextHandlers error = %v, want parameter mismatch", err)
	}
}

func TestIssue1098RequiredContextHandlerSetIsExact(t *testing.T) {
	application := appcore.NewWebApp()
	invoker, err := newMethodInvoker(application, aiservice.NewService())
	if err != nil {
		t.Fatalf("newMethodInvoker returned error: %v", err)
	}
	handlers := invoker.contextHandlers["app"]
	required := appcore.RequiredIssue1098WebRPCContextMethods()
	if len(handlers) != len(required) {
		t.Fatalf("handler count = %d, required count = %d", len(handlers), len(required))
	}
	for _, methodName := range required {
		if !handlers[methodName].IsValid() {
			t.Fatalf("required handler %s is missing", methodName)
		}
	}
}

func TestHTTPClientCancellationReachesContextHandler(t *testing.T) {
	receiver := &contextWebserverTestReceiver{}
	entered := make(chan struct{})
	observed := make(chan struct{})
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{"app": reflect.ValueOf(receiver)},
		contextHandlers: map[string]map[string]reflect.Value{
			"app": {
				"Echo": reflect.ValueOf(func(ctx context.Context, value string) string {
					close(entered)
					<-ctx.Done()
					close(observed)
					return value
				}),
			},
		},
	}
	server := httptest.NewServer(http.HandlerFunc((&Server{invoker: invoker}).handleInvoke))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL, strings.NewReader(
		`{"namespace":"app","method":"Echo","args":["hello"]}`,
	))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	result := make(chan error, 1)
	go func() {
		response, requestErr := server.Client().Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		result <- requestErr
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("context handler was not entered")
	}
	cancel()
	select {
	case <-observed:
	case <-time.After(2 * time.Second):
		t.Fatal("HTTP cancellation did not reach the context handler")
	}
	select {
	case requestErr := <-result:
		if requestErr == nil {
			t.Fatal("client request unexpectedly completed without cancellation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled HTTP request did not return")
	}
}

func TestRuntimeBridgeExposesStableAbortContract(t *testing.T) {
	script := runtimeBridgeScript()
	for _, expected := range []string{
		"window.__GONAVI_WEB_RPC__", "invokeWithOptions", "WEB_RPC_ABORTED",
		"not_started", "possibly_dispatched", "signal: signal",
	} {
		if !strings.Contains(script, expected) {
			t.Fatalf("runtime bridge is missing %q", expected)
		}
	}
}

func TestWebInvokeBodyLimitRejectsBeforeBusinessInvocation(t *testing.T) {
	receiver := &countingWebserverTestReceiver{}
	server := &Server{invoker: &methodInvoker{targets: map[string]reflect.Value{
		"test.receiver": reflect.ValueOf(receiver),
	}}}
	handler := httpserverlimits.LimitRequestBody(http.HandlerFunc(server.handleInvoke))
	validPayload := `{"namespace":"test","receiver":"receiver","method":"Echo","args":["ok"]}`

	t.Run("oversize", func(t *testing.T) {
		paddingSize := int(httpserverlimits.MaxRequestBodyBytes) - len(validPayload) + 1
		request := httptest.NewRequest(http.MethodPost, internalRoutePrefix+"/api/invoke", strings.NewReader(validPayload+strings.Repeat(" ", paddingSize)))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want %d; body=%q", recorder.Code, http.StatusRequestEntityTooLarge, recorder.Body.String())
		}
		if receiver.calls.Load() != 0 {
			t.Fatal("Web invoke business method was called for an oversized body")
		}
	})

	t.Run("normal", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, internalRoutePrefix+"/api/invoke", strings.NewReader(validPayload))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d; body=%q", recorder.Code, http.StatusOK, recorder.Body.String())
		}
		if receiver.calls.Load() != 1 {
			t.Fatalf("Web invoke calls = %d, want 1", receiver.calls.Load())
		}
	})
}

func TestParseOptionsPreservesDockerPublicListenAddress(t *testing.T) {
	t.Setenv("GONAVI_WEB_ADDR", "0.0.0.0:34116")

	options, err := ParseOptions(nil)
	if err != nil {
		t.Fatalf("ParseOptions returned error: %v", err)
	}
	if options.Addr != "0.0.0.0:34116" {
		t.Fatalf("Addr = %q, want Docker public listen address", options.Addr)
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
		"ImportData", "GetDataRootDirectoryInfo",
		"ApplyDataRootDirectory", "OpenDataRootDirectory", "SelectLogDirectory", "ApplyLogDirectory", "OpenLogDirectory",
		"SelectSavedQueryDirectory", "ApplySavedQueryDirectory", "OpenSavedQueryDirectory", "RevealSavedQueryInFolder", "SetApplicationBrandIcon",
		"RefreshWebViewBounds", "RevealSavedConnectionPrimaryPassword",
	} {
		_, err := invoker.Invoke(context.Background(), invokeRequest{Namespace: "app", Receiver: "app", Method: method})
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
	result, err := invoker.Invoke(context.Background(), invokeRequest{Namespace: "app", Receiver: "app", Method: "OpenSQLFile"})
	if err != nil {
		t.Fatalf("shared desktop method was rejected: %v", err)
	}
	if result != "desktop-method-reached" {
		t.Fatalf("unexpected shared desktop result: %#v", result)
	}
}

func TestSharedMethodInvokerAllowsSavedPasswordReveal(t *testing.T) {
	invoker := &methodInvoker{
		targets: map[string]reflect.Value{
			"app.app": reflect.ValueOf(webserverTestReceiver{}),
		},
		allowDesktopMethods: true,
	}
	rawID, _ := json.Marshal("conn-1")
	result, err := invoker.Invoke(context.Background(), invokeRequest{
		Namespace: "app",
		Receiver:  "app",
		Method:    "RevealSavedConnectionPrimaryPassword",
		Args:      []json.RawMessage{rawID},
	})
	if err != nil {
		t.Fatalf("shared desktop password reveal was rejected: %v", err)
	}
	if result != "secret-for-conn-1" {
		t.Fatalf("unexpected revealed password: %#v", result)
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

func TestEventHubReliableQueueDisconnectsSlowDetachedWindowAtHardLimit(t *testing.T) {
	hub := newEventHub()
	subscriber := hub.subscribe("window-1")
	t.Cleanup(func() { hub.unsubscribe(subscriber) })

	for index := 0; index < eventSubscriberReliableQueueLimit; index++ {
		hub.EmitTo("window-1", "gonavi:command", index)
	}

	subscriber.mu.Lock()
	queueLen := len(subscriber.queue) - subscriber.head
	closedBeforeOverflow := subscriber.closed
	subscriber.mu.Unlock()
	if queueLen != eventSubscriberReliableQueueLimit {
		t.Fatalf("reliable queue length before overflow = %d, want %d", queueLen, eventSubscriberReliableQueueLimit)
	}
	if closedBeforeOverflow {
		t.Fatal("reliable queue closed before reaching its hard limit")
	}

	hub.EmitTo("window-1", "gonavi:close", "close")
	select {
	case <-subscriber.done:
	default:
		t.Fatal("slow reliable subscriber was not disconnected after queue overflow")
	}

	subscriber.mu.Lock()
	queueLen = len(subscriber.queue) - subscriber.head
	closedAfterOverflow := subscriber.closed
	subscriber.mu.Unlock()
	if queueLen != 0 {
		t.Fatalf("reliable queue retained %d messages after disconnect", queueLen)
	}
	if !closedAfterOverflow {
		t.Fatal("subscriber was not marked closed after reliable queue overflow")
	}

	// A fresh SSE subscription for the same child ID still receives targeted
	// lifecycle events after the stalled stream has been removed.
	hub.unsubscribe(subscriber)
	reconnected := hub.subscribe("window-1")
	t.Cleanup(func() { hub.unsubscribe(reconnected) })
	hub.EmitTo("window-1", "gonavi:close", "close")
	message, ok := reconnected.dequeue()
	if !ok || message.Name != "gonavi:close" {
		t.Fatalf("reconnected subscriber message = %#v, %v", message, ok)
	}
}

func TestEventHubRunEventsUseTheNormalBestEffortQueueLimit(t *testing.T) {
	hub := newEventHub()
	target := hub.subscribe("window-1")
	t.Cleanup(func() { hub.unsubscribe(target) })

	// Run events are persisted in the Ledger and consumers fill sequence gaps
	// through AIReadAgentRun. The bridge therefore treats them as normal
	// best-effort notifications instead of retaining the old AI stream merger.
	for index := 0; index < eventSubscriberQueueLimit; index++ {
		hub.Emit("gonavi:progress", index)
	}
	hub.EmitToBestEffort("window-1", "ai:run:event", map[string]any{"runId": "run-1", "sequence": 1})

	for index := 0; index < eventSubscriberQueueLimit; index++ {
		message, ok := target.dequeue()
		if !ok || message.Name != "gonavi:progress" {
			t.Fatalf("broadcast %d = %#v, %v", index, message, ok)
		}
	}
	if _, ok := target.dequeue(); ok {
		t.Fatal("run event should be dropped at the normal best-effort queue limit")
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

func TestHandleEventsDisconnectsBlockedDetachedConsumerAfterReliableOverflow(t *testing.T) {
	events := newEventHub()
	server := &Server{events: events}
	requestContext, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	request := httptest.NewRequest(http.MethodGet, internalRoutePrefix+"/events", nil).WithContext(requestContext)
	request.Header.Set(detachedWindowIDHeader, "window-42")
	writer := newBlockingEventStreamTestWriter()
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(writer.release) }) }
	t.Cleanup(release)
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
	events.EmitTo("window-42", "gonavi:blocked", "first")
	select {
	case <-writer.started:
	case <-time.After(time.Second):
		t.Fatal("event stream did not block on the first targeted event")
	}

	events.mu.RLock()
	var subscriber *eventSubscriber
	for candidate := range events.subscribers {
		if candidate.targetID == "window-42" {
			subscriber = candidate
			break
		}
	}
	events.mu.RUnlock()
	if subscriber == nil {
		t.Fatal("detached subscriber was not registered")
	}

	for index := 0; index < eventSubscriberReliableQueueLimit; index++ {
		events.EmitTo("window-42", "gonavi:command", index)
	}
	events.EmitTo("window-42", "gonavi:overflow", "close")
	select {
	case <-subscriber.done:
	case <-time.After(time.Second):
		t.Fatal("blocked detached consumer was not disconnected after reliable overflow")
	}

	release()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("event stream handler did not exit after the blocked write was released")
	}
}

type blockingEventStreamTestWriter struct {
	*eventStreamTestWriter
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func newBlockingEventStreamTestWriter() *blockingEventStreamTestWriter {
	return &blockingEventStreamTestWriter{
		eventStreamTestWriter: newEventStreamTestWriter(),
		started:               make(chan struct{}),
		release:               make(chan struct{}),
	}
}

func (w *blockingEventStreamTestWriter) Write(payload []byte) (int, error) {
	if strings.Contains(string(payload), `"name":"gonavi:blocked"`) {
		w.once.Do(func() { close(w.started) })
		<-w.release
	}
	return w.eventStreamTestWriter.Write(payload)
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
