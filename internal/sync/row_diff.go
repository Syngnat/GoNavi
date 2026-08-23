package sync

import (
	"GoNavi-Wails/internal/connection"
	"encoding/json"
	"fmt"
)

// diffRowsByKeyColumns compares rows by the complete, ordered key tuple.
// Updates and deletes retain every key component for the database driver.
func diffRowsByKeyColumns(keyColumns []string, sourceRows, targetRows []map[string]interface{}) ([]map[string]interface{}, []connection.UpdateRow, []map[string]interface{}, int) {
	targetMap := make(map[string]map[string]interface{}, len(targetRows))
	for _, row := range targetRows {
		key, ok := syncRowKey(row, keyColumns)
		if !ok {
			continue
		}
		targetMap[key] = row
	}

	sourceKeySet := make(map[string]struct{}, len(sourceRows))
	inserts := make([]map[string]interface{}, 0)
	updates := make([]connection.UpdateRow, 0)
	same := 0
	for _, sourceRow := range sourceRows {
		key, ok := syncRowKey(sourceRow, keyColumns)
		if !ok {
			continue
		}
		sourceKeySet[key] = struct{}{}
		if targetRow, exists := targetMap[key]; exists {
			changes := make(map[string]interface{})
			for column, value := range sourceRow {
				if fmt.Sprintf("%v", value) != fmt.Sprintf("%v", targetRow[column]) {
					changes[column] = value
				}
			}
			if len(changes) == 0 {
				same++
				continue
			}
			updates = append(updates, connection.UpdateRow{
				Keys:   syncRowKeys(sourceRow, keyColumns),
				Values: changes,
			})
			continue
		}
		inserts = append(inserts, sourceRow)
	}

	deletes := make([]map[string]interface{}, 0)
	for key, row := range targetMap {
		if _, exists := sourceKeySet[key]; exists {
			continue
		}
		deletes = append(deletes, syncRowKeys(row, keyColumns))
	}
	return inserts, updates, deletes, same
}

func syncRowKeys(row map[string]interface{}, keyColumns []string) map[string]interface{} {
	keys := make(map[string]interface{}, len(keyColumns))
	for _, column := range keyColumns {
		keys[column] = row[column]
	}
	return keys
}

func syncRowKey(row map[string]interface{}, keyColumns []string) (string, bool) {
	if len(keyColumns) == 0 {
		return "", false
	}
	values := make([]interface{}, 0, len(keyColumns))
	for _, column := range keyColumns {
		value, ok := row[column]
		if !ok || value == nil {
			return "", false
		}
		if bytes, ok := value.([]byte); ok {
			value = string(bytes)
		}
		values = append(values, value)
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return "", false
	}
	return string(encoded), true
}
