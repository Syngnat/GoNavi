package hivesql

import "strings"

type sourceFieldProof struct {
	output string
	column SourceColumn
	proved bool
	// complex marks an unproven item that builds a complex value. Only a complex
	// output of the final projection is fatal; an unused inner derived column is not.
	complex bool
}
type sourceRelation struct {
	database, table, alias string
	qualifiers             []string
	wildcard               bool
	fields                 []sourceFieldProof
}
type sourceCTE struct {
	body    []sourceToken
	aliases []string
	scope   map[string]*sourceCTE
}

func sourceRelationQuery(tokens []sourceToken, scope map[string]*sourceCTE, visiting map[*sourceCTE]bool, depth int) (sourceRelation, bool) {
	if depth > 16 || len(tokens) < 2 {
		return sourceRelation{}, false
	}
	if sourceIsWord(tokens[0], "WITH") {
		var ok bool
		tokens, scope, ok = sourceRelationCTEs(tokens, scope)
		if !ok {
			return sourceRelation{}, false
		}
	}
	if len(tokens) < 2 || !sourceIsWord(tokens[0], "SELECT") {
		return sourceRelation{}, false
	}
	start := 1
	if sourceIsWord(tokens[start], "ALL") || sourceIsWord(tokens[start], "DISTINCT") {
		start++
	}
	from, end, level := -1, len(tokens), 0
	for i := start; i < len(tokens); i++ {
		token := tokens[i]
		if sourceIsSymbol(token, "(") {
			level++
		}
		if sourceIsSymbol(token, ")") {
			level--
		}
		if level != 0 || token.kind != sourceWord {
			continue
		}
		if token.value == "UNION" || token.value == "INTERSECT" || token.value == "EXCEPT" {
			return sourceRelation{}, false
		}
		if from < 0 && sourceIsWord(token, "FROM") {
			from = i
			end = i
			break
		}
		if sourceTailWord(token) {
			end = i
			break
		}
	}
	relation := sourceRelation{}
	if from >= 0 {
		var pos int
		var ok bool
		relation, pos, ok = sourceFromRelation(tokens, from+1, scope, visiting, depth+1)
		if !ok {
			return sourceRelation{}, false
		}
		if pos < len(tokens) && !sourceTailWord(tokens[pos]) {
			return sourceRelation{}, false
		}
		level = 0
		for _, token := range tokens[pos:] {
			if sourceIsSymbol(token, "(") {
				level++
			}
			if sourceIsSymbol(token, ")") {
				level--
			}
			if level == 0 && token.kind == sourceWord {
				switch token.value {
				case "JOIN", "FROM", "UNION", "INTERSECT", "EXCEPT", "LATERAL":
					return sourceRelation{}, false
				}
			}
		}
	}
	if end <= start {
		return sourceRelation{}, false
	}
	return sourceRelationProject(tokens[start:end], relation)
}

func sourceRelationCTEs(tokens []sourceToken, parent map[string]*sourceCTE) ([]sourceToken, map[string]*sourceCTE, bool) {
	scope := make(map[string]*sourceCTE, len(parent))
	for name, cte := range parent {
		scope[name] = cte
	}
	var declared []*sourceCTE
	seen := map[string]bool{}
	pos := 1
	for {
		if pos >= len(tokens) || !sourceIdentifier(tokens[pos]) {
			return nil, nil, false
		}
		name := strings.ToLower(sourceIdentifierName(tokens[pos]))
		if seen[name] {
			return nil, nil, false
		}
		seen[name] = true
		pos++
		cte := &sourceCTE{}
		if pos < len(tokens) && sourceIsSymbol(tokens[pos], "(") {
			end, err := sourceClosingParen(tokens, pos)
			if err != nil || !sourceIdentifierList(tokens[pos+1:end]) {
				return nil, nil, false
			}
			for i := pos + 1; i < end; i += 2 {
				cte.aliases = append(cte.aliases, sourceIdentifierName(tokens[i]))
			}
			pos = end + 1
		}
		if pos >= len(tokens) || !sourceIsWord(tokens[pos], "AS") {
			return nil, nil, false
		}
		pos++
		if pos >= len(tokens) || !sourceIsSymbol(tokens[pos], "(") {
			return nil, nil, false
		}
		end, err := sourceClosingParen(tokens, pos)
		if err != nil {
			return nil, nil, false
		}
		cte.body = tokens[pos+1 : end]
		scope[name] = cte
		declared = append(declared, cte)
		pos = end + 1
		if pos < len(tokens) && sourceIsSymbol(tokens[pos], ",") {
			pos++
			continue
		}
		break
	}
	for _, cte := range declared {
		cte.scope = scope
	}
	return tokens[pos:], scope, true
}

func sourceFromRelation(tokens []sourceToken, start int, scope map[string]*sourceCTE, visiting map[*sourceCTE]bool, depth int) (sourceRelation, int, bool) {
	if start >= len(tokens) || depth > 16 {
		return sourceRelation{}, start, false
	}
	var relation sourceRelation
	pos := start
	visible := ""
	derived := false
	if sourceIsSymbol(tokens[pos], "(") {
		end, err := sourceClosingParen(tokens, pos)
		if err != nil {
			return relation, pos, false
		}
		var ok bool
		relation, ok = sourceRelationQuery(tokens[pos+1:end], scope, visiting, depth+1)
		if !ok {
			return relation, pos, false
		}
		pos = end + 1
		derived = true
	} else {
		parts, next, ok := sourceQualifiedIdentifiers(tokens, pos)
		if !ok || len(parts) > 2 {
			return relation, pos, false
		}
		pos = next
		visible = parts[len(parts)-1]
		if len(parts) == 1 && scope[strings.ToLower(parts[0])] != nil {
			cte := scope[strings.ToLower(parts[0])]
			if visiting[cte] {
				return relation, pos, false
			}
			visiting[cte] = true
			relation, ok = sourceRelationQuery(cte.body, cte.scope, visiting, depth+1)
			delete(visiting, cte)
			if !ok {
				return relation, pos, false
			}
			if len(cte.aliases) > 0 {
				if relation.wildcard || len(cte.aliases) != len(relation.fields) {
					return relation, pos, false
				}
				for i, name := range cte.aliases {
					relation.fields[i].output = name
				}
			}
		} else {
			relation = sourceRelation{table: visible, wildcard: true}
			if len(parts) == 2 {
				relation.database = parts[0]
			}
		}
	}
	alias := ""
	if pos < len(tokens) && sourceIsWord(tokens[pos], "AS") {
		pos++
		if pos >= len(tokens) || !sourceIdentifier(tokens[pos]) {
			return relation, pos, false
		}
		alias = sourceIdentifierName(tokens[pos])
		pos++
	} else if pos < len(tokens) && sourceIdentifier(tokens[pos]) && !sourceTailWord(tokens[pos]) {
		alias = sourceIdentifierName(tokens[pos])
		pos++
	}
	if derived && alias == "" {
		return relation, pos, false
	}
	relation.alias = alias
	relation.qualifiers = nil
	if alias != "" {
		relation.qualifiers = append(relation.qualifiers, alias)
	}
	if visible != "" {
		relation.qualifiers = append(relation.qualifiers, visible)
		if relation.database != "" {
			relation.qualifiers = append(relation.qualifiers, relation.database+"."+visible)
		}
	}
	return relation, pos, true
}

func sourceRelationProject(tokens []sourceToken, from sourceRelation) (sourceRelation, bool) {
	result := sourceRelation{database: from.database, table: from.table, alias: from.alias, qualifiers: from.qualifiers}
	terms := sourceProjectionTerms(tokens)
	if terms == nil {
		return result, false
	}
	for _, term := range terms {
		if sourceProjectionStar(term, from) {
			if from.table == "" && !from.wildcard && len(from.fields) == 0 {
				return result, false
			}
			result.wildcard = result.wildcard || from.wildcard
			result.fields = append(result.fields, from.fields...)
			continue
		}
		core, alias := sourceProjectionAlias(term)
		if typ := sourceTopLevelCast(term); typ != "" {
			result.fields = append(result.fields, sourceFieldProof{output: alias, column: SourceColumn{Type: typ}, proved: true})
			continue
		}
		parts, end, ok := sourceQualifiedIdentifiers(core, 0)
		if ok && end == len(core) && len(parts) <= 3 && sourceRelationQualifier(parts[:len(parts)-1], from) {
			name := parts[len(parts)-1]
			field, found := sourceRelationField(name, from)
			if !found {
				return result, false
			}
			if alias != "" {
				field.output = alias
			} else {
				field.output = name
			}
			result.fields = append(result.fields, field)
			continue
		}
		if alias == "" {
			return result, false
		}
		proved := sourceProjectionRowNumber(core)
		typ := ""
		if proved {
			typ = "BIGINT"
		}
		result.fields = append(result.fields, sourceFieldProof{output: alias, column: SourceColumn{Type: typ}, proved: proved, complex: sourceComplexExpression(core)})
	}
	return result, true
}

// sourceComplexExpression reports whether an unproven SELECT item builds a
// complex value instead of projecting a scalar function of known columns.
func sourceComplexExpression(term []sourceToken) bool {
	for i := 0; i+1 < len(term); i++ {
		if term[i].kind != sourceWord || !sourceIsSymbol(term[i+1], "(") {
			continue
		}
		switch term[i].value {
		case "MAP", "ARRAY", "STRUCT", "NAMED_STRUCT", "COLLECT_LIST", "COLLECT_SET",
			"SORT_ARRAY", "FROM_JSON", "TO_JSON", "UNION", "REFLECT", "REFLECT2", "JAVA_METHOD":
			return true
		}
	}
	return false
}

func sourceProjectionTerms(tokens []sourceToken) [][]sourceToken {
	var terms [][]sourceToken
	start, depth := 0, 0
	for i := 0; i <= len(tokens); i++ {
		if i < len(tokens) {
			if sourceIsSymbol(tokens[i], "(") {
				depth++
			}
			if sourceIsSymbol(tokens[i], ")") {
				depth--
			}
			if depth != 0 || !sourceIsSymbol(tokens[i], ",") {
				continue
			}
		}
		if start == i {
			return nil
		}
		terms = append(terms, tokens[start:i])
		start = i + 1
	}
	return terms
}
func sourceProjectionAlias(term []sourceToken) ([]sourceToken, string) {
	if len(term) > 2 && sourceIsWord(term[len(term)-2], "AS") && sourceIdentifier(term[len(term)-1]) {
		return term[:len(term)-2], sourceIdentifierName(term[len(term)-1])
	}
	return term, ""
}
func sourceRelationQualifier(parts []string, relation sourceRelation) bool {
	if len(parts) == 0 {
		return true
	}
	joined := strings.Join(parts, ".")
	for _, qualifier := range relation.qualifiers {
		if strings.EqualFold(joined, qualifier) {
			return true
		}
	}
	return false
}
func sourceProjectionStar(term []sourceToken, relation sourceRelation) bool {
	if len(term) == 1 {
		return sourceIsSymbol(term[0], "*")
	}
	if len(term) < 3 || !sourceIsSymbol(term[len(term)-1], "*") || !sourceIsSymbol(term[len(term)-2], ".") {
		return false
	}
	parts, end, ok := sourceQualifiedIdentifiers(term[:len(term)-2], 0)
	return ok && end == len(term)-2 && sourceRelationQualifier(parts, relation)
}
func sourceRelationField(name string, relation sourceRelation) (sourceFieldProof, bool) {
	found := -1
	for i, field := range relation.fields {
		if strings.EqualFold(field.output, name) {
			if found >= 0 {
				return sourceFieldProof{}, false
			}
			found = i
		}
	}
	if found >= 0 {
		return relation.fields[found], true
	}
	if relation.wildcard {
		return sourceFieldProof{output: name, column: SourceColumn{Name: name}, proved: true}, true
	}
	return sourceFieldProof{}, false
}
func sourceProjectionRowNumber(term []sourceToken) bool {
	if len(term) < 7 || !sourceIsWord(term[0], "ROW_NUMBER") || !sourceIsSymbol(term[1], "(") || !sourceIsSymbol(term[2], ")") || !sourceIsWord(term[3], "OVER") || !sourceIsSymbol(term[4], "(") {
		return false
	}
	end, err := sourceClosingParen(term, 4)
	return err == nil && end == len(term)-1
}
func sourceProjectionProof(relation sourceRelation) (SourceProjection, bool) {
	result := SourceProjection{Database: relation.database, Table: relation.table, Alias: relation.alias, Wildcard: relation.wildcard}
	for _, field := range relation.fields {
		if !field.proved {
			if field.complex {
				// map()/array()/struct() members come from nowhere provable, so an
				// exported complex value must be cast explicitly by the user.
				return SourceProjection{}, false
			}
			// Keep the output position of a scalar expression: its value needs no
			// source members, while a complex type here is rejected later because
			// nothing proves which source column it came from.
			result.Columns = append(result.Columns, SourceColumn{Opaque: true, Alias: field.output})
			continue
		}
		column := field.column
		if !strings.EqualFold(column.Name, field.output) {
			column.Alias = field.output
		}
		result.Columns = append(result.Columns, column)
	}
	if result.Wildcard && result.Table == "" {
		return SourceProjection{}, false
	}
	return result, result.Wildcard || len(result.Columns) > 0
}
