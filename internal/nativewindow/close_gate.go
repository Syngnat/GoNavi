//go:build !wails3

package nativewindow

import "sync"

// closeGate lets the first native close request ask the frontend for a final
// sync. Control.Close opens the gate after that terminal action succeeds.
type closeGate struct {
	mu      sync.Mutex
	allowed bool
}

func (g *closeGate) intercept() (veto bool, requestFrontendClose bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.allowed {
		return false, false
	}
	// Emit on every native close attempt. The React terminal state deduplicates
	// concurrent requests, while a user can retry after a failed final flush.
	return true, true
}

func (g *closeGate) allow() {
	g.mu.Lock()
	g.allowed = true
	g.mu.Unlock()
}

func (g *closeGate) cancel() {
	g.mu.Lock()
	g.allowed = false
	g.mu.Unlock()
}

func (g *closeGate) isAllowed() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.allowed
}
