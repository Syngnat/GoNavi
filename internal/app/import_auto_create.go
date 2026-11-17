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
	// PG/Oracle 的列注释是独立 COMMENT ON 语句；SQL Server 由表设计器生成
	// IF EXISTS (...) BEGIN EXEC sp_updateextendedproperty ... END ELSE BEGIN
	// EXEC sp_addextendedproperty ... END 的幂等写法（见 buildSqlServerColumnCommentSql）。
	// 只允许这些紧随 CREATE TABLE 的注释语句，其余语句一律拒绝。
	importAutoCreateCommentPattern = regexp.MustCompile(`(?is)^\s*(?:comment\s+on\s+(?:column|table)\b|exec(?:ute)?\s+sp_addextendedproperty\b|if\s+(?:not\s+)?exists\b[\s\S]*\bsp_(?:add|update)extendedproperty\b)`)
	// CREATE TABLE 的目标名：表设计器生成的标识符最多包含引号/反引号/方括号与点。
	importCreateTableTargetPattern = regexp.MustCompile(`(?is)^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([^(]+?)\s*(?:\(|$)`)
	// 仅拦截标准 CTAS 形态（表名后直接 AS SELECT/WITH）；列定义里的注释字符串不受影响。
	importCreateTableAsQueryPattern = regexp.MustCompile(`(?is)^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?[^\s(]+\s+as\s+(?:select|with)\b`)
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

func normalizeImportCreateTableIdentifier(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.NewReplacer("`", "", "\"", "", "[", "", "]", "").Replace(value)
	return strings.ToLower(value)
}

func validateImportAutoCreateTarget(tableName string, statement string) (string, error) {
	if importCreateTableAsQueryPattern.MatchString(statement) {
		return "", errors.New("import auto create SQL must not use CREATE TABLE ... AS SELECT")
	}
	match := importCreateTableTargetPattern.FindStringSubmatch(statement)
	if len(match) < 2 {
		return "", errors.New("import auto create SQL is missing a CREATE TABLE target")
	}
	actual := normalizeImportCreateTableIdentifier(match[1])
	expected := normalizeImportCreateTableIdentifier(tableName)
	if actual == "" || expected == "" || actual != expected {
		return match[1], fmt.Errorf("import auto create target %q does not match %q", match[1], tableName)
	}
	return match[1], nil
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
	if declared := strings.TrimSpace(target.TableName); declared != "" && normalizeImportCreateTableIdentifier(declared) != normalizeImportCreateTableIdentifier(tableName) {
		return errors.New(a.appText("file.backend.error.import_auto_create_target_mismatch", map[string]any{
			"expected": tableName,
			"actual":   declared,
		}))
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
	actualTarget, err := validateImportAutoCreateTarget(tableName, statements[0])
	if err != nil {
		key := "file.backend.error.import_auto_create_target_mismatch"
		if strings.Contains(err.Error(), "AS SELECT") {
			key = "file.backend.error.import_auto_create_as_select"
		}
		return errors.New(a.appText(key, map[string]any{"expected": tableName, "actual": actualTarget}))
	}
	for _, statement := range statements {
		if _, err := execSQLFileStatement(ctx, database, statement); err != nil {
			return fmt.Errorf("%s: %w", a.appText("file.backend.error.import_auto_create_failed", nil), err)
		}
	}
	return nil
}
