package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"context"
	"errors"
	"fmt"
	"strings"
)

func validateSnapshotRowErrorConfig(config SyncConfig) error {
	policy, err := normalizeRowErrorPolicy(config.RowErrorPolicy)
	if err != nil {
		return err
	}
	if policy == RowErrorPolicyStop {
		return nil
	}
	if config.OnRowError == nil {
		return errors.New("snapshot skip_row 必须提供 OnRowError 回调")
	}
	content := strings.ToLower(strings.TrimSpace(config.Content))
	if content != "" && content != "data" {
		return errors.New("snapshot skip_row 仅支持 data-only 同步")
	}
	if normalizeSyncMode(config.Mode) == "full_overwrite" {
		return errors.New("snapshot skip_row 不支持 full_overwrite")
	}
	if config.AutoAddColumns || config.CreateIndexes || normalizeTargetTableStrategy(config.TargetTableStrategy) != "existing_only" {
		return errors.New("snapshot skip_row 要求目标表已存在，且不支持自动建表、补字段或创建索引")
	}
	for table, options := range config.TableOptions {
		if options.Delete {
			return fmt.Errorf("snapshot skip_row 不支持删除传播：%s", table)
		}
	}
	if !SupportsAtomicChangeEventTarget(resolveMigrationDBType(config.TargetConfig)) {
		return errors.New("snapshot skip_row 仅支持已知原子 SQL ApplyChanges 目标")
	}
	for _, mapping := range config.Mappings {
		for _, column := range mapping.Columns {
			for _, transform := range column.Transforms {
				if !deterministicSnapshotTransform(transform.Type) {
					return fmt.Errorf("snapshot skip_row 不支持非确定字段转换 %s", transform.Type)
				}
			}
		}
	}
	return nil
}

// ValidateSnapshotRowErrorConfig exposes the same fail-closed contract used by
// RunSyncContext so callers can reject unsupported quarantine combinations in
// preflight instead of discovering them after a task has started.
func ValidateSnapshotRowErrorConfig(config SyncConfig) error {
	config = normalizeSyncConnectionDatabases(config)
	config = normalizeMappedSyncTables(config)
	return validateSnapshotRowErrorConfig(config)
}

func deterministicSnapshotTransform(transform string) bool {
	switch strings.ToLower(strings.TrimSpace(transform)) {
	case "trim", "lower", "upper", "string", "int64", "decimal", "decimal-safe", "bool", "date", "timestamp", "json":
		return true
	default:
		return false
	}
}

func (s *SyncEngine) applySnapshotChanges(config SyncConfig, res *SyncResult, sourceTable, targetTable string, applier db.BatchApplier, changes connection.ChangeSet, indexBase int) (appliedChangeCounts, error) {
	policy, err := normalizeRowErrorPolicy(config.RowErrorPolicy)
	if err != nil {
		return appliedChangeCounts{}, err
	}
	if policy == RowErrorPolicyStop {
		return s.applyChangesInBatches(config.JobID, res, targetTable, applier, changes, config.BatchSize)
	}
	return s.applySnapshotChangesOneByOne(config, res, sourceTable, targetTable, applier, changes, indexBase)
}

func (s *SyncEngine) applySnapshotChangesOneByOne(config SyncConfig, res *SyncResult, sourceTable, targetTable string, applier db.BatchApplier, changes connection.ChangeSet, indexBase int) (appliedChangeCounts, error) {
	applied := appliedChangeCounts{}
	index := indexBase
	applyOne := func(operation string, change connection.ChangeSet) error {
		if err := s.contextError(); err != nil {
			return err
		}
		if err := applySyncChangesContext(s.context(), applier, targetTable, change); err != nil {
			if db.IsWriteOutcomeUnknown(err) {
				if res != nil {
					res.OutcomeUnknown = true
				}
				return err
			}
			if s.contextError() != nil {
				return s.contextError()
			}
			sourceKey, row := snapshotChangeErrorMaterial(operation, change)
			rowError := ChangeEventRowError{
				Index:       index,
				SourceTable: sourceTable,
				Operation:   operation,
				Code:        "apply_failed",
				Message:     "snapshot 目标行变更应用失败",
				SourceKey:   sourceKey,
				Row:         row,
			}
			if callbackErr := config.OnRowError(s.context(), rowError); callbackErr != nil {
				return errors.New("snapshot 行错误回调失败")
			}
			if res != nil {
				res.RowsSkipped++
			}
			index++
			return nil
		}
		applied.Inserts += len(change.Inserts)
		applied.Updates += len(change.Updates)
		applied.Deletes += len(change.Deletes)
		index++
		return nil
	}
	for _, keys := range changes.Deletes {
		if err := applyOne(ChangeEventOperationDelete, connection.ChangeSet{Deletes: []map[string]interface{}{keys}, LocatorStrategy: changes.LocatorStrategy}); err != nil {
			return applied, err
		}
	}
	for _, update := range changes.Updates {
		if err := applyOne(ChangeEventOperationUpdate, connection.ChangeSet{Updates: []connection.UpdateRow{update}, LocatorStrategy: changes.LocatorStrategy}); err != nil {
			return applied, err
		}
	}
	for _, row := range changes.Inserts {
		if err := applyOne(ChangeEventOperationInsert, connection.ChangeSet{Inserts: []map[string]interface{}{row}, LocatorStrategy: changes.LocatorStrategy}); err != nil {
			return applied, err
		}
	}
	return applied, nil
}

func projectSnapshotRowsWithPolicy(ctx context.Context, config SyncConfig, tableName string, projection *CompiledProjection, rows []map[string]interface{}) ([]map[string]interface{}, int, error) {
	policy, err := normalizeRowErrorPolicy(config.RowErrorPolicy)
	if err != nil {
		return nil, 0, err
	}
	if policy == RowErrorPolicyStop {
		projected, err := projectSyncRows(projection, rows)
		return projected, 0, err
	}
	projected := make([]map[string]interface{}, 0, len(rows))
	skipped := 0
	for index, row := range rows {
		if err := ctx.Err(); err != nil {
			return nil, skipped, err
		}
		mapped, err := projection.Project(row)
		if err == nil {
			projected = append(projected, mapped)
			continue
		}
		rowError := ChangeEventRowError{
			Index:       index,
			SourceTable: tableName,
			Operation:   "project",
			Code:        "projection_failed",
			Message:     "snapshot 字段投影失败",
			Row:         row,
		}
		if callbackErr := config.OnRowError(ctx, rowError); callbackErr != nil {
			return nil, skipped, errors.New("snapshot 行错误回调失败")
		}
		skipped++
	}
	return projected, skipped, nil
}

func snapshotChangeErrorMaterial(operation string, change connection.ChangeSet) (map[string]interface{}, map[string]interface{}) {
	switch operation {
	case ChangeEventOperationDelete:
		if len(change.Deletes) > 0 {
			return change.Deletes[0], change.Deletes[0]
		}
	case ChangeEventOperationUpdate:
		if len(change.Updates) > 0 {
			row := make(map[string]interface{}, len(change.Updates[0].Keys)+len(change.Updates[0].Values))
			for key, value := range change.Updates[0].Keys {
				row[key] = value
			}
			for key, value := range change.Updates[0].Values {
				row[key] = value
			}
			return change.Updates[0].Keys, row
		}
	case ChangeEventOperationInsert:
		if len(change.Inserts) > 0 {
			return nil, change.Inserts[0]
		}
	}
	return nil, nil
}
