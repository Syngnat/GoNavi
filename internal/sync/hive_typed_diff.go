package sync

import (
	"bytes"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

func diffSyncRowsByKeys(config SyncConfig, columns []connection.ColumnDefinition, keys []string, sourceRows, targetRows []map[string]interface{}) ([]map[string]interface{}, []connection.UpdateRow, []map[string]interface{}, int, error) {
	if !isHiveMigrationPair(resolveMigrationDBType(config.SourceConfig), resolveMigrationDBType(config.TargetConfig)) {
		inserts, updates, deletes, same := diffRowsByKeyColumns(keys, sourceRows, targetRows)
		return inserts, updates, deletes, same, nil
	}
	targetType := resolveMigrationDBType(config.TargetConfig)
	if err := validateHiveTypedKeys(targetType, columns, keys, sourceRows, "source"); err != nil {
		return nil, nil, nil, 0, err
	}
	if err := validateHiveTypedKeys(targetType, columns, keys, targetRows, "target"); err != nil {
		return nil, nil, nil, 0, err
	}
	targetByKey := make(map[string]map[string]interface{}, len(targetRows))
	for _, row := range targetRows {
		key, _, err := hiveTypedKey(targetType, columns, keys, row)
		if err != nil {
			return nil, nil, nil, 0, err
		}
		targetByKey[key] = row
	}
	seenSource := make(map[string]struct{}, len(sourceRows))
	keyNames := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		keyNames[strings.ToLower(key)] = struct{}{}
	}
	var inserts []map[string]interface{}
	var updates []connection.UpdateRow
	var deletes []map[string]interface{}
	same := 0
	for _, row := range sourceRows {
		key, bindings, err := hiveTypedKey(targetType, columns, keys, row)
		if err != nil {
			return nil, nil, nil, 0, err
		}
		seenSource[key] = struct{}{}
		targetRow, exists := targetByKey[key]
		if !exists {
			inserts = append(inserts, row)
			continue
		}
		values := make(map[string]interface{})
		for name, value := range row {
			if _, isKey := keyNames[strings.ToLower(name)]; isKey {
				continue
			}
			previous, _, ambiguous := lookupProjectionSourceValue(targetRow, name)
			if ambiguous {
				return nil, nil, nil, 0, fmt.Errorf("ambiguous target column %s", name)
			}
			if definition, found := columnDefinitionFold(columns, name); found {
				if known, equal := hiveKnownScalarValuesEqual(targetType, definition, value, previous); known {
					if !equal {
						values[name] = value
					}
					continue
				}
			}
			if fmt.Sprint(value) != fmt.Sprint(previous) {
				values[name] = value
			}
		}
		if len(values) == 0 {
			same++
			continue
		}
		updates = append(updates, connection.UpdateRow{Keys: bindings, Values: values})
	}
	for key, row := range targetByKey {
		if _, exists := seenSource[key]; exists {
			continue
		}
		_, bindings, err := hiveTypedKey(targetType, columns, keys, row)
		if err != nil {
			return nil, nil, nil, 0, err
		}
		deletes = append(deletes, bindings)
	}
	return inserts, updates, deletes, same, nil
}

func hiveKnownScalarValuesEqual(target string, column connection.ColumnDefinition, left, right interface{}) (bool, bool) {
	typ := column.Type
	if target != "hive" {
		mapped, err := mapColumnToHiveType(target, column)
		if err != nil {
			return false, false
		}
		typ = mapped
	}
	if strings.EqualFold(typ, "BINARY") {
		if left == nil || right == nil {
			return true, left == nil && right == nil
		}
		a, errA := hiveBinaryBinding(left)
		b, errB := hiveBinaryBinding(right)
		return true, errA == nil && errB == nil && bytes.Equal(a, b)
	}
	if isMySQLLikeWritableTargetType(target) && strings.HasPrefix(strings.ToLower(strings.ReplaceAll(column.Type, " ", "")), "tinyint") {
		_, leftBool := left.(bool)
		_, rightBool := right.(bool)
		if leftBool || rightBool {
			if left == nil || right == nil {
				return true, left == nil && right == nil
			}
			normalize := func(value interface{}) string {
				switch strings.ToLower(fmt.Sprint(value)) {
				case "true", "1":
					return "1"
				case "false", "0":
					return "0"
				}
				return "invalid"
			}
			a, b := normalize(left), normalize(right)
			return true, a != "invalid" && b != "invalid" && a == b
		}
	}
	return false, false
}

func watermarkSyncRowKey(plan watermarkRuntimePlan, row map[string]interface{}) (string, error) {
	if !isHiveMigrationPair(plan.sourceType, plan.targetType) {
		return watermarkCompositeRowKey(row, plan.targetTieColumns)
	}
	key, _, err := hiveTypedKey(plan.targetType, plan.targetColumns, plan.targetTieColumns, row)
	return key, err
}
