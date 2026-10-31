//go:build gonavi_full_drivers || gonavi_hive_driver

package db

import (
	"context"
	"fmt"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

var (
	_ ChangePreviewer    = (*HiveDB)(nil)
	_ ChangePreviewTrier = (*HiveDB)(nil)
)

// PreviewChanges returns the exact typed statements used by ApplyChangesContext.
// Failure is a non-executable comment, never generic VALUES SQL or a fallback.
func (h *HiveDB) PreviewChanges(tableName string, changes connection.ChangeSet) (deletes, updates, inserts []string) {
	_, statements, err := h.prepareHiveChanges(metadataContextFor(h), tableName, changes)
	if err != nil {
		return []string{hivePreviewUnavailable(err)}, nil, nil
	}
	deleteCount, updateCount := len(changes.Deletes), len(changes.Updates)
	return statements[:deleteCount], statements[deleteCount : deleteCount+updateCount], statements[deleteCount+updateCount:]
}

// TryPreviewChanges always owns the Hive preview path, including unavailable
// metadata. Returning false would re-enable the lossy generic SQL renderer.
func (h *HiveDB) TryPreviewChanges(tableName string, changes connection.ChangeSet) ([]string, []string, []string, bool) {
	deletes, updates, inserts := h.PreviewChanges(tableName, changes)
	return deletes, updates, inserts, true
}

func (h *HiveDB) prepareHiveChanges(ctx context.Context, tableName string, changes connection.ChangeSet) (HiveTableWriteCapabilities, []string, error) {
	if len(changes.Inserts)+len(changes.Updates)+len(changes.Deletes) == 0 {
		return HiveTableWriteCapabilities{}, nil, nil
	}
	capability, err := h.HiveTableWriteCapabilities(ctx, tableName)
	if err != nil {
		return capability, nil, err
	}
	if len(changes.Inserts) > 0 && !capability.Insert || len(changes.Updates) > 0 && !capability.Update || len(changes.Deletes) > 0 && !capability.Delete {
		return capability, nil, fmt.Errorf("Hive table does not support requested mutations: %s", capability.Reason)
	}
	base, err := h.sessionContext(ctx, true)
	if err != nil {
		return capability, nil, err
	}
	parts, err := hivesql.SplitTable(tableName)
	if err != nil {
		return capability, nil, err
	}
	database, table := base.config.Database, parts[0]
	if len(parts) == 2 {
		database, table = parts[0], parts[1]
	}
	columns, err := h.GetColumnsContext(ctx, database, table)
	if err != nil {
		return capability, nil, err
	}
	statements, err := hivePlanChanges(hiveQualifiedName(database, table), columns, capability, changes)
	return capability, statements, err
}
