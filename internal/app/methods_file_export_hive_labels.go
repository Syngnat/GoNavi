package app

import (
	"strings"

	"GoNavi-Wails/internal/db"
)

func hiveExportSourceTable(query string, consumer db.QueryStreamConsumer) string {
	if count, ok := consumer.(*countingExportConsumer); ok {
		return hiveExportSourceTable(query, count.delegate)
	}
	if _, ok := consumer.(*exportColumnProjectionConsumer); ok {
		return ""
	}
	tokens, err := hiveBackupTokens(query)
	if err != nil {
		return ""
	}
	if len(tokens) > 0 && tokens[len(tokens)-1].text == ";" {
		tokens = tokens[:len(tokens)-1]
	}
	if len(tokens) != 4 && len(tokens) != 6 {
		return ""
	}
	if !strings.EqualFold(tokens[0].text, "select") || tokens[1].text != "*" || !strings.EqualFold(tokens[2].text, "from") || tokens[3].kind != 'i' {
		return ""
	}
	if len(tokens) == 4 {
		return tokens[3].text
	}
	if tokens[4].text == "." && tokens[5].kind == 'i' {
		return tokens[5].text
	}
	return ""
}

func hiveExportBareColumns(columns []string, table string) []string {
	result := append([]string(nil), columns...)
	if table == "" {
		return result
	}
	prefix := strings.ToLower(table) + "."
	seen := make(map[string]bool, len(columns))
	for i, name := range columns {
		if strings.HasPrefix(strings.ToLower(name), prefix) {
			result[i] = name[len(prefix):]
		}
		key := normalizeColumnName(result[i])
		if key == "" || seen[key] {
			return append([]string(nil), columns...)
		}
		seen[key] = true
	}
	return result
}
