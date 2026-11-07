package app

import (
	"context"
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/uievents"
	wailsRuntime "GoNavi-Wails/internal/desktop"
)

const applicationBeforeCloseRequestEvent = "app:before-close-request"

var (
	emitApplicationBeforeCloseRequest = uievents.Emit
	quitApplicationRuntime            = wailsRuntime.Quit
	restartApplicationProcessFunc     = restartApplicationProcess
)

// NewBeforeCloseHandler exposes the Wails close guard without binding the
// lifecycle callback itself as a frontend RPC method.
func NewBeforeCloseHandler(a *App) func(context.Context) bool {
	return func(ctx context.Context) bool {
		if a == nil {
			return false
		}
		return a.beforeClose(ctx)
	}
}

func (a *App) beforeClose(ctx context.Context) bool {
	a.applicationQuitMu.Lock()
	if a.allowApplicationQuit {
		a.allowApplicationQuit = false
		a.applicationQuitPromptInFlight = false
		a.applicationQuitMu.Unlock()
		return false
	}
	if a.applicationQuitPromptInFlight {
		a.applicationQuitMu.Unlock()
		return true
	}
	a.applicationQuitPromptInFlight = true
	a.applicationQuitMu.Unlock()

	emitCtx := ctx
	if emitCtx == nil {
		emitCtx = a.ctx
	}
	if emitCtx != nil {
		emitApplicationBeforeCloseRequest(emitCtx, applicationBeforeCloseRequestEvent)
	}
	return true
}

// CancelApplicationQuit resets a previously intercepted close request after
// the frontend dialog is cancelled or cannot complete a save.
func (a *App) CancelApplicationQuit() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	a.applicationQuitMu.Lock()
	a.applicationQuitPromptInFlight = false
	a.allowApplicationQuit = false
	a.applicationQuitMu.Unlock()
	return connection.QueryResult{Success: true}
}

// ForceQuitApplication is called only after the frontend has confirmed that
// discarding or saving pending SQL edits is acceptable.
func (a *App) ForceQuitApplication() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	a.applicationQuitMu.Lock()
	a.allowApplicationQuit = true
	a.applicationQuitPromptInFlight = false
	a.applicationQuitMu.Unlock()
	if a.ctx != nil {
		quitApplicationRuntime(a.ctx)
	}
	return connection.QueryResult{Success: true}
}

// RestartApplication starts a detached copy of the current application and
// then exits this process. The child waits for this process to release the
// Windows single-instance lease before entering the normal startup path.
// Callers must run the normal frontend quit persistence flow first.
func (a *App) RestartApplication() connection.QueryResult {
	if a == nil {
		return connection.QueryResult{Success: false, Message: "application is not initialized"}
	}
	if err := restartApplicationProcessFunc(); err != nil {
		return connection.QueryResult{Success: false, Message: fmt.Sprintf("restart application: %v", err)}
	}
	a.applicationQuitMu.Lock()
	a.allowApplicationQuit = true
	a.applicationQuitPromptInFlight = false
	a.applicationQuitMu.Unlock()
	if a.ctx != nil {
		quitApplicationRuntime(a.ctx)
	}
	return connection.QueryResult{Success: true}
}
