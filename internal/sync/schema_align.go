package sync

import (
	"GoNavi-Wails/internal/connection"
	"strings"
)

func collectRequiredColumns(inserts []map[string]interface{}, updates []connection.UpdateRow) map[string]string {
	// key: lower(columnName), value: original columnName
	required := make(map[string]string)
	for _, row := range inserts {
		for k := range row {
			key := strings.ToLower(strings.TrimSpace(k))
			if key == "" {
				continue
			}
			if _, exists := required[key]; !exists {
				required[key] = k
			}
		}
	}
	for _, u := range updates {
		for k := range u.Values {
			key := strings.ToLower(strings.TrimSpace(k))
			if key == "" {
				continue
			}
			if _, exists := required[key]; !exists {
				required[key] = k
			}
		}
	}
	return required
}

func filterInsertRows(inserts []map[string]interface{}, allowedLower map[string]struct{}) []map[string]interface{} {
	if len(inserts) == 0 || len(allowedLower) == 0 {
		return inserts
	}

	out := make([]map[string]interface{}, 0, len(inserts))
	for _, row := range inserts {
		if len(row) == 0 {
			out = append(out, row)
			continue
		}
		n := make(map[string]interface{}, len(row))
		for k, v := range row {
			if _, ok := allowedLower[strings.ToLower(strings.TrimSpace(k))]; ok {
				n[k] = v
			}
		}
		out = append(out, n)
	}
	return out
}

func filterUpdateRows(updates []connection.UpdateRow, allowedLower map[string]struct{}) []connection.UpdateRow {
	if len(updates) == 0 || len(allowedLower) == 0 {
		return updates
	}

	out := make([]connection.UpdateRow, 0, len(updates))
	for _, u := range updates {
		if len(u.Values) == 0 {
			continue
		}

		values := make(map[string]interface{}, len(u.Values))
		for k, v := range u.Values {
			if _, ok := allowedLower[strings.ToLower(strings.TrimSpace(k))]; ok {
				values[k] = v
			}
		}
		if len(values) == 0 {
			continue
		}
		out = append(out, connection.UpdateRow{
			Keys:   u.Keys,
			Values: values,
		})
	}
	return out
}

func sanitizeMySQLColumnType(t string) string {
	tt := strings.TrimSpace(t)
	if tt == "" {
		return "TEXT"
	}

	// 基础防护：避免把元数据中异常内容拼进 SQL。
	if strings.ContainsAny(tt, "`;\n\r") {
		return "TEXT"
	}
	return tt
}
