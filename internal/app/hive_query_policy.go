package app

import "strings"

// hiveQueryMayRunExternalCode rejects Hive's script and Java-reflection escape
// hatches on protected connections, even when their leading keyword is SELECT.
// Hive strings escape with backslashes; MySQL hash comments and PG dollar quotes
// must not hide executable Hive tokens from this check.
func hiveQueryMayRunExternalCode(query string) bool {
	// Hive expands variables before SQL parsing, including inside quotes. A
	// protected connection cannot prove what a server-side variable executes.
	if strings.Contains(query, "${") {
		return true
	}
	transform, using := false, false
	for pos := 0; pos < len(query); {
		if strings.HasPrefix(query[pos:], "--") {
			end := strings.IndexByte(query[pos:], '\n')
			if end < 0 {
				break
			}
			pos += end + 1
			continue
		}
		if strings.HasPrefix(query[pos:], "/*") {
			end := strings.Index(query[pos+2:], "*/")
			if end < 0 {
				break
			}
			pos += end + 4
			continue
		}
		if query[pos] == '\'' || query[pos] == '"' || query[pos] == 96 {
			pos = skipHivePolicyQuote(query, pos)
			continue
		}
		if !isSQLKeywordByte(query[pos]) {
			pos++
			continue
		}
		end := pos + 1
		for end < len(query) && isSQLKeywordByte(query[end]) {
			end++
		}
		switch strings.ToLower(query[pos:end]) {
		case "reflect", "reflect2", "java_method":
			return true
		case "transform", "map", "reduce":
			transform = true
		case "using":
			using = true
		}
		pos = end
	}
	return transform && using
}

func isHiveSettingReadQuery(query string) bool {
	keyword, end := nextSQLKeyword(query, 0)
	if keyword != "set" {
		return false
	}
	// Hive SET without an assignment returns settings as a result set. The
	// supported read forms contain no strings, comments or statement separators.
	argument := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(query[end:]), ";"))
	if argument == "" || argument == "-v" {
		return true
	}
	for _, character := range argument {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || strings.ContainsRune("_.:-", character)) {
			return false
		}
	}
	return true
}

func skipHivePolicyQuote(query string, pos int) int {
	delimiter := query[pos]
	for pos++; pos < len(query); pos++ {
		if delimiter != 96 && query[pos] == '\\' {
			pos++
			continue
		}
		if query[pos] == delimiter {
			if pos+1 < len(query) && query[pos+1] == delimiter {
				pos++
				continue
			}
			return pos + 1
		}
	}
	return len(query)
}
