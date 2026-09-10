package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// SQL Server 与 SQLite 目标的 MySQL 类型映射与建表规划。

func buildMySQLToSQLServerCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)

	// 建表用的最终列类型，供索引计划判断该列在目标方言能否建索引。
	finalColumnTypes := make(map[string]string, len(sourceCols))

	for _, col := range sourceCols {
		// 同 Oracle 系专用路径：键列的 LOB 安全必须在此收口，
		// SQL Server 拒绝 NVARCHAR(MAX) / VARBINARY(MAX) 进主键或索引。
		col, keyWarnings := applyKeyColumnTypeSafety(targetType, col)
		warnings = append(warnings, keyWarnings...)
		def, colWarnings := buildMySQLToSQLServerColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		// 键小写归一 + 值取目标侧定义文本，理由同 Oracle 系路径。
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

	// SQL Server/SQLite 无内联列注释，有注释时告警而不是静默丢弃。
	_, commentWarnings := buildColumnCommentStatements(targetType, targetQueryTable, sourceCols)
	warnings = append(warnings, commentWarnings...)

	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan(targetType, targetQueryTable,
		stripPrimaryKeyImplicitIndexes(indexes, sourceCols), finalColumnTypes)
	return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), unmigrated, created, skipped, nil
}

func buildMySQLToSQLServerColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	// mapMySQLColumnToSQLServer 恒不返回 identity（SQL Server 的 IDENTITY 列
	// 拒绝显式插入，见其注释），这里没有 identity 分支。
	targetType, _, warnings := mapMySQLColumnToSQLServer(col)
	parts := []string{targetType}
	if defaultSQL, ok, warningText := mapMySQLDefaultToSQLServer(col, targetType); warningText != "" {
		warnings = append(warnings, warningText)
	} else if ok {
		parts = append(parts, "DEFAULT "+defaultSQL)
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapMySQLColumnToSQLServer(col connection.ColumnDefinition) (string, bool, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "NVARCHAR(MAX)", false, []string{fmt.Sprintf("字段 %s 类型为空，已降级为 NVARCHAR(MAX)", col.Name)}
	}
	unsigned := strings.Contains(raw, "unsigned")
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")

	// SQL Server 的 IDENTITY 列拒绝显式插入（需 SET IDENTITY_INSERT ON，且
	// 同一连接一次只允许一张表打开，同步引擎按批写入无法可靠包裹该开关）。
	// 自动建表若生成 IDENTITY，导入源端显式主键值时整批失败。数据完整性
	// 优先：建为普通数字列并告警，需要自增时建表后手工调整。
	if isAutoIncrement {
		warnings = append(warnings, fmt.Sprintf(
			"字段 %s 为自增列；SQL Server 的 IDENTITY 列不允许显式插入，已建为普通数字列以保证数据导入，如需自增请建表后手工调整",
			col.Name))
	}

	switch {
	case strings.HasPrefix(clean, "tinyint(1)") && !unsigned && !isAutoIncrement:
		return "BIT", false, warnings
	case strings.HasPrefix(clean, "tinyint"):
		// 自增的 tinyint(1) 不落 BIT：BIT 无法承载自增语义的整数族，SMALLINT 可以。
		return "SMALLINT", false, warnings
	case strings.HasPrefix(clean, "smallint"):
		return "INT", false, warnings
	case strings.HasPrefix(clean, "mediumint"), strings.HasPrefix(clean, "int"), strings.HasPrefix(clean, "integer"):
		if unsigned {
			return "BIGINT", false, warnings
		}
		return "INT", false, warnings
	case strings.HasPrefix(clean, "bigint"):
		if unsigned {
			return "DECIMAL(20,0)", false, warnings
		}
		return "BIGINT", false, warnings
	case strings.HasPrefix(clean, "decimal"), strings.HasPrefix(clean, "numeric"):
		// SQL Server DECIMAL 精度上限同为 38，超限直接建表失败。
		return clampSQLServerDecimalPrecision(replaceTypeBase(clean, []string{"decimal", "numeric"}, "DECIMAL"), col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "float"):
		return "REAL", false, warnings
	case strings.HasPrefix(clean, "double"):
		return "FLOAT", false, warnings
	case strings.HasPrefix(clean, "bit("), strings.HasPrefix(clean, "bool"), strings.HasPrefix(clean, "boolean"):
		return "BIT", false, warnings
	case strings.HasPrefix(clean, "char("):
		return enforceSQLServerStringLength(clean, col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "varchar("):
		return enforceSQLServerStringLength(clean, col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "tinytext"), strings.HasPrefix(clean, "text"), strings.HasPrefix(clean, "mediumtext"), strings.HasPrefix(clean, "longtext"), strings.HasPrefix(clean, "json"):
		return "NVARCHAR(MAX)", false, warnings
	case strings.HasPrefix(clean, "datetime"), strings.HasPrefix(clean, "timestamp"):
		// 必须放在 "date"/"time" 之前：datetime 同时以二者为前缀。
		return "DATETIME2", false, warnings
	case strings.HasPrefix(clean, "date"):
		return "DATE", false, warnings
	case strings.HasPrefix(clean, "time"):
		return "TIME", false, warnings
	case strings.HasPrefix(clean, "year"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 year 已映射为 SMALLINT", col.Name))
		return "SMALLINT", false, warnings
	case strings.HasPrefix(clean, "binary("), strings.HasPrefix(clean, "varbinary("):
		// 必须放在裸 binary/blob 分支之前：binary(16) 同时以 "binary" 为前缀。
		// 有界二进制在 SQL Server 有原生等价类型且可索引，落成 VARBINARY(MAX)
		// 会让 BINARY(16) 这类 UUID/哈希主键在建表阶段被拒。
		return sqlServerBoundedBinaryType(clean, col.Name, &warnings), false, warnings
	case strings.HasPrefix(clean, "tinyblob"), strings.HasPrefix(clean, "blob"), strings.HasPrefix(clean, "mediumblob"), strings.HasPrefix(clean, "longblob"), strings.HasPrefix(clean, "binary"), strings.HasPrefix(clean, "varbinary"):
		return "VARBINARY(MAX)", false, warnings
	case strings.HasPrefix(clean, "enum"), strings.HasPrefix(clean, "set"):
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 已降级为 NVARCHAR(255)", col.Name, col.Type))
		return "NVARCHAR(255)", false, warnings
	default:
		warnings = append(warnings, fmt.Sprintf("字段 %s 类型 %s 暂无专门映射，已降级为 NVARCHAR(MAX)", col.Name, col.Type))
		return "NVARCHAR(MAX)", false, warnings
	}
}

// enforceSQLServerStringLength 源 varchar 超过 4000 字节上限时降级为 NVARCHAR(MAX)。
func enforceSQLServerStringLength(cleanType string, colName string, warnings *[]string) string {
	length, ok := parseTypeLength(cleanType)
	if ok && length > 4000 {
		*warnings = append(*warnings, fmt.Sprintf("字段 %s 类型 %s 超过 SQL Server 长度上限 4000，已降级为 NVARCHAR(MAX)", colName, cleanType))
		return "NVARCHAR(MAX)"
	}
	return strings.ToUpper(strings.Replace(cleanType, "char", "CHAR", 1))
}

// sqlServerBinaryMaxLength 是 SQL Server BINARY/VARBINARY 的字节上限，
// 超出必须用 VARBINARY(MAX)。
const sqlServerBinaryMaxLength = 8000

// sqlServerBoundedBinaryType 把有界二进制类型映射为同名的 SQL Server 类型。
// BINARY(n)/VARBINARY(n) 在上限内与 MySQL 语义一致且可索引；超限只剩
// VARBINARY(MAX)，此时若该列参与主键/索引由 applyKeyColumnTypeSafety 再拦一道。
func sqlServerBoundedBinaryType(cleanType string, colName string, warnings *[]string) string {
	length, ok := parseTypeLength(cleanType)
	if !ok {
		return "VARBINARY(MAX)"
	}
	if length > sqlServerBinaryMaxLength {
		*warnings = append(*warnings, fmt.Sprintf("字段 %s 类型 %s 超过 SQL Server 二进制上限 %d，已降级为 VARBINARY(MAX)", colName, cleanType, sqlServerBinaryMaxLength))
		return "VARBINARY(MAX)"
	}
	if strings.HasPrefix(cleanType, "varbinary") {
		return fmt.Sprintf("VARBINARY(%d)", length)
	}
	return fmt.Sprintf("BINARY(%d)", length)
}

func mapMySQLDefaultToSQLServer(col connection.ColumnDefinition, targetType string) (string, bool, string) {
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
	// SQL Server 没有实现 ANSI 的 CURRENT_DATE / CURRENT_TIME，直接下发会建表失败；
	// 用 GETDATE() 加类型转换保留"当前日期/当前时刻"语义。
	// 不加分支则会落到末尾按未迁移丢弃。
	if strings.HasPrefix(lower, "current_date") {
		return "CAST(GETDATE() AS DATE)", true, ""
	}
	if strings.HasPrefix(lower, "current_time") {
		return "CAST(GETDATE() AS TIME)", true, ""
	}
	if targetType == "BIT" {
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
	if isStringLikeTargetType(strings.ToUpper(targetType)) {
		return "N'" + strings.ReplaceAll(raw, "'", "''") + "'", true, ""
	}
	return "", false, fmt.Sprintf("字段 %s 的默认值 %s 当前未自动迁移", col.Name, raw)
}

func buildMySQLToSQLiteCreateTablePlan(targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)

	// 建表用的最终列类型，供索引计划判断该列在目标方言能否建索引。
	finalColumnTypes := make(map[string]string, len(sourceCols))

	// 先按主键全貌决定哪些自增列能用内联 AUTOINCREMENT，剩下的在下面剥掉
	// Extra —— 映射器只看 Extra，留着会生成重复/错位的 PRIMARY KEY。
	inlinableAutoIncrement, autoIncrementWarnings := sqliteInlineAutoIncrementColumns(sourceCols)
	warnings = append(warnings, autoIncrementWarnings...)

	for _, col := range sourceCols {
		// SQLite 允许 TEXT 主键，这里当前是空操作；保留调用让四条建表路径
		// 统一过同一道键列关卡，改动 targetAllowsLOBKeyColumn 时不会漏掉本路径。
		col, keyWarnings := applyKeyColumnTypeSafety(targetType, col)
		warnings = append(warnings, keyWarnings...)
		if !inlinableAutoIncrement[strings.ToLower(strings.TrimSpace(col.Name))] {
			col.Extra = stripAutoIncrementExtra(col.Extra)
		}
		def, colWarnings := buildMySQLToSQLiteColumnDefinition(col)
		warnings = append(warnings, colWarnings...)
		// 键小写归一 + 值取目标侧定义文本，理由同 Oracle 系路径。
		finalColumnTypes[strings.ToLower(strings.TrimSpace(col.Name))] = def
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		isPrimary := col.Key == "PRI" || col.Key == "PK"
		// AUTOINCREMENT 定义已包含 PRIMARY KEY，不再重复声明。
		if isPrimary && !strings.Contains(def, "PRIMARY KEY") {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))

	// SQL Server/SQLite 无内联列注释，有注释时告警而不是静默丢弃。
	_, commentWarnings := buildColumnCommentStatements(targetType, targetQueryTable, sourceCols)
	warnings = append(warnings, commentWarnings...)

	if !config.CreateIndexes {
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	indexes, err := sourceDB.GetIndexes(sourceSchema, sourceTable)
	if err != nil {
		warnings = append(warnings, fmt.Sprintf("读取源表索引失败，已跳过索引迁移：%v", err))
		return createSQL, nil, dedupeStrings(warnings), dedupeStrings(unsupported), nil, 0, 0, nil
	}
	postSQL, unsupported, unmigrated, created, skipped := buildMySQLSourceIndexPlan(targetType, targetQueryTable,
		stripPrimaryKeyImplicitIndexes(indexes, sourceCols), finalColumnTypes)
	return createSQL, postSQL, dedupeStrings(warnings), dedupeStrings(unsupported), unmigrated, created, skipped, nil
}

func buildMySQLToSQLiteColumnDefinition(col connection.ColumnDefinition) (string, []string) {
	targetType, useAutoIncrement, warnings := mapMySQLColumnToSQLite(col)
	parts := []string{targetType}
	if useAutoIncrement {
		parts = append(parts, "PRIMARY KEY AUTOINCREMENT")
	}
	if !useAutoIncrement {
		if defaultSQL, ok, warningText := mapMySQLDefaultToSQLite(col, targetType); warningText != "" {
			warnings = append(warnings, warningText)
		} else if ok {
			parts = append(parts, "DEFAULT "+defaultSQL)
		}
	}
	if strings.EqualFold(strings.TrimSpace(col.Nullable), "NO") && !useAutoIncrement {
		parts = append(parts, "NOT NULL")
	}
	return strings.Join(parts, " "), dedupeStrings(warnings)
}

func mapMySQLColumnToSQLite(col connection.ColumnDefinition) (string, bool, []string) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	warnings := make([]string, 0)
	if raw == "" {
		return "TEXT", false, []string{fmt.Sprintf("字段 %s 类型为空，已降级为 TEXT", col.Name)}
	}
	isAutoIncrement := strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment")
	clean := strings.ReplaceAll(raw, " unsigned", "")
	clean = strings.ReplaceAll(clean, " zerofill", "")
	if isAutoIncrement && strings.HasPrefix(raw, "bigint") && strings.Contains(raw, "unsigned") {
		// SQLite 的 INTEGER 只有有符号 64 位范围；BIGINT UNSIGNED 的
		// 上半段无法无损表达，且 AUTOINCREMENT 只能绑定 INTEGER PRIMARY KEY。
		// 保留为 NUMERIC 并显式告警，避免建表成功后悄悄溢出。
		warnings = append(warnings, fmt.Sprintf(
			"字段 %s 为 bigint unsigned 自增列；SQLite INTEGER 无法覆盖其完整值域，已降级为 NUMERIC 并丢弃自增语义",
			col.Name))
		return "NUMERIC", false, warnings
	}

	switch {
	case strings.HasPrefix(clean, "tinyint(1)") && !isAutoIncrement,
		strings.HasPrefix(clean, "bool"), strings.HasPrefix(clean, "boolean"), strings.HasPrefix(clean, "bit(1)"):
		return "INTEGER", false, warnings
	case strings.HasPrefix(clean, "tinyint"), strings.HasPrefix(clean, "smallint"), strings.HasPrefix(clean, "mediumint"),
		strings.HasPrefix(clean, "int"), strings.HasPrefix(clean, "integer"), strings.HasPrefix(clean, "bigint"),
		strings.HasPrefix(clean, "year"):
		if isAutoIncrement {
			return "INTEGER", true, warnings
		}
		return "INTEGER", false, warnings
	case strings.HasPrefix(clean, "decimal"), strings.HasPrefix(clean, "numeric"):
		// 必须落 NUMERIC 而不是 REAL：SQLite 的 REAL 亲和性会把值强制转成 8 字节
		// 浮点，定点金额（decimal(10,2)）会出现 0.1+0.2 类误差；NUMERIC 亲和性
		// 则尽量按整数/文本原样存储，不做浮点转换。SQLite 不校验长度，保留
		// 精度声明只为人工辨识。
		return "NUMERIC", false, warnings
	case strings.HasPrefix(clean, "float"), strings.HasPrefix(clean, "double"), strings.HasPrefix(clean, "bit("):
		return "REAL", false, warnings
	case strings.HasPrefix(clean, "date"), strings.HasPrefix(clean, "time"), strings.HasPrefix(clean, "datetime"), strings.HasPrefix(clean, "timestamp"):
		return "TEXT", false, warnings
	case strings.HasPrefix(clean, "binary"), strings.HasPrefix(clean, "varbinary"), strings.HasPrefix(clean, "tinyblob"), strings.HasPrefix(clean, "blob"), strings.HasPrefix(clean, "mediumblob"), strings.HasPrefix(clean, "longblob"):
		return "BLOB", false, warnings
	case strings.HasPrefix(clean, "char("), strings.HasPrefix(clean, "varchar("), strings.HasPrefix(clean, "tinytext"), strings.HasPrefix(clean, "text"),
		strings.HasPrefix(clean, "mediumtext"), strings.HasPrefix(clean, "longtext"), strings.HasPrefix(clean, "json"),
		strings.HasPrefix(clean, "enum"), strings.HasPrefix(clean, "set"):
		// SQLite 的 TEXT 无长度语义，保留原始写法便于人工辨识。
		return "TEXT", false, warnings
	default:
		return "TEXT", false, warnings
	}
}

func mapMySQLDefaultToSQLite(col connection.ColumnDefinition, targetType string) (string, bool, string) {
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
	if strings.HasPrefix(lower, "current_date") {
		return "CURRENT_DATE", true, ""
	}
	if strings.HasPrefix(lower, "current_time") {
		return "CURRENT_TIME", true, ""
	}
	if numericPattern.MatchString(raw) {
		return raw, true, ""
	}
	if strings.ContainsAny(raw, "()") && !strings.HasPrefix(lower, "current_timestamp") {
		return "", false, fmt.Sprintf("字段 %s 的默认值 %s 包含表达式，当前未自动迁移", col.Name, raw)
	}
	return "'" + strings.ReplaceAll(raw, "'", "''") + "'", true, ""
}

// sqlServerDecimalMaxPrecision 是 SQL Server DECIMAL/NUMERIC 的精度上限。
const sqlServerDecimalMaxPrecision = 38

// clampSQLServerDecimalPrecision 把超过上限的精度钳到 38 并告警。
func clampSQLServerDecimalPrecision(decimalType string, colName string, warnings *[]string) string {
	precision, ok := parseTypeLength(decimalType)
	if !ok || precision <= sqlServerDecimalMaxPrecision {
		return decimalType
	}
	clamped := fmt.Sprintf("DECIMAL(%d,%d)", sqlServerDecimalMaxPrecision, oracleLikeDecimalScale(decimalType))
	*warnings = append(*warnings, fmt.Sprintf("字段 %s 精度 %d 超过 SQL Server DECIMAL 上限 %d，已钳制为 %s", colName, precision, sqlServerDecimalMaxPrecision, clamped))
	return clamped
}

// sqliteInlineAutoIncrementColumns 决定哪些列可以用内联的
// "INTEGER PRIMARY KEY AUTOINCREMENT"。
//
// SQLite 的这个写法只对"单列整数主键"合法，且它自带 PRIMARY KEY 约束。
// 建表层才知道主键全貌，所以判定必须在这里做，映射器只看 Extra 会出两种错：
//   - 复合主键含自增列：内联子句 + 末尾 PRIMARY KEY(...) 两个主键声明，
//     SQLite 报 "table has more than one primary key"，且复合主键被拆散；
//   - 自增列不是主键：把非主键列变成主键，真正的主键另起一个 PRIMARY KEY 子句。
//
// 两种情况 SQLite 都无法表达原语义，只能丢掉自增并告警：目标端插入不再自动
// 生成 ID，调用方需要自己提供值。返回值是"可内联的列名集合"与告警。
func sqliteInlineAutoIncrementColumns(sourceCols []connection.ColumnDefinition) (map[string]bool, []string) {
	pkCount := 0
	for _, col := range sourceCols {
		if col.Key == "PRI" || col.Key == "PK" {
			pkCount++
		}
	}

	inlinable := make(map[string]bool, 1)
	var warnings []string
	for _, col := range sourceCols {
		if !strings.Contains(strings.ToLower(strings.TrimSpace(col.Extra)), "auto_increment") {
			continue
		}
		isPrimary := col.Key == "PRI" || col.Key == "PK"
		switch {
		case isPrimary && pkCount == 1:
			inlinable[strings.ToLower(strings.TrimSpace(col.Name))] = true
		case isPrimary:
			warnings = append(warnings, fmt.Sprintf(
				"字段 %s 是复合主键的一部分，SQLite 的 AUTOINCREMENT 只支持单列整数主键，已丢弃自增语义",
				col.Name))
		default:
			warnings = append(warnings, fmt.Sprintf(
				"字段 %s 是自增列但不是主键，SQLite 的 AUTOINCREMENT 必须绑定主键，已丢弃自增语义",
				col.Name))
		}
	}
	return inlinable, warnings
}
