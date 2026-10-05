package webserver

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// requestTracker counts in-flight HTTP handlers so Server.runHTTP can keep the
// deferred App resource teardown ordered after the last handler has returned.
type requestTracker struct {
	mu      sync.Mutex
	count   int
	drained chan struct{}
}

func newRequestTracker() *requestTracker {
	drained := make(chan struct{})
	close(drained)
	return &requestTracker{drained: drained}
}

func (t *requestTracker) begin() {
	t.mu.Lock()
	if t.count == 0 {
		t.drained = make(chan struct{})
	}
	t.count++
	t.mu.Unlock()
}

func (t *requestTracker) done() {
	t.mu.Lock()
	t.count--
	if t.count == 0 {
		close(t.drained)
	}
	t.mu.Unlock()
}

func (t *requestTracker) active() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.count
}

// wait blocks until every in-flight handler has returned or ctx expires and
// reports how many handlers were still running. The re-check loop matters
// because a handler can still begin after http.Server.Shutdown for a request
// that was already being read, so a drained signal must never be trusted
// without re-reading the counter.
func (t *requestTracker) wait(ctx context.Context) int {
	for {
		t.mu.Lock()
		count := t.count
		drained := t.drained
		t.mu.Unlock()
		if count == 0 {
			return 0
		}
		select {
		case <-drained:
		case <-ctx.Done():
			return t.active()
		}
	}
}

func (t *requestTracker) waitDrain(timeout time.Duration) int {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return t.wait(ctx)
}

// withRequestLifecycle tracks each request as in-flight and derives its
// context from the request's own context (so client disconnects still cancel
// long-lived streams) while linking server-level cancellation into it, so a
// shutdown can force handlers to unwind through r.Context() even when
// http.Server.Shutdown no longer waits for them.
func withRequestLifecycle(serveCtx context.Context, tracker *requestTracker, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		stopServerCancel := context.AfterFunc(serveCtx, cancel)
		defer stopServerCancel()
		tracker.begin()
		defer tracker.done()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
