package app

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func (a *App) ApplyChanges(config connection.ConnectionConfig, dbName, tableName string, changes connection.ChangeSet) (result connection.QueryResult) {
	auditSQL := fmt.Sprintf("APPLY CHANGES TO %s", strings.TrimSpace(tableName))
	defer a.beginSQLAuditUserAction(config, dbName, "data_editor", &auditSQL, &result)()
	if err := ensureConnectionAllowsDataEdit(config, "connection.backend.action.apply_result_changes"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	if applier, ok := dbInst.(db.BatchApplier); ok && runtimeSupportsBatchApply(dbInst) {
		targetTableName := resolveChangeTargetTableName(config, dbName, tableName)
		preview := buildChangePreview(dbInst, config, targetTableName, changes)
		err := applier.ApplyChanges(targetTableName, changes)
		if err != nil {
			return connection.QueryResult{
				Success:        false,
				Message:        err.Error(),
				Data:           preview,
				OutcomeUnknown: db.IsWriteOutcomeUnknown(err),
			}
		}
		// 提交成功后才留快照：失败或结果未知时数据库状态本身不确定，生成反向语句会伪装成"可还原"。
		a.captureDMLSnapshot(config, dbName, targetTableName, changes)
		return connection.QueryResult{Success: true, Message: a.appText("file.backend.message.transaction_committed", nil), Data: preview}
	}

	return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.batch_commit_unsupported", nil)}
}

// ChangePreview 变更预览结果
type ChangePreview struct {
	Deletes []string `json:"deletes"`
	Updates []string `json:"updates"`
	Inserts []string `json:"inserts"`
}

func resolveChangeTargetTableName(config connection.ConnectionConfig, dbName, tableName string) string {
	targetTableName := strings.TrimSpace(tableName)
	dbType := resolveDDLDBType(config)
	if dbType == "dameng" {
		schemaName, pureTableName := splitDamengChangeTarget(dbName, targetTableName)
		if strings.TrimSpace(pureTableName) == "" {
			return targetTableName
		}
		if strings.TrimSpace(schemaName) == "" {
			return quoteIdentByType(dbType, pureTableName)
		}
		return quoteIdentByType(dbType, schemaName) + "." + quoteIdentByType(dbType, pureTableName)
	}
	if dbType != "oracle" {
		return targetTableName
	}

	schemaName, pureTableName := normalizeSchemaAndTableByType(dbType, dbName, targetTableName)
	if strings.TrimSpace(schemaName) == "" || strings.TrimSpace(pureTableName) == "" {
		return targetTableName
	}
	return strings.TrimSpace(schemaName) + "." + strings.TrimSpace(pureTableName)
}

func splitDamengChangeTarget(dbName, tableName string) (string, string) {
	schemaName := strings.TrimSpace(dbName)
	targetTableName := strings.TrimSpace(tableName)
	if targetTableName == "" {
		return schemaName, ""
	}

	// GetTables historically returns OWNER.TABLE_NAME without quoting. The
	// selected dbName is the authoritative boundary when OWNER itself has dots.
	if schemaName != "" && len(targetTableName) > len(schemaName) &&
		strings.EqualFold(targetTableName[:len(schemaName)], schemaName) &&
		targetTableName[len(schemaName)] == '.' {
		pureTableName := strings.TrimSpace(targetTableName[len(schemaName)+1:])
		if parsedSchema, parsedTable := db.SplitSQLQualifiedNameForDialect(pureTableName, "dameng"); parsedSchema == "" && parsedTable != "" {
			pureTableName = parsedTable
		}
		return schemaName, pureTableName
	}

	parsedSchema, parsedTable := db.SplitSQLQualifiedNameForDialect(targetTableName, "dameng")
	if parsedTable == "" {
		return schemaName, targetTableName
	}
	if parsedSchema != "" {
		return parsedSchema, parsedTable
	}
	return schemaName, parsedTable
}

func buildChangePreview(dbInst db.Database, config connection.ConnectionConfig, tableName string, changes connection.ChangeSet) ChangePreview {
	if trier, ok := dbInst.(db.ChangePreviewTrier); ok {
		if deletes, updates, inserts, ok := trier.TryPreviewChanges(tableName, changes); ok {
			return ChangePreview{Deletes: deletes, Updates: updates, Inserts: inserts}
		}
	}
	if previewer, ok := dbInst.(db.ChangePreviewer); ok {
		deletes, updates, inserts := previewer.PreviewChanges(tableName, changes)
		return ChangePreview{Deletes: deletes, Updates: updates, Inserts: inserts}
	}

	dbType := resolveDDLDBType(config)
	quoter := func(s string) string { return quoteIdentByType(dbType, s) }
	tableQuoter := func(s string) string { return quoteQualifiedIdentByType(dbType, s) }
	deletes, updates, inserts := db.GenerateChangePreviewWithDialect(tableName, changes, dbType, quoter, tableQuoter)
	return ChangePreview{Deletes: deletes, Updates: updates, Inserts: inserts}
}

func (a *App) PreviewChanges(config connection.ConnectionConfig, dbName, tableName string, changes connection.ChangeSet) connection.QueryResult {
	if err := ensureConnectionAllowsDataEdit(config, "connection.backend.action.preview_result_changes"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runConfig := normalizeRunConfig(config, dbName)

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	targetTableName := resolveChangeTargetTableName(config, dbName, tableName)
	return connection.QueryResult{Success: true, Data: buildChangePreview(dbInst, config, targetTableName, changes)}
}
