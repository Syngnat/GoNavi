package db

import (
	"context"
	"encoding/hex"
	"fmt"
	"reflect"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/hivesql"
)

// Native bytes and primitive map keys need declared types before crossing JSON.
// Ordinary string/JSON import values still need no extra metadata RPC.
func hiveChangesForAgent(ctx context.Context, d *OptionalDriverAgentDB, tableName string, changes connection.ChangeSet) (connection.ChangeSet, error) {
	if !hiveHasBytes(changes.Inserts) && !hiveHasBytes(changes.Updates) && !hiveHasBytes(changes.Deletes) &&
		!hiveAgentHasTypedKeys(changes.Inserts) && !hiveAgentHasTypedKeys(changes.Updates) && !hiveAgentHasTypedKeys(changes.Deletes) {
		return changes, nil
	}
	parts, err := hivesql.SplitTable(tableName)
	if err != nil {
		return changes, err
	}
	database, table := "", parts[0]
	if len(parts) == 2 {
		database, table = parts[0], parts[1]
	}
	columns, err := d.GetColumnsContext(ctx, database, table)
	if err != nil {
		return changes, err
	}
	types := make(map[string]hivesql.Type, len(columns))
	for _, column := range columns {
		typ, err := hivesql.ParseType(column.Type)
		if err != nil {
			return changes, err
		}
		types[column.Name] = typ
	}
	encode := func(row map[string]any) (map[string]any, error) {
		copy := make(map[string]any, len(row))
		for name, value := range row {
			typ, ok := types[name]
			if !ok {
				return nil, fmt.Errorf("unknown Hive cell column %q", name)
			}
			converted, err := hiveAgentCell(typ, value)
			if err != nil {
				return nil, err
			}
			copy[name] = converted
		}
		return copy, nil
	}
	result := changes
	result.Inserts = make([]map[string]any, len(changes.Inserts))
	for i, row := range changes.Inserts {
		result.Inserts[i], err = encode(row)
		if err != nil {
			return changes, err
		}
	}
	result.Deletes = make([]map[string]any, len(changes.Deletes))
	for i, row := range changes.Deletes {
		result.Deletes[i], err = encode(row)
		if err != nil {
			return changes, err
		}
	}
	result.Updates = append([]connection.UpdateRow(nil), changes.Updates...)
	for i, row := range changes.Updates {
		result.Updates[i].Keys, err = encode(row.Keys)
		if err != nil {
			return changes, err
		}
		result.Updates[i].Values, err = encode(row.Values)
		if err != nil {
			return changes, err
		}
	}
	return result, nil
}
func hiveHasBytes(value any) bool {
	if value == nil {
		return false
	}
	if _, ok := value.([]byte); ok {
		return true
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Interface, reflect.Pointer:
		if !rv.IsNil() {
			return hiveHasBytes(rv.Elem().Interface())
		}
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			if hiveHasBytes(rv.Index(i).Interface()) {
				return true
			}
		}
	case reflect.Map:
		iter := rv.MapRange()
		for iter.Next() {
			if hiveHasBytes(iter.Value().Interface()) {
				return true
			}
		}
	case reflect.Struct:
		if row, ok := value.(connection.UpdateRow); ok {
			return hiveHasBytes(row.Keys) || hiveHasBytes(row.Values)
		}
	}
	return false
}
func hiveAgentCell(typ hivesql.Type, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	if raw, ok := value.([]byte); ok {
		if typ.Kind == "binary" {
			return "0x" + hex.EncodeToString(raw), nil
		}
		if !utf8.Valid(raw) {
			return nil, fmt.Errorf("Hive textual bytes are not valid UTF-8")
		}
		return string(raw), nil
	}
	if !typ.Complex() {
		return value, nil
	}
	if _, ok := value.(string); ok {
		return value, nil
	}
	rv := reflect.ValueOf(value)
	if (rv.Kind() == reflect.Map || rv.Kind() == reflect.Slice) && rv.IsNil() {
		return nil, nil
	}
	switch typ.Kind {
	case "array":
		if rv.Kind() != reflect.Array && rv.Kind() != reflect.Slice {
			return value, nil
		}
		out := make([]any, rv.Len())
		for i := 0; i < rv.Len(); i++ {
			v, err := hiveAgentCell(*typ.Element, rv.Index(i).Interface())
			if err != nil {
				return nil, err
			}
			out[i] = v
		}
		return out, nil
	case "map", "struct":
		if rv.Kind() != reflect.Map {
			return value, nil
		}
		out := make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			key, member, err := hiveAgentCollectionKey(typ, iter.Key().Interface())
			if err != nil {
				return nil, err
			}
			if _, duplicate := out[key]; duplicate {
				return nil, fmt.Errorf("duplicate Hive primitive MAP key after normalization")
			}
			v, err := hiveAgentCell(member, iter.Value().Interface())
			if err != nil {
				return nil, err
			}
			out[key] = v
		}
		return out, nil
	}
	return value, nil
}

// Detect declared interface-key maps too: encoding/json cannot serialize them
// even when every current runtime key happens to be a string.
func hiveAgentHasTypedKeys(value any) bool {
	if value == nil {
		return false
	}
	rv := reflect.ValueOf(value)
	switch rv.Kind() {
	case reflect.Interface, reflect.Pointer:
		return !rv.IsNil() && hiveAgentHasTypedKeys(rv.Elem().Interface())
	case reflect.Slice, reflect.Array:
		for i := 0; i < rv.Len(); i++ {
			if hiveAgentHasTypedKeys(rv.Index(i).Interface()) {
				return true
			}
		}
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return true
		}
		iter := rv.MapRange()
		for iter.Next() {
			key := reflect.ValueOf(iter.Key().Interface())
			if !key.IsValid() || key.Kind() != reflect.String || !utf8.ValidString(key.String()) {
				return true
			}
			if hiveAgentHasTypedKeys(iter.Value().Interface()) {
				return true
			}
		}
	case reflect.Struct:
		if row, ok := value.(connection.UpdateRow); ok {
			return hiveAgentHasTypedKeys(row.Keys) || hiveAgentHasTypedKeys(row.Values)
		}
	}
	return false
}

func hiveAgentCollectionKey(typ hivesql.Type, key any) (string, hivesql.Type, error) {
	if typ.Kind == "map" {
		text, err := hivesql.NormalizePrimitiveMapKey(*typ.Key, key)
		return text, *typ.Value, err
	}
	rv := reflect.ValueOf(key)
	if !rv.IsValid() || rv.Kind() != reflect.String || !utf8.ValidString(rv.String()) {
		return "", hivesql.Type{}, fmt.Errorf("Hive STRUCT keys must be valid UTF-8 field names")
	}
	text := rv.String()
	for _, field := range typ.Fields {
		if field.Name == text {
			return text, field.Type, nil
		}
	}
	return "", hivesql.Type{}, fmt.Errorf("unknown Hive STRUCT field %q", text)
}
