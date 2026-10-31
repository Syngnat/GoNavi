package hivesql

import (
	"fmt"
	"strings"
)

// EnforcedNotNullColumns reads native Hive CREATE/ALTER constraint output.
// Hive JDBC NULLABLE can be hard-coded YES, so it is not authoritative here.
func EnforcedNotNullColumns(ddl string) (map[string]bool, error) {
	tokens, err := sourceQueryTokens(ddl)
	if err != nil {
		return nil, err
	}
	result := map[string]bool{}
	for i := 0; i < len(tokens); i++ {
		if sourceIsWord(tokens[i], "CREATE") {
			table := i + 1
			for table < len(tokens) && !sourceIsWord(tokens[table], "TABLE") && !sourceIsSymbol(tokens[table], ";") {
				table++
			}
			if table >= len(tokens) || !sourceIsWord(tokens[table], "TABLE") {
				continue
			}
			_, pos, ok := sourceQualifiedIdentifiers(tokens, table+1)
			if !ok || pos >= len(tokens) || !sourceIsSymbol(tokens[pos], "(") {
				continue
			}
			end, err := sourceClosingParen(tokens, pos)
			if err != nil {
				return nil, err
			}
			sourceInlineNotNull(tokens[pos+1:end], result)
			i = end
			continue
		}
		if !sourceIsWord(tokens[i], "ALTER") {
			continue
		}
		end := i + 1
		for end < len(tokens) && !sourceIsSymbol(tokens[end], ";") {
			end++
		}
		for pos := i + 1; pos+3 < end; pos++ {
			if !sourceIsWord(tokens[pos], "CHANGE") || !sourceIsWord(tokens[pos+1], "COLUMN") || !sourceIdentifier(tokens[pos+2]) || !sourceIdentifier(tokens[pos+3]) {
				continue
			}
			name := sourceIdentifierName(tokens[pos+3])
			if sourceEnforcedNotNull(tokens[pos+4 : end]) {
				result[strings.ToLower(name)] = true
			}
			break
		}
		i = end
	}
	return result, nil
}
func sourceEnforcedNotNull(tokens []sourceToken) bool {
	found := false
	depth, angle := 0, 0
	for i, token := range tokens {
		if sourceIsSymbol(token, "(") {
			depth++
		}
		if sourceIsSymbol(token, ")") {
			depth--
		}
		if sourceIsSymbol(token, "<") {
			angle++
		}
		if sourceIsSymbol(token, ">") {
			angle--
		}
		if depth != 0 || angle != 0 || token.kind != sourceWord {
			continue
		}
		if token.value == "DISABLE" {
			return false
		}
		if token.value == "NOT" && i+1 < len(tokens) && sourceIsWord(tokens[i+1], "NULL") && (i == 0 || !sourceIsWord(tokens[i-1], "IS")) {
			found = true
		}
	}
	return found
}
func sourceInlineNotNull(tokens []sourceToken, result map[string]bool) {
	start, depth, angle := 0, 0, 0
	for i := 0; i <= len(tokens); i++ {
		if i < len(tokens) {
			if sourceIsSymbol(tokens[i], "(") {
				depth++
			}
			if sourceIsSymbol(tokens[i], ")") {
				depth--
			}
			if sourceIsSymbol(tokens[i], "<") {
				angle++
			}
			if sourceIsSymbol(tokens[i], ">") {
				angle--
			}
			if depth != 0 || angle != 0 || !sourceIsSymbol(tokens[i], ",") {
				continue
			}
		}
		part := tokens[start:i]
		if len(part) > 1 && sourceIdentifier(part[0]) && !sourceIsWord(part[0], "CONSTRAINT") && sourceEnforcedNotNull(part[1:]) {
			result[strings.ToLower(sourceIdentifierName(part[0]))] = true
		}
		start = i + 1
	}
}

// ValidateNotNullMetadata verifies named constraint evidence against native DDL.
func ValidateNotNullMetadata(names []string, ddl string) (map[string]bool, error) {
	enforced, err := EnforcedNotNullColumns(ddl)
	if err != nil {
		return nil, err
	}
	for _, name := range names {
		if !enforced[strings.ToLower(name)] {
			return nil, fmt.Errorf("Hive NOT NULL enforcement for column %q could not be verified", name)
		}
	}
	return enforced, nil
}
