package provider

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// cliIdleWatchdog cancels a CLI process when it goes silent, not when the
// whole turn simply lasts longer than a fixed wall clock. Streaming thinking
// therefore keeps the request alive; a hung process still dies.
type cliIdleWatchdog struct {
	idle   time.Duration
	max    time.Duration
	cancel context.CancelFunc

	mu      sync.Mutex
	last    time.Time
	start   time.Time
	reason  string
	stopped chan struct{}
}

func startCLIIdleWatchdog(parent context.Context, idle, max time.Duration) (context.Context, *cliIdleWatchdog) {
	if idle <= 0 {
		idle = time.Second
	}
	if max <= 0 {
		max = idle
	}
	ctx, cancel := context.WithCancel(parent)
	watchdog := &cliIdleWatchdog{
		idle:    idle,
		max:     max,
		cancel:  cancel,
		last:    time.Now(),
		start:   time.Now(),
		stopped: make(chan struct{}),
	}
	go watchdog.loop(parent)
	return ctx, watchdog
}

func (w *cliIdleWatchdog) loop(parent context.Context) {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-w.stopped:
			return
		case <-parent.Done():
			w.cancel()
			return
		case now := <-ticker.C:
			w.mu.Lock()
			idleExpired := now.Sub(w.last) >= w.idle
			maxExpired := now.Sub(w.start) >= w.max
			already := w.reason != ""
			if !already && (idleExpired || maxExpired) {
				if maxExpired {
					w.reason = "max"
				} else {
					w.reason = "idle"
				}
			}
			reason := w.reason
			w.mu.Unlock()
			if reason != "" {
				w.cancel()
				return
			}
		}
	}
}

func (w *cliIdleWatchdog) Bump() {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.last = time.Now()
	w.mu.Unlock()
}

func (w *cliIdleWatchdog) Close() {
	if w == nil {
		return
	}
	select {
	case <-w.stopped:
	default:
		close(w.stopped)
	}
	w.cancel()
}

func (w *cliIdleWatchdog) TimedOut() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.reason == "idle" || w.reason == "max"
}

func (w *cliIdleWatchdog) TimeoutError(name string) error {
	elapsed := time.Since(w.start).Round(time.Millisecond)
	if w == nil {
		return fmt.Errorf("%s timed out after %s", name, elapsed)
	}
	w.mu.Lock()
	reason := w.reason
	idle := w.idle
	max := w.max
	w.mu.Unlock()
	if reason == "max" {
		return fmt.Errorf("%s timed out after %s (maximum %s)", name, elapsed, max)
	}
	return fmt.Errorf("%s timed out after %s without new output (idle %s, maximum %s)", name, elapsed, idle, max)
}
