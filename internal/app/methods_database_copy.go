package app

import (
	"fmt"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/logger"
)

// CopyDatabase 在同一连接内把整个库复制成一个新库（结构 + 数据）。
//
// 与 CopyTable 保持同一套语义：新库名从 <source>_copy1 开始，已存在就递增；
// 任一环节失败都回滚掉已建的库，不留下半成品。
//
// 复制方式按方言分两种：
//   - MySQL 系：CREATE DATABASE 后对每张表 CREATE TABLE ... LIKE + INSERT ... SELECT，
//     全程在服务端完成，不经过应用层搬运数据。
//   - PostgreSQL 系：库之间不能跨库查询，只能逐表导出/导入，暂不支持。
const maxCopyDatabaseCreateAttempts = 200

func (a *App) CopyDatabase(
	config connection.ConnectionConfig,
	dbName string,
) (result connection.QueryResult) {
	sourceDatabase := strings.TrimSpace(dbName)
	auditSQL := fmt.Sprintf("COPY DATABASE %s", sourceDatabase)
	defer a.beginSQLAuditUserAction(config, sourceDatabase, "object_editor", &auditSQL, &result)()

	if sourceDatabase == "" {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.database_name_required", nil),
		}
	}
	// 复制库会建库并写入数据，两项权限都必须显式允许。
	if err := ensureConnectionAllowsStructureEdit(config, "connection.backend.action.copy_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	if err := ensureConnectionAllowsDataImport(config, "connection.backend.action.copy_database"); err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	dbType := resolveDDLDBType(config)
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		dbType = "custom"
	}
	if !supportsCopyDatabaseDBType(dbType) {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.database_copy_unsupported", map[string]any{
				"database": sourceDatabase,
				"dbType":   dbType,
			}),
		}
	}

	// 建库与跨库复制都在服务端完成，连接必须落在「无默认库」的服务级上下文，
	// 否则 CREATE DATABASE 之后的跨库语句会被当前库限定。
	runConfig := config
	runConfig.Database = ""
	if strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		runConfig = runConfig.WithRuntimeDatabaseOverride("")
	}
	dbInst, err := a.getDatabase(runConfig)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}

	tables, err := dbInst.GetTables(sourceDatabase)
	if err != nil {
		return connection.QueryResult{
			Success: false,
			Message: a.appText("db.backend.error.database_copy_list_tables_failed", map[string]any{
				"database": sourceDatabase,
				"error":    err.Error(),
			}),
		}
	}

	var targetDatabase string
	for attempt := 0; attempt < maxCopyDatabaseCreateAttempts; attempt++ {
		targetDatabase = buildCopyDatabaseTargetName(sourceDatabase, attempt+1)
		statements, planErr := buildCopyDatabaseStatements(dbType, sourceDatabase, targetDatabase, tables)
		if planErr != nil {
			return connection.QueryResult{Success: false, Message: planErr.Error()}
		}
		auditSQL = strings.Join(statements, ";\n")

		if _, createErr := dbInst.Exec(statements[0]); createErr != nil {
			if isCopyTableAlreadyExistsError(createErr) {
				continue
			}
			return connection.QueryResult{
				Success: false,
				Message: a.appText("db.backend.error.database_copy_create_failed", map[string]any{
					"source": sourceDatabase,
					"target": targetDatabase,
					"error":  createErr.Error(),
				}),
			}
		}

		// 逐表复制；任一张失败就删掉整个新库，避免留下结构不全的副本。
		for _, statement := range statements[1:] {
			if _, copyErr := dbInst.Exec(statement); copyErr != nil {
				dropSQL := buildDropDatabaseSQL(dbType, targetDatabase)
				if _, cleanupErr := dbInst.Exec(dropSQL); cleanupErr != nil {
					logger.Warnf("CopyDatabase 复制失败且清理目标库失败：source=%s target=%s copyErr=%v cleanupErr=%v", sourceDatabase, targetDatabase, copyErr, cleanupErr)
					return connection.QueryResult{
						Success: false,
						Message: a.appText("db.backend.error.database_copy_cleanup_failed", map[string]any{
							"source": sourceDatabase,
							"target": targetDatabase,
							"error":  fmt.Sprintf("%v; %v", copyErr, cleanupErr),
						}),
					}
				}
				return connection.QueryResult{
					Success: false,
					Message: a.appText("db.backend.error.database_copy_failed", map[string]any{
						"source": sourceDatabase,
						"target": targetDatabase,
						"error":  copyErr.Error(),
					}),
				}
			}
		}

		return connection.QueryResult{
			Success: true,
			Message: a.appText("db.backend.message.database_copied", map[string]any{
				"source": sourceDatabase,
				"target": targetDatabase,
				"count":  len(tables),
			}),
			Data: targetDatabase,
		}
	}

	return connection.QueryResult{
		Success: false,
		Message: a.appText("db.backend.error.database_copy_create_failed", map[string]any{
			"source": sourceDatabase,
			"target": targetDatabase,
			"error":  "too many concurrent target-name conflicts",
		}),
	}
}

func supportsCopyDatabaseDBType(dbType string) bool {
	switch dbType {
	case "mysql", "mariadb", "oceanbase":
		return true
	default:
		return false
	}
}

// buildCopyDatabaseTargetName 生成 <source>_copyN，并按方言的标识符长度上限截断。
func buildCopyDatabaseTargetName(sourceName string, suffix int) string {
	suffixText := "_copy" + strconv.Itoa(suffix)
	switch {
	default:
		// MySQL 的库名上限 64 个字符。
		return truncateUTF8Runes(sourceName, 64-len(suffixText)) + suffixText
	}
}

// buildCopyDatabaseStatements 生成「建库 + 每表建表与搬数据」的完整语句序列。
//
// 所有数据搬运都在服务端用 INSERT ... SELECT 完成，不把行读进应用层：整库
// 复制的数据量可能很大，走应用层既慢又容易在中途失败留下半成品。
func buildCopyDatabaseStatements(
	dbType string,
	sourceDatabase string,
	targetDatabase string,
	tables []string,
) ([]string, error) {
	source := quoteCopyIdent(dbType, sourceDatabase)
	target := quoteCopyIdent(dbType, targetDatabase)
	statements := []string{
		fmt.Sprintf("CREATE DATABASE %s", target),
	}
	for _, table := range tables {
		name := strings.TrimSpace(table)
		if name == "" {
			continue
		}
		quoted := quoteCopyIdent(dbType, name)
		statements = append(statements,
			fmt.Sprintf("CREATE TABLE %s.%s LIKE %s.%s", target, quoted, source, quoted),
			fmt.Sprintf("INSERT INTO %s.%s SELECT * FROM %s.%s", target, quoted, source, quoted),
		)
	}
	return statements, nil
}

func buildDropDatabaseSQL(dbType string, database string) string {
	return fmt.Sprintf("DROP DATABASE IF EXISTS %s", quoteCopyIdent(dbType, database))
}

// quoteCopyIdent 用反引号引用标识符；MySQL 系里反引号同时适用于库名与表名。
func quoteCopyIdent(_ string, name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}
