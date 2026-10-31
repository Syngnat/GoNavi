package sync

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

func hiveTypedKey(target string, columns []connection.ColumnDefinition, keys []string, row map[string]interface{}) (string, map[string]interface{}, error) {
	atoms := make([]string, 0, len(keys))
	bindings := make(map[string]interface{}, len(keys))
	for _, key := range keys {
		value, present, ambiguous := lookupProjectionSourceValue(row, key)
		if !present || ambiguous || value == nil {
			return "", nil, fmt.Errorf("incomplete Hive logical key %s", key)
		}
		column, exists := columnDefinitionFold(columns, key)
		if !exists {
			return "", nil, fmt.Errorf("target logical key column %s is missing", key)
		}
		typ := column.Type
		var err error
		if target != "hive" {
			typ, err = mapColumnToHiveType(target, column)
		}
		if err != nil {
			return "", nil, err
		}
		if target == "sqlserver" && strings.HasPrefix(strings.ToLower(column.Type), "float") {
			typ = "DOUBLE"
		}
		parsed, err := hivesql.ParseType(typ)
		if err != nil {
			return "", nil, err
		}
		atom, binding, err := hiveTypedKeyAtom(target, parsed, value)
		if err != nil {
			return "", nil, fmt.Errorf("logical key %s: %w", key, err)
		}
		atoms = append(atoms, parsed.Kind+":"+atom)
		bindings[key] = binding
	}
	encoded, err := json.Marshal(atoms)
	return string(encoded), bindings, err
}

func hiveTypedKeyAtom(target string, typ hivesql.Type, value interface{}) (string, interface{}, error) {
	if typ.Complex() || strings.HasPrefix(typ.Kind, "interval") || typ.Kind == "void" {
		return "", nil, fmt.Errorf("logical keys require scalar target types")
	}
	if target != "hive" {
		if boolean, ok := value.(bool); ok && (typ.Kind == "tinyint" || typ.Kind == "smallint" || typ.Kind == "int" || typ.Kind == "bigint") {
			value = int64(0)
			if boolean {
				value = int64(1)
			}
		}
	}
	literal, err := hivesql.Value(typ.String(), value)
	if err != nil {
		return "", nil, err
	}
	switch typ.Kind {
	case "tinyint", "smallint", "int", "bigint", "decimal":
		number, err := projectionDecimal(value)
		if err != nil {
			return "", nil, err
		}
		rational, ok := new(big.Rat).SetString(number.String())
		if !ok {
			return "", nil, fmt.Errorf("invalid exact numeric key")
		}
		if typ.Kind == "decimal" {
			return rational.RatString(), rational.FloatString(typ.Scale), nil
		}
		if !rational.IsInt() || !rational.Num().IsInt64() {
			return "", nil, fmt.Errorf("invalid integral key range")
		}
		return rational.RatString(), rational.Num().Int64(), nil
	case "float", "double":
		bits := 64
		if typ.Kind == "float" {
			bits = 32
		}
		if v, ok := value.(float32); ok && bits == 64 {
			value = float64(v)
		}
		number, err := projectionDecimal(value)
		if err != nil {
			return "", nil, err
		}
		parsed, err := strconv.ParseFloat(number.String(), bits)
		if err != nil {
			return "", nil, err
		}
		if parsed == 0 {
			parsed = 0
		}
		return strconv.FormatFloat(parsed, 'g', -1, bits), value, nil
	case "binary":
		binary, err := watermarkBinaryCursorValue(value)
		if err != nil {
			return "", nil, err
		}
		if binary.Value == "" {
			return "", nil, fmt.Errorf("empty binary logical key")
		}
		binding := value
		if target != "hive" {
			binding, err = hiveBinaryBinding(value)
			if err != nil {
				return "", nil, err
			}
		}
		return binary.Value, binding, nil
	case "date":
		parsed, err := projectionTime(value, SyncValueTransform{Type: "date"}, true)
		if err != nil {
			return "", nil, err
		}
		return parsed.Format("2006-01-02"), value, nil
	case "timestamp", "timestamp_local_tz":
		parsed, err := watermarkTimestampValue(value)
		if err != nil {
			return "", nil, err
		}
		if typ.Kind == "timestamp_local_tz" {
			parsed = parsed.UTC()
		} else {
			parsed = time.Date(parsed.Year(), parsed.Month(), parsed.Day(), parsed.Hour(), parsed.Minute(), parsed.Second(), parsed.Nanosecond(), time.UTC)
		}
		return parsed.Format(time.RFC3339Nano), parsed, nil
	case "char", "varchar", "string":
		text := fmt.Sprint(value)
		if raw, ok := value.([]byte); ok {
			text = string(raw)
		}
		if strings.TrimSpace(text) == "" {
			return "", nil, fmt.Errorf("empty string logical key")
		}
		if typ.Kind == "char" {
			text = strings.TrimRight(text, " ")
		}
		return text, value, nil
	default:
		return literal, value, nil
	}
}

func hiveBinaryBinding(value interface{}) ([]byte, error) {
	cursor, err := watermarkBinaryCursorValue(value)
	if err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(cursor.Value)
}

func validateHiveTypedKeys(target string, columns []connection.ColumnDefinition, keys []string, rows []map[string]interface{}, side string) error {
	seen := make(map[string]struct{}, len(rows))
	for _, row := range rows {
		key, _, err := hiveTypedKey(target, columns, keys, row)
		if err != nil {
			return err
		}
		if _, duplicate := seen[key]; duplicate {
			return fmt.Errorf("%s contains duplicate stable keys after target-type normalization", side)
		}
		seen[key] = struct{}{}
	}
	return nil
}
