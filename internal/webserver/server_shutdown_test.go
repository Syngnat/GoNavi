package webserver

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func setShutdownDeadlines(t *testing.T, grace time.Duration, drain time.Duration) {
	t.Helper()
	originalGrace, originalDrain := shutdownGraceTimeout, shutdownDrainTimeout
	shutdownGraceTimeout, shutdownDrainTimeout = grace, drain
	t.Cleanup(func() {
		shutdownGraceTimeout, shutdownDrainTimeout = originalGrace, originalDrain
	})
}

// waitForBoundAddr polls until runHTTP has stored the listener address. It
// returns an empty string when the address never appears, which surfaces as a
// client dial error in the caller's assertions.
func waitForBoundAddr(server *Server) string {
	for range 100 {
		if addr, ok := server.boundAddr.Load().(string); ok && addr != "" {
			return addr
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ""
}

func TestRequestTrackerWaitDrainsAndReportsRemaining(t *testing.T) {
	tracker := newRequestTracker()
	if remaining := tracker.waitDrain(time.Second); remaining != 0 {
		t.Fatalf("idle tracker reported %d in-flight requests", remaining)
	}

	tracker.begin()
	tracker.begin()
	waitDone := make(chan int, 1)
	go func() {
		waitDone <- tracker.waitDrain(2 * time.Second)
	}()
	tracker.done()
	tracker.done()
	select {
	case remaining := <-waitDone:
		if remaining != 0 {
			t.Fatalf("tracker.wait reported %d remaining requests after all handlers returned", remaining)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tracker.wait did not drain after handlers finished")
	}

	// A handler that begins right after a drained signal was observed (a
	// request that was still being read when Shutdown was called) must still
	// be awaited instead of being treated as drained.
	tracker.begin()
	tracker.done()
	tracker.begin()
	if remaining := tracker.waitDrain(50 * time.Millisecond); remaining != 1 {
		t.Fatalf("tracker.wait reported %d remaining requests, want 1", remaining)
	}
	tracker.done()
	if remaining := tracker.waitDrain(time.Second); remaining != 0 {
		t.Fatalf("tracker.wait reported %d remaining requests after the last handler returned", remaining)
	}
}

func TestWithRequestLifecycleForcesCancellationOnServerShutdown(t *testing.T) {
	serveCtx, serveCancel := context.WithCancel(context.Background())
	defer serveCancel()
	tracker := newRequestTracker()
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	handler := withRequestLifecycle(serveCtx, tracker, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	testServer := httptest.NewServer(handler)
	defer testServer.Close()

	clientDone := make(chan error, 1)
	go func() {
		response, err := testServer.Client().Get(testServer.URL)
		if response != nil {
			_ = response.Body.Close()
		}
		clientDone <- err
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight handler was not entered")
	}
	serveCancel()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("server-level cancellation did not reach the in-flight handler")
	}
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer drainCancel()
	if remaining := tracker.wait(drainCtx); remaining != 0 {
		t.Fatalf("tracker reported %d in-flight requests after the handler returned", remaining)
	}
	select {
	case <-clientDone:
		// The handler returned without a response, so the client either sees
		// an empty reply or a connection error; both prove the request ended.
	case <-time.After(2 * time.Second):
		t.Fatal("client request did not return after forced server cancellation")
	}
}

func TestWithRequestLifecyclePreservesClientCancellation(t *testing.T) {
	serveCtx, serveCancel := context.WithCancel(context.Background())
	defer serveCancel()
	tracker := newRequestTracker()
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	handler := withRequestLifecycle(serveCtx, tracker, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(cancelled)
	}))
	testServer := httptest.NewServer(handler)
	defer testServer.Close()

	requestCtx, requestCancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, testServer.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	clientDone := make(chan error, 1)
	go func() {
		response, requestErr := testServer.Client().Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		clientDone <- requestErr
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight handler was not entered")
	}
	requestCancel()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("client cancellation did not reach the in-flight handler")
	}
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer drainCancel()
	if remaining := tracker.wait(drainCtx); remaining != 0 {
		t.Fatalf("tracker reported %d in-flight requests after the handler returned", remaining)
	}
	select {
	case <-clientDone:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled client request did not return")
	}
}

func TestWithRequestLifecycleKeepsNormalRequestsIntact(t *testing.T) {
	serveCtx, serveCancel := context.WithCancel(context.Background())
	defer serveCancel()
	tracker := newRequestTracker()
	handlerCtx := make(chan context.Context, 1)
	handler := withRequestLifecycle(serveCtx, tracker, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.Context().Err(); err != nil {
			http.Error(w, "request context was cancelled during handling: "+err.Error(), http.StatusInternalServerError)
			return
		}
		handlerCtx <- r.Context()
		_, _ = w.Write([]byte("ok"))
	}))
	testServer := httptest.NewServer(handler)
	defer testServer.Close()

	response, err := testServer.Client().Get(testServer.URL)
	if err != nil {
		t.Fatalf("normal request failed: %v", err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || string(body) != "ok" {
		t.Fatalf("status = %d, body = %q; want 200 and %q", response.StatusCode, string(body), "ok")
	}

	// The per-request context must stay live while the handler runs and be
	// released once it returns.
	select {
	case ctx := <-handlerCtx:
		if ctx.Err() == nil {
			t.Fatal("per-request context was not cancelled after the handler returned")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("handler context was not captured")
	}
	drainCtx, drainCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer drainCancel()
	if remaining := tracker.wait(drainCtx); remaining != 0 {
		t.Fatalf("tracker reported %d in-flight requests after the handler returned", remaining)
	}
}

func TestServerRunHTTPWaitsForInFlightHandlerBeforeTeardown(t *testing.T) {
	setShutdownDeadlines(t, 200*time.Millisecond, 3*time.Second)
	server := &Server{options: Options{Addr: "127.0.0.1:0"}}
	entered := make(chan struct{})
	released := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-r.Context().Done()
		close(released)
	})

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- server.runHTTP(ctx, handler)
	}()
	clientDone := make(chan error, 1)
	go func() {
		// The URL is only known after runHTTP has bound the listener; wait
		// for the bound address instead of dialing a guessed port.
		boundAddr := waitForBoundAddr(server)
		response, err := http.Get("http://" + boundAddr)
		if response != nil {
			_ = response.Body.Close()
		}
		clientDone <- err
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight handler was not entered")
	}
	cancel()

	// The graceful phase times out while the handler is still active; runHTTP
	// must force-cancel it and must not return before the handler unwound,
	// because the deferred App resource teardown starts on return.
	select {
	case err := <-runDone:
		t.Fatalf("runHTTP returned before the in-flight handler finished: %v", err)
	case <-released:
	}
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("runHTTP returned error after the in-flight handler finished: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runHTTP did not return after the in-flight handler finished")
	}
	select {
	case <-clientDone:
		// Whatever the client observed, the request ended because the handler
		// was force-cancelled and the server stopped.
	case <-time.After(2 * time.Second):
		t.Fatal("client request did not return after forced server cancellation")
	}
}

func TestServerRunHTTPGraceAllowsHandlersToFinish(t *testing.T) {
	setShutdownDeadlines(t, 3*time.Second, 3*time.Second)
	server := &Server{options: Options{Addr: "127.0.0.1:0"}}
	entered := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		// Finish within the graceful window without depending on cancellation.
		time.Sleep(100 * time.Millisecond)
		_, _ = w.Write([]byte("ok"))
	})

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- server.runHTTP(ctx, handler)
	}()
	clientDone := make(chan string, 1)
	go func() {
		boundAddr := waitForBoundAddr(server)
		response, err := http.Get("http://" + boundAddr)
		if err != nil {
			clientDone <- "request error: " + err.Error()
			return
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		clientDone <- string(body)
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight handler was not entered")
	}
	cancel()

	// The graceful phase must let the request finish normally and deliver its
	// response even though the shutdown was already triggered.
	select {
	case body := <-clientDone:
		if body != "ok" {
			t.Fatalf("request body = %q, want %q", body, "ok")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("graceful request did not complete")
	}
	select {
	case err := <-runDone:
		if err != nil {
			t.Fatalf("runHTTP returned error after a graceful shutdown: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runHTTP did not return after the graceful request completed")
	}
}

func TestServerRunHTTPReportsHandlersThatSurviveCancellation(t *testing.T) {
	setShutdownDeadlines(t, 100*time.Millisecond, 100*time.Millisecond)
	server := &Server{options: Options{Addr: "127.0.0.1:0"}}
	entered := make(chan struct{})
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		// Simulates a handler that never observes cancellation; the drain
		// timeout must make the shutdown failure diagnosable.
		select {}
	})

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan error, 1)
	go func() {
		runDone <- server.runHTTP(ctx, handler)
	}()
	go func() {
		boundAddr := waitForBoundAddr(server)
		// The handler never returns, so the outcome of this request is
		// irrelevant; it only exists to get the handler entered.
		response, _ := http.Get("http://" + boundAddr)
		if response != nil {
			_ = response.Body.Close()
		}
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight handler was not entered")
	}
	cancel()

	select {
	case err := <-runDone:
		if err == nil || !strings.Contains(err.Error(), "1 request handler(s) still active") {
			t.Fatalf("runHTTP error = %v, want drain timeout mentioning 1 still-active handler", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runHTTP did not return after the drain timeout")
	}
}
