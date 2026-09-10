package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// Oracle 系目标（dameng/oracle/iris）的自动建表规划。达梦 8 兼容 Oracle 语法，
// 标识符双引号、自增用 IDENTITY、无 jsonb/bytea（JSON→CLOB，二进制→BLOB）。
// varchar 长度超过 Oracle 上限 4000 时降级为 CLOB。

const oracleLikeVarcharMaxLength = 4000

func isOracleLikeTargetType(dbType string) bool {
	switch normalizeMigrationDBType(dbType) {
	case "oracle", "dameng", "iris":
		return true
	default:
		return false
	}
}

// buildColumnCommentStatements 生成建表后的列注释语句与告警。
//
// 列注释在各目标方言的表达能力不同：Oracle/达梦 支持 COMMENT ON COLUMN，
// 语句可以照建（放 postSQL，建表后执行）；SQL Server 只能用扩展属性
// sp_addextendedproperty、SQLite 完全没有注释语法，这两者以及其余方言生成
// 告警而不是静默丢弃。单引号按 SQL 标准转成两个，注释含单引号时生成非法
// DDL 会连累索引等后续 postSQL 一起中断。
func buildColumnCommentStatements(targetType, targetQueryTable string, sourceCols []connection.ColumnDefinition) ([]string, []string) {
	postSQL := make([]string, 0)
	warnings := make([]string, 0)
	target := normalizeMigrationDBType(targetType)
	if target == "oracle" || target == "dameng" {
		for _, col := range sourceCols {
			comment := strings.TrimSpace(col.Comment)
			if comment == "" {
				continue
			}
			postSQL = append(postSQL, fmt.Sprintf("COMMENT ON COLUMN %s.%s IS '%s'",
				quoteQualifiedIdentByType(targetType, targetQueryTable),
				quoteIdentByType(targetType, col.Name),
				strings.ReplaceAll(comment, "'", "''")))
		}
		return postSQL, warnings
	}
	for _, col := range sourceCols {
		if strings.TrimSpace(col.Comment) == "" {
			continue
		}
		warnings = append(warnings, fmt.Sprintf("字段 %s 的注释未迁移：目标 %s 不支持内联列注释，请按需手工补充",
			col.Name, strings.TrimSpace(targetType)))
	}
	return postSQL, warnings
}

// buildLegacyAutoCreateTablePlan 按 legacy 路径的目标方言分派建表计划。
// 专用 planner（MySQL 系/PG 系/ClickHouse/Mongo）不经过这里。
func buildLegacyAutoCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	sourceType := resolveMigrationDBType(config.SourceConfig)
	switch {
	case sourceType == "mysql" && isOracleLikeTargetType(targetType):
		return buildMySQLToOracleLikeCreateTablePlan(targetType, config, targetQueryTable, sourceCols, sourceDB, sourceSchema, sourceTable)
	case sourceType == "mysql" && normalizeMigrationDBType(targetType) == "sqlserver":
		return buildMySQLToSQLServerCreateTablePlan(targetType, config, targetQueryTable, sourceCols, sourceDB, sourceSchema, sourceTable)
	case sourceType == "mysql" && normalizeMigrationDBType(targetType) == "sqlite":
		return buildMySQLToSQLiteCreateTablePlan(targetType, config, targetQueryTable, sourceCols, sourceDB, sourceSchema, sourceTable)
	case supportsCrossDialectAutoCreate(sourceType, targetType):
		return buildCrossDialectAutoCreatePlan(sourceType, targetType, config, targetQueryTable, sourceCols, sourceDB, sourceSchema, sourceTable)
	default:
		return "", nil, nil, nil, nil, 0, 0, fmt.Errorf("当前不支持 source=%s target=%s 的 legacy 自动建表", sourceType, targetType)
	}
}

func buildMySQLToOracleLikeCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)
	// 建表用的最终列类型，供索引计划判断该列在目标方言能否建索引。
	finalColumnTypes := make(map[string]string, len(sourceCols))

	for _, col := range sourceCols {
		// MySQL 源专用路径不经过通用归一层，键列的 LOB 安全必须在此单独收口，
		// 否则 text 主键会生成 CLOB + PRIMARY KEY 而建表失败。
		col, keyWarnings := applyKeyColumnTypeSafety(targetType, col)
		warnings = append(warnings, keyWarnings...)
		def, colWarnings := buildMySQLToOracleLikeColumnDefinition(targetType, col)
		warnings = append(warnings, colWarnings...)
		// 键按小写归一：查找侧同样小写，否则 Oracle 系的全大写列名会全部查不到，
		// 防护静默失效。值必须是目标侧已生成的定义文本，中间类型（如 json）
		// 判不出目标的 CLOB。
		finalColumnTypes[strings.ToLower(strings.TrimSpace(col.Name))] = def
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		if col.Key == "PRI" || col.Key == "PK" {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))

	commentSQL, commentWarnings := buildColumnCommentStatements(targetType, targetQueryTable, sourceCols)
	warnings = append(warnings, commentWarnings...)
	if !config.CreateIndexes {
		return createSQL, commentSQL, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, commentSQL, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan(targetType, targetQueryTable,
		stripPrimaryKeyImplicitIndexes(indexes, sourceCols), finalColumnTypes)
	return createSQL, append(commentSQL, postSQL...), dedupeStrings(warnings), dedupeStrings(unsupported), unmigrated, created, skipped, nil
}

func buildMySQLToOracleLikeColumnDefinition(targetType string, col connection.ColumnDefinition) (string, []string) {
	targetTypeText, useIdentity, warnings := mapMySQLColumnToOracleLike(targetType, col)
	parts := []string{targetTypeText}
	if useIdentity {
		parts = append(parts, oracleLikeIdentityClause(targetType))
	}
	if !useIdentity {
		if defaultSQL, ok, warningText := mapMySQLDefaultToOracleLike(col, targetTypeText); warningText != "" {
			warnings = append(warnings, warningText)
		} else if ok {
			parts = append(parts, "DEFAULT "+defaultSQL)
		}
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

// oracleLikeIdentityClause generates the target-native identity clause.
//
// Oracle 12c+ requires GENERATED BY DEFAULT AS IDENTITY. Dameng native mode
// rejects GENERATED (Error -2007 at the keyword) and requires IDENTITY(seed,
// increment). IRIS never reaches here because its auto-increment handling is
// disabled in mapMySQLColumnToOracleLike.
func oracleLikeIdentityClause(targetType string) string {
	if normalizeMigrationDBType(targetType) == "dameng" {
		return "IDENTITY(1,1)"
	}
	return "GENERATED BY DEFAULT AS IDENTITY"
}

func mapMySQLColumnToOracleLike(targetType string, col connection.ColumnDefinition) (string, bool, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "CLOB", false, []string{fmt.Sprintf("字段 %s 类型为空，已降级为 CLOB", col.Name)}
	}
	unsigned := strings.Contains(raw, "unsigned")
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")
	if normalizeMigrationDBType(targetType) == "dameng" && isAutoIncrement {
		// 达梦仅允许 SMALLINT、INTEGER、BIGINT 定义 IDENTITY。Oracle 可对
		// NUMBER 使用 GENERATED AS IDENTITY，但不能把这条规则照搬给达梦，
		// 否则会在 CREATE TABLE 报 -2713（非法 IDENTITY 列类型）。
		switch {
		case strings.HasPrefix(clean, "tinyint"):
			return "SMALLINT", true, warnings
		case strings.HasPrefix(clean, "smallint"):
			if unsigned {
				return "INTEGER", true, warnings
			}
			return "SMALLINT", true, warnings
		case strings.HasPrefix(clean, "mediumint"), strings.HasPrefix(clean, "int"), strings.HasPrefix(clean, "integer"):
			if unsigned {
				// INT UNSIGNED 的上界超过 INTEGER，提升为 BIGINT 后仍可保留自增。
				return "BIGINT", true, warnings
			}
			return "INTEGER", true, warnings
		case strings.HasPrefix(clean, "bigint"):
			if unsigned {
				warnings = append(warnings, fmt.Sprintf(
					"字段 %s 为 bigint unsigned 自增列；达梦 IDENTITY 仅支持有符号整数，已保留为 NUMBER(20) 并不迁移自增语义",
					col.Name))
				return "NUMBER(20)", false, warnings
			}
			return "BIGINT", true, warnings
		}
	}

	// IRIS 不支持 IDENTITY 子句（见 buildMySQLToOracleLikeColumnDefinition），
	// 这里把自增收敛为告警，避免静默丢语义。
	if isAutoIncrement && normalizeMigrationDBType(targetType) == "iris" {
		warnings = append(warnings, fmt.Sprintf(
			"字段 %s 为自增列；IRIS 不支持 IDENTITY，已建为普通数字列以保证数据导入",
			col.Name))
		isAutoIncrement = false
	}

	switch {
	case strings.HasPrefix(clean, "tinyint(1)") && !unsigned && !isAutoIncrement:
		return "NUMBER(1)", false, warnings
	case strings.HasPrefix(clean, "tinyint"), strings.HasPrefix(clean, "smallint"):
		return "NUMBER(5)", isAutoIncrement, warnings
	case strings.HasPrefix(clean, "mediumint"), strings.HasPrefix(clean, "int"), strings.HasPrefix(clean, "integer"):
		return "NUMBER(10)", isAutoIncrement, warnings
	case strings.HasPrefix(clean, "bigint"):
		if unsigned {
			return "NUMBER(20)", isAutoIncrement, warnings
		}
		return "NUMBER(19)", isAutoIncrement, warnings
	case strings.HasPrefix(clean, "decimal"), strings.HasPrefix(clean, "numeric"):
		return clampOracleLikeDecimalPrecision(replaceTypeBase(clean, []string{"decimal", "numeric"}, "NUMBER"), col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "float"):
		return "BINARY_FLOAT", false, warnings
	case strings.HasPrefix(clean, "double"):
		return "BINARY_DOUBLE", false, warnings
	case strings.HasPrefix(clean, "bit(1)"), strings.HasPrefix(clean, "bool"), strings.HasPrefix(clean, "boolean"):
		return "NUMBER(1)", false, warnings
	case strings.HasPrefix(clean, "bit("):
		return "NUMBER(10)", false, warnings
	case strings.HasPrefix(clean, "char("), strings.HasPrefix(clean, "varchar("):
		return enforceOracleLikeVarcharLength(clean, col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "tinytext"), strings.HasPrefix(clean, "text"), strings.HasPrefix(clean, "mediumtext"), strings.HasPrefix(clean, "longtext"), strings.HasPrefix(clean, "json"):
		return "CLOB", false, warnings
	case strings.HasPrefix(clean, "datetime"), strings.HasPrefix(clean, "timestamp"):
		// MySQL datetime 的时分秒必须完整保留，统一落 TIMESTAMP：既覆盖全部
		// 时分秒，还留有小数秒容量。必须放在 "date"/"time" 之前：datetime
		// 同时以二者为前缀。
		return "TIMESTAMP", false, warnings
	case strings.HasPrefix(clean, "date"):
		return "DATE", false, warnings
	case strings.HasPrefix(clean, "time"):
		return "TIMESTAMP", false, warnings
	case strings.HasPrefix(clean, "year"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 year 已映射为 NUMBER(4)", col.Name))
		return "NUMBER(4)", false, warnings
	// 前缀用裸类型名而非带括号形式：无长度的 binary/varbinary（非法 MySQL
	// 写法但元数据里偶有出现）也会命中，经 oracleLikeBoundedBinaryType 的
	// 无长度分支落成 BLOB。落到 default 会变成 CLOB，二进制字节被按字符集
	// 重新解释而静默损坏。
	case strings.HasPrefix(clean, "binary"), strings.HasPrefix(clean, "varbinary"):
		// 必须放在裸 blob 分支之前：binary(16) 同时以 "binary" 为前缀。
		// 定长/短变长二进制落成 BLOB 有两重问题：16 字节的 UUID 主键会变成不可
		// 索引的大对象导致建表失败，即便是普通列也白付一份 LOB 存储开销。
		return oracleLikeBoundedBinaryType(targetType, clean, col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "tinyblob"), strings.HasPrefix(clean, "blob"), strings.HasPrefix(clean, "mediumblob"), strings.HasPrefix(clean, "longblob"):
		return "BLOB", false, warnings
	case strings.HasPrefix(clean, "enum"), strings.HasPrefix(clean, "set"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 VARCHAR(255)", col.Name, col.Type))
		return "VARCHAR(255)", false, warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 CLOB", col.Name, col.Type))
		return "CLOB", false, warnings
	}
}

// enforceOracleLikeVarcharLength 超过 Oracle varchar 上限时降级 CLOB，避免建表语法错误。
func enforceOracleLikeVarcharLength(cleanType string, colName string, warnings *[]string) string {
	length, ok := parseTypeLength(cleanType)
	if ok && length > oracleLikeVarcharMaxLength {
		*warnings = append(*warnings, fmt.Sprintf("字段 %s 类型 %s 超过 Oracle 系 varchar 上限 %d，已降级为 CLOB", colName, cleanType, oracleLikeVarcharMaxLength))
		return "CLOB"
	}
	return strings.ToUpper(cleanType)
}

// oracleLikeRawMaxLength 是 Oracle RAW 的字节上限，超出只能用 BLOB。
// 取 2000 是 Oracle 的保守值：达梦的 RAW 上限更大，统一按小的来保证两边都建得出。
const oracleLikeRawMaxLength = 2000

// oracleLikeBoundedBinaryType 把有界二进制类型映射为可索引的目标类型。
//
// Oracle / 达梦 用 RAW(n)，IRIS 不支持 RAW 改用 VARBINARY(n)。超过 RAW 上限时
// 只剩 BLOB 一条路，此时若该列参与主键/索引，applyKeyColumnTypeSafety 会再拦一道。
func oracleLikeBoundedBinaryType(targetType string, cleanType string, colName string, warnings *[]string) string {
	length, ok := parseTypeLength(cleanType)
	if !ok {
		return "BLOB"
	}
	if length > oracleLikeRawMaxLength {
		*warnings = append(*warnings, fmt.Sprintf("字段 %s 类型 %s 超过 Oracle 系 RAW 上限 %d，已降级为 BLOB", colName, cleanType, oracleLikeRawMaxLength))
		return "BLOB"
	}
	if normalizeMigrationDBType(targetType) == "iris" {
		return fmt.Sprintf("VARBINARY(%d)", length)
	}
	return fmt.Sprintf("RAW(%d)", length)
}

// oracleLikeDecimalMaxPrecision 是 Oracle 系 NUMBER 的精度上限。MySQL
// DECIMAL(65,30) 合法，直接落 NUMBER(65,30) 建表必失败。
const oracleLikeDecimalMaxPrecision = 38

// clampOracleLikeDecimalPrecision 把超过上限的精度钳到 38 并告警，
// 精度合法时保持原样。
func clampOracleLikeDecimalPrecision(numberType string, colName string, warnings *[]string) string {
	precision, ok := parseTypeLength(numberType)
	if !ok || precision <= oracleLikeDecimalMaxPrecision {
		return numberType
	}
	clamped := fmt.Sprintf("NUMBER(%d,%d)", oracleLikeDecimalMaxPrecision, oracleLikeDecimalScale(numberType))
	*warnings = append(*warnings, fmt.Sprintf("字段 %s 精度 %d 超过 Oracle 系 NUMBER 上限 %d，已钳制为 %s", colName, precision, oracleLikeDecimalMaxPrecision, clamped))
	return clamped
}

func oracleLikeDecimalScale(numberType string) int {
	open := strings.Index(numberType, "(")
	if open < 0 {
		return 0
	}
	rest := numberType[open+1:]
	comma := strings.Index(rest, ",")
	if comma < 0 {
		return 0
	}
	rest = rest[comma+1:]
	end := strings.Index(rest, ")")
	if end >= 0 {
		rest = rest[:end]
	}
	var scale int
	if _, err := fmt.Sscanf(strings.TrimSpace(rest), "%d", &scale); err != nil {
		return 0
	}
	if scale > oracleLikeDecimalMaxPrecision {
		return oracleLikeDecimalMaxPrecision
	}
	return scale
}

func parseTypeLength(raw string) (int, bool) {
	open := strings.Index(raw, "(")
	if open < 0 {
		return 0, false
	}
	rest := raw[open+1:]
	comma := strings.IndexAny(rest, ",)")
	if comma > 0 {
		rest = rest[:comma]
	}
	var length int
	if _, err := fmt.Sscanf(strings.TrimSpace(rest), "%d", &length); err != nil {
		return 0, false
	}
	return length, true
}

func mapMySQLDefaultToOracleLike(col connection.ColumnDefinition, targetType string) (string, bool, string) {
	if col.Default == nil {
		return "", false, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" {
		return "", false, ""
	}
	lower := strings.ToLower(raw)
	if lower == "null" {
		return "", false, ""
	}
	if strings.HasPrefix(lower, "current_timestamp") {
		return "CURRENT_TIMESTAMP", true, ""
	}
	// Oracle 系 DATE/TIMESTAMP 默认值：不加分支会因目标类型非字符串而被丢弃。
	if strings.HasPrefix(lower, "current_date") {
		return "CURRENT_DATE", true, ""
	}
	if strings.HasPrefix(lower, "current_time") {
		// Oracle 系无 TIME 类型，CURRENT_TIME 借 SYSTIMESTAMP 保留时刻语义。
		return "SYSTIMESTAMP", true, ""
	}
	if strings.HasPrefix(targetType, "NUMBER") {
		switch lower {
		case "1", "true":
			return "1", true, ""
		case "0", "false":
			return "0", true, ""
		}
	}
	if numericPattern.MatchString(raw) && !strings.ContainsAny(raw, "()") {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.HasPrefix(lower, "current_timestamp") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	if isStringLikeTargetType(targetType) {
		return "'" + strings.ReplaceAll(raw, "'", "''") + "'", true, ""
	}
	return "", false, fmt.Sprintf("字段 %s 的默认值 %s 当前未自动迁移", col.Name, raw)
}
