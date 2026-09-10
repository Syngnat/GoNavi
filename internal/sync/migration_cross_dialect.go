package sync

import (
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// 通用关系型互转：源方言先归一为 MySQL 类型（项目里映射面最全的中间表示），
// 再复用各目标方言已有的映射函数。覆盖 PG 系 / Oracle 系 / SQL Server /
// SQLite 作为源、任意关系型作为目标的组合，补齐 legacy 路径的 N×N 缺口。

// toMySQLColumnType 将源方言类型转为 MySQL 中间表示。第二个返回值表示
// 是否保留了自增语义。
//
// sourceType 目前只用于区分 DATE 语义（Oracle/达梦的 DATE 含时分秒），
// targetType 只用于决定是否折叠 Oracle 的负 scale：目标本身支持负 scale 时
// 不能改写，否则会丢掉"向左舍入"语义。其余映射与源/目标无关。
func toMySQLColumnType(sourceType string, targetType string, col connection.ColumnDefinition) (string, bool) {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	extra := strings.ToLower(strings.TrimSpace(col.Extra))
	if raw == "" {
		return "text", false
	}
	// 先把标准别名换成规范基础名，再进入下面的映射分支。
	// 这一步不可省：中间类型要过 knownIntermediateMySQLTypeBases 白名单，
	// 而 dec / bpchar / int1 这类别名在各方言里都是合法类型，不归一就会被
	// 白名单当成"无映射类型"降级为 text，反而丢掉本来能精确迁移的精度与长度。
	raw = canonicalizeSourceTypeAlias(raw)
	isAutoIncrement := strings.Contains(extra, "auto_increment") ||
		strings.Contains(extra, "identity") ||
		strings.HasPrefix(raw, "serial") // PG serial 类型自带自增

	switch {
	case strings.HasPrefix(raw, "serial"), strings.HasPrefix(raw, "bigserial"), strings.HasPrefix(raw, "smallserial"):
		if strings.HasPrefix(raw, "bigserial") {
			return "bigint", true
		}
		if strings.HasPrefix(raw, "smallserial") {
			return "smallint", true
		}
		return "int", true
	case raw == "boolean" || strings.HasPrefix(raw, "bool"):
		return "tinyint(1)", false
	case raw == "smallint" || raw == "int2":
		return "smallint", isAutoIncrement
	case raw == "integer" || raw == "int4":
		return "int", isAutoIncrement
	case raw == "bigint" || raw == "int8":
		return "bigint", isAutoIncrement
	case strings.HasPrefix(raw, "numeric"), strings.HasPrefix(raw, "decimal"):
		// PG 的裸 numeric / decimal 是任意精度，不带括号。原样传下去会被
		// MySQL 隐式补成 decimal(10,0)，小数位全部截断，金额类字段静默改值。
		// 这里显式给出上界精度，并由 unboundedDecimalWarning 把假设告知用户。
		// isAutoIncrement 必须透传：PG 的 identity 列可以声明为 numeric，
		// Oracle 的 identity 列更是固定 NUMBER(19)。这里返回 false 会让自增
		// 语义在归一层就丢失，coerceAutoIncrementIntegerType 也就永远不触发。
		if !strings.Contains(raw, "(") {
			return unboundedDecimalIntermediateType, isAutoIncrement
		}
		return foldNegativeDecimalScaleForTarget(targetType,
			replaceTypeBase(raw, []string{"numeric", "decimal"}, "decimal")), isAutoIncrement
	case raw == "real" || raw == "float4":
		return "float", false
	case raw == "double precision" || raw == "float8" || raw == "double":
		return "double", false
	case raw == "money":
		return "decimal(19,4)", false
	// 带 2 后缀的 Oracle 系类型必须排在 varchar/nvarchar 之前：varchar2 以
	// varchar 为前缀，先匹配宽泛分支会把 varchar2(100) 原样留下，生成的 DDL
	// 在 MySQL/PG 侧无效。
	case strings.HasPrefix(raw, "nvarchar2"), strings.HasPrefix(raw, "varchar2"):
		// Oracle varchar2(n char) 的 char/byte 长度语义忽略，只保留数字长度。
		base := strings.Replace(raw, "nvarchar2", "varchar", 1)
		base = strings.Replace(base, "varchar2", "varchar", 1)
		base = strings.ReplaceAll(base, " char)", ")")
		base = strings.ReplaceAll(base, " byte)", ")")
		return normalizeUnboundedCharacterType(base), false
	case strings.HasPrefix(raw, "national character varying"):
		return normalizeUnboundedCharacterType(strings.Replace(raw, "national character varying", "varchar", 1)), false
	case strings.HasPrefix(raw, "national char"):
		return normalizeUnboundedCharacterType(strings.Replace(raw, "national char", "char", 1)), false
	case strings.HasPrefix(raw, "nvarchar"):
		// nvarchar(max) 没有长度上限，MySQL 侧只能落 longtext；见 normalizeUnboundedCharacterType。
		return normalizeUnboundedCharacterType(strings.Replace(raw, "nvarchar", "varchar", 1)), false
	case strings.HasPrefix(raw, "nchar"):
		return normalizeUnboundedCharacterType(strings.Replace(raw, "nchar", "char", 1)), false
	case strings.HasPrefix(raw, "character varying"):
		return normalizeUnboundedCharacterType(strings.Replace(raw, "character varying", "varchar", 1)), false
	case strings.HasPrefix(raw, "varchar"):
		return normalizeUnboundedCharacterType(raw), false
	case strings.HasPrefix(raw, "character("):
		return strings.Replace(raw, "character", "char", 1), false
	case raw == "character" || raw == "char":
		return "char(1)", false
	case strings.HasPrefix(raw, "char("):
		return normalizeUnboundedCharacterType(raw), false
	case raw == "text" || raw == "clob":
		return "text", false
	case raw == "ntext" || raw == "nclob":
		return "longtext", false
	case raw == "json" || raw == "jsonb":
		return "json", false
	case raw == "bytea" || raw == "blob" || raw == "varbinary(max)" || raw == "image":
		return "longblob", false
	case strings.HasPrefix(raw, "binary("), strings.HasPrefix(raw, "varbinary("):
		return raw, false
	case raw == "uniqueidentifier" || raw == "uuid", raw == "raw(16)":
		// RAW(16) 按惯例存 UUID，落成可读的 varchar(36) 更有用。
		return "varchar(36)", false
	case strings.HasPrefix(raw, "raw("):
		// Oracle/达梦 的 RAW(n) 是定长二进制。必须显式映射：落到 default 分支会
		// 被 knownIntermediateMySQLTypeBases 当成无映射类型降级为 text，二进制
		// 字节按目标字符集重新解释，任何目标（不只是键列）都会静默损坏数据。
		return replaceTypeBase(raw, []string{"raw"}, "varbinary"), false
	case raw == "date":
		// Oracle/达梦 的 DATE 含时分秒（Oracle 是 7 字节存到秒，达梦兼容
		// Oracle），落成 date 会静默丢掉时间分量；归一为 datetime 保住语义。
		// 目标侧再把 datetime 映射为各自的日期时间类型（MySQL DATETIME、
		// PG timestamp、Oracle 系 TIMESTAMP），数据无损。PG/MySQL 系源的
		// DATE 是纯日期，保持 date 不变。
		if sourceDateIncludesTime(sourceType) {
			return "datetime", false
		}
		return "date", false
	// 时刻类型必须排在 timestamp/时区通配之前：PG 的 time with time zone 只有
	// 时分秒，落成 datetime 会改变字段语义，部分目标写入还会直接失败。
	// MySQL 侧没有带时区的 TIME/TIMESTAMP，时区信息在此丢弃。
	// interval 不在此列：它表达的是时长（可为 '1 year 2 mons' 这类年月量），
	// TIME 只能表示一日内时刻，装不下会写入失败；落到 default 由
	// normalizeIntermediateMySQLType 降级为 text 并告警。
	case raw == "time", raw == "timetz",
		strings.HasPrefix(raw, "time("),
		strings.HasPrefix(raw, "time with time zone"),
		strings.HasPrefix(raw, "time without time zone"),
		strings.HasPrefix(raw, "timetz("):
		return "time", false
	case strings.HasPrefix(raw, "timestamp"), strings.HasPrefix(raw, "datetime2"),
		strings.HasPrefix(raw, "datetime"), raw == "smalldatetime",
		strings.Contains(raw, "time zone"):
		return "datetime", false
	case raw == "bit":
		return "tinyint(1)", false
	case raw == "tinyint":
		return "tinyint", isAutoIncrement
	case raw == "money-dm":
		return "decimal(19,4)", false
	case strings.HasPrefix(raw, "number"):
		// Oracle 系 NUMBER(p,s) → decimal(p,s)；NUMBER 不带精度同样是变精度，
		// 降级为上界精度并告警，理由见 unboundedDecimalIntermediateType。
		//
		// 必须透传 isAutoIncrement：Oracle 的 GENERATED AS IDENTITY 列声明为
		// NUMBER(19)，写死 false 会让自增语义在归一层就丢掉，目标端建出普通
		// 数字列，插入不再自动生成 ID。类型收敛由
		// coerceAutoIncrementIntegerType 负责。
		if strings.Contains(raw, "(") {
			return foldNegativeDecimalScaleForTarget(targetType,
				replaceTypeBase(raw, []string{"number"}, "decimal")), isAutoIncrement
		}
		return unboundedDecimalIntermediateType, isAutoIncrement
	case strings.HasPrefix(raw, "binary_float"):
		return "float", false
	case strings.HasPrefix(raw, "binary_double"):
		return "double", false
	case raw == "long" || raw == "long raw":
		return "longtext", false
	default:
		return raw, isAutoIncrement
	}
}

// sourceTypeAliasBases 把各方言的标准类型别名映射到规范基础名。
// 只收录"同一类型的另一种写法"，不收录需要语义降级的类型（hierarchyid、
// hstore、数组等仍应走 normalizeIntermediateMySQLType 的 text 降级）。
var sourceTypeAliasBases = map[string]string{
	// 定点数：SQL 标准 DEC / MySQL FIXED。
	"dec": "decimal", "fixed": "decimal",
	// 字符：PG 内部的 bpchar 即 char；SQLite 的 native character 亲和 char。
	"bpchar": "char", "native character": "char",
	// 整数：MySQL 的宽度别名与 SQLite 亲和名。
	"int1": "tinyint", "int3": "mediumint", "middleint": "mediumint",
	"unsigned big int": "bigint",
	// 位串：PG 的 varbit / bit varying 只能按变长字符串迁移。
	"varbit": "varchar", "bit varying": "varchar",
	// Oracle PL/SQL 整数类型。
	"binary_integer": "int", "pls_integer": "int",
	// SQL Server 的 4 字节货币类型，定点语义。
	"smallmoney": "decimal(10,4)",
}

// canonicalizeSourceTypeAlias 把源类型的标准别名换成规范基础名，保留原有的
// 长度/精度括号。raw 必须已是小写并去除首尾空白。
func canonicalizeSourceTypeAlias(raw string) string {
	base := raw
	suffix := ""
	if idx := strings.Index(raw, "("); idx >= 0 {
		base = strings.TrimSpace(raw[:idx])
		suffix = raw[idx:]
	}
	canonical, ok := sourceTypeAliasBases[base]
	if !ok {
		return raw
	}
	// 别名自带精度（smallmoney）时忽略源侧括号，否则会拼出 decimal(10,4)(x)。
	if strings.Contains(canonical, "(") {
		return canonical
	}
	return canonical + suffix
}

// sourceDateIncludesTime 判定源方言的 DATE 类型是否含时分秒。
// Oracle 的 DATE 固定存到秒；达梦兼容 Oracle 同样含时分秒。IRIS 的
// %Date 是纯日期，PG/MySQL 系 DATE 也是纯日期，均不含时间。
func sourceDateIncludesTime(sourceType string) bool {
	switch normalizeMigrationDBType(sourceType) {
	case "oracle", "dameng":
		return true
	default:
		return false
	}
}

// foldNegativeDecimalScale 把 Oracle 的负 scale 折算成目标库合法的写法。
//
// Oracle 允许 NUMBER(10,-2)，语义是向左舍入到百位，实际能存的整数位是 p+|s|。
// MySQL / PG / SQL Server 的 DECIMAL scale 必须非负，原样下发会直接建表失败，
// 所以这里折成 decimal(p+|s|,0)：保住可存范围，舍入行为的差异由告警说明。
// 入参与返回值都是已归一的 decimal(...) 文本；非负 scale 原样返回。
func foldNegativeDecimalScale(decimalType string) (string, bool) {
	open := strings.Index(decimalType, "(")
	if open < 0 || !strings.HasSuffix(decimalType, ")") {
		return decimalType, false
	}
	inner := decimalType[open+1 : len(decimalType)-1]
	comma := strings.Index(inner, ",")
	if comma < 0 {
		return decimalType, false
	}
	scaleText := strings.TrimSpace(inner[comma+1:])
	if !strings.HasPrefix(scaleText, "-") {
		return decimalType, false
	}
	var precision, scale int
	if _, err := fmt.Sscanf(strings.TrimSpace(inner[:comma]), "%d", &precision); err != nil {
		return decimalType, false
	}
	if _, err := fmt.Sscanf(scaleText, "%d", &scale); err != nil {
		return decimalType, false
	}
	widened := precision - scale // scale 为负，相减等于加上其绝对值
	if widened > oracleLikeDecimalMaxPrecision {
		widened = oracleLikeDecimalMaxPrecision
	}
	return fmt.Sprintf("%s(%d,0)", decimalType[:open], widened), true
}

// foldNegativeDecimalScaleForTarget 仅在目标方言不支持负 scale 时折算。
//
// Oracle 系（Oracle / 达梦）原生支持 NUMBER(p,-s) 的向左舍入语义，对它们折成
// decimal(p+|s|,0) 是无谓的有损改写：舍入行为丢失，而目标本来能原样承载。
// MySQL / PG / SQL Server / SQLite 的 scale 必须非负，必须折算才能建表。
func foldNegativeDecimalScaleForTarget(targetType string, decimalType string) string {
	if targetSupportsNegativeDecimalScale(targetType) {
		return decimalType
	}
	folded, _ := foldNegativeDecimalScale(decimalType)
	return folded
}

// targetSupportsNegativeDecimalScale 判定目标方言的 DECIMAL 是否接受负 scale。
// IRIS 不在其中：它的 NUMERIC 遵循 SQL 标准，scale 必须非负。
func targetSupportsNegativeDecimalScale(targetType string) bool {
	switch normalizeMigrationDBType(targetType) {
	case "oracle", "dameng":
		return true
	default:
		return false
	}
}

// hasNegativeDecimalScale 判定源类型文本是否声明了负 scale，如 NUMBER(10,-2)。
func hasNegativeDecimalScale(sourceType string) bool {
	raw := strings.ToLower(strings.TrimSpace(sourceType))
	open := strings.Index(raw, "(")
	if open < 0 || !strings.HasSuffix(raw, ")") {
		return false
	}
	inner := raw[open+1 : len(raw)-1]
	comma := strings.Index(inner, ",")
	if comma < 0 {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(inner[comma+1:]), "-")
}

// negativeDecimalScaleWarning 在源列使用了 Oracle 负 scale 时返回告警文本。
func negativeDecimalScaleWarning(col connection.ColumnDefinition, folded string) string {
	return fmt.Sprintf("字段 %s 的源类型 %s 使用了 Oracle 负 scale（向左舍入），目标库不支持，已按 %s 建表",
		col.Name, strings.TrimSpace(col.Type), folded)
}

// normalizeUnboundedCharacterType maps SQL Server's (max) length specifier onto
// a MySQL LOB type. Keeping "varchar(max)" would emit VARCHAR(MAX) against
// Oracle-like and MySQL targets, which is not valid there.
func normalizeUnboundedCharacterType(value string) string {
	if strings.Contains(strings.ToLower(value), "(max)") {
		return "longtext"
	}
	return value
}

// normalizeCrossDialectDefault 把源方言默认值归一为 MySQL 中间语法。
// 目标侧映射器会按 MySQL 语义再加引号，所以源方言特有的写法（PG 的
// ::type 转型、外层括号、方言函数名）必须在这里拆掉或丢弃，否则会被当成
// 普通字符串二次转义，生成"可执行但语义错误"的默认值。
func normalizeCrossDialectDefault(col connection.ColumnDefinition) (*string, string) {
	if col.Default == nil {
		return nil, ""
	}
	raw := strings.TrimSpace(*col.Default)
	if raw == "" || strings.EqualFold(raw, "null") {
		return col.Default, ""
	}

	// SQL Server 元数据把默认值包在外层括号里：(getdate())、('abc')、((0))。
	for strings.HasPrefix(raw, "(") && strings.HasSuffix(raw, ")") {
		inner := strings.TrimSpace(raw[1 : len(raw)-1])
		if inner == "" || strings.Count(inner, "(") != strings.Count(inner, ")") {
			break
		}
		raw = inner
	}

	// SQL Server 的 Unicode 字面量 N'abc'：先剥掉 N 前缀还原成普通引号字面量。
	// 不剥的话下面的引号字面量分支匹配不到，会被当成裸值原样返回，目标侧再加
	// 一层引号后变成 N'N''abc''' —— 语法合法但存的不是原始值。
	if len(raw) >= 3 && (raw[0] == 'N' || raw[0] == 'n') && raw[1] == '\'' && strings.HasSuffix(raw, "'") {
		raw = raw[1:]
	}

	// 序列默认值（nextval('s') / nextval('s'::regclass)）由自增语义单独承载，
	// 静默丢弃。必须在转型处理之前判断：nextval('s'::regclass) 的 :: 在
	// 字面量之外，先走转型分支会落到"表达式"告警，制造无谓噪音。
	if strings.HasPrefix(strings.ToLower(raw), "nextval(") {
		return nil, ""
	}

	// PG 的 'abc'::character varying / 'abc'::text —— 剥掉转型后取字面量。
	// 只有转型后面跟着"纯类型文本"才按转型处理；转型后还有表达式
	// （'a'::text || 'b'）时只取字面量会静默截断，必须按表达式丢弃并告警。
	if idx := indexOfCastOperatorOutsideLiteral(raw); idx > 0 {
		candidate := strings.TrimSpace(raw[:idx])
		remainder := strings.TrimSpace(raw[idx+2:])
		if castRemainderLooksLikeType(remainder) {
			if strings.HasPrefix(candidate, "'") && strings.HasSuffix(candidate, "'") && len(candidate) >= 2 {
				// 还原为裸字面量，交给目标侧统一加引号。
				normalized := strings.ReplaceAll(candidate[1:len(candidate)-1], "''", "'")
				return &normalized, ""
			}
			// 时刻函数带转型（now()::timestamp）：转型只改类型不改"当前时刻"
			// 语义，按裸函数继续归一，不得因带转型而静默丢弃。
			if normalized := normalizeCurrentTimestampFunction(candidate); normalized != "" {
				return &normalized, ""
			}
			// 裸标量的转型（0::int）：转型只改类型不改值，保留标量本身。
			if !strings.ContainsAny(candidate, "()'\"") {
				normalized := candidate
				return &normalized, ""
			}
			// 其余函数类表达式（无法安全翻译的）丢弃并告警，避免静默丢默认值。
			return nil, fmt.Sprintf("字段 %s 的默认值 %s 为源方言表达式，跨库迁移时未保留", col.Name, *col.Default)
		}
		return nil, fmt.Sprintf("字段 %s 的默认值 %s 为源方言表达式，跨库迁移时未保留", col.Name, *col.Default)
	}

	lower := strings.ToLower(raw)

	// 各方言的"当前时间"函数统一成 MySQL 的 CURRENT_TIMESTAMP。
	if normalized := normalizeCurrentTimestampFunction(raw); normalized != "" {
		return &normalized, ""
	}
	switch {
	case lower == "true":
		normalized := "1"
		return &normalized, ""
	case lower == "false":
		normalized := "0"
		return &normalized, ""
	}

	// 已带引号的字面量：剥引号交给目标侧重新转义，避免双重加引号。
	if strings.HasPrefix(raw, "'") && strings.HasSuffix(raw, "'") && len(raw) >= 2 {
		normalized := strings.ReplaceAll(raw[1:len(raw)-1], "''", "'")
		return &normalized, ""
	}

	// 剩余含括号/表达式的默认值无法安全跨方言翻译，丢弃并告警。
	if strings.ContainsAny(raw, "()") {
		return nil, fmt.Sprintf("字段 %s 的默认值 %s 为源方言表达式，跨库迁移时未保留", col.Name, *col.Default)
	}

	normalized := raw
	return &normalized, ""
}

// indexOfCastOperatorOutsideLiteral 返回第一个位于单引号字面量之外的 :: 下标，
// 没有则返回 -1。PG 默认值形如 'a::b'::text，字面量内部的 :: 不是转型运算符：
// 直接用 strings.Index 会切在字符串中间，取不到闭合引号从而静默丢掉默认值。
func indexOfCastOperatorOutsideLiteral(raw string) int {
	inLiteral := false
	for i := 0; i < len(raw); i++ {
		switch raw[i] {
		case '\'':
			// '' 是字面量内的转义单引号，跳过整对后仍在字面量内部。
			if inLiteral && i+1 < len(raw) && raw[i+1] == '\'' {
				i++
				continue
			}
			inLiteral = !inLiteral
		case ':':
			if !inLiteral && i+1 < len(raw) && raw[i+1] == ':' {
				return i
			}
		}
	}
	return -1
}

// normalizeCurrentTimestampFunction 把各方言的"当前时间"函数归一为 MySQL
// 中间语法；入参不是已知时刻函数时返回空串。PG 允许 now()::timestamp 带
// 转型写默认值，转型剥离路径与主路径必须认同一套函数清单。
func normalizeCurrentTimestampFunction(raw string) string {
	lower := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case strings.HasPrefix(lower, "current_timestamp"),
		lower == "now()", lower == "getdate()", lower == "sysdate",
		lower == "systimestamp", lower == "localtimestamp", lower == "getutcdate()":
		return "CURRENT_TIMESTAMP"
	case lower == "current_date", lower == "curdate()":
		return "CURRENT_DATE"
	case lower == "current_time", lower == "curtime()":
		return "CURRENT_TIME"
	default:
		return ""
	}
}

// castRemainderLooksLikeType 判断 :: 之后的文本是否是一段纯类型声明
// （如 text、character varying(10)、timestamp(6) with time zone、
// pg_catalog.text）。只接受字母/数字/下标/点号/空格/逗号与成对括号：
// 出现引号或运算符说明转型之后还跟着表达式，取字面量会静默截断语义。
func castRemainderLooksLikeType(remainder string) bool {
	text := strings.TrimSpace(remainder)
	if text == "" {
		return false
	}
	if strings.Count(text, "(") != strings.Count(text, ")") {
		return false
	}
	for _, r := range text {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '.', r == ' ', r == '(', r == ')', r == ',':
		default:
			return false
		}
	}
	return true
}

// intermediateMySQLTypeBase 取中间类型的基础名，用于白名单校验。
// 去掉长度/精度括号与 unsigned/zerofill 修饰，保留 double precision 这类双词类型。
func intermediateMySQLTypeBase(raw string) string {
	text := strings.ToLower(strings.TrimSpace(raw))
	if idx := strings.Index(text, "("); idx >= 0 {
		text = text[:idx]
	}
	for _, modifier := range []string{" unsigned", " zerofill", " signed"} {
		text = strings.ReplaceAll(text, modifier, "")
	}
	return strings.TrimSpace(text)
}

// knownIntermediateMySQLTypeBases 是中间表示允许出现的 MySQL 类型基础名。
var knownIntermediateMySQLTypeBases = map[string]bool{
	"tinyint": true, "smallint": true, "mediumint": true, "int": true, "integer": true,
	"bigint": true, "decimal": true, "numeric": true, "float": true, "double": true,
	"double precision": true, "real": true, "bit": true, "bool": true, "boolean": true,
	"char": true, "varchar": true, "binary": true, "varbinary": true,
	"tinyblob": true, "blob": true, "mediumblob": true, "longblob": true,
	"tinytext": true, "text": true, "mediumtext": true, "longtext": true,
	"enum": true, "set": true, "json": true,
	"date": true, "datetime": true, "timestamp": true, "time": true, "year": true,
	"geometry": true, "point": true, "linestring": true, "polygon": true,
	"multipoint": true, "multilinestring": true, "multipolygon": true,
	"geometrycollection": true,
}

// normalizeIntermediateMySQLType 兜住 toMySQLColumnType 的 default 分支。
// 该分支把未识别类型原样返回，而 MySQL 系目标的 sanitizeMySQLColumnType 只拦
// 反引号/分号/换行，于是 SQL Server hierarchyid、Oracle BFILE 之类会被直接拼进
// CREATE TABLE 生成非法 DDL。这里统一降级并告警。
//
// 键列安全不在这里处理：LOB 能否进主键/索引取决于目标方言（PG 与 SQLite 允许
// text 主键，MySQL/Oracle 系/SQL Server 不允许），因此交给目标相关的
// applyKeyColumnTypeSafety 统一收口，避免对 PG 目标做无谓的长度截断。
func normalizeIntermediateMySQLType(colName, mysqlType, sourceType string) (string, string) {
	if knownIntermediateMySQLTypeBases[intermediateMySQLTypeBase(mysqlType)] {
		return normalizeKnownIntermediateMySQLType(colName, mysqlType, sourceType)
	}
	return "text", fmt.Sprintf("字段 %s 的源类型 %s 无跨方言映射，已降级为 text", colName, strings.TrimSpace(sourceType))
}

// unmappedKeyColumnFallbackType 是无映射键列的降级类型。长度取 255 是为了在
// MySQL utf8mb4 的 767 字节索引前缀限制内留出余量，同时不超过 SQL Server 的
// 900 字节索引键上限与 Oracle 系 VARCHAR2 上限。
const unmappedKeyColumnFallbackType = "varchar(255)"

// normalizeKnownIntermediateMySQLType 修掉白名单内类型仍会生成非法目标 DDL 的写法：
// 裸 varchar / char 无长度。PG 的 character varying 不声明长度是合法的（等同
// 无限长），但 MySQL 的 VARCHAR 必须带长度，直接下发会语法报错。无限长语义
// 只能落成 LOB，因此转 longtext；若该列参与键，后续 applyKeyColumnTypeSafety
// 会按目标方言再收紧。
func normalizeKnownIntermediateMySQLType(colName, mysqlType, sourceType string) (string, string) {
	base := intermediateMySQLTypeBase(mysqlType)
	if !strings.Contains(mysqlType, "(") && (base == "varchar" || base == "char") {
		return "longtext", fmt.Sprintf(
			"字段 %s 的源类型 %s 未声明长度，已按不限长文本建表",
			colName, strings.TrimSpace(sourceType))
	}
	return mysqlType, ""
}

// applyKeyColumnTypeSafety 保证参与主键/索引的列不会落成目标方言不可索引的类型。
//
// 这一步必须目标相关：MySQL 报 "BLOB/TEXT column used in key specification
// without a key length"，Oracle 系与 SQL Server 直接拒绝 CLOB / NVARCHAR(MAX)
// 进索引；而 PG 系与 SQLite 允许 text 主键，对它们做长度截断反而是无谓的有损
// 改写。返回值是（可能被替换的）MySQL 中间类型与告警。
//
// 三条 MySQL 源专用建表路径（Oracle 系 / SQL Server / SQLite）与通用互转层都要
// 经过这里：专用路径直接消费源列，不走 buildCrossDialectIntermediateColumn，
// 漏掉就会让 text 主键在达梦上生成 CLOB + PRIMARY KEY 而建表失败。
func applyKeyColumnTypeSafety(targetType string, col connection.ColumnDefinition) (connection.ColumnDefinition, []string) {
	if !isKeyColumnDefinition(col) || targetAllowsLOBKeyColumn(targetType) {
		return col, nil
	}
	// 实测而非按基础名猜：先按目标方言生成一次列定义，只有真的落成不可索引
	// 类型才降级。只看中间类型的基础名会漏掉"带长度但超目标上限"的情况 ——
	// varchar(8000) 在 Oracle 系落 CLOB、在 SQL Server 落 NVARCHAR(MAX)，
	// binary(8000) 落 BLOB / VARBINARY(MAX)，基础名却都不在 LOB 集合里。
	// buildColumnDefinitionForTargetType 不回调本函数，不存在递归。
	planned, _ := buildColumnDefinitionForTargetType(targetType, col)
	if reason, ok := keyColumnRejectionReason(targetType, planned); ok {
		safe := col
		safe.Type = keyColumnFallbackType(targetType, col)
		return safe, []string{fmt.Sprintf(
			"字段 %s 的类型 %s 在目标 %s 会落成 %s（%s），无法参与主键/索引，已降级为 %s",
			col.Name, strings.TrimSpace(col.Type), strings.TrimSpace(targetType),
			strings.TrimSpace(planned), reason, safe.Type)}
	}
	return col, nil
}

// keyColumnIndexKeyMaxBytes 返回目标方言单列索引键的字节上限。
//
// 这与"是否 LOB"是两回事：SQL Server 的 BINARY(8000) 是合法可声明类型、不是
// LOB，但拿它做主键照样报 "index key too long"，所以长度要单独查一道。
//
// 必须分方言，不能取跨库最小值一刀切：MySQL InnoDB 的上限是 3072 字节
// （DYNAMIC 行格式），varchar(1000) 做主键完全合法，按 SQL Server 的 900
// 去截会把本可精确迁移的列砍掉四分之三 —— 而主键被截短会在数据导入阶段
// 才暴露：超长值写入失败，或截断后产生主键冲突。
//
// 各值来源：SQL Server 非聚集索引键 1700 字节、聚集索引 900 字节，取小的
// 900 保证两种索引都建得出；Oracle 的索引键受块大小约束，8K 块下约为 3200
// 字节，取 VARCHAR2 的 4000 更紧的那个 3200；达梦与 IRIS 同族按 Oracle 处理。
func keyColumnIndexKeyMaxBytes(targetType string) int {
	switch normalizeMigrationDBType(targetType) {
	case "sqlserver":
		return 900
	case "oracle", "dameng", "iris":
		return 3200
	default:
		// MySQL 系（含 mariadb/oceanbase）：InnoDB DYNAMIC 行格式 3072 字节。
		return 3072
	}
}

// keyColumnRejectionReason 判定已生成的目标列定义能否作为主键/索引列。
// 返回拒绝原因与是否需要降级；可以直接做键列时返回 ("", false)。
func keyColumnRejectionReason(targetType string, plannedType string) (string, bool) {
	if isUnindexableTargetColumnType(plannedType) {
		return "大对象类型", true
	}
	limit := keyColumnIndexKeyMaxBytes(targetType)
	if length, ok := parseTypeLength(plannedType); ok && length > limit {
		return fmt.Sprintf("声明长度 %d 超过索引键上限 %d 字节", length, limit), true
	}
	return "", false
}

// binaryKeyColumnFallbackType 是二进制键列的兜底降级类型。必须保持二进制而不能
// 退成字符类型，否则原始字节会被按目标字符集重新解释，数据静默损坏。
const binaryKeyColumnFallbackType = "varbinary(255)"

// keyColumnFallbackType 为键列选择降级类型。
//
// 三条原则：
//  1. 保持类型族 —— 二进制列降级后仍是二进制，否则字节按字符集重解释而损坏；
//  2. 尽量保住长度 —— 主键值被截断会在导入阶段写入失败，或在宽松模式下静默
//     截断导致主键冲突，所以能留多少就留多少；
//  3. 结果必须自校验 —— 候选类型要再过一遍 keyColumnRejectionReason 才算数。
//
// 第 3 条不可省：索引键上限与类型自身的可声明上限是两个独立约束，取前者当答案
// 会再次踩坑 —— 达梦的索引键上限 3200 大于 RAW 的 2000，直接用 3200 生成的
// varbinary(3200) 会被映射器重新落成 BLOB，绕回不可索引的原点。所以从大到小
// 试候选长度，取第一个真正通过检查的。
func keyColumnFallbackType(targetType string, col connection.ColumnDefinition) string {
	isBinary := false
	switch intermediateMySQLTypeBase(col.Type) {
	case "binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob":
		isBinary = true
	}
	build := func(length int) string {
		if isBinary {
			return fmt.Sprintf("varbinary(%d)", length)
		}
		return fmt.Sprintf("varchar(%d)", length)
	}

	// 候选按可保留长度降序：目标索引键上限、RAW/VARCHAR2 等类型上限、兜底 255。
	candidates := []int{keyColumnIndexKeyMaxBytes(targetType), oracleLikeRawMaxLength, 1000, 255}
	if sourceLength, ok := parseTypeLength(col.Type); ok {
		// 源列本身更短时不必放大，避免把 varchar(300) 撑成 varchar(3072)。
		candidates = append([]int{sourceLength}, candidates...)
	}

	seen := make(map[int]bool, len(candidates))
	for _, length := range candidates {
		if length <= 0 || seen[length] {
			continue
		}
		seen[length] = true
		candidate := build(length)
		planned, _ := buildColumnDefinitionForTargetType(targetType, connection.ColumnDefinition{
			Name: col.Name, Type: candidate, Nullable: col.Nullable,
		})
		if _, rejected := keyColumnRejectionReason(targetType, planned); !rejected {
			return candidate
		}
	}

	if isBinary {
		return binaryKeyColumnFallbackType
	}
	return unmappedKeyColumnFallbackType
}

// targetAllowsLOBKeyColumn 判定目标方言是否允许大对象类型直接作为主键/索引列。
// PG 系的 text 与 SQLite 的 TEXT 都可以建索引，无需截断长度。
func targetAllowsLOBKeyColumn(targetType string) bool {
	target := normalizeMigrationDBType(targetType)
	return isPGLikeTarget(target) || target == "sqlite"
}

// unboundedDecimalIntermediateType 是无精度 numeric/decimal/NUMBER 的降级类型。
// 38 是 Oracle / 达梦 / SQL Server 共同的 DECIMAL 精度上限，取 10 位小数在整数
// 位与小数位之间折中。这是一个有损假设：PG 的裸 numeric 与 Oracle 的裸 NUMBER
// 都支持超出该范围的值，所以必须配合 unboundedDecimalWarning 告知用户。
const unboundedDecimalIntermediateType = "decimal(38,10)"

// unboundedDecimalWarning 在源列是无精度定点数时返回告警文本，否则返回空串。
// 归一层已把这类列钉成 unboundedDecimalIntermediateType，超出该精度的存量数据
// 会在写入阶段失败或被截断，属于必须显式提示的取舍。
func unboundedDecimalWarning(col connection.ColumnDefinition) string {
	raw := strings.ToLower(strings.TrimSpace(col.Type))
	if strings.Contains(raw, "(") {
		return ""
	}
	switch raw {
	case "numeric", "decimal", "number", "dec":
		return fmt.Sprintf("字段 %s 的源类型 %s 未声明精度，已按 %s 建表；超出该精度的数据会写入失败",
			col.Name, strings.TrimSpace(col.Type), unboundedDecimalIntermediateType)
	default:
		return ""
	}
}

// isKeyColumnDefinition 判定列是否会参与主键或索引。
// 除主键（PRI/PK）外，UNI/MUL 列会被 buildMySQLSourceIndexPlan 建成索引，
// 同样不能落成 LOB 类型，否则建索引阶段失败。
func isKeyColumnDefinition(col connection.ColumnDefinition) bool {
	switch strings.ToUpper(strings.TrimSpace(col.Key)) {
	case "PRI", "PK", "UNI", "MUL":
		return true
	default:
		return false
	}
}

// buildCrossDialectIntermediateColumn 把源方言列归一为 MySQL 中间列定义，
// 供建表与补列两条路径共用。
func buildCrossDialectIntermediateColumn(sourceType string, targetType string, col connection.ColumnDefinition) (connection.ColumnDefinition, []string) {
	mysqlType, isAutoIncrement := toMySQLColumnType(sourceType, targetType, col)
	mysqlType, typeWarning := normalizeIntermediateMySQLType(col.Name, mysqlType, col.Type)
	if typeWarning != "" {
		// 降级为 text 后自增语义无处承载，一并丢弃避免生成 text AUTO_INCREMENT。
		isAutoIncrement = false
	}
	// Oracle 的 identity 列类型是 NUMBER(19)，归一成 decimal(19) 后属于定点数，
	// 而 MySQL AUTO_INCREMENT / PG IDENTITY / SQL Server IDENTITY 都只接受整数
	// 类型，自增语义会被静默丢弃 —— 目标端建出普通数字列，插入不再生成 ID。
	// 这里按精度把它收敛成能承载自增的整数类型。
	var autoIncrementWarning string
	if isAutoIncrement {
		mysqlType, autoIncrementWarning = coerceAutoIncrementIntegerType(col.Name, mysqlType)
	}
	normalizedDefault, defaultWarning := normalizeCrossDialectDefault(col)
	intermediate := connection.ColumnDefinition{
		Name:     col.Name,
		Type:     mysqlType,
		Nullable: col.Nullable,
		Default:  normalizedDefault,
		Key:      col.Key,
		Extra:    "",
	}
	if isAutoIncrement {
		intermediate.Extra = "auto_increment"
	}
	warnings := make([]string, 0, 3)
	if typeWarning != "" {
		warnings = append(warnings, typeWarning)
	}
	// 无精度定点数被钉成上界精度，属于有损假设，必须显式提示。
	// typeWarning 非空说明该列已另有降级路径，不再叠加这条。
	if typeWarning == "" {
		if decimalWarning := unboundedDecimalWarning(col); decimalWarning != "" {
			warnings = append(warnings, decimalWarning)
		}
		// 负 scale 折算丢掉了 Oracle 的向左舍入语义，同样必须提示。
		// 仅在真的折算了才提示：Oracle 系目标原生支持负 scale，类型按原样下发，
		// 此时报"已按 xxx 建表"会误导用户以为精度语义被改过。
		if hasNegativeDecimalScale(col.Type) && !targetSupportsNegativeDecimalScale(targetType) {
			warnings = append(warnings, negativeDecimalScaleWarning(col, mysqlType))
		}
	}
	if autoIncrementWarning != "" {
		warnings = append(warnings, autoIncrementWarning)
	}
	if defaultWarning != "" {
		warnings = append(warnings, defaultWarning)
	}
	return intermediate, warnings
}

// coerceAutoIncrementIntegerType 把自增列的定点类型收敛成整数类型。
//
// Oracle 的 GENERATED AS IDENTITY 列声明为 NUMBER(19)，归一后是 decimal(19)；
// MySQL 的 AUTO_INCREMENT、PG 的 GENERATED AS IDENTITY、SQL Server 的
// IDENTITY(1,1) 都只接受整数类型，定点类型会让自增语义被丢弃。按精度选择
// 最小够用的整数类型：精度未知或超过 bigint 范围时统一用 bigint。
// 已经是整数类型的直接返回，不产生告警。
func coerceAutoIncrementIntegerType(colName, mysqlType string) (string, string) {
	base := intermediateMySQLTypeBase(mysqlType)
	switch base {
	case "tinyint", "smallint", "mediumint", "int", "integer", "bigint":
		return mysqlType, ""
	case "decimal", "numeric":
		// 带小数位的定点数做自增没有意义，也无法无损表达，一并按整数处理。
		coerced := "bigint"
		if precision, ok := parseTypeLength(mysqlType); ok {
			switch {
			case precision <= 4:
				coerced = "smallint"
			case precision <= 9:
				coerced = "int"
			}
		}
		return coerced, fmt.Sprintf(
			"字段 %s 是自增列但源类型为 %s，目标库的自增只支持整数类型，已按 %s 建表",
			colName, mysqlType, coerced)
	default:
		return mysqlType, ""
	}
}

// buildCrossDialectAutoCreatePlan 生成跨方言自动建表计划。
// 源为 PG 系 / Oracle 系 / SQL Server / SQLite，目标为任意关系型。
func buildCrossDialectAutoCreatePlan(sourceType, targetType string, config SyncConfig, targetQueryTable string, sourceCols []connection.ColumnDefinition, sourceDB db.Database, sourceSchema, sourceTable string) (string, []string, []string, []string, []UnmigratedIndex, int, int, error) {
	columnDefs := make([]string, 0, len(sourceCols)+1)
	warnings := make([]string, 0)
	unsupported := make([]string, 0)
	pkCols := make([]string, 0, 2)

	plannedColumnTypes := make(map[string]string, len(sourceCols))

	// 先把所有列归一，再决定 SQLite 的内联自增 —— 顺序不能反。
	// 各方言表达自增的方式不同（Oracle 的 Extra="IDENTITY"、PG 的类型 serial），
	// 只有归一层会把它们统一成 Extra="auto_increment"。在归一前判定会一个都
	// 认不出来，剥离也就不生效。
	intermediates := make([]connection.ColumnDefinition, 0, len(sourceCols))
	for _, col := range sourceCols {
		intermediate, intermediateWarnings := buildCrossDialectIntermediateColumn(sourceType, targetType, col)
		warnings = append(warnings, intermediateWarnings...)
		intermediates = append(intermediates, intermediate)
	}

	// SQLite 的 AUTOINCREMENT 只对单列整数主键合法且自带 PRIMARY KEY，
	// 其余自增列必须剥掉，否则会生成两个 PRIMARY KEY 子句。
	// 非 SQLite 目标集合为 nil，下面的剥离不触发。
	var inlinableAutoIncrement map[string]bool
	if normalizeMigrationDBType(targetType) == "sqlite" {
		var sqliteWarnings []string
		inlinableAutoIncrement, sqliteWarnings = sqliteInlineAutoIncrementColumns(intermediates)
		warnings = append(warnings, sqliteWarnings...)
	}

	for i, col := range sourceCols {
		intermediate := intermediates[i]
		if inlinableAutoIncrement != nil && !inlinableAutoIncrement[strings.ToLower(strings.TrimSpace(intermediate.Name))] {
			intermediate.Extra = stripAutoIncrementExtra(intermediate.Extra)
		}
		intermediate, keyWarnings := applyKeyColumnTypeSafety(targetType, intermediate)
		warnings = append(warnings, keyWarnings...)
		def, colWarnings := buildColumnDefinitionForTargetType(targetType, intermediate)
		warnings = append(warnings, colWarnings...)
		plannedColumnTypes[strings.ToLower(strings.TrimSpace(col.Name))] = def
		columnDefs = append(columnDefs, fmt.Sprintf("%s %s", quoteIdentByType(targetType, col.Name), def))
		// SQLite 的 AUTOINCREMENT 定义已含 PRIMARY KEY，不重复声明。
		if (col.Key == "PRI" || col.Key == "PK") && !strings.Contains(def, "PRIMARY KEY") {
			pkCols = append(pkCols, quoteIdentByType(targetType, col.Name))
		}
	}
	if len(pkCols) > 0 {
		columnDefs = append(columnDefs, fmt.Sprintf("PRIMARY KEY (%s)", strings.Join(pkCols, ", ")))
	}
	createSQL := fmt.Sprintf("CREATE TABLE %s (\n  %s\n)", quoteQualifiedIdentByType(targetType, targetQueryTable), strings.Join(columnDefs, ",\n  "))

	// 列注释按目标方言处理：Oracle/达梦 生成 COMMENT ON COLUMN（注释在源列
	// 元数据上，不在中间表示里，必须在源列循环外统一处理）；其余方言告警。
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
		stripPrimaryKeyImplicitIndexes(indexes, sourceCols), plannedColumnTypes)
	return createSQL, append(commentSQL, postSQL...), dedupeStrings(warnings), dedupeStrings(unsupported), unmigrated, created, skipped, nil
}

// buildColumnDefinitionForTargetType 按目标方言选择列定义生成器（输入已是 MySQL 中间类型）。
func buildColumnDefinitionForTargetType(targetType string, col connection.ColumnDefinition) (string, []string) {
	target := normalizeMigrationDBType(targetType)
	switch {
	case isMySQLLikeWritableTargetType(target):
		return buildMySQLToMySQLColumnDefinition(col)
	case isPGLikeTarget(target):
		return buildMySQLToPGLikeColumnDefinition(col)
	case isOracleLikeTargetType(target):
		return buildMySQLToOracleLikeColumnDefinition(targetType, col)
	case target == "sqlserver":
		return buildMySQLToSQLServerColumnDefinition(col)
	case target == "sqlite":
		return buildMySQLToSQLiteColumnDefinition(col)
	default:
		return "TEXT", []string{fmt.Sprintf("目标 %s 暂无专用列定义映射，已降级为 TEXT", targetType)}
	}
}

// supportsCrossDialectAutoCreate 判定源/目标组合是否可由通用互转层建表。
func supportsCrossDialectAutoCreate(sourceType, targetType string) bool {
	return isCrossDialectAutoCreateSourceType(normalizeMigrationDBType(sourceType)) &&
		isCrossDialectAutoCreateTargetType(normalizeMigrationDBType(targetType))
}

// isCrossDialectAutoCreateSourceType 列出可以只靠列元数据归一为中间表示的源。
// Doris/StarRocks 作为源只需要读取列定义，因此包含在内。
func isCrossDialectAutoCreateSourceType(source string) bool {
	switch source {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb",
		"oracle", "dameng", "iris", "sqlserver", "sqlite":
		return true
	default:
		return false
	}
}

// isCrossDialectAutoCreateTargetType 列出可以用普通 CREATE TABLE 建出可写表的目标。
//
// Doris/StarRocks 被有意排除：它们的建表语句必须带 key model（DUPLICATE/UNIQUE/
// AGGREGATE KEY）、ENGINE 与 DISTRIBUTED BY 分桶定义，复用普通 MySQL DDL 会在
// 运行时建表失败。这两个目标仍走"要求目标表已存在"的既有语义。
func isCrossDialectAutoCreateTargetType(target string) bool {
	switch target {
	case "mysql", "mariadb", "oceanbase",
		"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "duckdb",
		"oracle", "dameng", "iris", "sqlserver", "sqlite":
		return true
	default:
		return false
	}
}

// requiresDistributionClauseTarget 判定目标方言的 CREATE TABLE 是否必须带
// 分桶/分布定义（Doris 与 StarRocks 需要 key model + DISTRIBUTED BY）。
//
// 这道闸不能只挂在通用互转层：isMySQLCoreType 把 diros/starrocks 视为 MySQL 系
// 可写目标，于是 pglike-mysql-planner、clickhouse-mysql-planner、
// mongo-mysql-planner、tdengine-mysql-planner 这些 Full 级 planner 会直接接管，
// 生成的普通 MySQL DDL 缺分桶定义、建表必失败 —— 而 Full 级在 capability 里
// 无条件给出 SupportsAutoCreate=true，UI 会显示"将自动创建目标表"，preflight
// 也放行，最终在执行期崩。所以判定要独立成函数，供 capability 层一并收口。
func requiresDistributionClauseTarget(targetType string) bool {
	switch normalizeMigrationDBType(targetType) {
	case "diros", "starrocks":
		return true
	default:
		return false
	}
}

// stripAutoIncrementExtra 只剥掉 Extra 里的自增标记，保留其余内容。
//
// 不能直接把 Extra 清空：这个字段还承载生成列（virtual generated / stored
// generated）等标记，下游 isGeneratedCopyTableColumn 之类的判定依赖它们，
// 整体清掉会让生成列被当成普通列处理。
func stripAutoIncrementExtra(extra string) string {
	fields := strings.Fields(extra)
	kept := make([]string, 0, len(fields))
	for _, field := range fields {
		if strings.EqualFold(field, "auto_increment") {
			continue
		}
		kept = append(kept, field)
	}
	return strings.Join(kept, " ")
}
