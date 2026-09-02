package app

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSystemProxySnapshotCacheCoalescesConcurrentLoads(t *testing.T) {
	cache := systemProxySnapshotCache[string]{ttl: time.Minute}
	var calls atomic.Int32
	start := make(chan struct{})
	release := make(chan struct{})
	loader := func() (string, error) {
		if calls.Add(1) == 1 {
			close(start)
		}
		<-release
		return "snapshot", nil
	}

	const workers = 24
	results := make(chan string, workers)
	errorsSeen := make(chan error, workers)
	var waitGroup sync.WaitGroup
	for range workers {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			value, err := cache.get(loader)
			results <- value
			errorsSeen <- err
		}()
	}
	<-start
	close(release)
	waitGroup.Wait()
	close(results)
	close(errorsSeen)

	if calls.Load() != 1 {
		t.Fatalf("expected one desktop settings load, got %d", calls.Load())
	}
	for value := range results {
		if value != "snapshot" {
			t.Fatalf("expected cached snapshot, got %q", value)
		}
	}
	for err := range errorsSeen {
		if err != nil {
			t.Fatalf("unexpected cached load error: %v", err)
		}
	}
}

func TestSystemProxySnapshotCacheCachesErrorsAndRefreshesAfterTTL(t *testing.T) {
	now := time.Unix(100, 0)
	cache := systemProxySnapshotCache[int]{
		ttl: time.Second,
		now: func() time.Time { return now },
	}
	wantErr := errors.New("settings unavailable")
	var calls int
	loader := func() (int, error) {
		calls++
		if calls == 1 {
			return 0, wantErr
		}
		return 42, nil
	}

	if _, err := cache.get(loader); !errors.Is(err, wantErr) {
		t.Fatalf("expected initial load error, got %v", err)
	}
	if _, err := cache.get(loader); !errors.Is(err, wantErr) {
		t.Fatalf("expected cached load error, got %v", err)
	}
	if calls != 1 {
		t.Fatalf("expected error snapshot to be cached, got %d calls", calls)
	}

	now = now.Add(time.Second)
	value, err := cache.get(loader)
	if err != nil {
		t.Fatalf("refresh cached snapshot: %v", err)
	}
	if value != 42 || calls != 2 {
		t.Fatalf("expected refreshed value 42 after two calls, got value=%d calls=%d", value, calls)
	}
}
