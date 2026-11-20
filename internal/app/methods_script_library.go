package app

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/scriptlib"
)

func (a *App) GetScriptLibrarySnapshot() connection.QueryResult {
	return a.getScriptLibrarySnapshotContext(a.ctx)
}

func (a *App) getScriptLibrarySnapshotContext(ctx context.Context) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	store := a.scriptLibraryStore()
	if store == nil {
		return scriptWorkbenchFailure(errScriptWorkbenchUnavailable)
	}
	snapshot, err := store.Snapshot(actor)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{
		Success: true,
		Message: "OK",
		Data: ScriptWorkbenchLibrarySnapshot{
			Snapshot:        snapshot,
			CanManageShared: actor.CanManageShared,
		},
	}
}

func (a *App) SaveScriptLibraryScript(input scriptlib.SaveScriptInput) connection.QueryResult {
	return a.saveScriptLibraryScriptContext(a.ctx, input)
}

func (a *App) saveScriptLibraryScriptContext(
	ctx context.Context,
	input scriptlib.SaveScriptInput,
) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	script, err := a.scriptLibraryStore().SaveScript(ctx, actor, input)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: script}
}

func (a *App) SaveScriptLibraryFolder(input scriptlib.SaveFolderInput) connection.QueryResult {
	return a.saveScriptLibraryFolderContext(a.ctx, input)
}

func (a *App) saveScriptLibraryFolderContext(
	ctx context.Context,
	input scriptlib.SaveFolderInput,
) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	folder, err := a.scriptLibraryStore().SaveFolder(ctx, actor, input)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: folder}
}

func (a *App) DeleteScriptLibraryScript(input scriptlib.DeleteInput) connection.QueryResult {
	return a.deleteScriptLibraryScriptContext(a.ctx, input)
}

func (a *App) deleteScriptLibraryScriptContext(
	ctx context.Context,
	input scriptlib.DeleteInput,
) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	if err := a.scriptLibraryStore().DeleteScript(ctx, actor, input); err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK"}
}

func (a *App) DeleteScriptLibraryFolder(input scriptlib.DeleteInput) connection.QueryResult {
	return a.deleteScriptLibraryFolderContext(a.ctx, input)
}

func (a *App) deleteScriptLibraryFolderContext(
	ctx context.Context,
	input scriptlib.DeleteInput,
) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	if err := a.scriptLibraryStore().DeleteFolder(ctx, actor, input); err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK"}
}

func (a *App) SetScriptLibraryScriptVisibility(input scriptlib.ShareInput) connection.QueryResult {
	return a.setScriptLibraryScriptVisibilityContext(a.ctx, input)
}

func (a *App) setScriptLibraryScriptVisibilityContext(
	ctx context.Context,
	input scriptlib.ShareInput,
) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	script, err := a.scriptLibraryStore().SetScriptVisibility(ctx, actor, input)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: script}
}

func (a *App) SetScriptLibraryFolderVisibility(input scriptlib.ShareInput) connection.QueryResult {
	return a.setScriptLibraryFolderVisibilityContext(a.ctx, input)
}

func (a *App) setScriptLibraryFolderVisibilityContext(
	ctx context.Context,
	input scriptlib.ShareInput,
) connection.QueryResult {
	actor, _, err := a.scriptWorkbenchActor(ctx)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	folder, err := a.scriptLibraryStore().SetFolderVisibility(ctx, actor, input)
	if err != nil {
		return scriptWorkbenchFailure(err)
	}
	return connection.QueryResult{Success: true, Message: "OK", Data: folder}
}

func scriptWorkbenchFailure(err error) connection.QueryResult {
	message := "script workbench request failed"
	if err != nil {
		message = err.Error()
	}
	code := ""
	kind := "backend"
	switch {
	case errors.Is(err, scriptlib.ErrConflict):
		message = "script was modified by another session; reload and retry"
		code = "revision_conflict"
	case errors.Is(err, scriptlib.ErrForbidden):
		message = "this script operation is not allowed"
		code = "forbidden"
	case errors.Is(err, scriptlib.ErrNotFound):
		message = "script or folder not found"
		code = "item_not_found"
	case errors.Is(err, scriptlib.ErrInvalid):
		message = fmt.Sprintf("invalid script library input: %v", err)
		code = "invalid_input"
	case errors.Is(err, ErrWebTransferNotFound):
		code = "invalid_input"
	case errors.Is(err, errScriptWorkbenchUnavailable):
		code = "backend_unavailable"
	case errors.Is(err, errScriptWorkbenchRunNotFound):
		code = "run_not_found"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "operation_failed"
	}
	lower := strings.ToLower(message)
	if code == "" {
		switch {
		case strings.Contains(lower, "production write approval token"):
			code = "write_confirmation_required"
		case strings.Contains(lower, "another script is already running"),
			strings.Contains(lower, "concurrency limit"):
			code = "concurrency_limit"
		case strings.Contains(lower, "authenticated web user is required"),
			strings.Contains(lower, "not accessible for this user"):
			code = "forbidden"
		case strings.Contains(lower, "connection") && strings.Contains(lower, "not allowed"):
			code = "connection_not_allowed"
		case strings.Contains(lower, "script execution is restricted"):
			code = "execution_restricted"
		case strings.Contains(lower, "script writes are blocked by the current ai safety level"),
			strings.Contains(lower, "script ddl is blocked by the current ai safety level"):
			code = "execution_restricted"
		case strings.Contains(lower, "script source is required"):
			code = "empty_code"
		case strings.Contains(lower, "script exceeds"):
			code = "script_bytes"
		case strings.Contains(lower, "script input"):
			code = "invalid_input"
		}
	}
	return connection.QueryResult{
		Success: false,
		Message: message,
		Code:    code,
		Kind:    kind,
	}
}
