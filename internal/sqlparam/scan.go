// Package sqlparam 提供查询编辑器运行时绑定参数的扫描、重写与值转换。
//
// 参数语法为命名参数 :name（[A-Za-z_][A-Za-z0-9_$#]*）与花括号参数
// ${name}（花括号内为非空白字符，边界明确，可承载连字符等特殊字符），
// 两者按名字归一——同名即同一参数。扫描遵循 SQL 词法边界：
// 字符串字面量、引号标识符、注释与 dollar-quote 块内的冒号不构成参数，PG 类型
// 转换 :: 不构成参数。词法选项与 internal/app/sql_split.go 的语句拆分器保持
// 一致，确保「按语句分组」与「参数扫描」对同一份 SQL 得到互相吻合的边界。
package sqlparam

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// ScanOptions 控制方言相关的词法规则，字段语义与 sql_split.go 的方言判定对齐。
type ScanOptions struct {
	// BackslashEscapes 表示引号内反斜杠是转义符。查询执行链路沿用
	// SplitSQLStatementsForDialect 的默认（true），保证两个扫描器的字符串
	// 边界判定一致。
	BackslashEscapes bool
	// HashComments 表示 # 是行注释（MySQL 系与 ClickHouse）。
	HashComments bool
	// DashCommentNeedsSpace 表示 -- 仅在后跟空白或行尾时才开始注释（MySQL 系）。
	DashCommentNeedsSpace bool
	// BracketIdentifiers 表示 [name] 是定界标识符（SQL Server/SQLite）。
	BracketIdentifiers bool
	// EscapedBracketIdentifiers 表示 ]] 是标识符内的字面量 ]（SQL Server）。
	EscapedBracketIdentifiers bool
	// DollarQuotes 表示支持 $$...$$ 与 $tag$...$tag$ 块（PostgreSQL 系）。
	DollarQuotes bool
	// QuotedPlaceholders 为 true 时，引号里的 {name}、'{name} 后缀'、'${name}'
	// 是绑定参数。为 false 时这些文本保持字面量，只认引号外的 :name 和 ${name}。
	QuotedPlaceholders bool
	// OracleAlternativeQuotes 表示 q'...' / Q'...' / nq'...' 是 Oracle 替代
	// 引号：首个字符是定界符（括号对取匹配闭括号），到「定界符 + '」结束，
	// 内容整体是字面量。Oracle 家族启用，避免 q'{abc}' 的内容被误认成
	// 引号参数、以及 q'[it's]' 里的撇号吞掉后续真实参数。
	OracleAlternativeQuotes bool
}

// OptionsForDBType 按数据源类型返回与语句拆分器一致的词法选项。
// 归一化别名表镜像 normalizeExplainLexicalDBType；空类型沿用拆分器对未知
// 方言的宽松默认。
func OptionsForDBType(dbType string) ScanOptions {
	normalized := normalizeDBType(dbType)
	// BackslashEscapes 仅 MySQL 系启用（issue #1326 用户反馈）：Oracle/达梦等
	// 方言里 `'\'` 是内容为反斜杠的完整字符串，若按转义处理会让扫描器认为
	// 字符串未闭合，后续所有 ${param} 全部丢失。
	opts := ScanOptions{
		BackslashEscapes: normalized == "mysql" ||
			normalized == "mariadb" || normalized == "oceanbase" ||
			normalized == "diros" || normalized == "starrocks" ||
			normalized == "goldendb" || normalized == "sphinx" || normalized == "tidb",
		// 历史默认开启。查询编辑器按用户开关关掉后，'{code1}-{code2}' 按原文执行。
		QuotedPlaceholders: true,
		// Oracle 家族（oracle / dameng，yashandb、OceanBase Oracle 协议等在
		// app 层已归一为 oracle）支持 q'...' 替代引号。
		OracleAlternativeQuotes: IsOracleFamilyDBType(normalized),
	}
	if normalized == "" {
		opts.HashComments = true
		opts.DollarQuotes = true
		return opts
	}
	switch normalized {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
		opts.HashComments = true
		opts.DashCommentNeedsSpace = true
	case "clickhouse":
		opts.HashComments = true
	case "sqlserver":
		opts.BracketIdentifiers = true
		opts.EscapedBracketIdentifiers = true
	case "sqlite":
		opts.BracketIdentifiers = true
	case "postgres", "opengauss", "gaussdb", "kingbase", "highgo", "vastbase":
		opts.DollarQuotes = true
	}
	return opts
}

func normalizeDBType(dbType string) string {
	normalized := strings.ToLower(strings.TrimSpace(dbType))
	switch normalized {
	case "postgresql", "pg", "pq", "pgx":
		return "postgres"
	case "doris":
		return "diros"
	case "open_gauss", "open-gauss":
		return "opengauss"
	case "gauss_db", "gauss-db":
		return "gaussdb"
	case "kingbase8", "kingbasees", "kingbasev8":
		return "kingbase"
	case "greatdb", "gdb":
		return "goldendb"
	case "dm", "dm8":
		// 达梦别名归一，与 internal/db/driver_support.go 的口径一致。
		return "dameng"
	default:
		return normalized
	}
}

// IsOracleFamilyDBType 报告 dbType 是否为 Oracle 兼容方言（替代引号、
// :NEW/:OLD 伪记录等词法共享）。dameng 是达梦的归一名；yashandb、
// OceanBase Oracle 协议在 app 层 resolveDDLDBType 已归一为 oracle。
// 前端 isOracleLikeDialect 的 oracle 家族口径与这里保持一致。
func IsOracleFamilyDBType(dbType string) bool {
	switch normalizeDBType(dbType) {
	case "oracle", "dameng", "dm":
		return true
	default:
		return false
	}
}

// Span 描述一个命名参数在原文中的字节跨度（含起始冒号，不含结束）。
// Template 非空时表示引号包裹的字符串模板参数：'前缀{name}后缀' 整体
// 是一个参数跨度，Template 保存字符串字面量原文（含 {name} 占位）。
// templateNames 保存该模板里的全部参数名；Name 仍是其中第一个，按出现
// 位置遍历时用来标识这段跨度。名单与缺值检查必须走 parameterNames。
type Span struct {
	Name          string
	Start         int
	End           int
	Template      string
	templateNames []string
}

// parameterNames 返回这段跨度贡献的参数名。普通 :name、${name}、'{name}'
// 只有 Name。同一字面量里的多个 {name} 不会生成跨度。
func (s Span) parameterNames() []string {
	if len(s.templateNames) > 0 {
		return s.templateNames
	}
	if s.Name == "" {
		return nil
	}
	return []string{s.Name}
}

// Scan 返回 sql 中所有命名参数 :name 的出现位置，按出现顺序排列，不去重。
func Scan(sql string, opts ScanOptions) []Span {
	var spans []Span
	inSingle, inDouble, inBacktick, inBracket := false, false, false, false
	singleStart := -1
	inLineComment, inBlockComment, escaped := false, false, false
	dollarTag := ""
	var altQuoteFailFrom map[rune]int

	for i := 0; i < len(sql); i++ {
		ch := sql[i]
		next := byte(0)
		if i+1 < len(sql) {
			next = sql[i+1]
		}

		if inLineComment {
			if ch == '\n' {
				inLineComment = false
			}
			continue
		}
		if inBlockComment {
			if ch == '*' && next == '/' {
				i++
				inBlockComment = false
			}
			continue
		}
		if inBracket {
			if ch == ']' {
				if opts.EscapedBracketIdentifiers && next == ']' {
					i++
					continue
				}
				inBracket = false
			}
			continue
		}
		if dollarTag != "" {
			if strings.HasPrefix(sql[i:], dollarTag) {
				i += len(dollarTag) - 1
				dollarTag = ""
			}
			continue
		}
		if escaped {
			escaped = false
			continue
		}
		if opts.BackslashEscapes && (inSingle || inDouble) && ch == '\\' {
			escaped = true
			continue
		}

		// Oracle 替代引号 q'X...X'：内容整体是字面量，不参与引号参数识别。
		// 找不到合法闭合时回退为普通引号处理，避免吞掉后续真实参数。
		// altQuoteFailFrom 按 opener 定界符记录「该定界符在此位置起找不到
		// 闭合」的最早位置：同一定界符的后续 q-quote 搜索范围是失败扫描
		// 范围的子集，必然同样失败，直接跳过探测，保证大量未闭合 q' 的
		// 最坏情况仍是线性。前缀不匹配（普通文本里的 n/q 字母）、标识符
		// 守卫失败、定界符非法都与具体位置相关，不代表同定界符的后续
		// q-quote 会失败，不得记入水位线。
		if opts.OracleAlternativeQuotes && !inSingle && !inDouble && !inBacktick &&
			(ch == 'q' || ch == 'Q' || ch == 'n' || ch == 'N') {
			opener, openerIndex, ok := oracleAlternativeQuoteOpener(sql, i)
			if ok {
				// 同定界符此前已确认从更晚位置起找不到闭合：本次搜索范围是
				// 失败扫描范围的子集，必然同样失败，跳过探测并回退普通引号。
				// openerIndex 更早时搜索范围覆盖了失败范围之外的前段，仍需探测。
				failFrom, failed := altQuoteFailFrom[opener]
				if !failed || openerIndex < failFrom {
					if end, ok := oracleAlternativeQuoteEnd(sql, i, opener, openerIndex); ok {
						i = end - 1
						continue
					}
					if altQuoteFailFrom == nil {
						altQuoteFailFrom = make(map[rune]int)
					}
					altQuoteFailFrom[opener] = openerIndex
				}
			}
		}

		if !inDouble && !inBacktick && ch == '\'' {
			if inSingle && next == '\'' {
				i++
				continue
			}
			if inSingle && opts.QuotedPlaceholders {
				// 开关打开时才认引号里的占位符：
				// 1. 整个字符串恰为一个 {标识符} → 纯参数
				// 2. 含一个或多个 {标识符} → 字符串模板，每个名字都要登记
				// 开关关闭时整段保持字面量。名字用标识符规则，排除 JSON。
				content := sql[singleStart+1 : i]
				if len(content) > 1 && content[0] == '{' && content[len(content)-1] == '}' {
					if name := content[1 : len(content)-1]; isQuotedParamName(name) {
						spans = append(spans, Span{Name: name, Start: singleStart, End: i + 1})
						inSingle = !inSingle
						continue
					}
				}
				if names := extractTemplateNames(content); len(names) > 0 {
					spans = append(spans, Span{
						Name:          names[0],
						Start:         singleStart,
						End:           i + 1,
						Template:      content,
						templateNames: names,
					})
				}
			} else if !inSingle {
				singleStart = i
			}
			inSingle = !inSingle
			continue
		}
		if !inSingle && !inBacktick && ch == '"' {
			inDouble = !inDouble
			continue
		}
		if !inSingle && !inDouble && ch == '`' {
			inBacktick = !inBacktick
			continue
		}
		if opts.BracketIdentifiers && !inSingle && !inDouble && !inBacktick && ch == '[' {
			inBracket = true
			continue
		}
		if inSingle || inDouble || inBacktick {
			continue
		}

		if ch == '-' && next == '-' && dashCommentStartsAt(sql, i, opts.DashCommentNeedsSpace) {
			inLineComment = true
			continue
		}
		if opts.HashComments && ch == '#' {
			inLineComment = true
			continue
		}
		if ch == '/' && next == '*' {
			inBlockComment = true
			i++
			continue
		}
		if opts.DollarQuotes && ch == '$' {
			if tag := parseDollarTagAt(sql, i); tag != "" {
				dollarTag = tag
				i += len(tag) - 1
				continue
			}
		}

		// 花括号参数 ${name}：'$' 后跟 '{' 不是任何方言的 dollar-quote 或
		// 位置占位符语法，可安全识别。名字取到 '}' 为止（非空白），空名不识别。
		if ch == '$' && next == '{' {
			end := i + 2
			for end < len(sql) && sql[end] != '}' && !isHorizontalWhitespaceByte(sql[end]) {
				end++
			}
			if end < len(sql) && sql[end] == '}' && end > i+2 {
				spans = append(spans, Span{Name: sql[i+2 : end], Start: i, End: end + 1})
				i = end
				continue
			}
		}

		if ch == ':' && next != ':' {
			prev := byte(' ')
			if i > 0 {
				prev = sql[i-1]
			}
			if prev != ':' && !isIdentifierPart(prev) && isIdentifierStart(next) {
				end := i + 2
				for end < len(sql) && isIdentifierPart(sql[end]) {
					end++
				}
				spans = append(spans, Span{Name: sql[i+1 : end], Start: i, End: end})
				i = end - 1
				continue
			}
		}
	}
	return spans
}

// Names 返回 sql 中去重后的参数名，保持首次出现顺序。
func Names(sql string, opts ScanOptions) []string {
	seen := make(map[string]struct{})
	var names []string
	for _, span := range Scan(sql, opts) {
		for _, name := range span.parameterNames() {
			if _, ok := seen[name]; ok {
				continue
			}
			seen[name] = struct{}{}
			names = append(names, name)
		}
	}
	return names
}

func dashCommentStartsAt(text string, index int, needsSpace bool) bool {
	if !needsSpace {
		return true
	}
	third := index + 2
	return third >= len(text) || text[third] <= ' '
}

func parseDollarTagAt(text string, start int) string {
	if start < 0 || start >= len(text) || text[start] != '$' {
		return ""
	}
	if start > 0 && isIdentifierPart(text[start-1]) {
		return ""
	}
	if start+1 >= len(text) {
		return ""
	}
	if text[start+1] == '$' {
		return "$$"
	}
	if !isIdentifierStart(text[start+1]) {
		return ""
	}
	for end := start + 2; end < len(text); end++ {
		if text[end] == '$' {
			return text[start : end+1]
		}
		if !isIdentifierPart(text[end]) || text[end] == '$' || text[end] == '#' {
			return ""
		}
	}
	return ""
}

// oracleAlternativeQuoteOpener 判定 text[start:] 是否以 Oracle 替代引号的
// 合法开头起跑（q'X、Q'X、nq'X、NQ'X，X 非空白且非引号），是则返回 opener
// 定界符与其字节下标。前一个字符是标识符成分（如 abcq'、中q'）时不认，
// 按 rune 解码判定，与 result_masking.go 的 isSQLIdentifierRune 一致。
// 只做 O(1) 校验，不扫描内容；调用方据此决定是否探测闭合与记失败水位。
func oracleAlternativeQuoteOpener(text string, start int) (rune, int, bool) {
	prefixLen := 0
	switch {
	case start+1 < len(text) && (text[start] == 'q' || text[start] == 'Q') && text[start+1] == '\'':
		prefixLen = 1
	case start+2 < len(text) && (text[start] == 'n' || text[start] == 'N') &&
		(text[start+1] == 'q' || text[start+1] == 'Q') && text[start+2] == '\'':
		prefixLen = 2
	default:
		return 0, 0, false
	}
	if start > 0 && isSQLIdentifierRuneAt(text, start-1) {
		return 0, 0, false
	}
	openerIndex := start + prefixLen + 1
	opener, openerSize := utf8.DecodeRuneInString(text[openerIndex:])
	if opener == utf8.RuneError && openerSize == 0 {
		return 0, 0, false
	}
	switch opener {
	case '\'', ' ', '\t', '\r', '\n':
		return 0, 0, false
	}
	return opener, openerIndex, true
}

// oracleAlternativeQuoteEnd 从 oracleAlternativeQuoteOpener 已确认的 opener
// 处扫描闭合序列「定界符 + '」，括号类定界符取匹配闭括号，返回闭合引号
// 之后的下标；找不到闭合返回 false，由调用方回退为普通引号词法。
// 语义对齐 internal/mcpserver/result_masking.go 的 sqlOracleAlternativeQuoteEnd。
func oracleAlternativeQuoteEnd(text string, start int, opener rune, openerIndex int) (int, bool) {
	_, openerSize := utf8.DecodeRuneInString(text[openerIndex:])
	closer := opener
	switch opener {
	case '[':
		closer = ']'
	case '{':
		closer = '}'
	case '(':
		closer = ')'
	case '<':
		closer = '>'
	}
	for index := openerIndex + openerSize; index < len(text); {
		candidate, size := utf8.DecodeRuneInString(text[index:])
		if candidate == closer && index+size < len(text) && text[index+size] == '\'' {
			return index + size + 1, true
		}
		index += size
	}
	return start, false
}

// isSQLIdentifierRuneAt 判定 text 中 index 处开始的字符是否为标识符成分
// （字母/数字/下划线/$/#/@，rune 级），与 result_masking.go 的
// isSQLIdentifierRune 语义一致：多字节字母（如中文）也计为标识符成分。
// index 可能落在多字节字符中间（start-1 是字节下标），先向前找 rune 起点。
func isSQLIdentifierRuneAt(text string, index int) bool {
	for index > 0 && !utf8.RuneStart(text[index]) {
		index--
	}
	r, _ := utf8.DecodeRuneInString(text[index:])
	return r == '_' || r == '$' || r == '#' || r == '@' ||
		unicode.IsLetter(r) || unicode.IsDigit(r)
}

// isQuotedParamName 校验引号包裹参数的名字：标识符规则（字母/下划线开头，
// 字母数字下划线）。刻意比 ${name} 的宽松字符集收紧，避免 '{...}' 形态的
// JSON 等数据字面量被误认为参数。
func isQuotedParamName(name string) bool {
	if name == "" || !isIdentifierStart(name[0]) {
		return false
	}
	for i := 1; i < len(name); i++ {
		if !isIdentifierPart(name[i]) || name[i] == '$' || name[i] == '#' {
			return false
		}
	}
	return true
}

// extractTemplateNames 提取字符串内容中的全部 {标识符} 参数名，按出现顺序去重。
func extractTemplateNames(content string) []string {
	seen := make(map[string]struct{})
	var names []string
	for i := 0; i < len(content); i++ {
		if content[i] != '{' {
			continue
		}
		end := strings.IndexByte(content[i:], '}')
		if end <= 1 {
			continue
		}
		if name := content[i+1 : i+end]; isQuotedParamName(name) {
			if _, dup := seen[name]; !dup {
				seen[name] = struct{}{}
				names = append(names, name)
			}
			i += end
		}
	}
	return names
}

func isHorizontalWhitespaceByte(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'
}

func isIdentifierStart(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_'
}

func isIdentifierPart(ch byte) bool {
	return isIdentifierStart(ch) || (ch >= '0' && ch <= '9') || ch == '$' || ch == '#'
}
