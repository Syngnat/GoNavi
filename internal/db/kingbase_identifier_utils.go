package db

import (
	"regexp"
	"strings"
)

func normalizeKingbaseIdentCommon(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}

	// 兼容被多次 JSON 序列化后的转义引号：
	// \\\"schema\\\" -> \"schema\" -> "schema"
	for i := 0; i < 8; i++ {
		next := strings.TrimSpace(value)
		next = strings.ReplaceAll(next, `\\\"`, `\"`)
		next = strings.ReplaceAll(next, `\"`, `"`)
		if next == value {
			break
		}
		value = next
	}
	value = strings.TrimSpace(value)

	stripWrapperOnce := func(text string) string {
		t := strings.TrimSpace(text)
		if strings.HasPrefix(t, `\`) && len(t) > 1 {
			t = strings.TrimSpace(strings.TrimPrefix(t, `\`))
		}
		if strings.HasSuffix(t, `\`) && len(t) > 1 {
			t = strings.TrimSpace(strings.TrimSuffix(t, `\`))
		}
		if len(t) >= 4 && strings.HasPrefix(t, `\"`) && strings.HasSuffix(t, `\"`) {
			return strings.TrimSpace(t[2 : len(t)-2])
		}
		if len(t) >= 2 && strings.HasPrefix(t, `"`) && strings.HasSuffix(t, `"`) {
			return strings.TrimSpace(t[1 : len(t)-1])
		}
		if len(t) >= 2 && strings.HasPrefix(t, "`") && strings.HasSuffix(t, "`") {
			return strings.TrimSpace(t[1 : len(t)-1])
		}
		if len(t) >= 2 && strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			return strings.TrimSpace(t[1 : len(t)-1])
		}
		return t
	}

	for i := 0; i < 8; i++ {
		next := stripWrapperOnce(value)
		if next == value {
			break
		}
		value = next
	}
	value = strings.TrimSpace(value)

	// 兼容错误的二次引用与残留反斜杠。
	value = strings.ReplaceAll(value, `\"`, `"`)
	value = strings.ReplaceAll(value, `""`, "")
	value = strings.TrimSpace(value)

	for i := 0; i < 8; i++ {
		next := strings.TrimSpace(value)
		changed := false
		if strings.HasPrefix(next, `\`) && len(next) > 1 {
			next = strings.TrimSpace(strings.TrimPrefix(next, `\`))
			changed = true
		}
		if strings.HasSuffix(next, `\`) && len(next) > 1 {
			next = strings.TrimSpace(strings.TrimSuffix(next, `\`))
			changed = true
		}
		if !changed || next == value {
			break
		}
		value = next
	}

	return strings.TrimSpace(value)
}

// NormalizeKingbaseIdentifier removes nested client-side quoting from a Kingbase identifier.
func NormalizeKingbaseIdentifier(raw string) string {
	return normalizeKingbaseIdentCommon(raw)
}

func normalizeKingbaseIdentifier(raw string) string {
	return normalizeKingbaseIdentCommon(raw)
}

// QuoteKingbaseIdentifier quotes a Kingbase identifier only when the dialect requires it.
func QuoteKingbaseIdentifier(raw string) string {
	return quoteKingbaseIdent(raw)
}

// kingbaseIdentNeedsQuote 判断标识符是否需要双引号包裹。
// 与前端 sql.ts 中 needsQuote 逻辑保持一致。
func kingbaseIdentNeedsQuote(ident string) bool {
	if ident == "" {
		return false
	}
	// 不是合法裸标识符格式（必须以字母或下划线开头，仅含字母、数字、下划线）
	if matched, _ := regexp.MatchString(`^[a-zA-Z_][a-zA-Z0-9_]*$`, ident); !matched {
		return true
	}
	// 包含大写字母时需要引号保护（KingbaseES/PostgreSQL 默认将未加引号的标识符折叠为小写）
	for _, r := range ident {
		if r >= 'A' && r <= 'Z' {
			return true
		}
	}
	// 是 SQL 保留字
	return isKingbaseReservedWord(ident)
}

// isKingbaseReservedWord 检查是否为常见 SQL 保留字（简化版，与前端保持一致）。
func isKingbaseReservedWord(ident string) bool {
	switch strings.ToLower(ident) {
	case "select", "from", "where", "table", "index", "user", "order", "group", "by",
		"limit", "offset", "and", "or", "not", "null", "true", "false", "key",
		"primary", "foreign", "references", "default", "constraint",
		"create", "drop", "alter", "insert", "update", "delete", "set", "values", "into",
		"join", "left", "right", "inner", "outer", "on", "as", "is", "in", "like",
		"between", "case", "when", "then", "else", "end", "having", "distinct",
		"all", "any", "exists", "union", "except", "intersect",
		"column", "check", "unique", "with", "grant", "revoke", "trigger",
		"begin", "commit", "rollback", "schema", "database", "view", "function",
		"procedure", "sequence", "type", "domain", "role", "session", "current",
		"authorization", "cross", "full", "natural", "some", "cast", "fetch",
		"for", "to", "do", "if", "return", "returns", "declare", "cursor", "server", "owner":
		return true
	}
	return false
}

func quoteKingbaseIdent(name string) string {
	n := normalizeKingbaseIdentCommon(name)
	if n == "" {
		return "\"\""
	}
	if !kingbaseIdentNeedsQuote(n) {
		return n
	}
	n = strings.ReplaceAll(n, `"`, `""`)
	return `"` + n + `"`
}

// SplitKingbaseQualifiedName splits a Kingbase schema-qualified identifier safely.
func SplitKingbaseQualifiedName(raw string) (schema string, table string) {
	return splitKingbaseQualifiedNameCommon(raw)
}

// SplitSQLQualifiedName splits a schema-qualified SQL identifier without splitting dots inside quotes.
func SplitSQLQualifiedName(raw string) (schema string, table string) {
	return splitSQLQualifiedNameCommon(raw)
}

// SplitSQLQualifiedNameForDialect splits a two-part identifier using only the
// delimiter syntax supported by dbType. It retains the legacy first-dot split
// contract while applying the bracket-escape rule of the requested dialect.
func SplitSQLQualifiedNameForDialect(raw, dbType string) (schema string, table string) {
	text := normalizeSQLIdentifierEscapes(strings.TrimSpace(raw))
	if text == "" {
		return "", ""
	}
	bracketIdentifiers := supportsSQLBracketIdentifierDialect(dbType)
	escapedBracketIdentifiers := supportsSQLEscapedBracketIdentifierDialect(dbType)
	sep := findSQLQualifiedSeparatorWithBracketMode(text, bracketIdentifiers, escapedBracketIdentifiers)
	if sep < 0 {
		return "", normalizeSQLIdentPartWithBracketMode(text, bracketIdentifiers, escapedBracketIdentifiers)
	}

	schemaPart := normalizeSQLIdentPartWithBracketMode(text[:sep], bracketIdentifiers, escapedBracketIdentifiers)
	tablePart := normalizeSQLIdentPartWithBracketMode(text[sep+1:], bracketIdentifiers, escapedBracketIdentifiers)
	if tablePart == "" {
		if schemaPart == "" {
			return "", normalizeSQLIdentPartWithBracketMode(text, bracketIdentifiers, escapedBracketIdentifiers)
		}
		return "", schemaPart
	}
	if schemaPart == "" {
		return "", tablePart
	}
	return schemaPart, tablePart
}

// SQLIdentifierPathSegment is one quote-aware component of a qualified SQL
// identifier. Raw retains the original delimiter so callers that need to
// round-trip metadata can distinguish a dotted literal from a qualified path;
// Value is the logical identifier text with one layer of SQL quoting removed.
type SQLIdentifierPathSegment struct {
	Raw    string
	Value  string
	Quoted bool
}

// SplitSQLIdentifierPath splits a qualified identifier at dots outside SQL
// identifier delimiters. It preserves the historical generic behavior, which
// accepts all common delimiters for callers without a known database dialect.
func SplitSQLIdentifierPath(raw string) []SQLIdentifierPathSegment {
	return splitSQLIdentifierPath(raw, true, true)
}

// SplitSQLIdentifierPathForDialect applies only the delimiters supported by
// the target dialect. SQL Server escapes a closing bracket as ]], while SQLite
// closes at the first ]; other dialects treat [] as ordinary identifier text.
func SplitSQLIdentifierPathForDialect(raw, dbType string) []SQLIdentifierPathSegment {
	return splitSQLIdentifierPath(
		raw,
		supportsSQLBracketIdentifierDialect(dbType),
		supportsSQLEscapedBracketIdentifierDialect(dbType),
	)
}

func splitSQLIdentifierPath(raw string, bracketIdentifiers bool, escapedBracketIdentifiers bool) []SQLIdentifierPathSegment {
	text := normalizeSQLIdentifierEscapes(strings.TrimSpace(raw))
	if text == "" {
		return nil
	}

	segments := make([]SQLIdentifierPathSegment, 0, 3)
	current := strings.Builder{}
	quote := byte(0)
	closingQuote := byte(0)
	flush := func() {
		segmentRaw := strings.TrimSpace(current.String())
		current.Reset()
		if segmentRaw == "" {
			return
		}
		segments = append(segments, SQLIdentifierPathSegment{
			Raw:    segmentRaw,
			Value:  normalizeSQLIdentPartWithBracketMode(segmentRaw, bracketIdentifiers, escapedBracketIdentifiers),
			Quoted: isSQLDelimitedIdentifierWithBracketMode(segmentRaw, bracketIdentifiers, escapedBracketIdentifiers),
		})
	}

	for index := 0; index < len(text); index++ {
		ch := text[index]
		if quote != 0 {
			current.WriteByte(ch)
			if ch == closingQuote {
				if index+1 < len(text) && text[index+1] == closingQuote && (closingQuote != ']' || escapedBracketIdentifiers) {
					current.WriteByte(text[index+1])
					index++
					continue
				}
				quote = 0
				closingQuote = 0
			}
			continue
		}

		switch ch {
		case '"', '`':
			quote = ch
			closingQuote = ch
			current.WriteByte(ch)
		case '[':
			if !bracketIdentifiers {
				current.WriteByte(ch)
				continue
			}
			quote = ch
			closingQuote = ']'
			current.WriteByte(ch)
		case '.':
			flush()
		default:
			current.WriteByte(ch)
		}
	}
	flush()
	return segments
}

// SplitSQLQualifiedNamePreserveTableQuote splits a SQL identifier like
// SplitSQLQualifiedName, but keeps the original delimiter around the final
// segment when that segment is quoted. Callers that need to parse the name a
// second time (for example MySQL's database.table helpers) can therefore tell
// `order.items` (one table) from order.items (schema + table).
func SplitSQLQualifiedNamePreserveTableQuote(raw string) (schema string, table string) {
	return splitSQLQualifiedNamePreserveTableQuote(raw, true, true)
}

// SplitSQLQualifiedNamePreserveTableQuoteForDialect keeps quoted final table
// segments only for delimiters valid in dbType. Use it whenever the caller
// already knows the target engine so SQL Server bracket syntax cannot leak
// into other dialects.
func SplitSQLQualifiedNamePreserveTableQuoteForDialect(raw, dbType string) (schema string, table string) {
	return splitSQLQualifiedNamePreserveTableQuote(
		raw,
		supportsSQLBracketIdentifierDialect(dbType),
		supportsSQLEscapedBracketIdentifierDialect(dbType),
	)
}

func splitSQLQualifiedNamePreserveTableQuote(raw string, bracketIdentifiers bool, escapedBracketIdentifiers bool) (schema string, table string) {
	text := normalizeSQLIdentifierEscapes(strings.TrimSpace(raw))
	if text == "" {
		return "", ""
	}
	segments := splitSQLIdentifierPath(text, bracketIdentifiers, escapedBracketIdentifiers)
	if len(segments) == 0 {
		return "", ""
	}
	if len(segments) == 1 {
		segment := segments[0]
		if segment.Quoted && strings.Contains(segment.Value, ".") {
			return "", segment.Raw
		}
		return "", segment.Value
	}

	schemaParts := make([]string, 0, len(segments)-1)
	for _, segment := range segments[:len(segments)-1] {
		schemaParts = append(schemaParts, segment.Value)
	}
	schema = strings.Join(schemaParts, ".")
	last := segments[len(segments)-1]
	if last.Quoted {
		// Preserve the delimiter only when it carries a dot that a later
		// metadata helper could otherwise mistake for another qualification
		// level. Simple quoted names can keep the historical bare value.
		if strings.Contains(last.Value, ".") {
			return schema, last.Raw
		}
	}
	return schema, last.Value
}

// IsSQLDelimitedIdentifierForDialect reports whether value is one complete
// delimited identifier using only the syntax supported by dbType.
func IsSQLDelimitedIdentifierForDialect(value, dbType string) bool {
	segments := SplitSQLIdentifierPathForDialect(value, dbType)
	return len(segments) == 1 && segments[0].Quoted
}

func supportsSQLBracketIdentifierDialect(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "sqlserver", "mssql", "sql_server", "sql-server", "sqlite":
		return true
	default:
		return false
	}
}

func supportsSQLEscapedBracketIdentifierDialect(dbType string) bool {
	switch strings.ToLower(strings.TrimSpace(dbType)) {
	case "sqlserver", "mssql", "sql_server", "sql-server":
		return true
	default:
		return false
	}
}

// NormalizeSQLiteSchemaAndTable preserves dotted SQLite table names while
// still recognizing an explicit attached-database prefix. The second form
// handles the frontend's legacy `prefix.[prefix.name]` shape, where the
// prefix came from mistakenly splitting a literal catalog name as schema.
func NormalizeSQLiteSchemaAndTable(dbName, raw string) (schema string, table string) {
	rawDB := strings.TrimSpace(dbName)
	text := strings.TrimSpace(raw)
	if text == "" {
		return rawDB, ""
	}

	segments := SplitSQLIdentifierPathForDialect(text, "sqlite")
	if len(segments) == 0 {
		return rawDB, ""
	}
	knownDatabase := func(value string) bool {
		return strings.EqualFold(strings.TrimSpace(value), rawDB) ||
			strings.EqualFold(strings.TrimSpace(value), "main") ||
			strings.EqualFold(strings.TrimSpace(value), "temp")
	}
	if len(segments) >= 2 && knownDatabase(segments[0].Value) {
		parts := make([]string, 0, len(segments)-1)
		for _, segment := range segments[1:] {
			if value := strings.TrimSpace(segment.Value); value != "" {
				parts = append(parts, value)
			}
		}
		return strings.TrimSpace(segments[0].Value), strings.Join(parts, ".")
	}

	if len(segments) == 2 && segments[1].Quoted {
		first := strings.TrimSpace(segments[0].Value)
		last := strings.TrimSpace(segments[1].Value)
		literalPrefix := strings.TrimSpace(strings.SplitN(last, ".", 2)[0])
		if first != "" && literalPrefix != "" && strings.EqualFold(first, literalPrefix) {
			return rawDB, last
		}
	}

	if len(segments) == 1 {
		return rawDB, strings.TrimSpace(segments[0].Value)
	}
	return rawDB, text
}

func isSQLDelimitedIdentifier(value string) bool {
	return isSQLDelimitedIdentifierWithBracketMode(value, true, true)
}

func isSQLDelimitedIdentifierWithBracketMode(value string, bracketIdentifiers bool, escapedBracketIdentifiers bool) bool {
	text := strings.TrimSpace(value)
	if len(text) < 2 {
		return false
	}
	first := text[0]
	last := text[len(text)-1]
	delimited := (first == '"' && last == '"') ||
		(first == '`' && last == '`') ||
		(bracketIdentifiers && first == '[' && last == ']')
	return delimited && findSQLQualifiedSeparatorWithBracketMode(text, bracketIdentifiers, escapedBracketIdentifiers) < 0
}

// IsSQLDelimitedIdentifier reports whether value is one complete SQL
// delimited identifier. It is exported for app-layer context normalization;
// callers still use SplitSQLQualifiedName for the actual unquoting.
func IsSQLDelimitedIdentifier(value string) bool {
	return isSQLDelimitedIdentifier(value)
}

func splitKingbaseQualifiedNameCommon(raw string) (schema string, table string) {
	text := strings.TrimSpace(raw)
	if text == "" {
		return "", ""
	}

	sep := findKingbaseQualifiedSeparator(text)
	if sep < 0 {
		return "", normalizeKingbaseIdentCommon(text)
	}

	schemaPart := normalizeKingbaseIdentCommon(text[:sep])
	tablePart := normalizeKingbaseIdentCommon(text[sep+1:])

	if tablePart == "" {
		if schemaPart == "" {
			return "", normalizeKingbaseIdentCommon(text)
		}
		return "", schemaPart
	}
	if schemaPart == "" {
		return "", tablePart
	}
	return schemaPart, tablePart
}

func splitSQLQualifiedNameCommon(raw string) (schema string, table string) {
	text := normalizeSQLIdentifierEscapes(strings.TrimSpace(raw))
	if text == "" {
		return "", ""
	}

	sep := findSQLQualifiedSeparator(text)
	if sep < 0 {
		return "", normalizeSQLIdentPartCommon(text)
	}

	schemaPart := normalizeSQLIdentPartCommon(text[:sep])
	tablePart := normalizeSQLIdentPartCommon(text[sep+1:])

	if tablePart == "" {
		if schemaPart == "" {
			return "", normalizeSQLIdentPartCommon(text)
		}
		return "", schemaPart
	}
	if schemaPart == "" {
		return "", tablePart
	}
	return schemaPart, tablePart
}

func normalizeSQLIdentifierEscapes(raw string) string {
	value := strings.TrimSpace(raw)
	for i := 0; i < 4; i++ {
		next := strings.TrimSpace(value)
		next = strings.ReplaceAll(next, `\\\"`, `\"`)
		next = strings.ReplaceAll(next, `\"`, `"`)
		if next == value {
			break
		}
		value = next
	}
	return strings.TrimSpace(value)
}

func normalizeSQLIdentPartCommon(raw string) string {
	return normalizeSQLIdentPartWithBracketMode(raw, true, true)
}

func normalizeSQLIdentPartWithBracketMode(raw string, bracketIdentifiers bool, escapedBracketIdentifiers bool) string {
	value := normalizeSQLIdentifierEscapes(strings.TrimSpace(raw))
	if value == "" {
		return ""
	}
	if len(value) >= 2 {
		first := value[0]
		last := value[len(value)-1]
		switch {
		case first == '"' && last == '"':
			return strings.ReplaceAll(value[1:len(value)-1], `""`, `"`)
		case first == '`' && last == '`':
			return strings.ReplaceAll(value[1:len(value)-1], "``", "`")
		case bracketIdentifiers && first == '[' && last == ']':
			inner := value[1 : len(value)-1]
			if escapedBracketIdentifiers {
				return strings.ReplaceAll(inner, "]]", "]")
			}
			return inner
		}
	}
	return value
}

func findSQLQualifiedSeparator(raw string) int {
	return findSQLQualifiedSeparatorWithBracketMode(raw, true, true)
}

func findSQLQualifiedSeparatorWithBracketMode(raw string, bracketIdentifiers bool, escapedBracketIdentifiers bool) int {
	inDouble := false
	inBacktick := false
	inBracket := false

	for i := 0; i < len(raw); i++ {
		ch := raw[i]

		if inDouble {
			if ch == '\\' && i+1 < len(raw) && raw[i+1] == '"' {
				inDouble = false
				i++
				continue
			}
			if ch == '"' {
				if i+1 < len(raw) && raw[i+1] == '"' {
					i++
					continue
				}
				inDouble = false
			}
			continue
		}

		if inBacktick {
			if ch == '`' && i+1 < len(raw) && raw[i+1] == '`' {
				i++
				continue
			}
			if ch == '`' {
				inBacktick = false
			}
			continue
		}

		if inBracket {
			if escapedBracketIdentifiers && ch == ']' && i+1 < len(raw) && raw[i+1] == ']' {
				i++
				continue
			}
			if ch == ']' {
				inBracket = false
			}
			continue
		}

		switch ch {
		case '\\':
			if i+1 < len(raw) && raw[i+1] == '"' {
				inDouble = true
				i++
			}
		case '"':
			inDouble = true
		case '`':
			inBacktick = true
		case '[':
			if !bracketIdentifiers {
				continue
			}
			inBracket = true
		case '.':
			return i
		}
	}

	return -1
}

func findKingbaseQualifiedSeparator(raw string) int {
	inDouble := false
	inBacktick := false
	inBracket := false
	escaped := false

	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		if escaped {
			escaped = false
			continue
		}

		if ch == '\\' {
			escaped = true
			continue
		}

		if inDouble {
			if ch == '"' {
				// SQL 双引号转义："" 代表字面量 "
				if i+1 < len(raw) && raw[i+1] == '"' {
					i++
					continue
				}
				inDouble = false
			}
			continue
		}

		if inBacktick {
			if ch == '`' {
				inBacktick = false
			}
			continue
		}

		if inBracket {
			if ch == ']' {
				inBracket = false
			}
			continue
		}

		switch ch {
		case '"':
			inDouble = true
		case '`':
			inBacktick = true
		case '[':
			inBracket = true
		case '.':
			return i
		}
	}

	return -1
}

// buildKingbaseSearchPathCommon 统一构建 Kingbase search_path。
// 返回 search_path SQL 片段和规范化后的 schema 列表（用于调试/扩展）。
func buildKingbaseSearchPathCommon(rawSchemas []string) (string, []string) {
	if len(rawSchemas) == 0 {
		return "", nil
	}

	seen := make(map[string]struct{}, len(rawSchemas)+1)
	quotedParts := make([]string, 0, len(rawSchemas)+1)
	normalizedSchemas := make([]string, 0, len(rawSchemas)+1)

	appendSchema := func(raw string) {
		cleaned := normalizeKingbaseIdentCommon(raw)
		if cleaned == "" {
			return
		}
		if strings.EqualFold(cleaned, "public") {
			cleaned = "public"
		}
		key := strings.ToLower(cleaned)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		normalizedSchemas = append(normalizedSchemas, cleaned)
		escaped := strings.ReplaceAll(cleaned, `"`, `""`)
		quotedParts = append(quotedParts, `"`+escaped+`"`)
	}

	for _, raw := range rawSchemas {
		appendSchema(raw)
	}
	if _, ok := seen["public"]; !ok {
		appendSchema("public")
	}

	if len(quotedParts) == 0 {
		return "", normalizedSchemas
	}
	return strings.Join(quotedParts, ", "), normalizedSchemas
}
