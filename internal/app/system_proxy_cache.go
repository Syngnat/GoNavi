package app

import (
	"sync"
	"time"
)

// systemProxySnapshotCache prevents a transport's Proxy callback from
// repeatedly invoking desktop configuration processes or rereading config
// files for every request (including concurrent Range requests).
type systemProxySnapshotCache[T any] struct {
	mu       sync.Mutex
	ttl      time.Duration
	now      func() time.Time
	loaded   bool
	loadedAt time.Time
	value    T
	err      error
}

func (cache *systemProxySnapshotCache[T]) get(loader func() (T, error)) (T, error) {
	cache.mu.Lock()
	defer cache.mu.Unlock()

	now := time.Now()
	if cache.now != nil {
		now = cache.now()
	}
	if cache.loaded && cache.ttl > 0 && now.Sub(cache.loadedAt) < cache.ttl {
		return cache.value, cache.err
	}

	cache.value, cache.err = loader()
	cache.loaded = true
	cache.loadedAt = now
	return cache.value, cache.err
}
