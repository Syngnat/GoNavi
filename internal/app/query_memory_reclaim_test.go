package app

import (
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestShouldReleaseQueryMemoryUsesRowOrByteThreshold(t *testing.T) {
	if shouldReleaseQueryMemory(queryMemoryTrimRowsThreshold-1, queryMemoryTrimBytesThreshold-1) {
		t.Fatal("small result must not trigger a trim")
	}
	if !shouldReleaseQueryMemory(queryMemoryTrimRowsThreshold, 0) {
		t.Fatal("row threshold must trigger a trim")
	}
	if !shouldReleaseQueryMemory(1, queryMemoryTrimBytesThreshold) {
		t.Fatal("byte threshold must trigger a trim")
	}
}

func TestEstimateQueryRowsBytesCountsPayload(t *testing.T) {
	rows := []map[string]interface{}{
		{"id": 1, "name": "alpha", "blob": []byte("data")},
	}
	got := estimateQueryRowsBytes(rows)
	if got < int64(len("alpha")+len("data")) {
		t.Fatalf("estimate = %d, want at least payload size", got)
	}
}

func TestMaybeReleaseQueryResultMemorySkipsEmptyAndFailedResults(t *testing.T) {
	originalAsync := runQueryMemoryTrimAsync
	t.Cleanup(func() { runQueryMemoryTrimAsync = originalAsync })
	triggered := 0
	runQueryMemoryTrimAsync = func(func()) { triggered++ }

	large := make([]map[string]interface{}, queryMemoryTrimRowsThreshold)
	maybeReleaseQueryResultMemory(connection.QueryResult{Success: false, Data: large})
	maybeReleaseQueryResultMemory(connection.QueryResult{Success: true})
	if triggered != 0 {
		t.Fatalf("trims = %d, want 0", triggered)
	}
}

func TestNextQueryMemoryTrimDelayRespectsInterval(t *testing.T) {
	originalLast := queryMemoryTrimLastAt.Load()
	t.Cleanup(func() { queryMemoryTrimLastAt.Store(originalLast) })

	queryMemoryTrimLastAt.Store(0)
	if delay := nextQueryMemoryTrimDelay(); delay != 0 {
		t.Fatalf("delay = %v, want 0 without a previous trim", delay)
	}
	queryMemoryTrimLastAt.Store(time.Now().Add(-queryMemoryTrimMinInterval / 2).UnixNano())
	if delay := nextQueryMemoryTrimDelay(); delay <= 0 || delay > queryMemoryTrimMinInterval {
		t.Fatalf("delay = %v, want within the interval", delay)
	}
	queryMemoryTrimLastAt.Store(time.Now().Add(-2 * queryMemoryTrimMinInterval).UnixNano())
	if delay := nextQueryMemoryTrimDelay(); delay != 0 {
		t.Fatalf("delay = %v, want 0 after the interval", delay)
	}
}

func TestMaybeReleaseQueryResultMemoryTriggersForLargeResult(t *testing.T) {
	originalAsync := runQueryMemoryTrimAsync
	originalFn := queryMemoryTrimFn
	originalLast := queryMemoryTrimLastAt.Load()
	t.Cleanup(func() {
		runQueryMemoryTrimAsync = originalAsync
		queryMemoryTrimFn = originalFn
		queryMemoryTrimLastAt.Store(originalLast)
	})
	queryMemoryTrimLastAt.Store(0)
	queryMemoryTrimRunning.Store(false)

	trimmed := 0
	runQueryMemoryTrimAsync = func(fn func()) { fn() }
	queryMemoryTrimFn = func() { trimmed++ }

	rows := make([]map[string]interface{}, queryMemoryTrimRowsThreshold)
	maybeReleaseQueryResultMemory(connection.QueryResult{Success: true, Data: rows})
	if trimmed != 1 {
		t.Fatalf("trims = %d, want 1", trimmed)
	}
}
