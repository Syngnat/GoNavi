package hivesql

import "strings"

// ExplicitResultTypeCasts returns one type per SELECT projection position. An
// empty entry has no proved cast. Wildcards and set operations are not inferred.
func ExplicitResultTypeCasts(query string) ([]string, bool) {
	if ValidateReadOnlySourceQuery(query) != nil {
		return nil, false
	}
	tokens, err := sourceQueryTokens(query)
	if err != nil {
		return nil, false
	}
	if len(tokens) > 0 && sourceIsSymbol(tokens[len(tokens)-1], ";") {
		tokens = tokens[:len(tokens)-1]
	}
	start, ok := sourceMainSelect(tokens)
	if !ok {
		return nil, false
	}
	start++
	if start < len(tokens) && (sourceIsWord(tokens[start], "DISTINCT") || sourceIsWord(tokens[start], "ALL")) {
		start++
	}
	end := len(tokens)
	depth := 0
	for i := start; i < len(tokens); i++ {
		token := tokens[i]
		if sourceIsSymbol(token, "(") {
			depth++
		}
		if sourceIsSymbol(token, ")") {
			depth--
		}
		if depth == 0 && token.kind == sourceWord {
			if token.value == "UNION" || token.value == "INTERSECT" || token.value == "EXCEPT" {
				return nil, false
			}
			if end == len(tokens) && (token.value == "FROM" || sourceTailWord(token)) {
				end = i
			}
		}
	}
	var result []string
	found := false
	termStart := start
	depth = 0
	for pos := start; pos <= end; pos++ {
		if pos < end {
			if sourceIsSymbol(tokens[pos], "(") {
				depth++
			}
			if sourceIsSymbol(tokens[pos], ")") {
				depth--
			}
			if !sourceIsSymbol(tokens[pos], ",") || depth != 0 {
				continue
			}
		}
		term := tokens[termStart:pos]
		if len(term) == 0 {
			return nil, false
		}
		if len(term) == 1 && sourceIsSymbol(term[0], "*") || len(term) == 3 && sourceIsSymbol(term[1], ".") && sourceIsSymbol(term[2], "*") {
			return nil, false
		}
		typ := sourceTopLevelCast(term)
		result = append(result, typ)
		found = found || typ != ""
		termStart = pos + 1
	}
	return result, found
}
func sourceMainSelect(tokens []sourceToken) (int, bool) {
	if len(tokens) == 0 {
		return 0, false
	}
	if sourceIsWord(tokens[0], "SELECT") {
		return 0, true
	}
	if !sourceIsWord(tokens[0], "WITH") {
		return 0, false
	}
	pos := 1
	for pos < len(tokens) {
		if !sourceIdentifier(tokens[pos]) {
			return 0, false
		}
		pos++
		if pos < len(tokens) && sourceIsSymbol(tokens[pos], "(") {
			end, err := sourceClosingParen(tokens, pos)
			if err != nil {
				return 0, false
			}
			pos = end + 1
		}
		if pos >= len(tokens) || !sourceIsWord(tokens[pos], "AS") {
			return 0, false
		}
		pos++
		if pos >= len(tokens) || !sourceIsSymbol(tokens[pos], "(") {
			return 0, false
		}
		end, err := sourceClosingParen(tokens, pos)
		if err != nil {
			return 0, false
		}
		pos = end + 1
		if pos < len(tokens) && sourceIsSymbol(tokens[pos], ",") {
			pos++
			continue
		}
		return pos, pos < len(tokens) && sourceIsWord(tokens[pos], "SELECT")
	}
	return 0, false
}
func sourceTopLevelCast(term []sourceToken) string {
	if len(term) < 7 || !sourceIsWord(term[0], "CAST") || !sourceIsSymbol(term[1], "(") {
		return ""
	}
	end, err := sourceClosingParen(term, 1)
	if err != nil || end+3 != len(term) || !sourceIsWord(term[end+1], "AS") || !sourceIdentifier(term[end+2]) {
		return ""
	}
	depth := 0
	as := -1
	for i := 2; i < end; i++ {
		if sourceIsSymbol(term[i], "(") {
			depth++
		}
		if sourceIsSymbol(term[i], ")") {
			depth--
		}
		if depth == 0 && sourceIsWord(term[i], "AS") {
			as = i
		}
	}
	if as < 3 || as+1 >= end {
		return ""
	}
	parts := make([]string, 0, end-as-1)
	for _, token := range term[as+1 : end] {
		if token.kind == sourceQuotedIdentifier {
			parts = append(parts, QuoteIdentifier(token.value))
		} else {
			parts = append(parts, token.value)
		}
	}
	normalized, err := NormalizeType(strings.Join(parts, " "))
	if err != nil {
		return ""
	}
	return normalized
}
