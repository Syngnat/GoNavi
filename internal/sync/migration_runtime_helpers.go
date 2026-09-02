package sync

import (
	"GoNavi-Wails/internal/connection"
	"fmt"
	"strings"
)

func syncContentAllowsSchemaChanges(content string) bool {
	switch strings.ToLower(strings.TrimSpace(content)) {
	case "schema", "both":
		return true
	default:
		return false
	}
}

func supportsAutoAddColumnsForPair(sourceType string, targetType string) bool {
	source := normalizeMigrationDBType(sourceType)
	target := normalizeMigrationDBType(targetType)
	if isMySQLLikeWritableTargetType(target) {
		return isMySQLCoreType(source)
	}
	if isPGLikeSameFamilyDDLType(source) && isPGLikeSameFamilyDDLType(target) {
		return true
	}
	if isPGLikeTarget(target) {
		return isMySQLLikeSourceType(source)
	}
	if source == "clickhouse" && target == "clickhouse" {
		return true
	}
	return false
}

func buildAddColumnSQLForPair(sourceType string, targetType string, targetQueryTable string, sourceCol connection.ColumnDefinition) (string, error) {
	source := normalizeMigrationDBType(sourceType)
	target := normalizeMigrationDBType(targetType)
	switch {
	case isMySQLCoreType(source) && isMySQLLikeWritableTargetType(target):
		colType := sanitizeMySQLColumnType(sourceCol.Type)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", sourceCol.Name),
			colType,
		), nil
	case isMySQLLikeSourceType(source) && isPGLikeTarget(target):
		colType, _, warnings := mapMySQLColumnToKingbase(sourceCol)
		if len(warnings) > 0 && strings.Contains(strings.Join(warnings, " "), "identity") {
			// 对已有目标表补字段时保守处理，不补建自增语义。
		}
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), nil
	case isPGLikeSameFamilyDDLType(source) && isPGLikeSameFamilyDDLType(target):
		colType := sanitizePGLikeColumnType(sourceCol.Type)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), nil
	case source == "clickhouse" && target == "clickhouse":
		colType := sanitizeClickHouseColumnType(sourceCol.Type)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), nil
	default:
		return "", fmt.Errorf("当前不支持 source=%s target=%s 的自动补字段", sourceType, targetType)
	}
}

// relaxedNotNullAddColumnWarning explains why ADD COLUMN deliberately uses
// NULL even when the source field is NOT NULL: existing target rows have no
// value for the new field, so adding the constraint directly would fail.
func relaxedNotNullAddColumnWarning(sourceCol connection.ColumnDefinition) string {
	if normalizeColumnNullable(sourceCol.Nullable) != "NO" {
		return ""
	}
	return fmt.Sprintf("字段 %s 在已有目标表中新增时已按 NULL 创建，未保留源端 NOT NULL 约束；请补齐历史数据后按需手工收紧约束", sourceCol.Name)
}

func executeSQLStatements(execFn func(string) (int64, error), statements []string) error {
	for _, stmt := range statements {
		trimmed := strings.TrimSpace(stmt)
		if trimmed == "" {
			continue
		}
		if _, err := execFn(trimmed); err != nil {
			return err
		}
	}
	return nil
}
