package app

import (
	"errors"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

type tableDataClearMode string

const (
	tableDataClearModeTruncate  tableDataClearMode = "truncate"
	tableDataClearModeDeleteAll tableDataClearMode = "delete_all"
)

func supportsTruncateTableForDBType(dbType string) bool {
	switch normalizeSQLClassifierDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "starrocks", "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "iris", "oracle", "dameng", "clickhouse", "duckdb":
		return true
	default:
		return false
	}
}

func buildTableDataClearSQL(config connection.ConnectionConfig, objectName string, mode tableDataClearMode) (string, error) {
	return buildTableDataClearSQLWithText(config, objectName, mode, nil)
}

func buildTableDataClearSQLWithText(config connection.ConnectionConfig, objectName string, mode tableDataClearMode, text fileBackendTextFunc) (string, error) {
	registryAction := map[tableDataClearMode]string{tableDataClearModeTruncate: "truncateTable", tableDataClearModeDeleteAll: "clearTable"}[mode]
	if sql, ok := registryObjectStatement(config.Type, registryAction, map[string]string{"table": objectName}); ok {
		return sql, nil
	}
	dbType := resolveDDLDBType(config)
	quotedObject := quoteQualifiedIdentByType(dbType, objectName)

	switch mode {
	case tableDataClearModeTruncate:
		if !supportsTruncateTableForDBType(dbType) {
			return "", errors.New(fileBackendText(text, "file.backend.error.table_data_truncate_unsupported", map[string]any{"type": strings.TrimSpace(dbType)}))
		}
		return fmt.Sprintf("TRUNCATE TABLE %s", quotedObject), nil
	case tableDataClearModeDeleteAll:
		if dbType == "mongodb" {
			return fmt.Sprintf(`{"delete":"%s","deletes":[{"q":{},"limit":0}]}`, objectName), nil
		}
		return fmt.Sprintf("DELETE FROM %s", quotedObject), nil
	default:
		return "", errors.New(fileBackendText(text, "file.backend.error.table_data_mode_unsupported", map[string]any{"mode": string(mode)}))
	}
}

func tableDataClearActionLabels(mode tableDataClearMode) (actionLabel string, progressLabel string) {
	switch mode {
	case tableDataClearModeTruncate:
		return "truncate_table", "truncate"
	default:
		return "clear_table", "clear"
	}
}

func tableDataClearMessageKeys(mode tableDataClearMode, partial bool) (failureKey string, successKey string) {
	switch mode {
	case tableDataClearModeTruncate:
		if partial {
			return "file.backend.error.table_data_truncate_failed_partial", "file.backend.message.table_data_truncate_succeeded"
		}
		return "file.backend.error.table_data_truncate_failed", "file.backend.message.table_data_truncate_succeeded"
	default:
		if partial {
			return "file.backend.error.table_data_clear_failed_partial", "file.backend.message.table_data_clear_succeeded"
		}
		return "file.backend.error.table_data_clear_failed", "file.backend.message.table_data_clear_succeeded"
	}
}

func (a *App) runTableDataClear(config connection.ConnectionConfig, dbName string, tableNames []string, mode tableDataClearMode) (result connection.QueryResult) {
	auditAction := "DELETE TABLE DATA"
	if mode == tableDataClearModeTruncate {
		auditAction = "TRUNCATE TABLE DATA"
	}
	auditSQL := auditAction + " " + strings.Join(tableNames, ", ")
	defer a.beginSQLAuditUserAction(config, dbName, "object_editor", &auditSQL, &result)()
	actionLabel, progressLabel := tableDataClearActionLabels(mode)
	if err := ensureConnectionAllowsDataEdit(config, actionLabel); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	runConfig := normalizeRunConfig(config, dbName)

	// 参数校验
	if len(tableNames) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.table_data_no_tables", nil)}
	}

	objects := make([]string, 0, len(tableNames))
	seen := make(map[string]struct{}, len(tableNames))
	for _, t := range tableNames {
		tt := strings.TrimSpace(t)
		if tt == "" {
			continue
		}
		if _, ok := seen[tt]; ok {
			continue
		}
		seen[tt] = struct{}{}
		objects = append(objects, tt)
	}

	if len(objects) == 0 {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.table_data_no_tables", nil)}
	}
	const maxBatchSize = 200
	if len(objects) > maxBatchSize {
		return connection.QueryResult{Success: false, Message: a.appText("file.backend.error.table_data_batch_limit", map[string]any{"max": maxBatchSize, "count": len(objects)})}
	}

	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	logger.Warnf("%s 开始：%s db=%s tables=%v（共 %d 张）", actionLabel, formatConnSummary(runConfig), dbName, objects, len(objects))

	var executedSQLs []string
	for i, objectName := range objects {
		sql, sqlErr := buildTableDataClearSQLWithText(runConfig, objectName, mode, a.appText)
		if sqlErr != nil {
			return connection.QueryResult{
				Success: false,
				Message: sqlErr.Error(),
				Data: map[string]interface{}{
					"executedSQLs": executedSQLs,
					"count":        len(executedSQLs),
				},
			}
		}

		if _, err := dbInst.Exec(sql); err != nil {
			logger.Warnf("%s 第 %d/%d 张表失败：%s table=%s err=%v（已成功%s %d 张）", actionLabel, i+1, len(objects), formatConnSummary(runConfig), objectName, err, progressLabel, len(executedSQLs))
			failureKey, _ := tableDataClearMessageKeys(mode, len(executedSQLs) > 0)
			errMsg := a.appText(failureKey, map[string]any{"table": objectName, "detail": err.Error(), "count": len(executedSQLs)})
			return connection.QueryResult{
				Success: false,
				Message: errMsg,
				Data: map[string]interface{}{
					"executedSQLs": executedSQLs,
					"count":        len(executedSQLs),
				},
			}
		}
		executedSQLs = append(executedSQLs, sql)
	}

	logger.Warnf("%s 完成：%s db=%s 共%s %d 张表", actionLabel, formatConnSummary(runConfig), dbName, progressLabel, len(executedSQLs))

	_, successKey := tableDataClearMessageKeys(mode, false)
	return connection.QueryResult{
		Success: true,
		Message: a.appText(successKey, nil),
		Data: map[string]interface{}{
			"executedSQLs": executedSQLs,
			"count":        len(executedSQLs),
		},
	}
}

// TruncateTables 截断指定表的数据；仅在明确支持 TRUNCATE TABLE 的数据库类型上执行。
func (a *App) TruncateTables(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.runTableDataClear(config, dbName, tableNames, tableDataClearModeTruncate)
}

// ClearTables 清空指定表的数据；关系型数据库使用 DELETE FROM，MongoDB 使用 delete 命令。
func (a *App) ClearTables(config connection.ConnectionConfig, dbName string, tableNames []string) connection.QueryResult {
	return a.runTableDataClear(config, dbName, tableNames, tableDataClearModeDeleteAll)
}
