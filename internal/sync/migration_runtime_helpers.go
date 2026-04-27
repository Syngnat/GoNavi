package sync

import (
	"GoNavi-Wails/internal/connection"
	"fmt"
	"strings"
)

func supportsAutoAddColumnsForPair(sourceType string, targetType string) bool {
	source := normalizeMigrationDBType(sourceType)
	target := normalizeMigrationDBType(targetType)
	if isMySQLLikeWritableTargetType(target) {
		return isMySQLCoreType(source)
	}
	if isDirectPGLikeTarget(target) {
		return isDirectPGLikeSource(source) || isMySQLLikeSourceType(source)
	}
	if isPGLikeTarget(target) {
		return isMySQLLikeSourceType(source)
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
		colType, _, _ := mapMySQLColumnToKingbase(sourceCol)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), nil
	case isDirectPGLikeSource(source) && isDirectPGLikeTarget(target):
		def, _ := buildPGLikeToPGLikeColumnDefinition(sourceCol)
		def = stripIdentityAndNotNullForAddColumn(def)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			def,
		), nil
	default:
		return "", fmt.Errorf("当前不支持 source=%s target=%s 的自动补字段", sourceType, targetType)
	}
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
