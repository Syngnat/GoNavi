package hivesql

import (
	"fmt"
	"strings"
)

var hiveSourceWriteWords = map[string]bool{
	"INSERT": true, "UPDATE": true, "DELETE": true, "MERGE": true, "UPSERT": true,
	"CREATE": true, "ALTER": true, "DROP": true, "TRUNCATE": true, "RENAME": true,
	"LOAD": true, "IMPORT": true, "EXPORT": true, "ADD": true, "DFS": true, "MSCK": true, "ANALYZE": true,
	"SET": true, "RESET": true, "USE": true, "GRANT": true, "REVOKE": true,
	"BEGIN": true, "START": true, "COMMIT": true, "ROLLBACK": true, "SAVEPOINT": true, "RELEASE": true,
	"LOCK": true, "UNLOCK": true, "KILL": true, "CALL": true, "EXEC": true, "EXECUTE": true,
	"CACHE": true, "UNCACHE": true, "CLEAR": true, "REFRESH": true, "REPAIR": true, "LIST": true,
	"INTO": true, "TRANSFORM": true,
}
var hiveSourceExternalFunctions = map[string]bool{"REFLECT": true, "REFLECT2": true, "JAVA_METHOD": true, "TRANSFORM": true}

// ValidateReadOnlySourceQuery accepts one provably read-only Hive SELECT/WITH.
// It is deliberately stricter than a general SQL parser: uncertain syntax and
// unquoted command words are rejected before a protected source can execute.
func ValidateReadOnlySourceQuery(query string) error {
	tokens, err := sourceQueryTokens(query)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		return fmt.Errorf("Hive source query is empty")
	}
	if sourceIsSymbol(tokens[len(tokens)-1], ";") {
		tokens = tokens[:len(tokens)-1]
	}
	if len(tokens) == 0 {
		return fmt.Errorf("Hive source query is empty")
	}
	if err = sourceCheckTokens(tokens); err != nil {
		return err
	}
	if err = sourceReadQuery(tokens, 0); err != nil {
		return fmt.Errorf("Hive source query must be one read-only SELECT/WITH: %w; use explicit AS aliases, quoted identifiers, or CAST expressions", err)
	}
	return nil
}

func sourceCheckTokens(tokens []sourceToken) error {
	var stack []string
	for i, token := range tokens {
		if sourceIsSymbol(token, ";") {
			return fmt.Errorf("multiple Hive source statements are not allowed")
		}
		if token.kind == sourceSymbol {
			switch token.value {
			case "(", "[":
				stack = append(stack, token.value)
				if len(stack) > 128 {
					return fmt.Errorf("Hive source nesting exceeds 128")
				}
			case ")", "]":
				if len(stack) == 0 {
					return fmt.Errorf("unbalanced Hive source query")
				}
				open := stack[len(stack)-1]
				stack = stack[:len(stack)-1]
				if token.value == ")" && open != "(" || token.value == "]" && open != "[" {
					return fmt.Errorf("unbalanced Hive source query")
				}
			}
		}
		upper := strings.ToUpper(token.value)
		if token.kind == sourceWord && hiveSourceWriteWords[upper] {
			return fmt.Errorf("Hive protected source query rejects command token %s; quote identifiers or use an explicit AS/CAST", upper)
		}
		if i+1 < len(tokens) && sourceIsSymbol(tokens[i+1], "(") {
			if hiveSourceExternalFunctions[upper] {
				return fmt.Errorf("Hive protected source query rejects external-code function %s", upper)
			}
			if token.kind == sourceLiteral && !sourceNumeric(token.value) {
				return fmt.Errorf("quoted Hive function calls cannot be proven read-only; use an unquoted safe function name")
			}
		}
		if token.kind != sourceWord {
			continue
		}
		if upper == "MAP" || upper == "REDUCE" {
			if i+1 >= len(tokens) || !(sourceIsSymbol(tokens[i+1], "(") || upper == "MAP" && sourceIsSymbol(tokens[i+1], "<")) {
				return fmt.Errorf("Hive MAP/REDUCE scripts are not allowed in protected source queries")
			}
		}
		if upper == "USING" && !sourceJoinUsing(tokens, i+1) {
			return fmt.Errorf("Hive USING scripts are not allowed; only identifier-only JOIN USING lists are accepted")
		}
	}
	if len(stack) != 0 {
		return fmt.Errorf("unbalanced Hive source query")
	}
	return nil
}

func sourceReadQuery(tokens []sourceToken, depth int) error {
	if depth > 32 {
		return fmt.Errorf("CTE nesting exceeds 32")
	}
	if len(tokens) < 2 {
		return fmt.Errorf("incomplete SELECT query")
	}
	if sourceIsWord(tokens[0], "SELECT") {
		return nil
	}
	if !sourceIsWord(tokens[0], "WITH") {
		return fmt.Errorf("only SELECT and WITH are accepted")
	}
	pos := 1
	seen := map[string]bool{}
	for {
		if pos >= len(tokens) || !sourceIdentifier(tokens[pos]) {
			return fmt.Errorf("CTE name is missing")
		}
		name := strings.ToLower(sourceIdentifierName(tokens[pos]))
		if seen[name] {
			return fmt.Errorf("duplicate Hive CTE name")
		}
		seen[name] = true
		pos++
		if pos < len(tokens) && sourceIsSymbol(tokens[pos], "(") {
			end, err := sourceClosingParen(tokens, pos)
			if err != nil {
				return err
			}
			if !sourceIdentifierList(tokens[pos+1 : end]) {
				return fmt.Errorf("CTE aliases must be explicit identifiers")
			}
			pos = end + 1
		}
		if pos >= len(tokens) || !sourceIsWord(tokens[pos], "AS") {
			return fmt.Errorf("CTE requires explicit AS")
		}
		pos++
		if pos >= len(tokens) || !sourceIsSymbol(tokens[pos], "(") {
			return fmt.Errorf("CTE body must be a SELECT subquery")
		}
		end, err := sourceClosingParen(tokens, pos)
		if err != nil {
			return err
		}
		if err = sourceReadQuery(tokens[pos+1:end], depth+1); err != nil {
			return err
		}
		pos = end + 1
		if pos < len(tokens) && sourceIsSymbol(tokens[pos], ",") {
			pos++
			continue
		}
		break
	}
	if pos >= len(tokens) || !sourceIsWord(tokens[pos], "SELECT") {
		return fmt.Errorf("WITH must end in a read-only SELECT")
	}
	return sourceReadQuery(tokens[pos:], depth+1)
}
func sourceClosingParen(tokens []sourceToken, start int) (int, error) {
	depth := 0
	for i := start; i < len(tokens); i++ {
		if sourceIsSymbol(tokens[i], "(") {
			depth++
		}
		if sourceIsSymbol(tokens[i], ")") {
			depth--
			if depth == 0 {
				return i, nil
			}
		}
	}
	return 0, fmt.Errorf("unclosed CTE body")
}
func sourceJoinUsing(tokens []sourceToken, start int) bool {
	if start >= len(tokens) || !sourceIsSymbol(tokens[start], "(") {
		return false
	}
	end, err := sourceClosingParen(tokens, start)
	return err == nil && sourceIdentifierList(tokens[start+1:end])
}
func sourceIdentifierList(tokens []sourceToken) bool {
	if len(tokens) == 0 {
		return false
	}
	for i, token := range tokens {
		if i%2 == 0 {
			if !sourceIdentifier(token) {
				return false
			}
		} else if !sourceIsSymbol(token, ",") {
			return false
		}
	}
	return len(tokens)%2 == 1
}
func sourceIdentifier(token sourceToken) bool {
	return token.kind == sourceWord || token.kind == sourceQuotedIdentifier
}
func sourceIsWord(token sourceToken, value string) bool {
	return token.kind == sourceWord && token.value == value
}
func sourceIsSymbol(token sourceToken, value string) bool {
	return token.kind == sourceSymbol && token.value == value
}
func sourceNumeric(value string) bool {
	if value == "" {
		return false
	}
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
