package nativewindow

import (
	"context"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// Control is bound only in a child and always targets that process's native
// Wails window.
type Control struct {
	mu                      sync.RWMutex
	visibilityOpMu          sync.Mutex
	ctx                     context.Context
	bridge                  *Bridge
	closeGate               closeGate
	closeFallback           *time.Timer
	closeFallbackGeneration uint64
	closeFallbackDelay      time.Duration
	closeCommitted          bool
	visibilityRevision      uint64
	domReady                bool
	frontendReady           bool
	focusPending            bool
	focusPendingRevision    uint64
	visible                 bool
	emitCommand             func(context.Context, childCommand)
	showWindow              func(context.Context)
	hideWindow              func(context.Context)
	focusWindow             func(context.Context)
	quit                    func(context.Context)
}

func newControl(bridge *Bridge) *Control {
	return &Control{
		bridge:             bridge,
		closeFallbackDelay: defaultGracefulCloseTimeout,
		emitCommand: func(ctx context.Context, command childCommand) {
			wailsRuntime.EventsEmit(ctx, CommandEventName, command)
		},
		showWindow: func(ctx context.Context) {
			wailsRuntime.WindowShow(ctx)
		},
		hideWindow: func(ctx context.Context) {
			wailsRuntime.WindowHide(ctx)
		},
		focusWindow: func(ctx context.Context) {
			wailsRuntime.WindowUnminimise(ctx)
			wailsRuntime.Show(ctx)
			// Accessory applications do not reliably make their window key when
			// only the application is activated. Explicitly order the detached
			// window front after unhiding the process.
			wailsRuntime.WindowShow(ctx)
		},
		quit: wailsRuntime.Quit,
	}
}

func InitializeControl(control *Control, ctx context.Context) {
	if control == nil {
		return
	}
	control.mu.Lock()
	control.ctx = ctx
	control.mu.Unlock()
}

// markDOMReady records that the WebView exists without exposing its still-empty
// surface. The frontend ready handshake releases the first presentation only
// after its own post-paint barrier.
func (c *Control) markDOMReady(ctx context.Context) {
	if c == nil {
		return
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.ctx == nil {
		c.ctx = ctx
	}
	c.domReady = true
	presentation := c.takeInitialPresentationLocked()
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
}

func (c *Control) markFrontendReady() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window close is already committed")
	}
	if !c.domReady || c.ctx == nil || c.showWindow == nil {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window DOM is not ready")
	}
	c.frontendReady = true
	presentation := c.takeInitialPresentationLocked()
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
	return OperationResult{Success: true}
}

// Present exposes the already-mounted child without acknowledging readiness to
// the parent. The visible WebView can then cross a real paint frame before the
// frontend sends its final ready action.
func (c *Control) Present() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window close is already committed")
	}
	if !c.domReady || c.ctx == nil || c.showWindow == nil {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window DOM is not ready")
	}
	if c.visible {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return OperationResult{Success: true}
	}
	c.visible = true
	presentation := childWindowPresentation{ctx: c.ctx, show: c.showWindow}
	if c.focusPending && c.focusWindow != nil {
		c.focusPending = false
		presentation.visibilityRevision = c.focusPendingRevision
		c.focusPendingRevision = 0
		presentation.focus = c.focusWindow
		presentation.bridge = c.bridge
	}
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
	return OperationResult{Success: true}
}

type childWindowPresentation struct {
	ctx                context.Context
	show               func(context.Context)
	focus              func(context.Context)
	bridge             *Bridge
	visibilityRevision uint64
}

func (p childWindowPresentation) runNative() {
	if p.show != nil {
		p.show(p.ctx)
	}
	if p.focus != nil {
		p.focus(p.ctx)
	}
}

func (p childWindowPresentation) acknowledgeFocus() {
	if p.focus == nil || p.bridge == nil || p.visibilityRevision == 0 {
		return
	}
	// The parent must retain its pending focus until the native focus callback
	// has actually run. A failed acknowledgement deliberately leaves that
	// pending command available for the next SSE reconnect.
	_ = p.bridge.acknowledgeFocus(p.ctx, p.visibilityRevision)
}

// runVisibilityPresentationLocked keeps state selection and native effects in
// one visibility operation, then releases the lock before parent RPC.
func (c *Control) runVisibilityPresentationLocked(presentation childWindowPresentation) {
	func() {
		defer c.visibilityOpMu.Unlock()
		presentation.runNative()
	}()
	presentation.acknowledgeFocus()
}

func (c *Control) takeInitialPresentationLocked() childWindowPresentation {
	if c.closeCommitted || c.visible || !c.domReady || !c.frontendReady || c.ctx == nil || c.showWindow == nil {
		return childWindowPresentation{}
	}
	c.visible = true
	presentation := childWindowPresentation{ctx: c.ctx, show: c.showWindow}
	if c.focusPending && c.focusWindow != nil {
		c.focusPending = false
		presentation.visibilityRevision = c.focusPendingRevision
		c.focusPendingRevision = 0
		presentation.focus = c.focusWindow
		presentation.bridge = c.bridge
	}
	return presentation
}
