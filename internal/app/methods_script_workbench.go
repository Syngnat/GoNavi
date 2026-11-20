package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/scriptlib"
)

func (a *App) RunScriptWorkbench(request ScriptWorkbenchRunRequest) connection.QueryResult {
	return a.runScriptWorkbenchContext(a.ctx, request)
}

func (a *App) runScriptWorkbenchContext(
	ctx context.Context,
	request ScriptWorkbenchRunRequest,
) connection.QueryResult {
	actor, webActor, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	prepared, err := a.prepareScriptWorkbenchRun(ctx, request, actor, webActor)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	run, err := a.scriptWorkbench.begin(a, prepared, ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: run.snapshot()}
}

func (a *App) CancelScriptWorkbenchRun(runID string) connection.QueryResult {
	return a.cancelScriptWorkbenchRunContext(a.ctx, runID)
}

func (a *App) cancelScriptWorkbenchRunContext(
	ctx context.Context,
	runID string,
) connection.QueryResult {
	run := a.scriptWorkbench.get(runID)
	if run == nil {
		return scriptWorkbenchFailure(errScriptWorkbenchRunNotFound)
	}
	if err := a.ensureScriptRunAccess(ctx, run); err != nil {
		return scriptWorkbenchFailure(err)
	}
	if !a.scriptWorkbench.cancel(runID) {
		return scriptWorkbenchFailure(errScriptWorkbenchRunNotFound)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: run.snapshot()}
}

func (a *App) GetScriptWorkbenchRun(runID string) connection.QueryResult {
	return a.getScriptWorkbenchRunContext(a.ctx, runID)
}

func (a *App) getScriptWorkbenchRunContext(
	ctx context.Context,
	runID string,
) connection.QueryResult {
	run := a.scriptWorkbench.get(runID)
	if run == nil {
		return scriptWorkbenchFailure(errScriptWorkbenchRunNotFound)
	}
	if err := a.ensureScriptRunAccess(ctx, run); err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: run.snapshot()}
}

func (a *App) GetScriptWorkbenchOutput(
	runID string,
	outputIndex int,
	page int,
	pageSize int,
) connection.QueryResult {
	return a.getScriptWorkbenchOutputContext(a.ctx, runID, outputIndex, page, pageSize)
}

func (a *App) getScriptWorkbenchOutputContext(
	ctx context.Context,
	runID string,
	outputIndex int,
	page int,
	pageSize int,
) connection.QueryResult {
	run := a.scriptWorkbench.get(runID)
	if run == nil {
		return scriptWorkbenchFailure(errScriptWorkbenchRunNotFound)
	}
	if err := a.ensureScriptRunAccess(ctx, run); err != nil {
		return scriptWorkbenchFailure(err)
	}
	result, err := run.outputPage(outputIndex, page, pageSize)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: result}
}

func (a *App) ensureScriptRunAccess(ctx context.Context, run *scriptWorkbenchRun) error {
	if a == nil || run == nil {
		return errScriptWorkbenchUnavailable
	}
	if !a.webRuntime {
		return nil
	}
	actor, ok := webidentityActor(ctx)
	if !ok {
		return errors.New("authenticated web user is required")
	}
	if !strings.EqualFold(strings.TrimSpace(run.owner), scriptlib.WebOwner(actor.Username)) {
		return fmt.Errorf("script run %q is not accessible for this user", run.id)
	}
	return nil
}

// shutdownScriptWorkbenchRuns is called by lifecycle wiring owned by the main
// agent. It cancels active workers and waits for their database/file cleanup.
func (a *App) shutdownScriptWorkbenchRuns(timeout time.Duration) bool {
	if a == nil {
		return true
	}
	return a.scriptWorkbench.shutdown(timeout)
}
