package nativewindow

import (
	"context"
	"fmt"
	"strings"
	"time"
)

func (c *Control) Close() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	defer c.visibilityOpMu.Unlock()
	c.mu.Lock()
	ctx := c.ctx
	quit := c.quit
	if ctx == nil || quit == nil {
		c.mu.Unlock()
		return operationFailure("native window is not ready")
	}
	c.closeCommitted = true
	c.invalidateCloseFallbackLocked()
	c.mu.Unlock()
	c.closeGate.allow()
	if c.bridge != nil {
		c.bridge.notifyClosing()
	}
	quit(ctx)
	return OperationResult{Success: true}
}

// Hide parks this child window while keeping its process, WebView, and React
// tree alive. Visibility revisions make the transition monotonic: a delayed
// hide from an older close request cannot win over a newer host focus.
func (c *Control) Hide(visibilityRevision uint64) OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.visibilityOpMu.Lock()
	defer c.visibilityOpMu.Unlock()
	c.mu.Lock()
	if visibilityRevision < c.visibilityRevision {
		currentRevision := c.visibilityRevision
		c.mu.Unlock()
		return OperationResult{
			Success:            true,
			Message:            "stale native window hide ignored",
			VisibilityRevision: currentRevision,
		}
	}
	ctx := c.ctx
	hide := c.hideWindow
	if ctx == nil || hide == nil {
		c.mu.Unlock()
		return operationFailure("native window is not ready")
	}
	if c.closeCommitted {
		c.mu.Unlock()
		return operationFailure("native window close is already committed")
	}
	c.visibilityRevision = visibilityRevision
	c.visible = false
	c.focusPending = false
	c.focusPendingRevision = 0
	c.invalidateCloseFallbackLocked()
	c.mu.Unlock()
	c.closeGate.cancel()
	hide(ctx)
	return OperationResult{Success: true, VisibilityRevision: visibilityRevision}
}

// HideForAISettings parks the child before asking the parent to render its
// settings modal. The request runs in Go after WindowHide, so WebView suspension
// cannot leave the modal behind the detached window.
func (c *Control) HideForAISettings(visibilityRevision uint64) OperationResult {
	return c.hideForAISettings(visibilityRevision, "")
}

// HideForAISettingsProvider preserves the provider selected by the detached
// chat so the parent can open that provider's editor, not only the AI settings
// landing page.
func (c *Control) HideForAISettingsProvider(visibilityRevision uint64, providerID string) OperationResult {
	return c.hideForAISettings(visibilityRevision, strings.TrimSpace(providerID))
}

func (c *Control) hideForAISettings(visibilityRevision uint64, providerID string) OperationResult {
	if c == nil || c.bridge == nil {
		return operationFailure("native window control is unavailable")
	}
	bridge := c.bridge
	if bridge.allowParentForeground != nil {
		// Windows requires the currently foreground child to grant activation to
		// its parent before the child is hidden.
		_ = bridge.allowParentForeground()
	}
	hideResult := c.Hide(visibilityRevision)
	if !hideResult.Success {
		return hideResult
	}
	if hideResult.VisibilityRevision != visibilityRevision {
		failure := operationFailure("open AI settings was superseded by a newer window focus")
		failure.VisibilityRevision = hideResult.VisibilityRevision
		return failure
	}
	payload := map[string]any{
		"id":                 bridge.windowID,
		"kind":               bridge.kind,
		"visibilityRevision": visibilityRevision,
	}
	if providerID != "" {
		payload["providerId"] = providerID
	}
	actionResult := bridge.action("open-ai-settings", payload, false)
	if actionResult.Success && (actionResult.Applied == nil || *actionResult.Applied) {
		return OperationResult{
			Success:            true,
			ID:                 bridge.windowID,
			VisibilityRevision: visibilityRevision,
		}
	}

	// Do not strand the user in a hidden child when the parent request fails.
	restoreResult := bridge.FocusWindow(bridge.windowID)
	if restoreResult.Success {
		_ = c.FocusRevision(restoreResult.VisibilityRevision)
	} else {
		_ = c.FocusRevision(visibilityRevision)
	}
	failure := operationFailure(fmt.Sprintf("open AI settings failed: %s", actionResult.Message))
	failure.VisibilityRevision = visibilityRevision
	return failure
}

// CancelClose keeps the child alive after a failed final frontend flush. It
// also invalidates any native-close fallback so a retry starts a fresh grace
// period instead of inheriting the old timeout.
func (c *Control) CancelClose() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.mu.Lock()
	if c.closeCommitted {
		c.mu.Unlock()
		return operationFailure("native window close is already committed")
	}
	c.invalidateCloseFallbackLocked()
	c.mu.Unlock()
	c.closeGate.cancel()
	return OperationResult{Success: true}
}

// handleBeforeClose gives a mounted frontend one opportunity to submit its
// terminal payload. A child that has not acknowledged ready has no state worth
// gating, so its existing notifyClosing fallback remains in force.
func (c *Control) handleBeforeClose(ctx context.Context) bool {
	if c == nil {
		return false
	}
	if c.bridge == nil || !c.bridge.frontendReady() {
		if c.bridge != nil {
			c.bridge.notifyClosing()
		}
		return false
	}
	veto, requestFrontendClose := c.closeGate.intercept()
	if requestFrontendClose {
		c.mu.RLock()
		emitCommand := c.emitCommand
		c.mu.RUnlock()
		if emitCommand != nil {
			emitCommand(ctx, childCommand{
				ID:     c.bridge.WindowID(),
				Action: "close",
				Reason: ExitReasonWindowClosed,
			})
		}
	}
	if veto {
		c.scheduleCloseFallback(ctx)
	}
	return veto
}

func (c *Control) scheduleCloseFallback(fallbackCtx context.Context) {
	c.mu.Lock()
	if c.closeCommitted || c.closeFallback != nil {
		c.mu.Unlock()
		return
	}
	delay := c.closeFallbackDelay
	if delay <= 0 {
		delay = defaultGracefulCloseTimeout
	}
	c.closeFallbackGeneration++
	generation := c.closeFallbackGeneration
	c.closeFallback = time.AfterFunc(delay, func() {
		c.runCloseFallback(generation, fallbackCtx)
	})
	c.mu.Unlock()
}

func (c *Control) runCloseFallback(generation uint64, fallbackCtx context.Context) {
	c.visibilityOpMu.Lock()
	defer c.visibilityOpMu.Unlock()
	c.mu.Lock()
	if c.closeFallbackGeneration != generation {
		c.mu.Unlock()
		return
	}
	if c.closeCommitted || c.closeGate.isAllowed() {
		c.closeFallback = nil
		c.mu.Unlock()
		return
	}
	c.closeFallback = nil
	c.closeCommitted = true
	ctx := c.ctx
	quit := c.quit
	c.mu.Unlock()

	c.closeGate.allow()
	if c.bridge != nil {
		c.bridge.notifyClosing()
	}
	if ctx == nil {
		ctx = fallbackCtx
	}
	if ctx != nil && quit != nil {
		quit(ctx)
	}
}

func (c *Control) invalidateCloseFallbackLocked() {
	c.closeFallbackGeneration++
	if c.closeFallback != nil {
		c.closeFallback.Stop()
		c.closeFallback = nil
	}
}

func (c *Control) Focus() OperationResult {
	if c == nil {
		return operationFailure("native window control is unavailable")
	}
	c.mu.RLock()
	visibilityRevision := c.visibilityRevision
	c.mu.RUnlock()
	return c.FocusRevision(visibilityRevision)
}

// FocusRevision raises the window only when the request is at least as new as
// the last visibility transition observed by this child.
func (c *Control) FocusRevision(visibilityRevision uint64) OperationResult {
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
	if visibilityRevision < c.visibilityRevision {
		currentRevision := c.visibilityRevision
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return OperationResult{
			Success:            true,
			Message:            "stale native window focus ignored",
			VisibilityRevision: currentRevision,
		}
	}
	c.visibilityRevision = visibilityRevision
	ctx := c.ctx
	focus := c.focusWindow
	if ctx == nil || focus == nil {
		c.mu.Unlock()
		c.visibilityOpMu.Unlock()
		return operationFailure("native window is not ready")
	}
	if !c.visible {
		c.focusPending = true
		c.focusPendingRevision = visibilityRevision
		presentation := c.takeInitialPresentationLocked()
		c.mu.Unlock()
		c.runVisibilityPresentationLocked(presentation)
		return OperationResult{Success: true, VisibilityRevision: visibilityRevision}
	}
	c.focusPending = false
	c.focusPendingRevision = 0
	presentation := childWindowPresentation{
		ctx:                ctx,
		focus:              focus,
		bridge:             c.bridge,
		visibilityRevision: visibilityRevision,
	}
	c.mu.Unlock()
	c.runVisibilityPresentationLocked(presentation)
	return OperationResult{Success: true, VisibilityRevision: visibilityRevision}
}
