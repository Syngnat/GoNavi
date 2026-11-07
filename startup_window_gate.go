//go:build !wails3

package main

import (
	"sync"
	"time"
)

const (
	startupFrontendReadyEvent = "gonavi:frontend-ready"
	startupWindowShowFallback = 4 * time.Second
)

// startupWindowGate keeps the main window hidden until either the frontend has
// painted its final startup geometry or a fallback timer fires. Showing on
// DOMContentLoaded used to present Wails' empty white client area because
// bootstrap.ts still had to load catalogs and React had not hydrated; on macOS
// it also exposed the remembered-bounds/maximise transition as a visible
// "small window then full screen" animation.
type startupWindowGate struct {
	mu            sync.Mutex
	iconReady     bool
	frontendReady bool
	timedOut      bool
	presented     bool
	show          func()
	fallback      *time.Timer
}

func newStartupWindowGate() *startupWindowGate {
	return &startupWindowGate{}
}

func shouldShowStartupWindow(iconReady, frontendReady, timedOut, showBound bool) bool {
	return showBound && iconReady && (frontendReady || timedOut)
}

func (g *startupWindowGate) bindShow(show func()) {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.show = show
	g.mu.Unlock()
	g.tryShow()
}

func (g *startupWindowGate) markIconReady() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.iconReady = true
	g.mu.Unlock()
	g.tryShow()
}

func (g *startupWindowGate) markFrontendReady() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.frontendReady = true
	g.mu.Unlock()
	g.tryShow()
}

func (g *startupWindowGate) markTimedOut() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.timedOut = true
	g.mu.Unlock()
	g.tryShow()
}

func (g *startupWindowGate) startFallback(timeout time.Duration, onTimeout func()) {
	if g == nil {
		return
	}
	if timeout <= 0 {
		if onTimeout != nil {
			onTimeout()
		} else {
			g.markTimedOut()
		}
		return
	}
	g.mu.Lock()
	if g.fallback != nil {
		g.fallback.Stop()
	}
	g.fallback = time.AfterFunc(timeout, func() {
		if onTimeout != nil {
			onTimeout()
			return
		}
		g.markTimedOut()
	})
	g.mu.Unlock()
}

func (g *startupWindowGate) tryShow() {
	if g == nil {
		return
	}
	g.mu.Lock()
	show := g.show
	ready := shouldShowStartupWindow(g.iconReady, g.frontendReady, g.timedOut, show != nil)
	if !ready || g.presented {
		g.mu.Unlock()
		return
	}
	g.presented = true
	if g.fallback != nil {
		g.fallback.Stop()
		g.fallback = nil
	}
	g.mu.Unlock()
	show()
}
