package hivesql

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

type sourceToken struct {
	value string
	kind  byte
	raw   string
}

const sourceWord byte = 'w'
const sourceQuotedIdentifier byte = 'i'
const sourceLiteral byte = 'l'
const sourceSymbol byte = 's'

func sourceQueryTokens(query string) ([]sourceToken, error) {
	if len(query) > 16<<20 {
		return nil, fmt.Errorf("source query exceeds 16 MiB")
	}
	if strings.Contains(query, "$"+"{") {
		return nil, fmt.Errorf("Hive variable substitution is not allowed in a protected source query; use an explicit literal or CAST")
	}
	if strings.ContainsRune(query, 0) {
		return nil, fmt.Errorf("NUL is not allowed in a Hive source query")
	}
	tokens := make([]sourceToken, 0, 64)
	for pos := 0; pos < len(query); {
		if len(tokens) > 100000 {
			return nil, fmt.Errorf("Hive source query has too many tokens")
		}
		r, size := utf8.DecodeRuneInString(query[pos:])
		if r == utf8.RuneError && size == 1 {
			return nil, fmt.Errorf("source query is not valid UTF-8")
		}
		if unicode.IsSpace(r) {
			pos += size
			continue
		}
		if strings.HasPrefix(query[pos:], "--") {
			pos += 2
			for pos < len(query) && query[pos] != '\n' && query[pos] != '\r' {
				pos++
			}
			continue
		}
		if strings.HasPrefix(query[pos:], "/*") {
			end, err := sourceBlockComment(query, pos)
			if err != nil {
				return nil, err
			}
			pos = end
			continue
		}
		if r == '\'' || r == '"' || r == 96 {
			value, end, err := sourceQuotedToken(query, pos, byte(r))
			if err != nil {
				return nil, err
			}
			kind := sourceLiteral
			if r == 96 {
				kind = sourceQuotedIdentifier
			}
			tokens = append(tokens, sourceToken{value: value, kind: kind})
			pos = end
			continue
		}
		if unicode.IsLetter(r) || r == '_' {
			start := pos
			pos += size
			for pos < len(query) {
				next, n := utf8.DecodeRuneInString(query[pos:])
				if !(unicode.IsLetter(next) || unicode.IsDigit(next) || next == '_') {
					break
				}
				pos += n
			}
			tokens = append(tokens, sourceToken{value: strings.ToUpper(query[start:pos]), kind: sourceWord, raw: query[start:pos]})
			continue
		}
		if unicode.IsDigit(r) {
			start := pos
			pos += size
			for pos < len(query) && query[pos] >= '0' && query[pos] <= '9' {
				pos++
			}
			tokens = append(tokens, sourceToken{value: query[start:pos], kind: sourceLiteral})
			continue
		}
		if strings.ContainsRune("(),.[]<>:+-*/%=!&|^~;?", r) {
			tokens = append(tokens, sourceToken{value: string(r), kind: sourceSymbol})
			pos += size
			continue
		}
		// Hive has neither # comments nor PostgreSQL dollar quoting. Never hide the
		// remainder of a statement behind syntax understood by another dialect.
		return nil, fmt.Errorf("unsupported character in Hive source query at byte %d; quote identifiers or use an explicit CAST", pos)
	}
	if len(tokens) > 100000 {
		return nil, fmt.Errorf("Hive source query has too many tokens")
	}
	return tokens, nil
}

func sourceBlockComment(query string, start int) (int, error) {
	for pos := start + 2; pos < len(query); pos++ {
		if strings.HasPrefix(query[pos:], "/*") {
			return 0, fmt.Errorf("nested Hive block comments cannot be proven safe")
		}
		if strings.HasPrefix(query[pos:], "*/") {
			return pos + 2, nil
		}
	}
	return 0, fmt.Errorf("unterminated Hive block comment")
}

func sourceQuotedToken(query string, start int, quote byte) (string, int, error) {
	var value strings.Builder
	for pos := start + 1; pos < len(query); {
		char := query[pos]
		if char == quote {
			if pos+1 < len(query) && query[pos+1] == quote {
				value.WriteByte(quote)
				pos += 2
				continue
			}
			return value.String(), pos + 1, nil
		}
		if char == '\\' {
			if quote == 96 {
				return "", 0, fmt.Errorf("backslash escapes in Hive quoted identifiers cannot be proven safe")
			}
			if pos+1 >= len(query) {
				return "", 0, fmt.Errorf("unterminated Hive string escape")
			}
			value.WriteByte(query[pos+1])
			pos += 2
			continue
		}
		value.WriteByte(char)
		pos++
	}
	return "", 0, fmt.Errorf("unterminated Hive quoted token")
}
