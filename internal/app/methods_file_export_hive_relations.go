package app

import "strings"

type hiveBackupRelation struct {
	start, end     int
	database, name string
	ddlTarget      bool
}

func hiveBackupRelations(sql string, tokens []hiveBackupToken) []hiveBackupRelation {
	var relations []hiveBackupRelation
	fromScope := make(map[int]bool)
	selectScope := make(map[int]bool)
	for i, token := range tokens {
		keyword := token.kind == 'i' && sql[token.start] != 96
		word := strings.ToLower(token.text)
		if token.text == ")" {
			delete(selectScope, token.depth)
			delete(fromScope, token.depth)
		}
		if keyword && word == "select" {
			selectScope[token.depth] = true
		}
		if keyword {
			switch word {
			case "where", "group", "order", "having", "limit", "union", "except", "intersect", "qualify", "window", "distribute", "cluster", "sort":
				fromScope[token.depth] = false
			}
		}
		isFrom := keyword && selectScope[token.depth] && (word == "from" || word == "join")
		isComma := token.text == "," && fromScope[token.depth]
		isTarget := token.depth == 0 && keyword && (word == "table" || word == "view") && hiveDDLTargetKeyword(sql, tokens, i)
		if !isFrom && !isComma && !isTarget {
			continue
		}
		if isFrom {
			fromScope[token.depth] = true
		}
		j := i + 1
		if isTarget && j+2 < len(tokens) && strings.EqualFold(tokens[j].text, "if") && strings.EqualFold(tokens[j+1].text, "not") && strings.EqualFold(tokens[j+2].text, "exists") {
			j += 3
		}
		if j >= len(tokens) || tokens[j].kind != 'i' {
			continue
		}
		r := hiveBackupRelation{start: j, end: j + 1, name: tokens[j].text, ddlTarget: isTarget}
		if j+2 < len(tokens) && tokens[j+1].text == "." && tokens[j+2].kind == 'i' {
			r.database, r.name, r.end = tokens[j].text, tokens[j+2].text, j+3
		}
		relations = append(relations, r)
	}
	return relations
}

func hiveDDLTargetKeyword(sql string, tokens []hiveBackupToken, index int) bool {
	created := false
	for i := 0; i < index; i++ {
		if tokens[i].kind != 'i' || sql[tokens[i].start] == 96 {
			continue
		}
		word := strings.ToLower(tokens[i].text)
		if word == "as" || word == "select" || word == "from" {
			return false
		}
		if word == "create" {
			created = true
		}
	}
	return created
}
