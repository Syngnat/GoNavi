package app

import "strings"

// splitSQLStatements 按分号拆分 SQL 文本为独立语句。
// 正确处理单引号/双引号/反引号字符串、行注释（-- / #）、块注释（/* */）、
// PostgreSQL/Kingbase 的 $$...$$ dollar-quoting，以及 Oracle PL/SQL 匿名块，
// 避免在这些上下文中错误拆分。
// 同时支持 SQL 标准的转义单引号（两个连续单引号 ” 表示字面量引号）。
func splitSQLStatements(sql string) []string {
	return splitSQLStatementsForDialect("", sql)
}

// splitSQLStatementsForDialect keeps the legacy generic splitter available to
// existing execution paths while allowing security-sensitive callers to apply
// the actual comment and dollar-quote rules of the target database.
func splitSQLStatementsForDialect(dbType, sql string) []string {
	text := strings.ReplaceAll(sql, "\r\n", "\n")
	if normalizeSQLClassifierDBType(dbType) == "elasticsearch" {
		if source := strings.TrimSpace(text); source != "" {
			return []string{source}
		}
		return nil
	}
	var statements []string

	var cur strings.Builder
	inSingle := false
	inDouble := false
	inBacktick := false
	escaped := false
	inLineComment := false
	inBlockComment := false
	var dollarTag string // postgres/kingbase: $$...$$ or $tag$...$tag$
	plsqlDepth := 0
	plsqlDeclareBeginSkips := 0
	plsqlCaseDepth := 0
	skipNextPLSQLCaseEndToken := false
	justClosedPLSQLBlock := false

	push := func() {
		s := strings.TrimSpace(cur.String())
		if s != "" && hasExecutableSQLStatementContent(dbType, s) {
			statements = append(statements, s)
		}
		cur.Reset()
	}

	for i := 0; i < len(text); i++ {
		ch := text[i]
		next := byte(0)
		if i+1 < len(text) {
			next = text[i+1]
		}

		// 行注释
		if inLineComment {
			if ch == '\n' {
				inLineComment = false
			}
			cur.WriteByte(ch)
			continue
		}

		// 块注释
		if inBlockComment {
			cur.WriteByte(ch)
			if ch == '*' && next == '/' {
				cur.WriteByte('/')
				i++
				inBlockComment = false
			}
			continue
		}

		// Dollar-quoting
		if dollarTag != "" {
			if strings.HasPrefix(text[i:], dollarTag) {
				cur.WriteString(dollarTag)
				i += len(dollarTag) - 1
				dollarTag = ""
			} else {
				cur.WriteByte(ch)
			}
			continue
		}

		// 转义字符（反斜杠转义，MySQL 风格）
		if escaped {
			escaped = false
			cur.WriteByte(ch)
			continue
		}
		if (inSingle || inDouble) && ch == '\\' {
			escaped = true
			cur.WriteByte(ch)
			continue
		}

		// 字符串开闭
		if !inDouble && !inBacktick && ch == '\'' {
			if inSingle && next == '\'' {
				// SQL 标准转义：两个连续单引号 '' 表示字面量引号，保持在引号内
				cur.WriteByte(ch)
				cur.WriteByte(next)
				i++
				continue
			}
			inSingle = !inSingle
			cur.WriteByte(ch)
			continue
		}
		if !inSingle && !inBacktick && ch == '"' {
			inDouble = !inDouble
			cur.WriteByte(ch)
			continue
		}
		if !inSingle && !inDouble && ch == '`' {
			inBacktick = !inBacktick
			cur.WriteByte(ch)
			continue
		}

		// 在引号/反引号内部不做任何判断
		if inSingle || inDouble || inBacktick {
			cur.WriteByte(ch)
			continue
		}

		if isSQLIdentifierStart(ch) {
			tokenStart := i
			tokenEnd := i + 1
			for tokenEnd < len(text) && isSQLIdentifierPart(text[tokenEnd]) {
				tokenEnd++
			}
			token := strings.ToLower(text[tokenStart:tokenEnd])
			if token == "case" && plsqlDepth > 0 {
				if skipNextPLSQLCaseEndToken {
					skipNextPLSQLCaseEndToken = false
				} else {
					plsqlCaseDepth++
					justClosedPLSQLBlock = false
				}
			} else if token != "case" {
				skipNextPLSQLCaseEndToken = false
			}
			if token == "begin" && plsqlDeclareBeginSkips > 0 {
				plsqlDeclareBeginSkips--
				justClosedPLSQLBlock = false
			} else if token == "begin" && shouldEnterPLSQLBlockForDialect(dbType, text, tokenEnd) {
				plsqlDepth++
				justClosedPLSQLBlock = false
			} else if token == "declare" && shouldEnterPLSQLDeclareBlock(text, tokenEnd) {
				plsqlDepth++
				plsqlDeclareBeginSkips++
				justClosedPLSQLBlock = false
			} else if plsqlDepth == 0 && shouldEnterPLSQLCreateRoutineBlock(text, cur.String(), token, tokenEnd) {
				plsqlDepth++
				if !isCreatePackageHeaderPrefix(cur.String()) {
					plsqlDeclareBeginSkips++
				}
				justClosedPLSQLBlock = false
			} else if token == "end" && plsqlDepth > 0 && plsqlCaseDepth > 0 {
				plsqlCaseDepth--
				if nextSQLSignificantToken(text, tokenEnd) == "case" {
					skipNextPLSQLCaseEndToken = true
				}
				justClosedPLSQLBlock = false
			} else if token == "end" && plsqlDepth > 0 && !isPLSQLControlEnd(text, tokenEnd) {
				plsqlDepth--
				if plsqlDeclareBeginSkips > plsqlDepth {
					plsqlDeclareBeginSkips = plsqlDepth
				}
				if plsqlCaseDepth > plsqlDepth {
					plsqlCaseDepth = plsqlDepth
				}
				justClosedPLSQLBlock = plsqlDepth == 0
			}
			cur.WriteString(text[tokenStart:tokenEnd])
			i = tokenEnd - 1
			continue
		}

		// 行注释开始
		if ch == '-' && next == '-' && isSQLDashLineCommentStart(dbType, text, i) {
			inLineComment = true
			cur.WriteByte(ch)
			continue
		}
		if ch == '#' && supportsSQLHashLineComment(dbType) {
			inLineComment = true
			cur.WriteByte(ch)
			continue
		}

		if ch == '/' && (justClosedPLSQLBlock || strings.TrimSpace(cur.String()) == "") {
			if lineEnd, ok := standaloneSQLSlashLineEnd(text, i); ok {
				push()
				justClosedPLSQLBlock = false
				i = lineEnd
				continue
			}
		}

		// 块注释开始
		if ch == '/' && next == '*' {
			inBlockComment = true
			cur.WriteString("/*")
			i++
			continue
		}

		// Dollar-quoting 开始
		if ch == '$' && supportsSQLDollarQuote(dbType) {
			if tag := parseSQLDollarTagAt(text, i); tag != "" {
				dollarTag = tag
				cur.WriteString(tag)
				i += len(tag) - 1
				continue
			}
		}

		// 分号分隔（支持全角分号"；"）
		if ch == ';' {
			if plsqlDepth > 0 {
				cur.WriteByte(ch)
				continue
			}
			if justClosedPLSQLBlock {
				cur.WriteByte(ch)
				push()
				justClosedPLSQLBlock = false
				continue
			}
			push()
			continue
		}
		// 全角分号 UTF-8 序列: 0xEF 0xBC 0x9B
		if ch == 0xEF && i+2 < len(text) && text[i+1] == 0xBC && text[i+2] == 0x9B {
			if plsqlDepth > 0 {
				cur.WriteString("；")
				i += 2
				continue
			}
			if justClosedPLSQLBlock {
				cur.WriteString("；")
				push()
				justClosedPLSQLBlock = false
				i += 2
				continue
			}
			push()
			i += 2
			continue
		}

		cur.WriteByte(ch)
	}

	push()
	return statements
}

func hasExecutableSQLStatementContent(dbType, statement string) bool {
	for i := 0; i < len(statement); {
		switch statement[i] {
		case ' ', '\t', '\n', '\r', '\f':
			i++
			continue
		case '-':
			if i+1 < len(statement) && statement[i+1] == '-' && isSQLDashLineCommentStart(dbType, statement, i) {
				i = scanSQLLineCommentEnd(statement, i+2)
				continue
			}
		case '#':
			if supportsSQLHashLineComment(dbType) {
				i = scanSQLLineCommentEnd(statement, i+1)
				continue
			}
		case '/':
			if i+1 < len(statement) && statement[i+1] == '*' {
				remaining := statement[i:]
				if supportsSQLExecutableBlockComment(dbType, remaining) {
					return true
				}
				blockEnd := strings.Index(remaining[2:], "*/")
				if blockEnd < 0 {
					return false
				}
				i += blockEnd + 4
				continue
			}
		}
		return true
	}
	return false
}

func supportsSQLExecutableBlockComment(dbType, remaining string) bool {
	isMySQLVersionComment := strings.HasPrefix(remaining, "/*!")
	isMariaDBVersionComment := len(remaining) >= 4 && strings.EqualFold(remaining[:4], "/*m!")
	if !isMySQLVersionComment && !isMariaDBVersionComment {
		return false
	}
	normalized := normalizeExplainLexicalDBType(dbType)
	if normalized == "" {
		return true
	}
	if isMariaDBVersionComment {
		return normalized == "mariadb"
	}
	switch normalized {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
		return true
	default:
		return false
	}
}

func isSQLDashLineCommentStart(dbType, text string, index int) bool {
	switch normalizeExplainLexicalDBType(dbType) {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb":
		return isMySQLDashCommentStart(text, index)
	default:
		return true
	}
}

func supportsSQLHashLineComment(dbType string) bool {
	normalized := normalizeExplainLexicalDBType(dbType)
	if normalized == "" {
		return true
	}
	switch normalized {
	case "mysql", "mariadb", "oceanbase", "diros", "starrocks", "goldendb", "sphinx", "tidb", "clickhouse":
		return true
	default:
		return false
	}
}

func supportsSQLDollarQuote(dbType string) bool {
	normalized := normalizeExplainLexicalDBType(dbType)
	if normalized == "" {
		return true
	}
	switch normalized {
	case "postgres", "opengauss", "gaussdb", "kingbase", "highgo", "vastbase":
		return true
	default:
		return false
	}
}

func normalizeExplainLexicalDBType(dbType string) string {
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
	default:
		return normalized
	}
}

func isSQLIdentifierStart(ch byte) bool {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch == '_'
}

func isSQLIdentifierPart(ch byte) bool {
	return isSQLIdentifierStart(ch) || (ch >= '0' && ch <= '9') || ch == '$' || ch == '#'
}

func isSQLHorizontalWhitespace(ch byte) bool {
	return ch == ' ' || ch == '\t' || ch == '\r' || ch == '\f'
}

func standaloneSQLSlashLineEnd(text string, pos int) (int, bool) {
	if pos < 0 || pos >= len(text) || text[pos] != '/' {
		return 0, false
	}
	lineStart := strings.LastIndexByte(text[:pos], '\n') + 1
	for i := lineStart; i < pos; i++ {
		if !isSQLHorizontalWhitespace(text[i]) {
			return 0, false
		}
	}
	lineEnd, standalone, _ := scanSQLStandaloneSlashLineSuffix(text, pos)
	if !standalone {
		return 0, false
	}
	return lineEnd, true
}

func scanSQLStandaloneSlashLineSuffix(text string, pos int) (lineEnd int, standalone bool, complete bool) {
	if pos < 0 || pos >= len(text) || text[pos] != '/' {
		return 0, false, true
	}
	seenOptionalSemicolon := false
	for i := pos + 1; i < len(text); i++ {
		if text[i] == '\n' {
			return i, true, true
		}
		if text[i] == ';' && !seenOptionalSemicolon {
			seenOptionalSemicolon = true
			continue
		}
		if text[i] == '-' {
			if i+1 >= len(text) {
				return len(text), true, false
			}
			if text[i+1] == '-' {
				lineEnd := scanSQLLineCommentEnd(text, i+2)
				if lineEnd >= len(text) {
					return lineEnd, true, false
				}
				return lineEnd, true, true
			}
		}
		if !isSQLHorizontalWhitespace(text[i]) {
			return 0, false, true
		}
	}
	return len(text), true, false
}

func scanSQLLineCommentEnd(text string, pos int) int {
	for i := pos; i < len(text); i++ {
		if text[i] == '\n' {
			return i
		}
	}
	return len(text)
}

func skipSQLWhitespaceAndComments(text string, pos int) int {
	i := pos
	for i < len(text) {
		switch text[i] {
		case ' ', '\t', '\n', '\r', '\f':
			i++
			continue
		case '-':
			if i+1 < len(text) && text[i+1] == '-' {
				i += 2
				for i < len(text) && text[i] != '\n' {
					i++
				}
				continue
			}
		case '/':
			if i+1 < len(text) && text[i+1] == '*' {
				i += 2
				for i+1 < len(text) && !(text[i] == '*' && text[i+1] == '/') {
					i++
				}
				if i+1 < len(text) {
					i += 2
				}
				continue
			}
		}
		break
	}
	return i
}

func nextSQLSignificantToken(text string, pos int) string {
	i := skipSQLWhitespaceAndComments(text, pos)
	if i >= len(text) || !isSQLIdentifierStart(text[i]) {
		return ""
	}
	end := i + 1
	for end < len(text) && isSQLIdentifierPart(text[end]) {
		end++
	}
	return strings.ToLower(text[i:end])
}

func nextSQLSignificantByte(text string, pos int) byte {
	i := skipSQLWhitespaceAndComments(text, pos)
	if i >= len(text) {
		return 0
	}
	return text[i]
}

func sqlBeginStartsTransactionForDialect(dbType string, text string, tokenEnd int) bool {
	second, secondEnd := nextSQLKeyword(text, tokenEnd)
	switch normalizeSQLClassifierDBType(dbType) {
	case "sqlserver":
		switch second {
		case "transaction", "tran":
			return true
		case "distributed":
			third, _ := nextSQLKeyword(text, secondEnd)
			return third == "transaction" || third == "tran"
		default:
			return false
		}
	case "oracle", "dameng":
		return false
	case "sqlite":
		switch second {
		case "", "transaction", "deferred", "immediate", "exclusive":
			return true
		default:
			return false
		}
	case "mysql", "mariadb", "diros", "starrocks", "sphinx", "oceanbase":
		return second == "" || second == "work"
	case "postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb":
		switch second {
		case "", "work", "transaction", "isolation", "read", "write", "deferrable":
			return true
		case "not":
			third, _ := nextSQLKeyword(text, secondEnd)
			return third == "deferrable"
		default:
			return false
		}
	case "duckdb", "iris":
		return second == "" || second == "work" || second == "transaction"
	default:
		return false
	}
}

func shouldEnterPLSQLBlockForDialect(dbType string, text string, tokenEnd int) bool {
	nextPos := skipSQLTrivia(text, tokenEnd)
	if nextPos >= len(text) || text[nextPos] == ';' {
		return false
	}
	if sqlBeginStartsTransactionForDialect(dbType, text, tokenEnd) {
		return false
	}

	nextToken, _ := nextSQLKeyword(text, tokenEnd)
	normalizedType := normalizeSQLClassifierDBType(dbType)
	if normalizedType == "sqlserver" && (nextToken == "dialog" || nextToken == "conversation") {
		// BEGIN DIALOG CONVERSATION and BEGIN CONVERSATION TIMER are standalone
		// Service Broker commands, not BEGIN ... END control-flow blocks.
		return false
	}
	if normalizedType == "" {
		// Preserve the historical dialect-neutral behavior for callers that do
		// not know their target engine. Ambiguous forms are resolved only on the
		// new dialect-aware paths.
		switch nextToken {
		case "transaction", "work", "isolation", "read", "write":
			return false
		}
	}
	return true
}

func isPLSQLBlockStatement(stmt string) bool {
	return isPLSQLBlockStatementForDialect("", stmt)
}

func isPLSQLBlockStatementForDialect(dbType string, stmt string) bool {
	text := strings.TrimSpace(stmt)
	if text == "" {
		return false
	}
	if strings.HasSuffix(text, "/") {
		text = strings.TrimSpace(strings.TrimSuffix(text, "/"))
	}
	token, tokenEnd := nextSQLKeyword(text, 0)
	if token == "declare" {
		return shouldEnterPLSQLDeclareBlock(text, tokenEnd)
	}
	if token == "begin" {
		return shouldEnterPLSQLBlockForDialect(dbType, text, tokenEnd)
	}
	return isCreateRoutineHeaderPrefix(text)
}

func shouldEnterPLSQLDeclareBlock(text string, tokenEnd int) bool {
	return nextSQLSignificantToken(text, tokenEnd) != ""
}

func isPLSQLControlEnd(text string, tokenEnd int) bool {
	switch nextSQLSignificantToken(text, tokenEnd) {
	case "if", "loop", "case":
		return true
	default:
		return false
	}
}

func isCreateRoutineHeaderPrefix(text string) bool {
	currentToken, currentEnd := nextSQLSignificantTokenSpan(text, 0)
	if currentToken != "create" {
		return false
	}

	currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
	if currentToken == "or" {
		currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
		if currentToken != "replace" {
			return false
		}
		currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
	}

	for currentToken == "editionable" || currentToken == "noneditionable" {
		currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
	}

	if currentToken == "procedure" || currentToken == "function" {
		return true
	}
	if currentToken != "package" {
		return false
	}
	currentToken, _ = nextSQLSignificantTokenSpan(text, currentEnd)
	return currentToken == "" || currentToken == "body" || isSQLIdentifierStart(currentToken[0])
}

func isCreatePackageHeaderPrefix(text string) bool {
	currentToken, currentEnd := nextSQLSignificantTokenSpan(text, 0)
	if currentToken != "create" {
		return false
	}

	currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
	if currentToken == "or" {
		currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
		if currentToken != "replace" {
			return false
		}
		currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
	}

	for currentToken == "editionable" || currentToken == "noneditionable" {
		currentToken, currentEnd = nextSQLSignificantTokenSpan(text, currentEnd)
	}

	return currentToken == "package"
}

func nextSQLSignificantTokenSpan(text string, pos int) (string, int) {
	i := skipSQLWhitespaceAndComments(text, pos)
	if i >= len(text) || !isSQLIdentifierStart(text[i]) {
		return "", i
	}
	end := i + 1
	for end < len(text) && isSQLIdentifierPart(text[end]) {
		end++
	}
	return strings.ToLower(text[i:end]), end
}

func shouldEnterPLSQLCreateRoutineBlock(text string, currentStatementPrefix string, token string, tokenEnd int) bool {
	if token != "is" && token != "as" {
		return false
	}
	nextChar := nextSQLSignificantByte(text, tokenEnd)
	if nextChar == 0 {
		return false
	}
	if token == "as" && (nextChar == '$' || nextChar == '\'' || nextChar == '"') {
		return false
	}
	return isCreateRoutineHeaderPrefix(currentStatementPrefix)
}

// parseSQLDollarTag 解析 PostgreSQL/Kingbase 的 dollar-quoting 标签。
func parseSQLDollarTag(s string) string {
	if len(s) < 2 || s[0] != '$' {
		return ""
	}
	for i := 1; i < len(s); i++ {
		c := s[i]
		if c == '$' {
			return s[:i+1]
		}
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return ""
		}
	}
	return ""
}

func parseSQLDollarTagAt(text string, start int) string {
	if start < 0 || start >= len(text) || text[start] != '$' {
		return ""
	}
	if start > 0 && isSQLIdentifierPart(text[start-1]) {
		return ""
	}
	if start+1 >= len(text) {
		return ""
	}
	if text[start+1] == '$' {
		return "$$"
	}
	if !isSQLIdentifierStart(text[start+1]) {
		return ""
	}
	for end := start + 2; end < len(text); end++ {
		if text[end] == '$' {
			return text[start : end+1]
		}
		if !isSQLIdentifierPart(text[end]) || text[end] == '$' || text[end] == '#' {
			return ""
		}
	}
	return ""
}
