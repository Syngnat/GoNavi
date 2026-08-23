package sync

import (
	"GoNavi-Wails/internal/connection"
	"fmt"
)

func filterRowsByPKSelection(pkCol string, rows []map[string]interface{}, enabled bool, selectedPKs []string) []map[string]interface{} {
	return filterRowsByKeySelection([]string{pkCol}, rows, enabled, selectedPKs)
}

func filterRowsByKeySelection(keyColumns []string, rows []map[string]interface{}, enabled bool, selectedKeys []string) []map[string]interface{} {
	if !enabled {
		return nil
	}
	if len(rows) == 0 {
		return rows
	}
	if len(selectedKeys) == 0 {
		return rows
	}

	set := make(map[string]struct{}, len(selectedKeys))
	for _, key := range selectedKeys {
		set[key] = struct{}{}
	}

	out := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		key, ok := selectionRowKey(row, keyColumns)
		if !ok {
			continue
		}
		if _, selected := set[key]; selected {
			out = append(out, row)
		}
	}
	return out
}

func filterUpdatesByPKSelection(pkCol string, updates []connection.UpdateRow, enabled bool, selectedPKs []string) []connection.UpdateRow {
	return filterUpdatesByKeySelection([]string{pkCol}, updates, enabled, selectedPKs)
}

func filterUpdatesByKeySelection(keyColumns []string, updates []connection.UpdateRow, enabled bool, selectedKeys []string) []connection.UpdateRow {
	if !enabled {
		return nil
	}
	if len(updates) == 0 {
		return updates
	}
	if len(selectedKeys) == 0 {
		return updates
	}

	set := make(map[string]struct{}, len(selectedKeys))
	for _, key := range selectedKeys {
		set[key] = struct{}{}
	}

	out := make([]connection.UpdateRow, 0, len(updates))
	for _, u := range updates {
		key, ok := selectionRowKey(u.Keys, keyColumns)
		if !ok {
			continue
		}
		if _, selected := set[key]; selected {
			out = append(out, u)
		}
	}
	return out
}

func selectionRowKey(row map[string]interface{}, keyColumns []string) (string, bool) {
	if len(keyColumns) == 1 {
		value, ok := row[keyColumns[0]]
		if !ok || value == nil {
			return "", false
		}
		return fmt.Sprintf("%v", value), true
	}
	return syncRowKey(row, keyColumns)
}
