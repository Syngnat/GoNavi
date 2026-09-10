package mcpserver

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"GoNavi-Wails/internal/ai"
	appcore "GoNavi-Wails/internal/app"
	"GoNavi-Wails/internal/connection"
)

const (
	maskNone = iota
	maskPartial
	maskFull
)

type directProjection struct {
	final           string
	finalExact      string
	source          string
	alternateSource string
}

type statementProjections struct {
	items []directProjection
}

// maskResultSets copies rows before replacing matching values, so no caller can
// accidentally reuse the database result object after it has been redacted.
func maskResultSets(settings ai.ResultMaskingSettings, dbType, sql string, resultSets []connection.ResultSetData) []connection.ResultSetData {
	noBackslashEscapes := false
	if isMySQLProjectionDialect(dbType) {
		defaultScore := mysqlProjectionCandidateScore(dbType, sql, resultSets, false)
		noBackslashScore := mysqlProjectionCandidateScore(dbType, sql, resultSets, true)
		noBackslashEscapes = noBackslashScore > defaultScore
	}
	return maskResultSetsWithSQLMode(settings, dbType, sql, resultSets, noBackslashEscapes)
}

// mysqlProjectionCandidateScore uses the database-returned column labels as
// evidence for the string-literal mode that actually parsed the statement.
// This avoids guessing server/session sql_mode from connection text while also
// preventing the losing candidate from contributing positional source maps.
func mysqlProjectionCandidateScore(dbType, sql string, resultSets []connection.ResultSetData, noBackslashEscapes bool) int {
	parseDBType := dbType
	statementSQL := appcore.SplitSQLStatementsForDialect(dbType, sql)
	if noBackslashEscapes {
		parseDBType += "|no_backslash"
		statementSQL = appcore.SplitSQLStatementsForDialectMode(dbType, sql, false)
	}
	statements := directSelectProjectionsForStatements(parseDBType, statementSQL)
	sequentialFallback := projectionCandidateMapsResultPrefix(statements, resultSets)
	score := 0
	for resultIndex, resultSet := range resultSets {
		projections := projectionsForResultSet(statements, resultSets, resultIndex, sequentialFallback)
		score += projectionColumnCompatibilityScore(projections, resultSet.Columns)
	}
	return score
}

func projectionColumnCompatibilityScore(projections []directProjection, columns []string) int {
	if len(projections) == 0 || len(columns) == 0 {
		return 0
	}
	score := 0
	if len(projections) == len(columns) {
		score += 2
	} else {
		score -= 2
	}
	seen := make(map[string]int, len(projections))
	for index, projection := range projections {
		if index >= len(columns) || projection.finalExact == "" {
			continue
		}
		base := projection.finalExact
		seen[base]++
		expected := base
		if seen[base] > 1 {
			expected = fmt.Sprintf("%s_%d", base, seen[base])
		}
		if columns[index] == expected {
			score += 4
		} else if normalizedMaskField(columns[index]) == normalizedMaskField(expected) {
			score += 2
		} else {
			score--
		}
	}
	return score
}

func maskResultSetsWithSQLMode(settings ai.ResultMaskingSettings, dbType, sql string, resultSets []connection.ResultSetData, mysqlNoBackslashEscapes bool) []connection.ResultSetData {
	settings = ai.NormalizeResultMaskingSettings(settings)
	if !settings.Enabled || (len(settings.FullMaskFields) == 0 && len(settings.PartialMaskFields) == 0) {
		return resultSets
	}

	full := maskFieldSet(settings.FullMaskFields)
	partial := maskFieldSet(settings.PartialMaskFields)
	parseDBType := dbType
	statementSQL := appcore.SplitSQLStatementsForDialect(dbType, sql)
	sequentialFallback := false
	if mysqlNoBackslashEscapes && isMySQLProjectionDialect(dbType) {
		parseDBType += "|no_backslash"
		statementSQL = appcore.SplitSQLStatementsForDialectMode(dbType, sql, false)
	}
	statements := directSelectProjectionsForStatements(parseDBType, statementSQL)
	sequentialFallback = mysqlNoBackslashEscapes && projectionCandidateMapsResultPrefix(statements, resultSets)
	masked := make([]connection.ResultSetData, 0, len(resultSets))
	for resultIndex, resultSet := range resultSets {
		copySet := resultSet
		copySet.Columns = append([]string(nil), resultSet.Columns...)
		copySet.Messages = append([]string(nil), resultSet.Messages...)
		copySet.Rows = make([]map[string]interface{}, 0, len(resultSet.Rows))
		projections := projectionsForResultSet(statements, resultSets, resultIndex, sequentialFallback)
		sourceFields := projectionSourceFields(projections, resultSet.Columns)
		for _, row := range resultSet.Rows {
			copyRow := make(map[string]interface{}, len(row))
			for column, value := range row {
				mode := maskingMode(column, sourceFields[column], full, partial)
				if mode == maskNone || value == nil {
					copyRow[column] = value
					continue
				}
				copyRow[column] = maskSQLValue(value, mode)
			}
			copySet.Rows = append(copySet.Rows, copyRow)
		}
		masked = append(masked, copySet)
	}
	return masked
}

func projectionsForResultSet(statements []statementProjections, resultSets []connection.ResultSetData, resultIndex int, sequentialFallback bool) []directProjection {
	resultSet := resultSets[resultIndex]
	if resultSet.StatementIndex > 0 && resultSet.StatementIndex <= len(statements) {
		return statements[resultSet.StatementIndex-1].items
	}
	if sequentialFallback && resultIndex < len(statements) {
		return statements[resultIndex].items
	}
	// A zero index cannot be mapped safely from result cardinality: CALL and
	// executable blocks may emit several result sets. Production native paths
	// assign proven statement indexes before the result reaches this layer.
	return nil
}

func projectionCandidateMapsResultPrefix(statements []statementProjections, resultSets []connection.ResultSetData) bool {
	if len(resultSets) == 0 || len(statements) < len(resultSets) {
		return false
	}
	for index, resultSet := range resultSets {
		if resultSet.StatementIndex != 0 && resultSet.StatementIndex != index+1 {
			return false
		}
		if len(statements[index].items) == 0 {
			return false
		}
	}
	return true
}

func projectionSourceFields(projections []directProjection, columns []string) map[string][]string {
	fields := make(map[string][]string)
	if len(projections) == len(columns) {
		for index, column := range columns {
			fields[column] = projectionSources(projections[index])
		}
		return fields
	}
	return projectionSourceFieldsByAlias(projections, columns)
}

func projectionSourceFieldsByAlias(projections []directProjection, columns []string) map[string][]string {
	fields := make(map[string][]string)
	// Some drivers omit or reshape column metadata. Fall back only for unique
	// final aliases so an ambiguous duplicate projection cannot be misattributed.
	exactCounts := make(map[string]int, len(projections))
	foldedCounts := make(map[string]int, len(projections))
	for _, projection := range projections {
		if projection.final != "" && len(projectionSources(projection)) > 0 {
			exactCounts[projection.finalExact]++
			foldedCounts[projection.final]++
		}
	}
	for _, column := range columns {
		if exactCounts[column] == 1 {
			for _, projection := range projections {
				if projection.finalExact == column && len(projectionSources(projection)) > 0 {
					fields[column] = projectionSources(projection)
					break
				}
			}
			continue
		}
		columnKey := normalizedMaskField(column)
		if foldedCounts[columnKey] != 1 {
			continue
		}
		for _, projection := range projections {
			if projection.final == columnKey && len(projectionSources(projection)) > 0 {
				fields[column] = projectionSources(projection)
				break
			}
		}
	}
	return fields
}

func projectionSources(projection directProjection) []string {
	sources := make([]string, 0, 2)
	if projection.source != "" {
		sources = append(sources, projection.source)
	}
	if projection.alternateSource != "" && projection.alternateSource != projection.source {
		sources = append(sources, projection.alternateSource)
	}
	return sources
}

func maskFieldSet(fields []string) map[string]struct{} {
	set := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		if name := normalizedMaskField(field); name != "" {
			set[name] = struct{}{}
		}
	}
	return set
}

func maskingMode(column string, sources []string, full, partial map[string]struct{}) int {
	candidates := []string{normalizedMaskField(column)}
	for _, source := range sources {
		if source != "" && source != candidates[0] {
			candidates = append(candidates, source)
		}
	}
	for _, candidate := range candidates {
		if _, ok := full[candidate]; ok {
			return maskFull
		}
	}
	for _, candidate := range candidates {
		if _, ok := partial[candidate]; ok {
			return maskPartial
		}
	}
	return maskNone
}

func normalizedMaskField(field string) string {
	return ai.ResultMaskFieldKey(field)
}

func maskSQLValue(value interface{}, mode int) string {
	var text string
	switch typed := value.(type) {
	case string:
		text = typed
	case []byte:
		text = string(typed)
	case fmt.Stringer:
		text = typed.String()
	default:
		text = fmt.Sprint(value)
	}
	runes := []rune(text)
	if len(runes) == 0 {
		return ""
	}
	if mode == maskPartial && len(runes) > 6 {
		return string(runes[:3]) + strings.Repeat("*", len(runes)-6) + string(runes[len(runes)-3:])
	}
	return strings.Repeat("*", len(runes))
}

func directSelectStatementProjections(dbType, sql string) []statementProjections {
	statements := appcore.SplitSQLStatementsForDialect(dbType, sql)
	return directSelectProjectionsForStatements(dbType, statements)
}

func directSelectProjectionsForStatements(dbType string, statements []string) []statementProjections {
	result := make([]statementProjections, len(statements))
	for index, statement := range statements {
		if projections, ok := directSelectProjections(dbType, statement); ok {
			result[index].items = projections
		}
	}
	return result
}

// directSelectProjectionFields is retained as a compact test helper.
func directSelectProjectionFields(statement string) map[string]string {
	projections, ok := directSelectProjections("", statement)
	if !ok {
		return nil
	}
	fields := make(map[string]string)
	for _, projection := range projections {
		if projection.final != "" && projection.source != "" {
			fields[projection.final] = projection.source
		}
	}
	return fields
}

// directSelectProjections recognizes only direct field projections and keeps
// every projection position. Complex expressions remain in the slice with an
// empty source so later direct fields still align with driver column metadata.
func directSelectProjections(dbType, statement string) ([]directProjection, bool) {
	statement = strings.TrimSpace(stripSQLComments(dbType, statement))
	rest, ok := selectStatementBody(dbType, statement)
	if !ok {
		return nil, false
	}
	rest = trimSelectModifiers(dbType, rest)
	selectList, ok := topLevelSelectList(dbType, rest)
	if !ok {
		return nil, false
	}
	items := splitTopLevelComma(dbType, selectList)
	projections := make([]directProjection, 0, len(items))
	for _, item := range items {
		final, finalExact, source, direct := directProjectionField(dbType, item)
		if !direct {
			projections = append(projections, directProjection{})
			continue
		}
		projections = append(projections, directProjection{final: final, finalExact: finalExact, source: source})
	}
	return projections, true
}

func selectStatementBody(dbType, statement string) (string, bool) {
	if rest, ok := consumeSQLKeyword(statement, "select"); ok {
		return rest, true
	}
	if _, ok := consumeSQLKeyword(statement, "with"); !ok {
		return statement, false
	}
	depth := 0
	for index := 0; index < len(statement); {
		if end, ok := sqlQuotedEnd(dbType, statement, index); ok {
			index = end
			continue
		}
		switch statement[index] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 && sqlKeywordAt(statement, index, "select") {
				return strings.TrimSpace(statement[index+len("select"):]), true
			}
		}
		index++
	}
	return statement, false
}

func trimSelectModifiers(dbType, text string) string {
	dialect := strings.ToLower(strings.TrimSpace(dbType))
	for {
		var consumed bool
		for _, keyword := range []string{"all", "distinct", "unique"} {
			var rest string
			if rest, consumed = consumeSQLKeyword(text, keyword); consumed {
				text = rest
				if keyword == "distinct" {
					if afterOn, ok := consumeSQLKeyword(text, "on"); ok {
						if afterExpr, ok := consumeParenthesizedPrefix(dbType, afterOn); ok {
							text = afterExpr
						}
					}
				}
				break
			}
		}
		if consumed {
			continue
		}
		if isMySQLProjectionDialect(dialect) {
			for _, keyword := range []string{"distinctrow", "high_priority", "straight_join", "sql_small_result", "sql_big_result", "sql_buffer_result", "sql_cache", "sql_no_cache", "sql_calc_found_rows"} {
				if rest, ok := consumeSQLKeyword(text, keyword); ok {
					text, consumed = rest, true
					break
				}
			}
			if consumed {
				continue
			}
		}
		if dialect == "sqlserver" || dialect == "mssql" {
			if rest, ok := consumeSQLKeyword(text, "top"); ok {
				if afterValue, ok := consumeTopValue(dbType, rest); ok {
					text = afterValue
					if afterPercent, ok := consumeSQLKeyword(text, "percent"); ok {
						text = afterPercent
					}
					if afterWith, ok := consumeSQLKeyword(text, "with"); ok {
						if afterTies, ok := consumeSQLKeyword(afterWith, "ties"); ok {
							text = afterTies
						}
					}
					continue
				}
			}
		}
		return strings.TrimSpace(text)
	}
}

func consumeSQLKeyword(text, keyword string) (string, bool) {
	text = strings.TrimSpace(text)
	if len(text) < len(keyword) || !strings.EqualFold(text[:len(keyword)], keyword) {
		return text, false
	}
	if len(text) > len(keyword) {
		r, _ := utf8.DecodeRuneInString(text[len(keyword):])
		if isSQLIdentifierRune(r) {
			return text, false
		}
	}
	return strings.TrimSpace(text[len(keyword):]), true
}

func consumeParenthesizedPrefix(dbType, text string) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" || text[0] != '(' {
		return text, false
	}
	depth := 0
	for index := 0; index < len(text); {
		if end, ok := sqlQuotedEnd(dbType, text, index); ok {
			index = end
			continue
		}
		switch text[index] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return strings.TrimSpace(text[index+1:]), true
			}
		}
		index++
	}
	return text, false
}

func consumeTopValue(dbType, text string) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return text, false
	}
	if text[0] == '(' {
		return consumeParenthesizedPrefix(dbType, text)
	}
	index := 0
	for index < len(text) && !unicode.IsSpace(rune(text[index])) && text[index] != ',' {
		index++
	}
	if index == 0 {
		return text, false
	}
	return strings.TrimSpace(text[index:]), true
}

func topLevelSelectList(dbType, text string) (string, bool) {
	depth := 0
	for index := 0; index < len(text); {
		if end, ok := sqlQuotedEnd(dbType, text, index); ok {
			index = end
			continue
		}
		switch text[index] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 && sqlKeywordAt(text, index, "from") {
				return text[:index], true
			}
		}
		index++
	}
	return "", false
}

func splitTopLevelComma(dbType, text string) []string {
	items := []string{}
	start, depth := 0, 0
	for index := 0; index < len(text); {
		if end, ok := sqlQuotedEnd(dbType, text, index); ok {
			index = end
			continue
		}
		switch text[index] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				items = append(items, text[start:index])
				start = index + 1
			}
		}
		index++
	}
	return append(items, text[start:])
}

type projectionLexeme struct {
	value     string
	dot       bool
	equal     bool
	quoted    bool
	aliasOnly bool
}

func directProjectionField(dbType, item string) (final string, finalExact string, source string, ok bool) {
	tokens, ok := lexDirectProjection(dbType, strings.TrimSpace(item))
	if !ok || len(tokens) == 0 {
		return "", "", "", false
	}
	if isSQLServerProjectionDialect(dbType) {
		equalIndex := -1
		for index, token := range tokens {
			if token.equal {
				if equalIndex >= 0 {
					return "", "", "", false
				}
				equalIndex = index
			}
		}
		if equalIndex >= 0 {
			if equalIndex != 1 || tokens[0].dot || strings.TrimSpace(tokens[0].value) == "" {
				return "", "", "", false
			}
			source, ok = qualifiedProjectionSource(tokens[equalIndex+1:])
			if !ok {
				return "", "", "", false
			}
			return normalizedMaskField(tokens[0].value), tokens[0].value, source, true
		}
	}
	asIndex := -1
	for index, token := range tokens {
		if !token.dot && !token.equal && !token.quoted && strings.EqualFold(token.value, "as") {
			if asIndex >= 0 {
				return "", "", "", false
			}
			asIndex = index
		}
	}
	if asIndex >= 0 {
		if asIndex == 0 || asIndex+2 != len(tokens) || tokens[asIndex+1].dot {
			return "", "", "", false
		}
		source, ok = qualifiedProjectionSource(tokens[:asIndex])
		if !ok {
			return "", "", "", false
		}
		return normalizedMaskField(tokens[asIndex+1].value), tokens[asIndex+1].value, source, true
	}
	if source, ok = qualifiedProjectionSource(tokens); ok {
		return source, tokens[len(tokens)-1].value, source, true
	}
	if len(tokens) < 2 || tokens[len(tokens)-1].dot {
		return "", "", "", false
	}
	source, ok = qualifiedProjectionSource(tokens[:len(tokens)-1])
	if !ok {
		return "", "", "", false
	}
	return normalizedMaskField(tokens[len(tokens)-1].value), tokens[len(tokens)-1].value, source, true
}

func lexDirectProjection(dbType, text string) ([]projectionLexeme, bool) {
	tokens := make([]projectionLexeme, 0, 5)
	for index := 0; index < len(text); {
		r, size := utf8.DecodeRuneInString(text[index:])
		if unicode.IsSpace(r) {
			index += size
			continue
		}
		if text[index] == '.' {
			tokens = append(tokens, projectionLexeme{dot: true})
			index++
			continue
		}
		if text[index] == '=' {
			tokens = append(tokens, projectionLexeme{equal: true})
			index++
			continue
		}
		if text[index] == '`' || text[index] == '"' || text[index] == '[' || text[index] == '\'' {
			end, value, ok := quotedIdentifier(dbType, text, index)
			if !ok {
				return nil, false
			}
			tokens = append(tokens, projectionLexeme{value: value, quoted: true, aliasOnly: text[index] == '\''})
			index = end
			continue
		}
		if !isSQLIdentifierRune(r) {
			return nil, false
		}
		start := index
		for index < len(text) {
			r, size = utf8.DecodeRuneInString(text[index:])
			if !isSQLIdentifierRune(r) {
				break
			}
			index += size
		}
		tokens = append(tokens, projectionLexeme{value: text[start:index]})
	}
	return tokens, true
}

func qualifiedProjectionSource(tokens []projectionLexeme) (string, bool) {
	if len(tokens) == 0 || len(tokens)%2 == 0 {
		return "", false
	}
	for index, token := range tokens {
		if index%2 == 0 {
			if token.dot || token.equal || token.aliasOnly || strings.TrimSpace(token.value) == "" {
				return "", false
			}
		} else if !token.dot || token.equal {
			return "", false
		}
	}
	return normalizedMaskField(tokens[len(tokens)-1].value), true
}

func quotedIdentifier(dbType, text string, start int) (int, string, bool) {
	opener := text[start]
	closer := opener
	if opener == '[' {
		closer = ']'
	}
	var builder strings.Builder
	for index := start + 1; index < len(text); index++ {
		if text[index] == '\\' && sqlBackslashEscapesQuote(dbType, text, start, opener) && index+1 < len(text) {
			builder.WriteByte(text[index+1])
			index++
			continue
		}
		if text[index] != closer {
			builder.WriteByte(text[index])
			continue
		}
		if index+1 < len(text) && text[index+1] == closer {
			builder.WriteByte(closer)
			index++
			continue
		}
		return index + 1, builder.String(), builder.Len() > 0
	}
	return start, "", false
}

func stripSQLComments(dbType, text string) string {
	var builder strings.Builder
	for index := 0; index < len(text); {
		if end, ok := sqlQuotedEnd(dbType, text, index); ok {
			builder.WriteString(text[index:end])
			index = end
			continue
		}
		if index+1 < len(text) && text[index] == '-' && text[index+1] == '-' && isSQLLineCommentStart(dbType, text, index) {
			builder.WriteByte(' ')
			index += 2
			for index < len(text) && text[index] != '\n' && text[index] != '\r' {
				index++
			}
			continue
		}
		if isMySQLProjectionDialect(strings.ToLower(strings.TrimSpace(dbType))) && text[index] == '#' {
			builder.WriteByte(' ')
			index++
			for index < len(text) && text[index] != '\n' && text[index] != '\r' {
				index++
			}
			continue
		}
		if index+1 < len(text) && text[index] == '/' && text[index+1] == '*' {
			commentStart := index
			contentStart := index + 2
			executable := false
			dialect := projectionDialect(dbType)
			if contentStart < len(text) && text[contentStart] == '!' && isMySQLProjectionDialect(dialect) {
				executable = true
				contentStart++
			} else if contentStart+1 < len(text) && (text[contentStart] == 'M' || text[contentStart] == 'm') && text[contentStart+1] == '!' && dialect == "mariadb" {
				executable = true
				contentStart += 2
			}
			index = contentStart
			depth := 1
			contentEnd := len(text)
			for index < len(text) && depth > 0 {
				if index+1 < len(text) && text[index] == '/' && text[index+1] == '*' {
					depth++
					index += 2
				} else if index+1 < len(text) && text[index] == '*' && text[index+1] == '/' {
					depth--
					if depth == 0 {
						contentEnd = index
					}
					index += 2
				} else {
					index++
				}
			}
			builder.WriteByte(' ')
			if executable {
				content := text[contentStart:contentEnd]
				content = trimExecutableCommentVersion(content)
				builder.WriteString(stripSQLComments(dbType, content))
				builder.WriteByte(' ')
			} else if index <= commentStart+2 {
				// Defensive progress guard for malformed input.
				index = commentStart + 2
			}
			continue
		}
		builder.WriteByte(text[index])
		index++
	}
	return builder.String()
}

func trimExecutableCommentVersion(text string) string {
	if text == "" || text[0] < '0' || text[0] > '9' {
		return text
	}
	index := 0
	for index < len(text) && text[index] >= '0' && text[index] <= '9' {
		index++
	}
	return strings.TrimLeftFunc(text[index:], unicode.IsSpace)
}

func sqlQuotedEnd(dbType, text string, start int) (int, bool) {
	if start >= len(text) {
		return start, false
	}
	if end, ok := sqlOracleAlternativeQuoteEnd(dbType, text, start); ok {
		return end, true
	}
	if supportsProjectionDollarQuote(dbType) {
		if tag := sqlDollarQuoteTag(text, start); tag != "" {
			if offset := strings.Index(text[start+len(tag):], tag); offset >= 0 {
				return start + len(tag) + offset + len(tag), true
			}
			return len(text), true
		}
	}
	opener := text[start]
	if opener != '\'' && opener != '"' && opener != '`' && opener != '[' {
		return start, false
	}
	closer := opener
	if opener == '[' {
		closer = ']'
	}
	for index := start + 1; index < len(text); index++ {
		if text[index] == '\\' && sqlBackslashEscapesQuote(dbType, text, start, opener) && index+1 < len(text) {
			index++
			continue
		}
		if text[index] != closer {
			continue
		}
		if index+1 < len(text) && text[index+1] == closer {
			index++
			continue
		}
		return index + 1, true
	}
	return len(text), true
}

func sqlOracleAlternativeQuoteEnd(dbType, text string, start int) (int, bool) {
	if !isOracleProjectionDialect(dbType) || start >= len(text) {
		return start, false
	}
	prefixLen := 0
	switch {
	case start+2 < len(text) && (text[start] == 'q' || text[start] == 'Q') && text[start+1] == '\'':
		prefixLen = 2
	case start+3 < len(text) && (text[start] == 'n' || text[start] == 'N') && (text[start+1] == 'q' || text[start+1] == 'Q') && text[start+2] == '\'':
		prefixLen = 3
	default:
		return start, false
	}
	if start > 0 {
		previous, _ := utf8.DecodeLastRuneInString(text[:start])
		if isSQLIdentifierRune(previous) {
			return start, false
		}
	}
	openerIndex := start + prefixLen
	opener, openerSize := utf8.DecodeRuneInString(text[openerIndex:])
	if opener == utf8.RuneError && openerSize == 0 {
		return start, false
	}
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
	case '\'', ' ', '\t', '\r', '\n':
		return start, false
	}
	for index := openerIndex + openerSize; index < len(text); {
		candidate, size := utf8.DecodeRuneInString(text[index:])
		if candidate == closer && index+size < len(text) && text[index+size] == '\'' {
			return index + size + 1, true
		}
		index += size
	}
	return len(text), true
}

func sqlBackslashEscapesQuote(dbType, text string, start int, opener byte) bool {
	if strings.HasSuffix(strings.ToLower(strings.TrimSpace(dbType)), "|no_backslash") {
		return false
	}
	dialect := projectionDialect(dbType)
	if isMySQLProjectionDialect(dialect) || dialect == "clickhouse" {
		return opener != '['
	}
	if supportsProjectionDollarQuote(dialect) && opener == '\'' && start > 0 && (text[start-1] == 'E' || text[start-1] == 'e') {
		if start == 1 {
			return true
		}
		previous, _ := utf8.DecodeLastRuneInString(text[:start-1])
		return !isSQLIdentifierRune(previous)
	}
	return false
}

func supportsProjectionDollarQuote(dbType string) bool {
	switch projectionDialect(dbType) {
	case "postgres", "postgresql", "pg", "pq", "pgx", "opengauss", "open_gauss", "open-gauss", "gaussdb", "gauss_db", "kingbase", "kingbase8", "kingbasees", "kingbasev8", "highgo", "vastbase":
		return true
	default:
		return false
	}
}

func sqlDollarQuoteTag(text string, start int) string {
	if start >= len(text) || text[start] != '$' {
		return ""
	}
	if start > 0 {
		previous, _ := utf8.DecodeLastRuneInString(text[:start])
		if isSQLIdentifierRune(previous) {
			return ""
		}
	}
	for index := start + 1; index < len(text); index++ {
		if text[index] == '$' {
			return text[start : index+1]
		}
		r := rune(text[index])
		if index == start+1 && unicode.IsDigit(r) {
			return ""
		}
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_') {
			return ""
		}
	}
	return ""
}

func sqlKeywordAt(text string, index int, keyword string) bool {
	if index < 0 || index+len(keyword) > len(text) || !strings.EqualFold(text[index:index+len(keyword)], keyword) {
		return false
	}
	if index > 0 {
		r, _ := utf8.DecodeLastRuneInString(text[:index])
		if isSQLIdentifierRune(r) {
			return false
		}
	}
	if index+len(keyword) < len(text) {
		r, _ := utf8.DecodeRuneInString(text[index+len(keyword):])
		if isSQLIdentifierRune(r) {
			return false
		}
	}
	return true
}

func isSQLIdentifierRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '$' || r == '#' || r == '@'
}

func isMySQLProjectionDialect(dialect string) bool {
	switch projectionDialect(dialect) {
	case "mysql", "mariadb", "oceanbase", "diros", "doris", "starrocks", "goldendb", "greatdb", "gdb", "sphinx", "tidb":
		return true
	default:
		return false
	}
}

func isSQLServerProjectionDialect(dialect string) bool {
	switch projectionDialect(dialect) {
	case "sqlserver", "mssql":
		return true
	default:
		return false
	}
}

func isOracleProjectionDialect(dialect string) bool {
	switch projectionDialect(dialect) {
	case "oracle", "dm", "dameng":
		return true
	default:
		return false
	}
}

func projectionDialect(dbType string) string {
	dialect := strings.ToLower(strings.TrimSpace(dbType))
	if separator := strings.IndexByte(dialect, '|'); separator >= 0 {
		dialect = dialect[:separator]
	}
	return dialect
}

func isSQLLineCommentStart(dbType, text string, index int) bool {
	if !isMySQLProjectionDialect(dbType) {
		return true
	}
	after := index + 2
	if after >= len(text) {
		return true
	}
	return unicode.IsSpace(rune(text[after])) || text[after] < 0x20
}
