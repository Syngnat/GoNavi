package hivesql

import (
	"fmt"
	"strings"
)

// PartitionColumnsFromDDL reads a native PARTITIONED BY declaration without
// treating table properties, comments or nested type commas as column boundaries.
func PartitionColumnsFromDDL(ddl string) ([]string, error) {
	tokens, err := sourceQueryTokens(ddl)
	if err != nil {
		return nil, err
	}
	for i := 0; i+2 < len(tokens); i++ {
		if !sourceIsWord(tokens[i], "PARTITIONED") || !sourceIsWord(tokens[i+1], "BY") || !sourceIsSymbol(tokens[i+2], "(") {
			continue
		}
		end, err := sourceClosingParen(tokens, i+2)
		if err != nil {
			return nil, err
		}
		return sourcePartitionNames(tokens[i+3 : end])
	}
	return nil, nil
}
func sourcePartitionNames(tokens []sourceToken) ([]string, error) {
	var names []string
	for start := 0; start < len(tokens); {
		if !sourceIdentifier(tokens[start]) {
			return nil, fmt.Errorf("invalid Hive partition column identity")
		}
		name := sourceIdentifierName(tokens[start])
		pos := start + 1
		angle, paren := 0, 0
		typeEnd := -1
		for pos < len(tokens) {
			token := tokens[pos]
			if angle == 0 && paren == 0 {
				if sourceIsSymbol(token, ",") {
					break
				}
				if sourceIsWord(token, "COMMENT") && typeEnd < 0 {
					typeEnd = pos
				}
			}
			switch token.value {
			case "<":
				angle++
			case ">":
				angle--
			case "(":
				paren++
			case ")":
				paren--
			}
			if angle < 0 || paren < 0 {
				return nil, fmt.Errorf("unbalanced Hive partition type")
			}
			pos++
		}
		if typeEnd < 0 {
			typeEnd = pos
		}
		if typeEnd <= start+1 || angle != 0 || paren != 0 {
			return nil, fmt.Errorf("missing Hive partition type")
		}
		parts := make([]string, 0, typeEnd-start-1)
		for _, token := range tokens[start+1 : typeEnd] {
			if token.kind == sourceQuotedIdentifier {
				parts = append(parts, QuoteIdentifier(token.value))
			} else {
				parts = append(parts, token.value)
			}
		}
		if _, err := ParseType(strings.Join(parts, " ")); err != nil {
			return nil, err
		}
		names = append(names, name)
		if pos == len(tokens) {
			return names, nil
		}
		start = pos + 1
		if start == len(tokens) {
			return nil, fmt.Errorf("empty Hive partition definition")
		}
	}
	return nil, fmt.Errorf("empty Hive partition declaration")
}
