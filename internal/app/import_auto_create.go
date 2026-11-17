package app

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// ImportAutoCreateTable 让导入任务在目标表不存在时先执行建表语句，再走既有导入管线。
// SQL 由前端复用表设计器生成（覆盖全部方言），后端只负责校验、存在性检查与执行；
// 建表发生在回滚快照之后，RollbackImportJob 会把新建表当作新增对象删除。
type ImportAutoCreateTable struct {
	TableName string `json:"tableName,omitempty"`
	SQL       string `json:"sql"`
}

var (
	importCreateTableStatementPattern = regexp.MustCompile(`(?is)^\s*create\s+table\s+`)
	// PG/Oracle 的列注释是独立 COMMENT ON 语句；SQL Server 用 sp_addextendedproperty。
	// 允许这两类紧随 CREATE TABLE 的注释语句，其余语句一律拒绝。
	importAutoCreateCommentPattern = regexp.MustCompile(`(?is)^\s*(?:comment\s+on\s+(?:column|table)\b|exec(?:ute)?\s+sp_addextendedproperty\b)`)
)

func normalizeImportAutoCreateStatements(dbType string, raw string) ([]string, error) {
	statements := splitSQLStatementsForDialect(dbType, raw)
	if len(statements) == 0 {
		return nil, errors.New("import auto create SQL is empty")
	}
	first := strings.TrimSpace(statements[0])
	if !importCreateTableStatementPattern.MatchString(first) {
		return nil, errors.New("import auto create SQL must start with a CREATE TABLE statement")
	}
	normalized := []string{first}
	for _, statement := range statements[1:] {
		trimmed := strings.TrimSpace(statement)
		if trimmed == "" {
			continue
		}
		if !importAutoCreateCommentPattern.MatchString(trimmed) {
			return nil, errors.New("import auto create SQL contains an unsupported follow-up statement")
		}
		normalized = append(normalized, trimmed)
	}
	return normalized, nil
}

// ensureImportAutoCreateTarget 在导入开始前按需建表。调用点位于回滚快照之后，
// 因此失败回滚时新建表会被识别为「任务期间新增对象」并删除。
func (a *App) ensureImportAutoCreateTarget(
	ctx context.Context,
	database db.Database,
	config connection.ConnectionConfig,
	dbName string,
	tableName string,
	options ImportFileOptions,
	allowExisting bool,
) error {
	target := options.AutoCreateTable
	if target == nil {
		return nil
	}
	if config.Protection.RestrictStructureEdit || config.Protection.RestrictScriptExecution {
		return errors.New(a.appText("file.backend.error.import_auto_create_restricted", nil))
	}
	tableName = strings.TrimSpace(tableName)
	if tableName == "" {
		return errors.New(a.appText("file.backend.error.import_target_table_empty", nil))
	}
	dbType := resolveDDLDBType(config)
	statements, err := normalizeImportAutoCreateStatements(dbType, target.SQL)
	if err != nil {
		key := "file.backend.error.import_auto_create_invalid_sql"
		if strings.Contains(err.Error(), "unsupported follow-up") {
			key = "file.backend.error.import_auto_create_unsupported_statement"
		} else if strings.Contains(err.Error(), "CREATE TABLE") {
			key = "file.backend.error.import_auto_create_not_create_table"
		}
		return fmt.Errorf("%s: %v", a.appText(key, nil), err)
	}

	schemaName, lookupTable := normalizeTableExistsLookup(config, dbName, tableName)
	exists, err := lookupExactTableExists(database, schemaName, lookupTable)
	if err != nil {
		return fmt.Errorf("%s: %w", a.appText("file.backend.error.import_auto_create_check_failed", nil), err)
	}
	if exists {
		// 恢复导入时目标表是上一次运行创建的，不能再次建表，也不能按「已存在」拒绝。
		if allowExisting {
			return nil
		}
		return errors.New(a.appText("file.backend.error.import_auto_create_exists", map[string]any{"table": tableName}))
	}
	for _, statement := range statements {
		if _, err := execSQLFileStatement(ctx, database, statement); err != nil {
			return fmt.Errorf("%s: %w", a.appText("file.backend.error.import_auto_create_failed", nil), err)
		}
	}
	return nil
}
