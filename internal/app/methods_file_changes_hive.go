package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func (a *App) applyHiveChanges(config connection.ConnectionConfig, database, table string, instance db.Database, changes connection.ChangeSet) connection.QueryResult {
	applier, ok := instance.(db.BatchApplierContext)
	if !ok {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.batch_commit_unsupported", nil)}
	}
	ctx := a.pluginRuntimeContext()
	if ctx == nil {
		ctx = context.Background()
	}
	target := resolveChangeTargetTableName(config, database, table)
	preview := buildChangePreview(instance, config, target, changes)
	if err := applier.ApplyChangesContext(ctx, target, changes); err != nil {
		// The driver marks post-dispatch uncertainty. Never replay any subset or
		// build compensating statements from a possibly partial Hive write.
		return connection.QueryResult{Success: false, Message: err.Error(), Data: preview,
			OutcomeUnknown: db.IsWriteOutcomeUnknown(err) || db.IsAmbiguousWriteResponse(err)}
	}
	return connection.QueryResult{Success: true, Message: a.appText("hive.backend.message.changes_applied", nil), Data: preview}
}
