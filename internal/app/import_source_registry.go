package app

import (
	"io"
	"sync"
)

// importSourceRegistry lets cancellable import readers close the underlying
// file or zip handle immediately. Lower-level parsers may block in read while
// a context cancellation is already pending; closing the handle interrupts it.
type importSourceRegistry struct {
	mu             sync.Mutex
	closeRequested bool
	closer         io.Closer
}

func (r *importSourceRegistry) Attach(closer io.Closer) {
	if r == nil || closer == nil {
		return
	}
	r.mu.Lock()
	if !r.closeRequested {
		r.closer = closer
		r.mu.Unlock()
		return
	}
	r.mu.Unlock()
	_ = closer.Close()
}

func (r *importSourceRegistry) Close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.closeRequested = true
	closer := r.closer
	r.mu.Unlock()
	if closer != nil {
		_ = closer.Close()
	}
}
