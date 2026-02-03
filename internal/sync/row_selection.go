package sync

import (
	"GoNavi-Wails/internal/connection"
	"fmt"
)

func filterRowsByPKSelection(pkCol string, rows []map[string]interface{}, enabled bool, selectedPKs []string) []map[string]interface{} {
	if !enabled {
		return nil
	}
	if len(rows) == 0 {
		return rows
	}
	if len(selectedPKs) == 0 {
		return rows
	}

	set := make(map[string]struct{}, len(selectedPKs))
	for _, pk := range selectedPKs {
		set[pk] = struct{}{}
	}

	out := make([]map[string]interface{}, 0, len(rows))
	for _, row := range rows {
		pkStr := fmt.Sprintf("%v", row[pkCol])
		if _, ok := set[pkStr]; ok {
			out = append(out, row)
		}
	}
	return out
}

func filterUpdatesByPKSelection(pkCol string, updates []connection.UpdateRow, enabled bool, selectedPKs []string) []connection.UpdateRow {
	if !enabled {
		return nil
	}
	if len(updates) == 0 {
		return updates
	}
	if len(selectedPKs) == 0 {
		return updates
	}

	set := make(map[string]struct{}, len(selectedPKs))
	for _, pk := range selectedPKs {
		set[pk] = struct{}{}
	}

	out := make([]connection.UpdateRow, 0, len(updates))
	for _, u := range updates {
		pkStr := fmt.Sprintf("%v", u.Keys[pkCol])
		if _, ok := set[pkStr]; ok {
			out = append(out, u)
		}
	}
	return out
}
