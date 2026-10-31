package plugin

import (
	"context"
	"errors"
	"testing"
	"time"
)

// watchdogBudget is the dispatch budget both tests below use and wait out. It has to outlast the
// fixture's 75ms reply plus a loaded runner's scheduling noise, yet stay short enough that a test
// can sleep past it and prove the watchdog really was stopped.
const watchdogBudget = 600 * time.Millisecond

func TestAIWatchdogSurvivesCallerDeadlineAndHealthyPong(t *testing.T) {
	manager, status := runningAIProvider(t, "hold")
	// The watchdog budget has to dominate the caller deadline by a wide margin: the ping below is
	// a real stdin/stdout round trip through a child process, and a loaded runner can spend tens
	// of milliseconds scheduling it. A 60ms budget left only a 40ms window between the 20ms
	// caller deadline and the watchdog, so the ping occasionally lost the race and was answered
	// with the watchdog error (plugin ai runtime invocation deadline exceeded) even though the
	// caller-cancel semantics under test were correct.
	manager.opts.InvocationTimeout = watchdogBudget
	manager.mu.Lock()
	instance := manager.instances[status.Manifest.ID]
	manager.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := manager.InvokeAIProviderGeneration(ctx, status.Manifest.ID, status.Generation, "first", status.Digest, aiArguments("pull", "first")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("caller deadline: %v", err)
	}
	if manager.List()[0].State != StateRunning {
		t.Fatal("caller timeout quarantined before own pending watchdog")
	}
	// Keep the ping's own budget well inside the watchdog budget. Sharing one second with the
	// watchdog would reopen the same race at the far end: a ping still in flight when the
	// watchdog fires is reported as a watchdog failure, not as unresponsive fixture.
	pong, pongCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer pongCancel()
	if _, err := instance.process.call(pong, "plugin.ping", struct{}{}); err != nil {
		t.Fatalf("fixture was not responsive to heartbeat: %v", err)
	}
	waitState(t, manager, status.Manifest.ID, StateFaulted)
	waitFor(t, "watchdog settled canceled reply credit", func() bool {
		instance.aiTraffic.mu.Lock()
		defer instance.aiTraffic.mu.Unlock()
		return instance.aiTraffic.pending == 0
	})
}

func TestAILateReplyStopsPendingWatchdogWithoutFault(t *testing.T) {
	manager, status := runningAIProvider(t, "delay")
	manager.opts.InvocationTimeout = watchdogBudget
	manager.mu.Lock()
	instance := manager.instances[status.Manifest.ID]
	manager.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := manager.InvokeAIProviderGeneration(ctx, status.Manifest.ID, status.Generation, "first", status.Digest, aiArguments("pull", "first")); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("caller deadline: %v", err)
	}
	waitFor(t, "late75ms reply settled", func() bool {
		instance.aiTraffic.mu.Lock()
		defer instance.aiTraffic.mu.Unlock()
		return instance.aiTraffic.pending == 0
	})
	// Sleep past the whole budget: an unstopped watchdog has fired by now and faulted the
	// process, which is exactly the regression this test exists to catch.
	time.Sleep(watchdogBudget + 100*time.Millisecond)
	if manager.List()[0].State != StateRunning {
		t.Fatal("settled late reply retained a live watchdog")
	}
}
