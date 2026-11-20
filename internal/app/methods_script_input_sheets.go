package app

import (
	"context"
	"errors"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/webidentity"
)

// ListScriptInputSheets returns worksheet names in workbook.xml order. Text
// inputs deliberately return an empty list without parsing their contents.
func (a *App) ListScriptInputSheets(input ScriptWorkbenchInput) connection.QueryResult {
	return a.listScriptInputSheetsContext(a.ctx, input)
}

func (a *App) listScriptInputSheetsContext(
	ctx context.Context,
	input ScriptWorkbenchInput,
) connection.QueryResult {
	if a == nil {
		return scriptWorkbenchFailure(errScriptWorkbenchUnavailable)
	}

	webOwner := ""
	if a.webRuntime {
		actor, ok := webidentity.ActorFromContext(ctx)
		if !ok {
			return scriptWorkbenchFailure(errors.New("authenticated web user is required"))
		}
		webOwner = actor.Username
	}

	source, err := a.resolveScriptWorkbenchInputSource(
		input.Path,
		input.Reference,
		webOwner,
	)
	if err != nil {
		if errors.Is(err, ErrWebTransferNotFound) {
			err = errors.New("script input file is unavailable")
		}
		return scriptWorkbenchFailure(err)
	}

	sheets := make([]string, 0)
	if source.extension == ".xlsx" {
		sheets, err = readXLSXSheetNames(source.path)
		if err != nil {
			return scriptWorkbenchFailure(err)
		}
	}
	return connection.QueryResult{
		Success: true,
		Message: "OK",
		Data:    map[string]any{"sheets": sheets},
	}
}
