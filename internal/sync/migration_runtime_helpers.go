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
		if isMySQLCoreType(source) {
			return true
		}
		// legacy 互转层：非 MySQL 系源经中间表示落到 MySQL 系目标。
		return isCrossDialectAutoCreateSourceType(source) && supportsAutoCreateMigration(source, target)
	}
	if isPGLikeSameFamilyDDLType(source) && isPGLikeSameFamilyDDLType(target) {
		return true
	}
	if isPGLikeTarget(target) {
		if isMySQLLikeSourceType(source) {
			return true
		}
		return isCrossDialectAutoCreateSourceType(source) && supportsAutoCreateMigration(source, target)
	}
	if source == "clickhouse" && target == "clickhouse" {
		return true
	}
	// 与 supportsAutoCreateMigration 的 legacy 建表目标保持一致：
	// 能按方言生成 CREATE TABLE 的目标，同样能生成 ADD COLUMN。
	return isCrossDialectAutoCreateSourceType(source) && supportsAutoCreateMigration(source, target)
}

// hasNativeAddColumnPath reports whether buildAddColumnSQLForPair has a branch
// that consumes the source dialect's own type text. Those branches must not see
// a MySQL-normalized column, and every other supported pair must.
func hasNativeAddColumnPath(source, target string) bool {
	if isMySQLLikeSourceType(source) {
		return true
	}
	if isPGLikeSameFamilyDDLType(source) && isPGLikeSameFamilyDDLType(target) {
		return true
	}
	return source == "clickhouse" && target == "clickhouse"
}

func buildAddColumnSQLForPair(sourceType string, targetType string, targetQueryTable string, sourceCol connection.ColumnDefinition) (string, []string, error) {
	source := normalizeMigrationDBType(sourceType)
	target := normalizeMigrationDBType(targetType)
	// 原生路径直接用源方言类型；其余组合先把列归一为 MySQL 中间表示，并把
	// 分派用的 source 一起改成 mysql，否则 oracle->dameng 会落到 default 报错，
	// postgres->kingbase 会把归一后的 tinyint(1) 直接用于 PG 类 DDL。
	// 归一与目标映射产生的告警必须回传：类型降级、精度假设、自增语义丢弃
	// 都是调用方要展示的取舍，静默发生会让补列结果无从排查。
	var warnings []string
	if !hasNativeAddColumnPath(source, target) && supportsAutoAddColumnsForPair(sourceType, targetType) {
		sourceCol, warnings = buildCrossDialectIntermediateColumn(source, targetType, sourceCol)
		source = "mysql"
	}
	// 所有目标分支的 ADD COLUMN 都不携带自增子句（要么各方言语法不允许，
	// 要么需要键约束前置），自增语义统一在此丢弃并告警，避免逐分支判定遗漏。
	// 判定放在归一之后：归一层可能因类型降级剥掉自增标记，剥掉后不应告警。
	if strings.Contains(strings.ToLower(strings.TrimSpace(sourceCol.Extra)), "auto_increment") {
		warnings = append(warnings, fmt.Sprintf("字段 %s 为自增列，补齐到已有目标表时不会自动补建自增（identity/sequence/AUTO_INCREMENT），新列需手工提供取值", sourceCol.Name))
	}
	switch {
	case isMySQLCoreType(source) && isMySQLLikeWritableTargetType(target):
		colType := sanitizeMySQLColumnType(sourceCol.Type)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType("mysql", targetQueryTable),
			quoteIdentByType("mysql", sourceCol.Name),
			colType,
		), warnings, nil
	case isMySQLLikeSourceType(source) && isPGLikeTarget(target):
		colType, _, mapWarnings := mapMySQLColumnToKingbase(sourceCol)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), dedupeStrings(append(warnings, mapWarnings...)), nil
	case isMySQLLikeSourceType(source) && isOracleLikeTargetType(target):
		// Oracle 系 ADD 语法无 COLUMN 关键字；补列保守不带 NOT NULL/默认值。
		colType, _, mapWarnings := mapMySQLColumnToOracleLike(target, sourceCol)
		return fmt.Sprintf("ALTER TABLE %s ADD %s %s",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), dedupeStrings(append(warnings, mapWarnings...)), nil
	case isMySQLLikeSourceType(source) && target == "sqlserver":
		colType, _, mapWarnings := mapMySQLColumnToSQLServer(sourceCol)
		return fmt.Sprintf("ALTER TABLE %s ADD %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), dedupeStrings(append(warnings, mapWarnings...)), nil
	case isMySQLLikeSourceType(source) && target == "sqlite":
		colType, _, mapWarnings := mapMySQLColumnToSQLite(sourceCol)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), dedupeStrings(append(warnings, mapWarnings...)), nil
	case isPGLikeSameFamilyDDLType(source) && isPGLikeSameFamilyDDLType(target):
		colType := sanitizePGLikeColumnType(sourceCol.Type)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s NULL",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), warnings, nil
	case source == "clickhouse" && target == "clickhouse":
		colType := sanitizeClickHouseColumnType(sourceCol.Type)
		return fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteQualifiedIdentByType(target, targetQueryTable),
			quoteIdentByType(target, sourceCol.Name),
			colType,
		), warnings, nil
	default:
		return "", nil, fmt.Errorf("当前不支持 source=%s target=%s 的自动补字段", sourceType, targetType)
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
