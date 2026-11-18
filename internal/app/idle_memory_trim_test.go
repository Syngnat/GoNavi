package app

import (
	"testing"
	"time"
)

func TestShouldTrimIdleMemoryGatesOnVisibilityDelayIntervalAndTasks(t *testing.T) {
	now := time.Now()
	trim := &App{}

	if trim.shouldTrimIdleMemory(now) {
		t.Fatal("visible window must not trim")
	}

	trim.idleMemoryTrim.hidden.Store(true)
	trim.idleMemoryTrim.hiddenAt.Store(now.Add(-idleMemoryTrimDelay / 2).UnixNano())
	if trim.shouldTrimIdleMemory(now) {
		t.Fatal("recently hidden window must not trim before the delay")
	}

	trim.idleMemoryTrim.hiddenAt.Store(now.Add(-idleMemoryTrimDelay * 2).UnixNano())
	if !trim.shouldTrimIdleMemory(now) {
		t.Fatal("hidden window without tasks should trim")
	}

	trim.idleMemoryTrim.lastAt.Store(now.UnixNano())
	if trim.shouldTrimIdleMemory(now) {
		t.Fatal("trim must respect the minimum interval")
	}
	trim.idleMemoryTrim.lastAt.Store(now.Add(-idleMemoryTrimInterval * 2).UnixNano())

	trim.runningQueries = map[string]queryContext{"query-1": {}}
	if trim.shouldTrimIdleMemory(now) {
		t.Fatal("running query must block the trim")
	}
	delete(trim.runningQueries, "query-1")

	trim.exportTasks = map[string]*exportTaskRegistration{"job-1": {}}
	if trim.shouldTrimIdleMemory(now) {
		t.Fatal("running export must block the trim")
	}
}

func TestSetWindowHiddenForMemoryTrimResetsOnRestore(t *testing.T) {
	trim := &App{}
	trim.SetWindowHiddenForMemoryTrim(true)
	if !trim.idleMemoryTrim.hidden.Load() || trim.idleMemoryTrim.hiddenAt.Load() == 0 {
		t.Fatal("hidden state must be recorded")
	}
	trim.SetWindowHiddenForMemoryTrim(false)
	if trim.idleMemoryTrim.hidden.Load() || trim.idleMemoryTrim.hiddenAt.Load() != 0 {
		t.Fatal("restore must clear the hidden state")
	}
}
