package hivesql

import "strings"

// SourceColumn binds one direct source column to its explicit output alias.
type SourceColumn struct {
	Name  string
	Alias string
	Type  string
	// Opaque marks a scalar expression at this output position. Its value needs no
	// source members, but a complex type here still cannot be proven.
	Opaque bool
}

// SourceProjection proves a SELECT's output comes directly from one base table.
// It never takes types from a destination table or an unrelated result label.
type SourceProjection struct {
	Database string
	Table    string
	Alias    string
	Wildcard bool
	Columns  []SourceColumn
}

// DirectSourceProjection recognizes only simple base-table projections. Joins,
// CTEs, derived tables and complex expressions deliberately need explicit SQL.
func DirectSourceProjection(query string) (SourceProjection, bool) {
	if ValidateReadOnlySourceQuery(query) != nil {
		return SourceProjection{}, false
	}
	tokens, err := sourceQueryTokens(query)
	if err != nil {
		return SourceProjection{}, false
	}
	if len(tokens) > 0 && sourceIsSymbol(tokens[len(tokens)-1], ";") {
		tokens = tokens[:len(tokens)-1]
	}
	relation, ok := sourceRelationQuery(tokens, nil, make(map[*sourceCTE]bool), 0)
	if !ok {
		return SourceProjection{}, false
	}
	return sourceProjectionProof(relation)
}

func sourceTailWord(token sourceToken) bool {
	if token.kind != sourceWord {
		return false
	}
	switch token.value {
	case "WHERE", "GROUP", "HAVING", "ORDER", "SORT", "DISTRIBUTE", "CLUSTER", "LIMIT", "OFFSET":
		return true
	}
	return false
}
func sourceQualifiedIdentifiers(tokens []sourceToken, start int) ([]string, int, bool) {
	if start >= len(tokens) || !sourceIdentifier(tokens[start]) {
		return nil, start, false
	}
	parts := []string{sourceIdentifierName(tokens[start])}
	pos := start + 1
	for pos < len(tokens) && sourceIsSymbol(tokens[pos], ".") {
		pos++
		if pos >= len(tokens) || !sourceIdentifier(tokens[pos]) {
			return nil, pos, false
		}
		parts = append(parts, sourceIdentifierName(tokens[pos]))
		pos++
	}
	return parts, pos, true
}

// SelectedDatabase recognizes a literal USE statement for source-schema tracking.
func SelectedDatabase(query string) (string, bool) {
	tokens, err := sourceQueryTokens(query)
	if err != nil {
		return "", false
	}
	if len(tokens) > 0 && sourceIsSymbol(tokens[len(tokens)-1], ";") {
		tokens = tokens[:len(tokens)-1]
	}
	if len(tokens) == 2 && sourceIsWord(tokens[0], "USE") && sourceIdentifier(tokens[1]) {
		return sourceIdentifierName(tokens[1]), true
	}
	return "", false
}
func sourceIdentifierName(token sourceToken) string {
	if token.raw != "" {
		return token.raw
	}
	return token.value
}

// ChangesDatabase detects a leading USE even when its dynamic operand cannot
// be resolved. Drivers then require qualified source names instead of guessing.
func ChangesDatabase(query string) bool {
	for {
		query = strings.TrimSpace(query)
		if strings.HasPrefix(query, "--") {
			end := strings.IndexAny(query, "\r\n")
			if end < 0 {
				return false
			}
			query = query[end:]
			continue
		}
		if strings.HasPrefix(query, "/*") {
			end, err := sourceBlockComment(query, 0)
			if err != nil {
				return false
			}
			query = query[end:]
			continue
		}
		break
	}
	end := 0
	for end < len(query) && (query[end] >= 'a' && query[end] <= 'z' || query[end] >= 'A' && query[end] <= 'Z') {
		end++
	}
	return strings.EqualFold(query[:end], "USE")
}
