package app

import (
	"fmt"
	"strings"
)

type hiveBackupToken struct {
	start, end int
	text       string
	kind       byte
	depth      int
}

type hiveBackupEdit struct {
	start, end  int
	replacement string
}

func hiveBackupTokens(sql string) ([]hiveBackupToken, error) {
	if len(sql) > maxImportCellBytes {
		return nil, fmt.Errorf("Hive DDL exceeds safety limit")
	}
	var tokens []hiveBackupToken
	depth := 0
	for pos := 0; pos < len(sql); {
		if strings.HasPrefix(sql[pos:], "--") {
			end := strings.IndexByte(sql[pos:], '\n')
			if end < 0 {
				break
			}
			pos += end + 1
			continue
		}
		if strings.HasPrefix(sql[pos:], "/*") {
			end := strings.Index(sql[pos+2:], "*/")
			if end < 0 {
				return nil, fmt.Errorf("unterminated Hive DDL comment")
			}
			pos += end + 4
			continue
		}
		ch := sql[pos]
		if ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' {
			pos++
			continue
		}
		start, kind := pos, byte('s')
		if ch == '\'' || ch == '"' || ch == 96 {
			pos = skipHivePolicyQuote(sql, pos)
			if pos <= start+1 || sql[pos-1] != ch {
				return nil, fmt.Errorf("unterminated Hive DDL quote")
			}
			kind = 'v'
			if ch == 96 {
				kind = 'i'
			}
		} else if isSQLKeywordByte(ch) {
			pos++
			for pos < len(sql) && isSQLKeywordByte(sql[pos]) {
				pos++
			}
			kind = 'i'
		} else {
			pos++
		}
		text := sql[start:pos]
		if kind == 'i' && ch == 96 {
			text = strings.ReplaceAll(text[1:len(text)-1], "\x60\x60", "\x60")
		}
		tokens = append(tokens, hiveBackupToken{start: start, end: pos, text: text, kind: kind, depth: depth})
		if ch == '(' {
			depth++
		}
		if ch == ')' {
			depth--
			if depth < 0 {
				return nil, fmt.Errorf("unbalanced Hive DDL parentheses")
			}
		}
	}
	if depth != 0 {
		return nil, fmt.Errorf("unbalanced Hive DDL parentheses")
	}
	return tokens, nil
}

func prepareHiveBackupDDL(ddl, database string, includeContext bool) (string, error) {
	tokens, err := hiveBackupTokens(ddl)
	if err != nil {
		return "", err
	}
	if hiveImportHasVariableSubstitution(ddl) {
		return "", fmt.Errorf("Hive DDL contains unresolved variable substitutions")
	}
	var edits []hiveBackupEdit
	relationStarts := make(map[int]bool)
	for _, relation := range hiveBackupRelations(ddl, tokens) {
		if includeContext && database != "" && strings.EqualFold(relation.database, database) {
			relationStarts[relation.start] = true
		}
	}
	relocated := false
	queryBody := false
	for i, token := range tokens {
		keyword := token.kind == 'i' && ddl[token.start] != 96
		if keyword && token.depth == 0 && (strings.EqualFold(token.text, "select") || strings.EqualFold(token.text, "with") && i > 0 && strings.EqualFold(tokens[i-1].text, "as")) {
			queryBody = true
		}
		if token.kind != 'i' {
			continue
		}
		if !queryBody && keyword && token.depth == 0 && strings.EqualFold(token.text, "stored") && i+1 < len(tokens) && strings.EqualFold(tokens[i+1].text, "by") {
			return "", fmt.Errorf("Hive storage-handler DDL cannot be safely isolated from its source system")
		}
		if !queryBody && keyword && token.depth == 0 && strings.EqualFold(token.text, "location") && i+1 < len(tokens) && tokens[i+1].kind == 'v' {
			// Never bind restored data to the source table's path. Do not echo the
			// source URI: object-store locations may contain credentials/tokens.
			edits = append(edits, hiveBackupEdit{start: token.start, end: tokens[i+1].end})
			relocated = true
			continue
		}
		if relationStarts[i] {
			edits = append(edits, hiveBackupEdit{start: token.start, end: tokens[i+1].end})
		}
	}
	var output strings.Builder
	if relocated {
		output.WriteString("-- Source LOCATION omitted for isolated restore; target warehouse path will be used.\n")
	}
	cursor := 0
	for _, edit := range edits {
		if edit.start < cursor {
			continue
		}
		output.WriteString(ddl[cursor:edit.start])
		output.WriteString(edit.replacement)
		cursor = edit.end
	}
	output.WriteString(ddl[cursor:])
	return output.String(), nil
}
