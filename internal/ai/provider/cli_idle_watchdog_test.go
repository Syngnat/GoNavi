package provider

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCLIIdleWatchdogTimesOutWhenSilent(t *testing.T) {
	ctx, watchdog := startCLIIdleWatchdog(context.Background(), 80*time.Millisecond, time.Second)
	defer watchdog.Close()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("expected idle timeout")
	}
	if !watchdog.TimedOut() || !strings.Contains(watchdog.TimeoutError("Grok CLI").Error(), "without new output") {
		t.Fatalf("expected idle timeout error, got timedOut=%v err=%v", watchdog.TimedOut(), watchdog.TimeoutError("Grok CLI"))
	}
}

func TestCLIIdleWatchdogExtendsOnBump(t *testing.T) {
	ctx, watchdog := startCLIIdleWatchdog(context.Background(), 80*time.Millisecond, time.Second)
	defer watchdog.Close()
	done := make(chan struct{})
	go func() {
		for i := 0; i < 6; i++ {
			time.Sleep(40 * time.Millisecond)
			watchdog.Bump()
		}
		close(done)
	}()
	select {
	case <-ctx.Done():
		t.Fatal("active stream must not idle-timeout")
	case <-done:
	}
	if watchdog.TimedOut() {
		t.Fatal("bumping must keep the watchdog alive")
	}
}

func TestCLIIdleWatchdogHonorsMaxEvenWhenBumped(t *testing.T) {
	ctx, watchdog := startCLIIdleWatchdog(context.Background(), 80*time.Millisecond, 120*time.Millisecond)
	defer watchdog.Close()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(20 * time.Millisecond):
				watchdog.Bump()
			}
		}
	}()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("expected max timeout")
	}
	if !watchdog.TimedOut() || !strings.Contains(watchdog.TimeoutError("Grok CLI").Error(), "maximum") {
		t.Fatalf("expected max timeout, got %v", watchdog.TimeoutError("Grok CLI"))
	}
}
